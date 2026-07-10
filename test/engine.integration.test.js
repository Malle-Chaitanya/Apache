import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Force the in-memory store adapter. Must happen before repository.js (and the
// config.js it imports) is ever evaluated, so this uses a dynamic import
// rather than a static one — static imports are hoisted ahead of this line.
process.env.STORE = 'memory';

const { initStore, repo, clearAll } = await import('../src/db/repository.js');
const { extract } = await import('../src/engine/extractor.js');
const { loadAll } = await import('../src/engine/loader.js');
const { reconcile } = await import('../src/engine/reconciler.js');

const FIXTURES = {
  groups: [{ id: 1001, name: 'Group A' }],
  agents: [{ id: 2002, name: 'Agent A', email: 'agent@example.com', group_ids: [1001] }],
  organizations: [{ id: 3001, name: 'Acme', domain_names: ['acme.com'] }],
  users: [{ id: 2001, name: 'User A', email: 'user@example.com', organization_id: 3001 }],
  tickets: [{
    id: 5001, subject: 'Help', description: 'Please help', status: 'open', priority: 'normal',
    via: { channel: 'web' }, group_id: 1001, assignee_id: 2002, requester_id: 2001, organization_id: 3001,
    tags: [], custom_fields: [], created_at: '2026-01-01', updated_at: '2026-01-02',
  }],
};

const COMMENTS = [
  {
    id: 9001, public: true, body: 'Reply body', author_id: 2001,
    attachments: [
      { content_url: 'https://z.example/a.png', file_name: 'a.png', content_type: 'image/png', size: 500 },
      { content_url: 'https://z.example/big.zip', file_name: 'big.zip', content_type: 'application/zip', size: 30 * 1024 * 1024 },
    ],
  },
  // ticketNote creation is forced to fail below, to exercise the failed-child path.
  { id: 9002, public: false, body: 'Private note', author_id: 2002, attachments: [] },
];

function fakeSource() {
  return {
    list: async (type) => FIXTURES[type] || [],
    listComments: async () => COMMENTS,
    fetchBinary: async () => Buffer.from('fake-bytes'),
  };
}

function fakeTarget() {
  const createdReplies = [];
  const ids = { groups: 501, agents: 502, companies: 503, contacts: 504, tickets: 601 };
  return {
    capability: () => ({ known: true, creatable: true, verifyLive: false }),
    create: async (targetType, payload, ctx = {}) => {
      if (targetType === 'ticketNote') throw new Error('simulated note failure');
      if (targetType === 'ticketReply') { createdReplies.push({ payload, ctx }); return { id: 701 }; }
      if (!(targetType in ids)) throw new Error(`fakeTarget: unexpected targetType ${targetType}`);
      return { id: ids[targetType] };
    },
    createdReplies,
  };
}

function makeCtx() {
  const project = { _id: 'proj1' };
  return {
    project, dryRun: false,
    source: fakeSource(),
    target: fakeTarget(),
    idCache: new Map(),
    conflicts: [],
    stats: { migrated: 0, manual: 0, failed: 0, comments: 0 },
    emit: async () => {},
  };
}

before(async () => { await initStore(); });
beforeEach(async () => { await clearAll(); });

test('extract -> load -> reconcile migrates data, uploads attachments, and surfaces a failed comment', async () => {
  const ctx = makeCtx();

  await extract(ctx);
  await loadAll(ctx);
  const summary = await reconcile(ctx);

  // Core entities migrated.
  assert.equal(ctx.stats.migrated, 5); // group, agent, organization, user, ticket
  assert.equal(ctx.stats.failed, 0);

  // The oversized attachment is a conflict, not a silent drop.
  assert.ok(ctx.conflicts.some((c) => c.kind === 'attachment_too_large'));

  // The reply upload received exactly the one attachment under the size cap.
  assert.equal(ctx.target.createdReplies.length, 1);
  const replyCtx = ctx.target.createdReplies[0].ctx;
  assert.equal(replyCtx.attachments.length, 1);
  assert.equal(replyCtx.attachments[0].filename, 'a.png');
  assert.equal(replyCtx.attachments[0].buffer.toString(), 'fake-bytes'); // only the under-cap file was downloaded

  // ticketComments carries a real, queryable record per child — not just a log line.
  const comments = await repo('ticketComments').find({ projectId: 'proj1' });
  assert.equal(comments.length, 2);
  const reply = comments.find((c) => c.entityType === 'ticketReply');
  const note = comments.find((c) => c.entityType === 'ticketNote');
  assert.equal(reply.status, 'loaded');
  assert.equal(reply.targetId, '701');
  assert.equal(note.status, 'failed');
  assert.equal(note.errors[0].message, 'simulated note failure');

  // Reconciliation reflects both the success and the failure — nothing vanishes.
  assert.equal(summary.totals.comments, 1);
  assert.equal(summary.totals.commentsFailed, 1);
});
