import { repo } from '../db/repository.js';

// Live operational progress for a running (or finished) migration, aggregated
// from the `batches` records the loader writes. This is the "watch a 6-hour
// migration" view: per-type batch status, throughput (items/min) measured off
// real load-phase wall-clock, active batches, and a best-effort ETA.
//
// Throughput is deliberately measured from the FIRST batch start to now (or the
// last finish) — i.e. real wall-clock including rate-limiter waits — because that
// is the rate an admin actually experiences, and the honest basis for an ETA.
export async function computeProgress(projectId, now = Date.now()) {
  const jobs = await repo('jobs').find({ projectId });
  if (!jobs.length) return null;
  // Most-recent job = the run being watched. `startedAt` may be a Date or ISO.
  const job = jobs.sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];

  const batches = await repo('batches').find({ jobId: job._id });
  const empty = {
    jobId: job._id, jobStatus: job.status, phase: 'load',
    byType: [], totals: zeroTotals(),
    throughputPerMin: 0, elapsedMs: 0, startedAt: null,
    activeBatches: [], eta: null,
  };
  if (!batches.length) return empty;

  // Group by entity type, preserving the load order the batches were created in.
  const byTypeMap = new Map();
  for (const b of batches) {
    if (!byTypeMap.has(b.entityType)) byTypeMap.set(b.entityType, []);
    byTypeMap.get(b.entityType).push(b);
  }
  const byType = [...byTypeMap.entries()].map(([type, list]) => ({
    type,
    batches: batchStatusBreakdown(list),
    items: sumCounts(list),
  }));

  const totals = {
    batches: batchStatusBreakdown(batches),
    items: sumCounts(batches),
  };
  totals.processed = totals.items.ok + totals.items.skipped + totals.items.failed;

  // Load-phase wall-clock: first batch start → last finish (or now if any run on).
  const starts = batches.map((b) => ms(b.startedAt)).filter(Boolean);
  const startedAt = starts.length ? Math.min(...starts) : null;
  const anyRunning = batches.some((b) => b.status === 'in_progress');
  const finishes = batches.map((b) => ms(b.finishedAt)).filter(Boolean);
  const endAnchor = anyRunning || !finishes.length ? now : Math.max(...finishes);
  const elapsedMs = startedAt ? Math.max(0, endAnchor - startedAt) : 0;

  const throughputPerMin = elapsedMs > 0 ? totals.processed / (elapsedMs / 60000) : 0;

  const activeBatches = batches
    .filter((b) => b.status === 'in_progress')
    .map((b) => ({ entityType: b.entityType, seq: b.seq, size: b.size, startedAt: b.startedAt }));

  const eta = await estimateEta(projectId, totals.processed, throughputPerMin);

  return {
    jobId: job._id, jobStatus: job.status, phase: 'load',
    byType, totals,
    throughputPerMin: round(throughputPerMin),
    elapsedMs, startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    activeBatches,
    eta,
  };
}

// Best-effort ETA. The denominator (total records to load) is only reliably known
// once discovery ran; when it isn't, we return null rather than invent a number.
async function estimateEta(projectId, processed, throughputPerMin) {
  if (throughputPerMin <= 0) return null;
  const project = await repo('projects').findOne({ _id: projectId });
  const total = project?.stats?.totalEntities;
  if (!total || total <= 0) return null;
  const remaining = Math.max(0, total - processed);
  return { remaining, etaMinutes: round(remaining / throughputPerMin) };
}

function batchStatusBreakdown(list) {
  const out = { total: list.length, pending: 0, inProgress: 0, done: 0, failed: 0 };
  for (const b of list) {
    if (b.status === 'done') out.done++;
    else if (b.status === 'failed') out.failed++;
    else if (b.status === 'in_progress') out.inProgress++;
    else out.pending++;
  }
  return out;
}

function sumCounts(list) {
  const acc = { in: 0, ok: 0, skipped: 0, failed: 0 };
  for (const b of list) {
    const c = b.counts || {};
    acc.in += c.in || 0; acc.ok += c.ok || 0; acc.skipped += c.skipped || 0; acc.failed += c.failed || 0;
  }
  return acc;
}

function zeroTotals() {
  return { batches: { total: 0, pending: 0, inProgress: 0, done: 0, failed: 0 }, items: { in: 0, ok: 0, skipped: 0, failed: 0 }, processed: 0 };
}

// Accept Date | ISO string | epoch-ms | falsy → 0.
function ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const round = (n) => Math.round(n * 100) / 100;
