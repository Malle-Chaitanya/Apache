import { repo } from '../db/repository.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';
import { transformers } from '../mapping/transformers/index.js';
import { NoApiError } from '../connectors/freshdesk/index.js';

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

  for (const ent of entities) {
    // Skip if already crosswalked (resumable / idempotent).
    if (idCache.has(`${type}:${ent.sourceId}`)) { await mark(type, ent, 'loaded'); continue; }

    let result;
    try {
      result = transformers[meta.transformer](ent.sourceRaw, buildCtx(ctx, type));
    } catch (err) {
      await mark(type, ent, 'failed', err.message);
      emit('transform', type, `transform failed for ${type}#${ent.sourceId}: ${err.message}`, 'error');
      continue;
    }
    await repo(type).updateOne({ _id: ent._id }, { transformed: result.payload });

    // Objects with no create API → recorded as manual (conflict already written by transformer).
    const cap = target.capability(meta.targetType);
    if (result.manual || !cap.creatable) { await mark(type, ent, 'manual'); ctx.stats.manual++; continue; }

    if (dryRun) { await mark(type, ent, 'validated'); continue; }

    try {
      const { id } = await target.create(meta.targetType, result.payload, result.ctxOut || {});
      await writeIdmap(ctx, type, ent.sourceId, id, meta.targetType);
      await repo(type).updateOne({ _id: ent._id }, { status: 'loaded', targetId: String(id) });
      ctx.stats.migrated++;

      // Sub-resources (ticket replies/notes) load against the new parent id.
      for (const child of result.children || []) {
        try {
          await target.create(child.targetType, child.payload, { ticketId: id });
          await repo('ticketComments').insertOne({ projectId: project._id, entityType: child.targetType, sourceId: child.sourceId, targetId: String(id), status: 'loaded' });
          ctx.stats.comments = (ctx.stats.comments || 0) + 1;
        } catch (err) { emit('load', type, `child ${child.targetType} failed: ${err.message}`, 'warn'); }
      }
      emit('load', type, `loaded ${type}#${ent.sourceId} → ${id}`);
    } catch (err) {
      if (err instanceof NoApiError || err.noApi) { await mark(type, ent, 'manual'); ctx.stats.manual++; continue; }
      await mark(type, ent, 'failed', err.message);
      ctx.stats.failed++;
      emit('load', type, `load failed for ${type}#${ent.sourceId}: ${err.message}`, 'error');
    }
  }
  const done = await repo(type).count({ projectId: project._id, status: 'loaded' });
  emit('load', type, `${type}: ${done} loaded`);
}

function buildCtx(ctx, type) {
  return {
    sourceKey: type,
    resolve: (t, sourceId) => (sourceId == null ? null : ctx.idCache.get(`${t}:${String(sourceId)}`) ?? null),
    addConflict: (kind, detail, suggestion) => ctx.conflicts.push({ projectId: ctx.project._id, entityType: type, kind, detail, suggestion, status: kind === 'no_api' ? 'manual' : 'open' }),
  };
}

async function writeIdmap(ctx, entityType, sourceId, targetId, targetType) {
  ctx.idCache.set(`${entityType}:${sourceId}`, targetId);
  await repo('idmap').upsert(
    { projectId: ctx.project._id, entityType, sourceId },
    { projectId: ctx.project._id, entityType, sourceId, targetId: String(targetId), targetType },
  );
}

async function mark(type, ent, status, message) {
  const patch = { status };
  if (message) patch.errors = [...(ent.errors || []), { at: new Date(), code: status, message }];
  await repo(type).updateOne({ _id: ent._id }, patch);
}
