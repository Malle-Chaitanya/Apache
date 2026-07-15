// test/sla.test.js — unit tests for the Zendesk→Freshdesk SLA transformer.
// Run: node test/sla.test.js   (plain Node + assert, no framework needed)
import assert from 'node:assert';
import { transformSla } from '../src/mapping/transformers/sla.js';

let pass = 0, fail = 0;
function test(name, fn) {
  // ctx stub: records conflicts; resolve() maps group/org ids like the idmap would.
  const conflicts = [];
  const ctx = {
    addConflict: (kind, detail, suggestion) => conflicts.push({ kind, detail, suggestion }),
    resolve: (type, id) => ({ 'groups:100': 500, 'organizations:200': 900 }[`${type}:${id}`] ?? null),
  };
  try { fn(ctx, conflicts); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const hasConflict = (cs, re) => cs.some((c) => re.test(c.detail));

// A realistic Zendesk SLA (targets in minutes; Zendesk also sends target_in_seconds).
const base = () => ({
  title: 'Premium', description: 'd', position: 2,
  filter: { all: [{ field: 'ticket_type_id', operator: 'is', value: '2' }], any: [] },
  policy_metrics: [
    { priority: 'urgent', metric: 'first_reply_time', target: 15, target_in_seconds: 900, business_hours: false },
    { priority: 'urgent', metric: 'agent_work_time', target: 120, target_in_seconds: 7200, business_hours: false },
    { priority: 'high', metric: 'first_reply_time', target: 30, target_in_seconds: 1800, business_hours: false },
    { priority: 'normal', metric: 'first_reply_time', target: 60, target_in_seconds: 3600, business_hours: false },
  ],
});

console.log('SLA transformer tests:');

test('faithful create: type→ticket_types, minutes→seconds, all 4 priorities', (ctx) => {
  const { payload, manual } = transformSla(base(), ctx);
  assert.ok(!manual, 'should not be manual');
  assert.deepStrictEqual(payload.applicable_to, { ticket_types: ['Incident'] });
  assert.strictEqual(payload.sla_target.priority_4.respond_within, 900);
  assert.strictEqual(payload.sla_target.priority_4.resolve_within, 7200);
  assert.strictEqual(payload.sla_target.priority_3.respond_within, 1800);
  assert.strictEqual(payload.sla_target.priority_2.respond_within, 3600);
  assert.strictEqual(Object.keys(payload.sla_target).length, 4, 'all 4 priorities present');
  for (const p of Object.values(payload.sla_target)) {
    for (const f of ['respond_within', 'resolve_within', 'business_hours', 'escalation_enabled']) assert.ok(f in p, `mandatory ${f}`);
  }
});

test('prefers target_in_seconds; falls back to minutes×60 when absent', (ctx) => {
  const z = base();
  z.policy_metrics = [{ priority: 'urgent', metric: 'first_reply_time', target: 10 }]; // no target_in_seconds
  z.filter = { all: [{ field: 'group_id', value: 100 }] };
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.respond_within, 600); // 10min ×60
});

test('defaulted targets are REPORTED (audit), not silent', (ctx, cs) => {
  transformSla(base(), ctx); // High/Normal/Low have no resolution; Low no metrics at all
  assert.ok(hasConflict(cs, /auto-completed/i), 'must report auto-completed targets');
  assert.ok(hasConflict(cs, /Low resolution/i) || hasConflict(cs, /Low first-response/i), 'must name Low defaults');
});

test('resolution derived ×8 when only first-response is set', (ctx) => {
  const { payload } = transformSla(base(), ctx);
  // High first-response 1800 → resolve 1800×8 = 14400
  assert.strictEqual(payload.sla_target.priority_3.resolve_within, 14400);
});

test('unmappable condition (priority) → MANUAL, not broad-applied', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'priority', operator: 'is', value: 'urgent' }], any: [] };
  const { manual, payload } = transformSla(z, ctx);
  assert.ok(manual, 'should be manual');
  assert.ok(!payload.applicable_to, 'must NOT emit a (broadened) scope');
  assert.ok(hasConflict(cs, /can't target: priority/i), 'must flag the unmappable field');
});

test('applies-to-all (no conditions) → MANUAL', (ctx, cs) => {
  const z = base(); z.filter = { all: [], any: [] };
  const { manual } = transformSla(z, ctx);
  assert.ok(manual, 'scopeless policy cannot be a Freshdesk custom SLA');
  assert.ok(hasConflict(cs, /applies to ALL/i));
});

test('mixed ANY/ALL (OR) → MANUAL', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'ticket_type_id', value: '2' }], any: [{ field: 'group_id', value: 100 }] };
  const { manual } = transformSla(z, ctx);
  assert.ok(manual, 'OR-logic not expressible');
  assert.ok(hasConflict(cs, /OR/i));
});

test('group condition resolves via idmap → group_ids', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] };
  const { payload, manual } = transformSla(z, ctx);
  assert.ok(!manual);
  assert.deepStrictEqual(payload.applicable_to, { group_ids: [500] });
});

test('unmigrated group → MANUAL (not silently dropped/broadened)', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 999 }], any: [] }; // not in idmap
  const { manual } = transformSla(z, ctx);
  assert.ok(manual);
  assert.ok(hasConflict(cs, /group \(not migrated\)/i));
});

test('business hours flagged', (ctx, cs) => {
  const z = base();
  z.policy_metrics = z.policy_metrics.map((m) => ({ ...m, business_hours: true }));
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.business_hours, true);
  assert.ok(hasConflict(cs, /BUSINESS HOURS/i));
});

test('next_respond_within: included when ≥30s, omitted otherwise', (ctx) => {
  const z = base();
  z.policy_metrics.push({ priority: 'urgent', metric: 'next_reply_time', target: 30, target_in_seconds: 1800 });
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.next_respond_within, 1800);
  assert.ok(!('next_respond_within' in payload.sla_target.priority_3), 'omit when not set');
});

test('Total resolution time metric maps to resolve_within', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] };
  z.policy_metrics = [{ priority: 'urgent', metric: 'total_resolution_time', target: 240, target_in_seconds: 14400 }];
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.resolve_within, 14400);
});

test('long durations convert to seconds (72h agent work → 259200s)', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] };
  z.policy_metrics = [{ priority: 'urgent', metric: 'first_reply_time', target: 60 }, { priority: 'urgent', metric: 'agent_work_time', target: 4320 }]; // 72h
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.resolve_within, 259200);
});

test('tiny durations convert (1 min → 60s)', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] };
  z.policy_metrics = [{ priority: 'urgent', metric: 'first_reply_time', target: 1 }];
  const { payload } = transformSla(z, ctx);
  assert.strictEqual(payload.sla_target.priority_4.respond_within, 60);
});

test('AND of two mappable conditions (type + group) → both scope keys', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'ticket_type_id', value: '2' }, { field: 'group_id', value: 100 }], any: [] };
  const { payload, manual } = transformSla(z, ctx);
  assert.ok(!manual);
  assert.deepStrictEqual(payload.applicable_to.ticket_types, ['Incident']);
  assert.deepStrictEqual(payload.applicable_to.group_ids, [500]);
});

test('multiple ticket types → ticket_types array', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'ticket_type_id', value: '2' }, { field: 'ticket_type_id', value: '3' }], any: [] };
  const { payload } = transformSla(z, ctx);
  assert.deepStrictEqual(payload.applicable_to.ticket_types, ['Incident', 'Problem']);
});

test('tag condition → MANUAL (unmappable), name/targets kept for checklist', (ctx, cs) => {
  const z = base();
  z.title = 'VIP';
  z.filter = { all: [{ field: 'tags', operator: 'includes', value: 'vip' }], any: [] };
  const { manual, payload } = transformSla(z, ctx);
  assert.ok(manual);
  assert.ok(hasConflict(cs, /can't target: tags/i));
  assert.strictEqual(payload.name, 'VIP');
  assert.ok(payload.sla_target.priority_4, 'targets preserved for the checklist');
});

test('sub-30s target is raised to Freshdesk floor (30s) and reported', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] };
  z.policy_metrics = [{ priority: 'urgent', metric: 'first_reply_time', target_in_seconds: 0 }]; // 0 would 400 the whole policy
  const { payload, manual } = transformSla(z, ctx);
  assert.ok(!manual);
  assert.strictEqual(payload.sla_target.priority_4.respond_within, 30, '0 → clamped to FD minimum 30s');
  assert.ok(hasConflict(cs, /raised to 30s/i), 'the clamp is reported, not silent');
});

test('operator is_not on ticket_type → MANUAL, not inverted to the excluded type', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'ticket_type_id', operator: 'is_not', value: '2' }], any: [] };
  const { manual, payload } = transformSla(z, ctx);
  assert.ok(manual, 'a negated scope must NOT be auto-created');
  assert.ok(!payload.applicable_to, 'must not emit the inverted (Incident) scope');
  assert.ok(hasConflict(cs, /can't target: ticket_type_id is_not/i), 'flags the negated operator');
});

test('operator is_not on group → MANUAL (would otherwise scope to the excluded group)', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', operator: 'is_not', value: 100 }], any: [] };
  const { manual } = transformSla(z, ctx);
  assert.ok(manual, 'negated group scope is unmappable');
  assert.ok(hasConflict(cs, /group_id is_not/i));
});

test('comparison operator (less_than) → MANUAL', (ctx, cs) => {
  const z = base();
  z.filter = { all: [{ field: 'ticket_type_id', operator: 'less_than', value: '2' }], any: [] };
  const { manual } = transformSla(z, ctx);
  assert.ok(manual);
  assert.ok(hasConflict(cs, /less_than/i));
});

test('missing operator is treated as equality (maps, preserves prior behavior)', (ctx) => {
  const z = base();
  z.filter = { all: [{ field: 'group_id', value: 100 }], any: [] }; // no operator
  const { manual, payload } = transformSla(z, ctx);
  assert.ok(!manual);
  assert.deepStrictEqual(payload.applicable_to, { group_ids: [500] });
});

test('unicode / long / special-char names pass through unchanged', (ctx) => {
  for (const name of ['日本 Support', 'SLA #1 & Premium (Gold)/IT', 'Enterprise Global Premium Platinum 24x7 Critical Incident Resolution Policy for International Customers']) {
    const z = base(); z.title = name;
    const { payload } = transformSla(z, ctx);
    assert.strictEqual(payload.name, name);
  }
});

test('active flag set (Zendesk SLAs are active)', (ctx) => {
  const { payload } = transformSla(base(), ctx);
  assert.strictEqual(payload.active, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
