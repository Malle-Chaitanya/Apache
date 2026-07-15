import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformers } from '../src/mapping/transformers/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transformer contract: (raw, ctx) => { payload, targetType?, children?, manual?,
// notes?, ctxOut? }. These assert the ACTUAL shipped shapes (verified against
// src/mapping/transformers/index.js), not the doc.
// ─────────────────────────────────────────────────────────────────────────────

// Full-featured stub ctx: mirrors loader.buildCtx (resolve / addConflict /
// mapValue / forensic) so transformers behave exactly as they do in the engine.
function stubCtx(resolveMap = {}, opts = {}) {
  const conflicts = [];
  const ctx = {
    conflicts,
    forensic: !!opts.forensic,
    resolve: (type, sourceId) => (sourceId == null ? null : resolveMap[`${type}:${sourceId}`] ?? null),
    addConflict: (kind, detail, suggestion) => conflicts.push({ kind, detail, suggestion }),
  };
  if (opts.valueMaps) {
    ctx.mapValue = (name, sourceValue, fallback) => {
      const m = opts.valueMaps[name];
      if (!m) return fallback;
      const key = sourceValue == null ? '__default' : sourceValue;
      const v = m[key];
      if (v !== undefined) return v;
      return m.__default ?? fallback;
    };
  }
  return ctx;
}

// ── group ───────────────────────────────────────────────────────────────────

test('group: maps name; description defaults to empty string', () => {
  assert.deepEqual(transformers.group({ name: 'Support' }).payload, { name: 'Support', description: '' });
  assert.deepEqual(transformers.group({ name: 'Support', description: 'd' }).payload, { name: 'Support', description: 'd' });
});

// ── role ──────────────────────────────────────────────────────────────────────

test('role: maps to nearest FD default role and flags a no_api conflict + manual', () => {
  const ctx = stubCtx();
  const { payload, manual } = transformers.role({ name: 'Team Lead' }, ctx);
  assert.equal(payload.mappedTo, 'Supervisor');
  assert.equal(manual, true);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('role: unknown role name falls back to Agent', () => {
  assert.equal(transformers.role({ name: 'Grand Wizard' }, stubCtx()).payload.mappedTo, 'Agent');
});

// ── agent ─────────────────────────────────────────────────────────────────────

test('agent: resolves group ids, sets ticket_scope, emits role via ctxOut', () => {
  const ctx = stubCtx({ 'groups:10': 501, 'groups:11': 502 });
  const { payload, ctxOut } = transformers.agent({ name: 'A', email: 'a@x.com', group_ids: [10, 11], role_type: 4 }, ctx);
  assert.deepEqual(payload.group_ids, [501, 502]);
  assert.equal(payload.name, 'A');
  assert.equal(payload.email, 'a@x.com');
  assert.equal(payload.ticket_scope, 1); // Administrator → global
  assert.equal(ctxOut.role, 'Administrator');
});

test('agent: drops unresolvable group ids instead of sending stale source ids', () => {
  const { payload } = transformers.agent({ name: 'A', email: 'a@x.com', group_ids: [999] }, stubCtx());
  assert.deepEqual(payload.group_ids, []);
  assert.equal(payload.ticket_scope, 2); // plain Agent → group scope
});

test('agent: billing admin surfaces a review conflict', () => {
  const ctx = stubCtx();
  transformers.agent({ name: 'Biller', email: 'b@x.com', role_type: 5 }, ctx);
  assert.equal(ctx.conflicts.length, 1);
  assert.equal(ctx.conflicts[0].kind, 'unmapped_field');
  assert.match(ctx.conflicts[0].detail, /Billing admin/i);
});

test('agent: no group_ids array does not throw', () => {
  const { payload } = transformers.agent({ name: 'A', email: 'a@x.com' }, stubCtx());
  assert.deepEqual(payload.group_ids, []);
});

// ── ticketField ────────────────────────────────────────────────────────────────

test('ticketField: custom types map through FIELD_TYPE with FD-required flags', () => {
  const ctx = stubCtx();
  const { payload } = transformers.ticketField({ title: 'Notes', type: 'textarea', required: true }, ctx);
  assert.equal(payload.type, 'custom_paragraph');
  assert.equal(payload.label, 'Notes');
  assert.equal(payload.label_for_customers, 'Notes');
  assert.equal(payload.customers_can_edit, false);
  assert.equal(payload.required_for_closure, true);
  assert.equal(ctx.conflicts.length, 0);
});

test('ticketField: dropdown choices become {value, position} objects, 1-based, ordered', () => {
  const { payload } = transformers.ticketField(
    { title: 'Tier', type: 'tagger', custom_field_options: [{ name: 'Gold' }, { name: 'Silver' }, { name: 'Bronze' }] },
    stubCtx(),
  );
  assert.deepEqual(payload.choices, [
    { value: 'Gold', position: 1 },
    { value: 'Silver', position: 2 },
    { value: 'Bronze', position: 3 },
  ]);
});

test('ticketField: regex field degrades to text and flags an unmapped_field conflict', () => {
  const ctx = stubCtx();
  const { payload } = transformers.ticketField({ title: 'SKU', type: 'regexp', regexp_for_validation: '^[0-9]+$' }, ctx);
  assert.equal(payload.type, 'custom_text');
  assert.equal(ctx.conflicts[0].kind, 'unmapped_field');
});

test('ticketField: a Zendesk system field is skipped (manual) and not recreated', () => {
  const ctx = stubCtx();
  const { manual, payload } = transformers.ticketField({ title: 'Status', type: 'status' }, ctx);
  assert.equal(manual, true);
  assert.equal(payload.systemField, 'status');
  assert.equal(ctx.conflicts[0].kind, 'skipped');
});

// ── best-effort config: brand / businessHours / sla ─────────────────────────────
// NOTE: these are NOT `manual` in the shipped code — the loader attempts the API
// and only downgrades to a checklist if the plan rejects it (bestEffort path).

test('brand: builds a product payload, no forced-manual flag', () => {
  const { payload, manual } = transformers.brand({ name: 'Acme', subdomain: 'acme' });
  assert.equal(payload.name, 'Acme');
  assert.match(payload.description, /acme/i);
  assert.notEqual(manual, true);
});

test('businessHours: carries name/time_zone/intervals through, not forced-manual', () => {
  const { payload, manual } = transformers.businessHours({ name: 'Std', time_zone: 'UTC', intervals: { mon: [] } });
  assert.deepEqual(payload, { name: 'Std', time_zone: 'UTC', business_hours: { mon: [] } });
  assert.notEqual(manual, true);
});

test('sla: maps title→name, metrics→sla_target(seconds), scopes by ticket type', () => {
  const { payload, manual } = transformers.sla({
    title: 'Gold',
    filter: { all: [{ field: 'ticket_type_id', operator: 'is', value: '2' }], any: [] },
    policy_metrics: [{ priority: 'urgent', metric: 'first_reply_time', target_in_seconds: 900 }],
  }, stubCtx());
  assert.notEqual(manual, true);
  assert.equal(payload.name, 'Gold');
  assert.equal(payload.sla_target.priority_4.respond_within, 900);
  assert.deepEqual(payload.applicable_to, { ticket_types: ['Incident'] });
});

test('sla: a malformed (non-array) policy_metrics degrades gracefully, does not throw', () => {
  const { payload } = transformers.sla({
    title: 'Weird', filter: { all: [{ field: 'group_id', operator: 'is', value: 10 }], any: [] },
    policy_metrics: { p1: 60 }, // not an array — must not crash
  }, stubCtx({ 'groups:10': 501 }));
  assert.equal(payload.name, 'Weird');
  assert.equal(Object.keys(payload.sla_target).length, 4, 'all 4 priorities defaulted');
});

// ── triggers / automations (rule IR translation) ────────────────────────────────

test('trigger: a new-ticket condition classifies as ticket_creation, manual + no_api', () => {
  const ctx = stubCtx();
  const raw = { title: 'Notify on new', conditions: { all: [{ field: 'status', operator: 'is', value: 'new' }] }, actions: [{ field: 'notification_user', value: 'requester' }] };
  const { payload, manual } = transformers.trigger(raw, ctx);
  assert.equal(payload.ir.event, 'ticket_creation');
  assert.equal(payload.ir.name, 'Notify on new');
  assert.equal(manual, true);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('automation: hourly condition classifies as hourly and remaps group refs in actions', () => {
  const ctx = stubCtx({ 'groups:10': 501 });
  const raw = { title: 'Escalate stale', conditions: { all: [{ field: 'hours', operator: 'greater_than', value: '24' }] }, actions: [{ field: 'group_id', value: 10 }] };
  const { payload } = transformers.automation(raw, ctx);
  assert.equal(payload.ir.event, 'hourly');
  assert.equal(payload.ir.actions[0].field, 'group'); // group_id action renamed to group
  assert.equal(payload.ir.actions[0].value, 501);     // and the id remapped
});

test('trigger: a plain update condition classifies as ticket_update', () => {
  const ctx = stubCtx();
  const raw = { title: 'On tag', conditions: { all: [{ field: 'tags', operator: 'includes', value: 'vip' }] }, actions: [] };
  assert.equal(transformers.trigger(raw, ctx).payload.ir.event, 'ticket_update');
});

test('trigger: custom_field_ conditions are rewritten to cf_ names', () => {
  const ctx = stubCtx();
  const raw = { title: 'CF rule', conditions: { all: [{ field: 'custom_field_123', operator: 'is', value: 'x' }] }, actions: [] };
  assert.equal(transformers.trigger(raw, ctx).payload.ir.conditions[0].field, 'cf_123');
});

// ── macro ───────────────────────────────────────────────────────────────────────

test('macro: reply-only becomes a canned response with no conflict', () => {
  const ctx = stubCtx();
  const { payload } = transformers.macro({ title: 'Thanks', actions: [{ field: 'comment_value', value: 'Thanks!' }] }, ctx);
  assert.equal(payload.title, 'Thanks');
  assert.equal(payload.content, 'Thanks!');
  assert.equal(payload.content_html, '<p>Thanks!</p>');
  assert.equal(ctx.conflicts.length, 0);
});

test('macro: field-changing actions beyond the reply flag a no_api conflict', () => {
  const ctx = stubCtx();
  transformers.macro({ title: 'Close', actions: [{ field: 'comment_value', value: 'Closing.' }, { field: 'status', value: 'solved' }] }, ctx);
  assert.equal(ctx.conflicts[0].kind, 'no_api');
});

test('macro: no reply action yields empty content, still valid', () => {
  const { payload } = transformers.macro({ title: 'Set prio', actions: [{ field: 'priority', value: 'high' }] }, stubCtx());
  assert.equal(payload.content, '');
  assert.equal(payload.content_html, '');
});

// ── organization / user ──────────────────────────────────────────────────────────

test('organization: maps name and domain_names → domains', () => {
  assert.deepEqual(transformers.organization({ name: 'Acme', domain_names: ['acme.com', 'acme.io'] }).payload,
    { name: 'Acme', domains: ['acme.com', 'acme.io'] });
});

test('organization: missing domain_names defaults to empty array', () => {
  assert.deepEqual(transformers.organization({ name: 'Acme' }).payload, { name: 'Acme', domains: [] });
});

test('user: resolves organization_id → company_id', () => {
  const ctx = stubCtx({ 'organizations:3001': 503 });
  const { payload } = transformers.user({ name: 'U', email: 'u@x.com', organization_id: 3001 }, ctx);
  assert.equal(payload.company_id, 503);
});

test('user: an unresolvable/absent org yields a null company_id, not a crash', () => {
  assert.equal(transformers.user({ name: 'U', email: 'u@x.com' }, stubCtx()).payload.company_id, null);
});

// ── knowledge base ─────────────────────────────────────────────────────────────

test('kbCategory: maps name, empty description default', () => {
  assert.deepEqual(transformers.kbCategory({ name: 'Docs' }).payload, { name: 'Docs', description: '' });
});

test('kbSection: sets visibility and resolves its category', () => {
  const ctx = stubCtx({ 'kbCategories:1': 901 });
  const { payload, ctxOut } = transformers.kbSection({ name: 'Start', category_id: 1 }, ctx);
  assert.equal(payload.visibility, 1);
  assert.equal(ctxOut.categoryId, 901);
});

test('kbArticle: draft/published state and folder resolution', () => {
  const ctx = stubCtx({ 'kbSections:1': 902 });
  const draft = transformers.kbArticle({ title: 'A', body: '<p>hi</p>', section_id: 1, draft: true }, ctx);
  assert.equal(draft.payload.status, 1);          // draft
  assert.equal(draft.ctxOut.folderId, 902);
  const pub = transformers.kbArticle({ title: 'A', body: '<p>hi</p>', section_id: 1, draft: false }, ctx);
  assert.equal(pub.payload.status, 2);            // published
});

test('kbArticle: empty title/body get safe non-empty defaults (FD rejects empties)', () => {
  const { payload } = transformers.kbArticle({ section_id: 1 }, stubCtx());
  assert.equal(payload.title, '(untitled)');
  assert.equal(payload.description, '<p></p>');
});

test('kbArticle: a Zendesk inline image becomes a marker and flags a conflict', () => {
  const ctx = stubCtx({ 'kbSections:1': 902 });
  const { payload } = transformers.kbArticle({ title: 'How', body: '<img src="https://acme.zendesk.com/img.png">', section_id: 1 }, ctx);
  assert.match(payload.description, /\[inline image/);
  assert.doesNotMatch(payload.description, /<img/);
  assert.equal(ctx.conflicts[0].kind, 'unmapped_field');
});

test('kbArticle: an external (non-Zendesk) image is left intact', () => {
  const { payload } = transformers.kbArticle({ title: 'How', body: '<img src="https://cdn.example.com/x.png">', section_id: 1 }, stubCtx());
  assert.match(payload.description, /<img/);
});

// ── ticket (the heaviest object) ────────────────────────────────────────────────

function fullTicketCtx(extra = {}) {
  return stubCtx({
    'groups:1001': 501, 'agents:2002': 502, 'users:2001': 504, 'organizations:3001': 503,
    'ticketFieldName:42': 'cf_priority_score', 'ticketFieldType:42': 'integer',
    ...(extra.resolveMap || {}),
  }, extra.opts || {});
}

test('ticket: maps core fields and resolves all foreign keys', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'Help', description: 'Please help', status: 'open', priority: 'high',
    via: { channel: 'email' }, type: 'incident', group_id: 1001, assignee_id: 2002,
    requester_id: 2001, organization_id: 3001, tags: ['vip'],
    custom_fields: [{ id: 42, value: '7' }], created_at: '2026-01-01', updated_at: '2026-01-02',
    comments: [{ id: 9001, public: true, body: 'first', author_id: 2001 }],
  };
  const { payload, ctxOut } = transformers.ticket(raw, ctx);
  assert.equal(payload.subject, 'Help');
  assert.equal(payload.status, 2);
  assert.equal(payload.priority, 3);
  assert.equal(payload.source, 1);       // email
  assert.equal(payload.type, 'Incident');
  assert.equal(payload.group_id, 501);
  assert.equal(payload.responder_id, 502);
  assert.equal(payload.requester_id, 504);
  assert.equal(payload.company_id, 503);
  assert.deepEqual(payload.tags, ['vip']);
  assert.equal(payload.custom_fields.cf_priority_score, 7); // coerced string→int
  assert.equal(ctxOut.migrationMeta.originalId, '5001');
  assert.equal(ctxOut.migrationMeta.sourcePlatform, 'Zendesk');
});

test('ticket: the first comment IS the description and is not duplicated as a reply', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' },
    requester_id: 2001,
    comments: [
      { id: 1, public: true, html_body: '<p>Opening message</p>', author_id: 2001 },
      { id: 2, public: true, body: 'A real reply', author_id: 2001 },
    ],
  };
  const { payload, children } = transformers.ticket(raw, ctx);
  assert.match(payload.description, /Opening message/); // first comment → description
  assert.equal(children.length, 1);                      // only the 2nd comment becomes a reply
  assert.equal(children[0].sourceId, '2');
});

test('ticket: the first comment IS kept as a reply when it carries attachments', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    comments: [{ id: 1, public: true, body: 'with file', author_id: 2001, attachments: [{ content_url: 'u', file_name: 'f.png', content_type: 'image/png', size: 10 }] }],
  };
  const { children } = transformers.ticket(raw, ctx);
  assert.equal(children.length, 1); // kept to avoid dropping the attachment
  assert.equal(children[0].attachments[0].filename, 'f.png');
});

test('ticket: public comments → ticketReply (no private), private → ticketNote (private:true)', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    comments: [
      { id: 1, public: true, body: 'desc', author_id: 2001 },
      { id: 2, public: true, body: 'public reply', author_id: 2001 },
      { id: 3, public: false, body: 'internal note', author_id: 2002 },
    ],
  };
  const { children } = transformers.ticket(raw, ctx);
  const reply = children.find((c) => c.sourceId === '2');
  const note = children.find((c) => c.sourceId === '3');
  assert.equal(reply.targetType, 'ticketReply');
  assert.equal(reply.payload.private, undefined);       // FD /reply rejects private
  assert.equal(note.targetType, 'ticketNote');
  assert.equal(note.payload.private, true);
});

test('ticket: an empty message body is backfilled so FD does not reject it', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    comments: [
      { id: 1, public: true, body: 'desc', author_id: 2001 },
      { id: 2, public: true, body: '   ', author_id: 2001 },
    ],
  };
  const { children } = transformers.ticket(raw, ctx);
  assert.match(children[0].payload.body, /no message text/);
});

test('ticket: forensic mode prefixes each message with its original send time', () => {
  const ctx = fullTicketCtx({ opts: { forensic: true } });
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    comments: [
      { id: 1, public: true, body: 'desc', author_id: 2001 },
      { id: 2, public: true, body: 'reply', author_id: 2001, created_at: '2020-05-01T10:00:00Z' },
    ],
  };
  const { children } = transformers.ticket(raw, ctx);
  assert.match(children[0].payload.body, /Originally sent 2020-05-01 10:00/);
});

test('ticket: clean (default) mode adds NO per-message time prefix', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 5001, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    comments: [
      { id: 1, public: true, body: 'desc', author_id: 2001 },
      { id: 2, public: true, body: 'reply', author_id: 2001, created_at: '2020-05-01T10:00:00Z' },
    ],
  };
  const { children } = transformers.ticket(raw, ctx);
  assert.doesNotMatch(children[0].payload.body, /Originally sent/);
});

test('ticket: collaborator emails become cc_emails', () => {
  const ctx = fullTicketCtx();
  const raw = {
    id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001,
    collaborator_emails: ['cc1@x.com', 'cc2@x.com'], comments: [],
  };
  assert.deepEqual(transformers.ticket(raw, ctx).payload.cc_emails, ['cc1@x.com', 'cc2@x.com']);
});

test('ticket: a requester not among migrated contacts raises a conflict', () => {
  const ctx = stubCtx({ 'groups:1001': 501 }); // requester intentionally unresolved
  const raw = { id: 1, subject: 'Orphan', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 77, comments: [] };
  transformers.ticket(raw, ctx);
  assert.ok(ctx.conflicts.some((c) => /requester/i.test(c.detail)));
});

test('ticket: an unknown "task" type folds away (undefined), never rejected', () => {
  const ctx = fullTicketCtx();
  const raw = { id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, type: 'task', requester_id: 2001, comments: [] };
  assert.equal(transformers.ticket(raw, ctx).payload.type, undefined);
});

test('ticket: an empty subject gets a safe placeholder', () => {
  const ctx = fullTicketCtx();
  const raw = { id: 1, subject: '', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [] };
  assert.equal(transformers.ticket(raw, ctx).payload.subject, '(no subject)');
});

// ── custom-field value coercion (via the ticket transformer) ────────────────────

test('ticket custom fields: integer coercion truncates and skips non-numbers', () => {
  const good = fullTicketCtx({ resolveMap: { 'ticketFieldType:42': 'integer' } });
  const t1 = transformers.ticket({ id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [], custom_fields: [{ id: 42, value: '7.9' }] }, good);
  assert.equal(t1.payload.custom_fields.cf_priority_score, 7);

  const bad = fullTicketCtx({ resolveMap: { 'ticketFieldType:42': 'integer' } });
  const t2 = transformers.ticket({ id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [], custom_fields: [{ id: 42, value: 'not-a-number' }] }, bad);
  assert.equal(t2.payload.custom_fields, undefined); // value skipped, ticket still migrates
  assert.ok(bad.conflicts.some((c) => c.kind === 'value_out_of_range'));
});

test('ticket custom fields: checkbox coercion normalizes truthy strings', () => {
  const ctx = fullTicketCtx({ resolveMap: { 'ticketFieldType:42': 'checkbox' } });
  const t = transformers.ticket({ id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [], custom_fields: [{ id: 42, value: 'true' }] }, ctx);
  assert.equal(t.payload.custom_fields.cf_priority_score, true);
});

test('ticket custom fields: an over-255-char text value is truncated with a conflict', () => {
  const ctx = fullTicketCtx({ resolveMap: { 'ticketFieldType:42': 'text' } });
  const big = 'x'.repeat(300);
  const t = transformers.ticket({ id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [], custom_fields: [{ id: 42, value: big }] }, ctx);
  assert.equal(t.payload.custom_fields.cf_priority_score.length, 255);
  assert.ok(ctx.conflicts.some((c) => c.kind === 'value_out_of_range'));
});

test('ticket custom fields: a null value is skipped, an unmapped field id is skipped', () => {
  const ctx = fullTicketCtx();
  const t = transformers.ticket({
    id: 1, subject: 'S', status: 'open', priority: 'normal', via: { channel: 'web' }, requester_id: 2001, comments: [],
    custom_fields: [{ id: 42, value: null }, { id: 999, value: 'orphan' }],
  }, ctx);
  assert.equal(t.payload.custom_fields, undefined); // nothing landed
});

// ── value-map overrides (admin-edited maps) ─────────────────────────────────────

test('ticket: an admin value-map override wins over the JS default', () => {
  const ctx = fullTicketCtx({ opts: { valueMaps: { status: { open: 3 }, priority: { high: 4 } } } });
  const raw = { id: 1, subject: 'S', status: 'open', priority: 'high', via: { channel: 'web' }, requester_id: 2001, comments: [] };
  const { payload } = transformers.ticket(raw, ctx);
  assert.equal(payload.status, 3);   // override, not the default 2
  assert.equal(payload.priority, 4); // override, not the default 3
});

test('ticket: value map "use for empty" default applies to a missing source value', () => {
  const ctx = fullTicketCtx({ opts: { valueMaps: { source: { __default: 9 } } } });
  const raw = { id: 1, subject: 'S', status: 'open', priority: 'normal', via: {}, requester_id: 2001, comments: [] };
  assert.equal(transformers.ticket(raw, ctx).payload.source, 9);
});
