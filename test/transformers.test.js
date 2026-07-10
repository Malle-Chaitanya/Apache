import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformers } from '../src/mapping/transformers/index.js';

// Stub ctx: resolve(type, sourceId) -> target id via a lookup table; addConflict
// records calls so tests can assert on kind/detail without a real DB.
function stubCtx(resolveMap = {}) {
  const conflicts = [];
  return {
    conflicts,
    resolve: (type, sourceId) => resolveMap[`${type}:${sourceId}`] ?? null,
    addConflict: (kind, detail, suggestion) => conflicts.push({ kind, detail, suggestion }),
  };
}

test('group: maps name/description, defaults description to empty string', () => {
  assert.deepEqual(transformers.group({ name: 'Support' }).payload, { name: 'Support', description: '' });
  assert.deepEqual(transformers.group({ name: 'Support', description: 'desc' }).payload, { name: 'Support', description: 'desc' });
});

test('role: maps to nearest default role and flags a conflict', () => {
  const ctx = stubCtx();
  const { payload, manual } = transformers.role({ name: 'Senior Agent' }, ctx);
  assert.equal(payload.mappedTo, 'Agent');
  assert.equal(manual, true);
  assert.equal(ctx.conflicts.length, 1);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('role: unknown role name falls back to Agent', () => {
  const ctx = stubCtx();
  const { payload } = transformers.role({ name: 'Some Custom Role' }, ctx);
  assert.equal(payload.mappedTo, 'Agent');
});

test('agent: resolves group ids through ctx.resolve', () => {
  const ctx = stubCtx({ 'groups:10': 501 });
  const { payload } = transformers.agent({ name: 'A', email: 'a@x.com', group_ids: [10] }, ctx);
  assert.deepEqual(payload.group_ids, [501]);
  assert.equal(payload.ticket_scope, 1);
});

test('agent: drops unresolvable group ids', () => {
  const ctx = stubCtx();
  const { payload } = transformers.agent({ name: 'A', email: 'a@x.com', group_ids: [999] }, ctx);
  assert.deepEqual(payload.group_ids, []);
});

test('ticketField: maps known types and flags regex fields as a conflict', () => {
  const ctx = stubCtx();
  const text = transformers.ticketField({ title: 'Notes', type: 'textarea' }, ctx);
  assert.equal(text.payload.type, 'custom_paragraph');
  assert.equal(ctx.conflicts.length, 0);

  const regex = transformers.ticketField({ title: 'SKU', type: 'regexp', regexp_for_validation: '^[0-9]+$' }, ctx);
  assert.equal(regex.payload.type, 'custom_text');
  assert.equal(ctx.conflicts.length, 1);
  assert.equal(ctx.conflicts[0].kind, 'unmapped_field');
});

test('ticketField: maps custom_field_options to choices', () => {
  const ctx = stubCtx();
  const { payload } = transformers.ticketField({ title: 'Tier', type: 'tagger', custom_field_options: [{ name: 'Gold' }, { name: 'Silver' }] }, ctx);
  assert.deepEqual(payload.choices, ['Gold', 'Silver']);
});

test('brand/businessHours/sla: all manual with a no_api conflict', () => {
  for (const [type, raw] of [
    ['brand', { name: 'Acme', subdomain: 'acme' }],
    ['businessHours', { name: 'Standard', time_zone: 'UTC', intervals: {} }],
    ['sla', { title: 'Gold SLA', policy_metrics: {} }],
  ]) {
    const ctx = stubCtx();
    const { manual } = transformers[type](raw, ctx);
    assert.equal(manual, true, `${type} should be manual`);
    assert.equal(ctx.conflicts[0].kind, 'no_api');
  }
});

test('trigger: classifies a new-ticket condition as ticket_creation and is manual', () => {
  const ctx = stubCtx();
  const raw = { title: 'Notify on new', conditions: { all: [{ field: 'status', operator: 'is', value: 'new' }] }, actions: [{ field: 'notification_user', value: 'requester' }] };
  const { payload, manual } = transformers.trigger(raw, ctx);
  assert.equal(payload.ir.event, 'ticket_creation');
  assert.equal(manual, true);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('automation: classifies an hourly condition and resolves group refs in actions', () => {
  const ctx = stubCtx({ 'groups:10': 501 });
  const raw = { title: 'Escalate stale tickets', conditions: { all: [{ field: 'hours', operator: 'greater_than', value: '24' }] }, actions: [{ field: 'group_id', value: 10 }] };
  const { payload } = transformers.automation(raw, ctx);
  assert.equal(payload.ir.event, 'hourly');
  assert.equal(payload.ir.actions[0].field, 'group');
  assert.equal(payload.ir.actions[0].value, 501);
});

test('macro: reply-only action becomes a canned response with no conflict', () => {
  const ctx = stubCtx();
  const raw = { title: 'Thanks', actions: [{ field: 'comment_value', value: 'Thanks for reaching out!' }] };
  const { payload } = transformers.macro(raw, ctx);
  assert.equal(payload.title, 'Thanks');
  assert.equal(payload.content, 'Thanks for reaching out!');
  assert.equal(ctx.conflicts.length, 0);
});

test('macro: field actions beyond the reply flag a conflict', () => {
  const ctx = stubCtx();
  const raw = { title: 'Close it', actions: [{ field: 'comment_value', value: 'Closing.' }, { field: 'status', value: 'solved' }] };
  transformers.macro(raw, ctx);
  assert.equal(ctx.conflicts.length, 1);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('organization: maps name and domains', () => {
  const { payload } = transformers.organization({ name: 'Acme', domain_names: ['acme.com'] });
  assert.deepEqual(payload, { name: 'Acme', domains: ['acme.com'] });
});

test('user: resolves organization_id to a company_id', () => {
  const ctx = stubCtx({ 'organizations:3001': 503 });
  const { payload } = transformers.user({ name: 'User A', email: 'a@x.com', organization_id: 3001 }, ctx);
  assert.equal(payload.company_id, 503);
});

test('kbCategory/kbSection: map names and resolve category ref', () => {
  assert.deepEqual(transformers.kbCategory({ name: 'Docs' }).payload, { name: 'Docs', description: '' });
  const ctx = stubCtx({ 'kbCategories:1': 901 });
  const { ctxOut } = transformers.kbSection({ name: 'Getting Started', category_id: 1 }, ctx);
  assert.equal(ctxOut.categoryId, 901);
});

test('kbArticle: rehosts inline Zendesk image URLs and flags a conflict', () => {
  const ctx = stubCtx({ 'kbSections:1': 902 });
  const { payload, ctxOut } = transformers.kbArticle({ title: 'How to', body: '<img src="https://acme.zendesk.com/img.png">', section_id: 1 }, ctx);
  assert.ok(payload.description.includes('{{TARGET_REHOSTED_IMAGE}}'));
  assert.equal(ctxOut.folderId, 902);
  assert.equal(ctx.conflicts[0].kind, 'unmapped_field');
});

test('ticket: maps core fields, resolves refs, and carries child replies with attachments', () => {
  const ctx = stubCtx({
    'groups:1001': 501, 'agents:2002': 502, 'users:2001': 504, 'organizations:3001': 503,
  });
  const raw = {
    id: 5001, subject: 'Help', description: 'Please help', status: 'open', priority: 'normal',
    via: { channel: 'web' }, group_id: 1001, assignee_id: 2002, requester_id: 2001, organization_id: 3001,
    tags: ['vip'], custom_fields: [{ id: 42, value: 'x' }], created_at: '2026-01-01', updated_at: '2026-01-02',
    comments: [
      {
        id: 9001, public: true, body: 'Reply body', author_id: 2001,
        attachments: [{ content_url: 'https://z.example/a.png', file_name: 'a.png', content_type: 'image/png', size: 500 }],
      },
      { id: 9002, public: false, body: 'Private note', author_id: 2002, attachments: [] },
    ],
  };
  const { payload, children } = transformers.ticket(raw, ctx);

  assert.equal(payload.subject, 'Help');
  assert.equal(payload.group_id, 501);
  assert.equal(payload.responder_id, 502);
  assert.equal(payload.requester_id, 504);
  assert.equal(payload.company_id, 503);
  assert.equal(payload.custom_fields.cf_42, 'x');

  assert.equal(children.length, 2);
  assert.equal(children[0].targetType, 'ticketReply');
  assert.equal(children[0].attachments.length, 1);
  assert.deepEqual(children[0].attachments[0], { url: 'https://z.example/a.png', filename: 'a.png', contentType: 'image/png', size: 500 });
  assert.equal(children[1].targetType, 'ticketNote');
  assert.equal(children[1].attachments.length, 0);
});
