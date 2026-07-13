import { repo } from '../db/repository.js';
import { config } from '../config.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';
import { transformers } from '../mapping/transformers/index.js';
import { NoApiError } from '../connectors/freshdesk/index.js';

// Bounded-concurrency worker pool: run `fn` over `items` with at most `n` in
// flight. Workers pull the next index as they free up (queue semantics), so the
// pipe stays full up to the shared rate limiter. A thrown fn rejects the pool.
async function runPool(items, n, fn) {
  const width = Math.max(1, Math.min(n || 1, items.length));
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: width }, worker));
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Freshdesk's per-file attachment cap

// Split a work-set into fixed-size chunks (the batch unit). Order is preserved,
// so `seq` is a stable index into the original list for a given job.
function chunk(items, size) {
  const n = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// TRANSFORM + LOAD, in dependency order (config before data). FK references are
// resolved through the in-memory idmap cache, which is filled as objects load —
// this is why config must load first. Idempotent against the idmap collection.
export async function loadAll(ctx) {
  for (const type of LOAD_ORDER) await loadType(ctx, type);
}

export async function loadType(ctx, type) {
  const { project, target, dryRun, idCache, emit } = ctx;
  const meta = MATRIX[type];
  const entities = await repo(type).find({ projectId: project._id, status: { $in: ['extracted', 'transformed', 'validated', 'failed'] } });

  // Returns a batch-count bucket for this record: 'ok' (written/reused/validated),
  // 'skipped' (already crosswalked / manual / no-API), or 'failed'. Auth failures
  // (401/403) still THROW so the pool rejects and the run pauses for reconnect.
  const processEntity = async (ent) => {
    // Skip if already crosswalked (resumable / idempotent).
    if (idCache.has(`${type}:${ent.sourceId}`)) { await mark(type, ent, 'loaded'); return 'skipped'; }

    let result;
    try {
      result = transformers[meta.transformer](ent.sourceRaw, buildCtx(ctx, type));
    } catch (err) {
      await mark(type, ent, 'failed', err.message);
      emit('transform', type, `transform failed for ${type}#${ent.sourceId}: ${err.message}`, 'error');
      return 'failed';
    }
    // Honor the admin's field mapping: drop any field they chose to skip. Required
    // fields are never in this set (the mapping API refuses to skip them), so the
    // record still validates on the target.
    const skips = ctx.fieldSkips?.[type];
    if (skips?.size && result?.payload) for (const k of skips) delete result.payload[k];
    await repo(type).updateOne({ _id: ent._id }, { transformed: result.payload });

    // Objects with no create API → recorded as manual (conflict already written by transformer).
    const cap = target.capability(meta.targetType);
    if (result.manual || !cap.creatable) { await mark(type, ent, 'manual'); ctx.stats.manual++; return 'skipped'; }

    if (dryRun) { await mark(type, ent, 'validated'); return 'ok'; }

    try {
      const ctxOut = result.ctxOut || {};
      // Macro replies become canned responses, which must live in a folder.
      if (meta.targetType === 'cannedResponses' && target.ensureCannedFolder) ctxOut.folderId = await target.ensureCannedFolder();
      const { id, raw } = await target.create(meta.targetType, result.payload, ctxOut);
      await writeIdmap(ctx, type, ent.sourceId, id, meta.targetType);
      // Remember the Freshdesk field NAME for SAFE-typed custom fields so tickets
      // can carry their values (dropdowns/system fields excluded — no clean 1:1).
      if (type === 'ticketFields' && raw?.name) {
        const SAFE = new Set(['text', 'textarea', 'integer', 'decimal', 'checkbox', 'date']);
        if (SAFE.has(ent.sourceRaw?.type)) {
          ctx.idCache.set(`ticketFieldName:${ent.sourceId}`, raw.name);
          // Remember the source TYPE too, so the ticket transformer can coerce the
          // value (integer/decimal → number, text → ≤255) instead of sending raw.
          ctx.idCache.set(`ticketFieldType:${ent.sourceId}`, ent.sourceRaw.type);
        }
      }
      await repo(type).updateOne({ _id: ent._id }, { status: 'loaded', targetId: String(id) });
      ctx.stats.migrated++;

      // Sub-resources (ticket replies/notes) load against the new parent id.
      // Sequential WITHIN a ticket (order matters); different tickets run in parallel.
      for (const child of result.children || []) await loadChild(ctx, type, id, child);
      emit('load', type, `loaded ${type}#${ent.sourceId} → ${id}`);
      return 'ok';
    } catch (err) {
      if (err instanceof NoApiError || err.noApi) { await mark(type, ent, 'manual'); ctx.stats.manual++; return 'skipped'; }
      // Auth failure = rotated/revoked credential → rethrow so the pool rejects
      // and the orchestrator can pause and request reconnect (resume later).
      if (err.status === 401 || err.status === 403) throw err;
      // IDEMPOTENCY: already exists on the target (re-run / prior migration) →
      // reuse it, never duplicate. Freshdesk returns the existing id in the 409.
      if (err.status === 409) {
        const existingId = extractExistingId(err.body) ?? await lookupExisting(target, meta.targetType, result.payload);
        if (existingId) {
          await writeIdmap(ctx, type, ent.sourceId, existingId, meta.targetType, true);
          // A reused record keeps its existing profile — but some fields (e.g. an
          // agent's group membership) must be (re)applied so downstream references
          // work (ticket assignment). Best-effort: never fail the reuse.
          if (target.afterReuse) { try { await target.afterReuse(meta.targetType, existingId, result.payload, result.ctxOut || {}); } catch { /* best-effort */ } }
          // Record the FD field name for safe custom fields (same as the create path).
          if (type === 'ticketFields') {
            const SAFE = new Set(['text', 'textarea', 'integer', 'decimal', 'checkbox', 'date']);
            const nm = err.body?.errors?.[0]?.additional_info?.name;
            if (nm && SAFE.has(ent.sourceRaw?.type)) {
              ctx.idCache.set(`ticketFieldName:${ent.sourceId}`, nm);
              ctx.idCache.set(`ticketFieldType:${ent.sourceId}`, ent.sourceRaw.type);
            }
          }
          await repo(type).updateOne({ _id: ent._id }, { status: 'loaded', targetId: String(existingId) });
          ctx.stats.migrated++;
          emit('load', type, `${type}#${ent.sourceId} already existed → reused #${existingId}`);
          return 'ok';
        }
      }
      // BEST-EFFORT config (SLA / products / business hours): we attempt the API;
      // if the plan/endpoint rejects it, it becomes a manual checklist item —
      // not a hard failure.
      if (target.capability(meta.targetType).bestEffort) {
        const nm = ent.sourceRaw?.title || ent.sourceRaw?.name || ent.sourceId;
        ctx.conflicts.push({ projectId: project._id, entityType: type, sourceId: ent.sourceId, kind: 'no_api', detail: `${type} "${nm}" couldn't be auto-created (${(err.message || '').slice(0, 120)}).`, suggestion: 'Recreate it in the Freshdesk admin UI.', status: 'manual' });
        await mark(type, ent, 'manual'); ctx.stats.manual++;
        return 'skipped';
      }
      // PER-ITEM failure isolation: mark this record failed and keep going — it
      // stays retryable (a re-run re-picks 'failed' records = the retry queue).
      await mark(type, ent, 'failed', err.message);
      ctx.stats.failed++;
      emit('load', type, `load failed for ${type}#${ent.sourceId}: ${err.message}`, 'error');
      return 'failed';
    }
  };

  // Types load sequentially (LOAD_ORDER) so all cross-type FK deps are already
  // crosswalked. Within a type the work-set is split into fixed-size BATCHES:
  // each batch is its own checkpointed, retryable unit of work (PRD §8.1 / §12).
  // A `batches` doc is the operational record — status, attempt count, per-batch
  // {in/ok/skipped/failed} tallies and timings — so progress is observable and a
  // paused run shows exactly where it stopped. Records inside a batch stay
  // independent → up to `config.concurrency` run at once through the worker pool.
  const batches = chunk(entities, config.batchSize);
  for (let seq = 0; seq < batches.length; seq++) {
    const items = batches[seq];
    const key = { jobId: ctx.jobId, entityType: type, phase: 'load', seq };
    const prior = await repo('batches').findOne(key);
    // Resume: a batch already marked done is skipped without re-touching its items
    // (item-level idmap still guarantees no duplicates if it is ever re-entered).
    if (prior?.status === 'done') { emit('load', type, `${type} batch ${seq + 1}/${batches.length}: resumed (already done)`); continue; }

    const batch = await repo('batches').upsert(key, {
      ...key, projectId: project._id, size: items.length,
      status: 'in_progress', attempts: (prior?.attempts || 0) + 1, startedAt: new Date(),
    });
    const counts = { in: items.length, ok: 0, skipped: 0, failed: 0 };
    try {
      await runPool(items, config.concurrency, async (ent) => { counts[await processEntity(ent)]++; });
      await repo('batches').updateOne({ _id: batch._id }, { status: 'done', counts, finishedAt: new Date() });
      emit('load', type, `${type} batch ${seq + 1}/${batches.length}: ${counts.ok} ok, ${counts.skipped} skipped, ${counts.failed} failed`);
    } catch (err) {
      // The pool only rejects on a rethrown auth failure (rotated/revoked
      // credential). Record the partial batch as failed so the report pinpoints
      // where the run paused, then propagate so the orchestrator can pause+resume.
      await repo('batches').updateOne({ _id: batch._id }, { status: 'failed', counts, finishedAt: new Date() });
      emit('load', type, `${type} batch ${seq + 1}/${batches.length} paused: ${err.message}`, 'error');
      throw err;
    }
  }

  const done = await repo(type).count({ projectId: project._id, status: 'loaded' });
  emit('load', type, `${type}: ${done} loaded`);
}

// A reply/note is its own retryable record: staged before the API call so a
// failure is a visible, resumable `failed` doc instead of a dropped warning.
async function loadChild(ctx, type, ticketId, child) {
  const { project, target, emit } = ctx;
  const query = { projectId: project._id, sourceId: child.sourceId };
  await repo('ticketComments').upsert(query, { ...query, entityType: child.targetType, status: 'extracted' });

  const files = [];
  for (const a of child.attachments || []) {
    if (a.size && a.size > MAX_ATTACHMENT_BYTES) {
      ctx.conflicts.push({ projectId: project._id, entityType: type, kind: 'attachment_too_large', detail: `Attachment "${a.filename}" on ${type}#${child.sourceId} is ${a.size} bytes, over Freshdesk's per-file limit.`, suggestion: 'Share via link or upload manually after migration.', status: 'open' });
      continue;
    }
    try {
      const buffer = await ctx.source.fetchBinary(a.url);
      files.push({ filename: a.filename, contentType: a.contentType, buffer });
    } catch (err) {
      emit('load', type, `attachment "${a.filename}" on ${type}#${child.sourceId} failed to download: ${err.message}`, 'warn');
    }
  }

  try {
    const { id } = await target.create(child.targetType, child.payload, { ticketId, attachments: files });
    await repo('ticketComments').updateOne(query, { status: 'loaded', targetId: String(id) });
    ctx.stats.comments = (ctx.stats.comments || 0) + 1;
  } catch (err) {
    await repo('ticketComments').updateOne(query, { status: 'failed', errors: [{ at: new Date(), code: 'load_failed', message: err.message }] });
    emit('load', type, `child ${child.targetType} failed: ${err.message}`, 'warn');
  }
}

function buildCtx(ctx, type) {
  return {
    sourceKey: type,
    forensic: !!ctx.forensic, // provenance mode → transformers gate visible prefixes on this
    resolve: (t, sourceId) => (sourceId == null ? null : ctx.idCache.get(`${t}:${String(sourceId)}`) ?? null),
    addConflict: (kind, detail, suggestion) => ctx.conflicts.push({ projectId: ctx.project._id, entityType: type, kind, detail, suggestion, status: kind === 'no_api' ? 'manual' : 'open' }),
    // Effective value map lookup (customer override ⊕ JS default). Returns the
    // mapped target for `sourceValue`; falls back to the map's "use for empty"
    // default, then the caller's `fallback`. A map that resolves to null means
    // "skip" (the transformer omits the field).
    mapValue: (name, sourceValue, fallback) => {
      const m = ctx.valueMaps?.[name];
      if (!m) return fallback;
      const key = sourceValue == null ? '__default' : sourceValue;
      const v = m[key];
      if (v !== undefined) return v;
      return m.__default ?? fallback;
    },
  };
}

async function writeIdmap(ctx, entityType, sourceId, targetId, targetType, preexisting = false) {
  ctx.idCache.set(`${entityType}:${sourceId}`, targetId);
  await repo('idmap').upsert(
    { projectId: ctx.project._id, entityType, sourceId },
    { projectId: ctx.project._id, entityType, sourceId, targetId: String(targetId), targetType, preexisting },
  );
}

// Pull the existing record's id out of a Freshdesk 409 duplicate error, so we
// can reuse it instead of creating a duplicate.
function extractExistingId(body) {
  const errs = body && body.errors;
  if (!Array.isArray(errs)) return null;
  for (const e of errs) {
    const info = e.additional_info || {};
    for (const k of ['group_id', 'agent_id', 'company_id', 'contact_id', 'user_id', 'id']) if (info[k]) return info[k];
  }
  return null;
}

// Fallback lookup when the 409 body doesn't carry the id.
async function lookupExisting(target, targetType, payload) {
  try {
    if (targetType === 'contacts' && payload.email && target.findContactByEmail) return (await target.findContactByEmail(payload.email))?.id ?? null;
    if (targetType === 'companies' && payload.name && target.findCompanyByName) return (await target.findCompanyByName(payload.name))?.id ?? null;
  } catch { /* ignore */ }
  return null;
}

async function mark(type, ent, status, message) {
  const patch = { status };
  if (message) patch.errors = [...(ent.errors || []), { at: new Date(), code: status, message }];
  await repo(type).updateOne({ _id: ent._id }, patch);
}
