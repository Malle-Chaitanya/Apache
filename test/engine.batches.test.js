import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory store (see engine.integration.test.js for why this must precede the
// dynamic import of repository.js).
process.env.STORE = 'memory';

const { initStore, repo, clearAll } = await import('../src/db/repository.js');
const { config } = await import('../src/config.js');
const { extract } = await import('../src/engine/extractor.js');
const { loadType } = await import('../src/engine/loader.js');

// Only groups have work; everything else is empty so the run stays focused on
// one type's batch behaviour.
function fakeSource(groupCount) {
  const groups = Array.from({ length: groupCount }, (_, i) => ({ id: 1000 + i, name: `Group ${i}` }));
  return {
    list: async (type) => (type === 'groups' ? groups : []),
    listComments: async () => [],
    fetchBinary: async () => Buffer.from('bytes'),
  };
}

function fakeTarget({ failOnName } = {}) {
  const creates = [];
  return {
    creates,
    capability: () => ({ known: true, creatable: true, verifyLive: false }),
    create: async (targetType, payload) => {
      creates.push({ targetType, payload });
      // Simulate a single per-item failure (isolated, non-auth) to prove it lands
      // in the batch's `failed` tally without sinking the whole batch.
      if (failOnName && payload.name === failOnName) { const e = new Error('boom'); e.status = 500; throw e; }
      return { id: 500 + creates.length };
    },
  };
}

function makeCtx(over = {}) {
  return {
    project: { _id: 'proj1' },
    jobId: 'job1',
    dryRun: false,
    source: fakeSource(5),
    target: fakeTarget(),
    idCache: new Map(),
    conflicts: [],
    stats: { migrated: 0, manual: 0, failed: 0, comments: 0 },
    emit: async () => {},
    ...over,
  };
}

before(async () => { await initStore(); });
beforeEach(async () => { await clearAll(); });

test('batching: work is chunked into config.batchSize batches, each recorded done with counts', async () => {
  const original = config.batchSize;
  config.batchSize = 2;
  try {
    const ctx = makeCtx({ source: fakeSource(5) }); // 5 groups / size 2 → batches of 2,2,1
    await extract(ctx);
    await loadType(ctx, 'groups');

    const batches = (await repo('batches').find({ jobId: 'job1', entityType: 'groups', phase: 'load' }))
      .sort((a, b) => a.seq - b.seq);
    assert.equal(batches.length, 3, 'ceil(5/2) = 3 batches');
    assert.deepEqual(batches.map((b) => b.size), [2, 2, 1], 'batch sizes chunk the work-set in order');
    assert.ok(batches.every((b) => b.status === 'done'), 'every batch reaches done');
    assert.ok(batches.every((b) => b.attempts === 1 && b.startedAt && b.finishedAt), 'timings + attempt recorded');

    const totalOk = batches.reduce((s, b) => s + b.counts.ok, 0);
    assert.equal(totalOk, 5, 'all five loaded (ok) across the batches');
    assert.equal(batches.reduce((s, b) => s + b.counts.in, 0), 5, 'in-counts sum to the work-set');
  } finally {
    config.batchSize = original;
  }
});

test('batching: a per-item failure is isolated to its batch tally, run continues', async () => {
  const original = config.batchSize;
  config.batchSize = 2;
  try {
    const target = fakeTarget({ failOnName: 'Group 3' }); // 4th group (seq index 1) fails
    const ctx = makeCtx({ source: fakeSource(5), target });
    await extract(ctx);
    await loadType(ctx, 'groups');

    const batches = await repo('batches').find({ jobId: 'job1', entityType: 'groups', phase: 'load' });
    const failedTally = batches.reduce((s, b) => s + b.counts.failed, 0);
    const okTally = batches.reduce((s, b) => s + b.counts.ok, 0);
    assert.equal(failedTally, 1, 'exactly one item counted failed');
    assert.equal(okTally, 4, 'the other four still loaded');
    assert.ok(batches.every((b) => b.status === 'done'), 'a per-item failure does not fail the batch');
    assert.equal(ctx.stats.failed, 1, 'global stats agree with the batch tally');
  } finally {
    config.batchSize = original;
  }
});

test('batching: a batch already marked done is skipped on re-entry (resume checkpoint)', async () => {
  const original = config.batchSize;
  config.batchSize = 2;
  try {
    const ctx = makeCtx({ source: fakeSource(3) });
    await extract(ctx);
    // Pre-seed the first batch as done, as a prior interrupted run would leave it.
    await repo('batches').upsert(
      { jobId: 'job1', entityType: 'groups', phase: 'load', seq: 0 },
      { jobId: 'job1', entityType: 'groups', phase: 'load', seq: 0, projectId: 'proj1', size: 2, status: 'done', attempts: 1, counts: { in: 2, ok: 2, skipped: 0, failed: 0 } },
    );

    await loadType(ctx, 'groups');

    const seq0 = await repo('batches').findOne({ jobId: 'job1', entityType: 'groups', phase: 'load', seq: 0 });
    assert.equal(seq0.attempts, 1, 'the done batch was not re-attempted');
    const seq1 = await repo('batches').findOne({ jobId: 'job1', entityType: 'groups', phase: 'load', seq: 1 });
    assert.equal(seq1.status, 'done', 'the remaining batch still runs to completion');
  } finally {
    config.batchSize = original;
  }
});
