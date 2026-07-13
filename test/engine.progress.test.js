import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.STORE = 'memory';

const { initStore, repo, clearAll } = await import('../src/db/repository.js');
const { computeProgress } = await import('../src/engine/progress.js');

const T0 = new Date('2026-07-12T10:00:00Z').getTime();
const min = (n) => new Date(T0 + n * 60000).toISOString();

async function seedJob() {
  return repo('jobs').insertOne({ _id: 'job1', projectId: 'proj1', status: 'running', startedAt: min(0) });
}
function seedBatch(over) {
  return repo('batches').upsert(
    { jobId: 'job1', entityType: over.entityType, phase: 'load', seq: over.seq },
    { jobId: 'job1', projectId: 'proj1', phase: 'load', ...over },
  );
}

before(async () => { await initStore(); });
beforeEach(async () => { await clearAll(); });

test('progress: null before any job exists', async () => {
  assert.equal(await computeProgress('proj1'), null);
});

test('progress: aggregates per-type breakdown, totals, throughput and ETA', async () => {
  await repo('projects').insertOne({ _id: 'proj1', stats: { totalEntities: 20 } });
  await seedJob();
  // 3 done group batches (10 items in 2 min) + 1 in-progress ticket batch.
  await seedBatch({ entityType: 'groups', seq: 0, size: 4, status: 'done', attempts: 1, startedAt: min(0), finishedAt: min(1), counts: { in: 4, ok: 4, skipped: 0, failed: 0 } });
  await seedBatch({ entityType: 'groups', seq: 1, size: 4, status: 'done', attempts: 1, startedAt: min(1), finishedAt: min(2), counts: { in: 4, ok: 3, skipped: 0, failed: 1 } });
  await seedBatch({ entityType: 'tickets', seq: 0, size: 4, status: 'in_progress', attempts: 1, startedAt: min(2), counts: { in: 4, ok: 2, skipped: 0, failed: 0 } });

  // now = 4 minutes after start; a ticket batch is still running.
  const p = await computeProgress('proj1', T0 + 4 * 60000);

  assert.equal(p.jobId, 'job1');
  // Totals: processed = ok+skipped+failed = (4)+(3+1)+(2) = 10.
  assert.equal(p.totals.processed, 10);
  assert.equal(p.totals.items.failed, 1);
  assert.deepEqual(p.totals.batches, { total: 3, pending: 0, inProgress: 1, done: 2, failed: 0 });

  // Per-type: groups has 2 done batches (8 items), tickets 1 in-progress.
  const groups = p.byType.find((t) => t.type === 'groups');
  assert.equal(groups.batches.done, 2);
  assert.equal(groups.items.ok, 7);
  const tickets = p.byType.find((t) => t.type === 'tickets');
  assert.equal(tickets.batches.inProgress, 1);

  // Throughput: 10 processed over 4 min wall-clock (start min0 → now min4) = 2.5/min.
  assert.equal(p.throughputPerMin, 2.5);
  // ETA: 20 total − 10 processed = 10 remaining / 2.5 = 4 min.
  assert.deepEqual(p.eta, { remaining: 10, etaMinutes: 4 });

  assert.equal(p.activeBatches.length, 1);
  assert.equal(p.activeBatches[0].entityType, 'tickets');
});

test('progress: no ETA when totalEntities is unknown', async () => {
  await repo('projects').insertOne({ _id: 'proj1', stats: {} });
  await seedJob();
  await seedBatch({ entityType: 'groups', seq: 0, size: 2, status: 'done', attempts: 1, startedAt: min(0), finishedAt: min(1), counts: { in: 2, ok: 2, skipped: 0, failed: 0 } });

  const p = await computeProgress('proj1', T0 + 1 * 60000);
  assert.ok(p.throughputPerMin > 0);
  assert.equal(p.eta, null, 'no denominator → honest null, not a fabricated ETA');
});
