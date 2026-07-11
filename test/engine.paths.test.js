import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory store (see engine.integration.test.js for why this must precede the
// dynamic import of repository.js).
process.env.STORE = 'memory';

const { initStore, repo, clearAll } = await import('../src/db/repository.js');
const { extract } = await import('../src/engine/extractor.js');
const { loadAll } = await import('../src/engine/loader.js');
const { reconcile } = await import('../src/engine/reconciler.js');

const FIXTURES = {
  groups: [{ id: 1001, name: 'Group A' }],
  organizations: [{ id: 3001, name: 'Acme', domain_names: ['acme.com'] }],
  users: [{ id: 2001, name: 'User A', email: 'user@example.com', organization_id: 3001 }],
  tickets: [{
    id: 5001, subject: 'Help', description: 'Please help', status: 'open', priority: 'normal',
    via: { channel: 'web' }, group_id: 1001, requester_id: 2001, organization_id: 3001,
    tags: [], custom_fields: [], created_at: '2026-01-01', updated_at: '2026-01-02',
  }],
};

function fakeSource(overrides = {}) {
  return {
    list: async (type) => (overrides[type] ?? FIXTURES[type] ?? []),
    listComments: async () => [],
    fetchBinary: async () => Buffer.from('bytes'),
  };
}

// Configurable fake target: records every create, and can be told to throw a
// 409 for a given targetType (to exercise the idempotent-reuse path).
function fakeTarget({ conflictOn } = {}) {
  const creates = [];
  const ids = { groups: 501, companies: 503, contacts: 504, tickets: 601 };
  return {
    creates,
    capability: () => ({ known: true, creatable: true, verifyLive: false }),
    create: async (targetType, payload) => {
      creates.push({ targetType, payload });
      if (conflictOn && targetType === conflictOn) {
        const err = new Error('duplicate');
        err.status = 409;
        err.body = { errors: [{ additional_info: { company_id: 999 } }] };
        throw err;
      }
      if (!(targetType in ids)) throw new Error(`unexpected targetType ${targetType}`);
      return { id: ids[targetType] };
    },
  };
}

function makeCtx(over = {}) {
  return {
    project: { _id: 'proj1' },
    dryRun: false,
    source: fakeSource(),
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

test('dry run: entities are validated, nothing is created on the target', async () => {
  const target = fakeTarget();
  const ctx = makeCtx({ dryRun: true, target });

  await extract(ctx);
  await loadAll(ctx);
  const summary = await reconcile(ctx);

  assert.equal(target.creates.length, 0, 'dry run must not write to the target');
  assert.equal(ctx.stats.migrated, 0);
  assert.ok(summary.totals.validated >= 4, 'group+org+user+ticket validated'); // "would migrate"
  assert.equal(summary.totals.migrated, 0);

  const org = (await repo('organizations').find({ projectId: 'proj1' }))[0];
  assert.equal(org.status, 'validated');
});

test('idempotency: a 409 on create reuses the existing record, never duplicates', async () => {
  const target = fakeTarget({ conflictOn: 'companies' });
  const ctx = makeCtx({ target });

  await extract(ctx);
  await loadAll(ctx);

  const org = (await repo('organizations').find({ projectId: 'proj1' }))[0];
  assert.equal(org.status, 'loaded');
  assert.equal(org.targetId, '999', 'reused the id from the 409 body');

  const idmap = (await repo('idmap').find({ projectId: 'proj1', entityType: 'organizations' }))[0];
  assert.equal(idmap.preexisting, true);
  assert.ok(ctx.stats.migrated >= 1, 'a reused record still counts as migrated, not failed');
  assert.equal(ctx.stats.failed, 0);
});

test('re-run safety: a pre-crosswalked entity is marked loaded with zero new creates', async () => {
  const target = fakeTarget();
  const ctx = makeCtx({ target });
  // Simulate a prior run: the org is already in the idmap cache.
  ctx.idCache.set('organizations:3001', 503);

  await extract(ctx);
  await loadAll(ctx);

  const orgCreates = target.creates.filter((c) => c.targetType === 'companies');
  assert.equal(orgCreates.length, 0, 'already-mapped org is not recreated');
  const org = (await repo('organizations').find({ projectId: 'proj1' }))[0];
  assert.equal(org.status, 'loaded');
});

test('field skips: a field the admin deselected is stripped from the payload', async () => {
  const target = fakeTarget();
  const ctx = makeCtx({ target, fieldSkips: { organizations: new Set(['domains']) } });

  await extract(ctx);
  await loadAll(ctx);

  const orgCreate = target.creates.find((c) => c.targetType === 'companies');
  assert.ok(orgCreate, 'org was still created');
  assert.equal(orgCreate.payload.domains, undefined, 'the skipped field never reached the target');
  assert.equal(orgCreate.payload.name, 'Acme', 'non-skipped fields survive');
});

test('reconcile: byType + totals reflect exactly what loaded', async () => {
  const ctx = makeCtx();
  await extract(ctx);
  await loadAll(ctx);
  const summary = await reconcile(ctx);

  const orgRow = summary.byType.find((b) => b.type === 'organizations');
  assert.equal(orgRow.source, 1);
  assert.equal(orgRow.migrated, 1);
  assert.equal(summary.totals.failed, 0);
  assert.equal(typeof summary.generatedAt, 'string');
});
