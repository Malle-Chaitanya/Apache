// scripts/test-sla-e2e.js
// Live enterprise SLA validation: create varied policies in Zendesk → migrate
// through the real transformer + connector → assert Freshdesk accepts them and
// the outcome is correct → test re-run/edit (upsert, no dup) → clean up both sides.
// Run: node scripts/test-sla-e2e.js
import { initStore, repo } from '../src/db/repository.js';
import { connectionManager } from '../src/auth/connectionManager.js';
import { makeSource, makeTarget } from '../src/connectors/registry.js';
import { transformers } from '../src/mapping/transformers/index.js';

const projects = await (async () => { await initStore(); const ps = await repo('projects').find({}); ps.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); return ps; })();
const pid = projects[0]._id;
const zd = makeSource((await connectionManager.get(pid, 'source')).platform, (await connectionManager.get(pid, 'source')).connectorCreds);
const fd = makeTarget((await connectionManager.get(pid, 'target')).platform, (await connectionManager.get(pid, 'target')).connectorCreds);

// Real idmap → idCache (authentic group/org resolution, like the loader).
const idCache = new Map();
for (const m of await repo('idmap').find({ projectId: pid })) idCache.set(m.entityType + ':' + m.sourceId, m.targetId);
const resolve = (t, id) => idCache.get(t + ':' + String(id)) ?? null;
const gid = Number([...idCache.keys()].find((k) => k.startsWith('groups:'))?.split(':')[1]);
const oid = Number([...idCache.keys()].find((k) => k.startsWith('organizations:'))?.split(':')[1]);

const M = (pri, metric, min, bh = false) => ({ priority: pri, metric, target: min, business_hours: bh });
const full = (bh = false) => [M('urgent', 'first_reply_time', 15, bh), M('urgent', 'agent_work_time', 120, bh), M('high', 'first_reply_time', 30, bh), M('normal', 'first_reply_time', 60, bh), M('low', 'first_reply_time', 120, bh)];

// [name, zendesk filter, metrics, expected outcome, assert(fn on fd raw / conflicts)]
const cases = [
  ['Type=Incident (happy path)', { all: [{ field: 'ticket_type_id', value: '2' }], any: [] }, full(), 'create', (r) => r.applicable_to.ticket_types?.includes('Incident') && r.sla_target.priority_4.respond_within === 900],
  ['Group-scoped', { all: [{ field: 'group_id', value: gid }], any: [] }, full(), 'create', (r) => Array.isArray(r.applicable_to.group_ids) && r.applicable_to.group_ids.length === 1],
  ['Org-scoped', { all: [{ field: 'organization_id', value: oid }], any: [] }, full(), 'create', (r) => Array.isArray(r.applicable_to.company_ids)],
  ['Type + Group (AND)', { all: [{ field: 'ticket_type_id', value: '2' }, { field: 'group_id', value: gid }], any: [] }, full(), 'create', (r) => r.applicable_to.ticket_types && r.applicable_to.group_ids],
  ['Business hours', { all: [{ field: 'ticket_type_id', value: '2' }], any: [] }, full(true), 'create', (r, cs) => r.sla_target.priority_4.business_hours === true && cs.some((c) => /BUSINESS HOURS/i.test(c))],
  ['Long duration (72h resolve)', { all: [{ field: 'group_id', value: gid }], any: [] }, [M('urgent', 'first_reply_time', 60), M('urgent', 'agent_work_time', 4320)], 'create', (r) => r.sla_target.priority_4.resolve_within === 259200],
  ['Unicode name 日本 Support', { all: [{ field: 'ticket_type_id', value: '2' }], any: [] }, full(), 'create', (r) => /日本/.test(r.name)],
  ['Tags (unmappable)', { all: [{ field: 'tags', operator: 'includes', value: 'vip' }], any: [] }, full(), 'manual', () => true],
  ['OR-logic', { all: [{ field: 'ticket_type_id', value: '2' }], any: [{ field: 'group_id', value: gid }] }, full(), 'manual', () => true],
];

const created = { zd: [], fd: [] };
const results = [];
let idx = 0;
for (const [label, filter, metrics, expect, check] of cases) {
  idx++;
  const title = `CF E2E ${idx} — ${label}`.slice(0, 90);
  let zid = null;
  try { const { data } = await zd.http.post('/slas/policies.json', { body: { sla_policy: { title, filter, policy_metrics: metrics } } }); zid = data.sla_policy.id; created.zd.push(zid); }
  catch (e) { results.push([label, 'SKIP', `Zendesk rejected (${e.status}) — can't create at source`]); continue; }

  const raw = (await zd.list('slaPolicies')).find((p) => String(p.id) === String(zid));
  const conflicts = [];
  const { payload, manual } = transformers.sla(raw, { resolve, addConflict: (k, d) => conflicts.push(d) });

  if (expect === 'manual') { results.push([label, manual ? 'PASS' : 'FAIL', manual ? 'checklisted (not broad-applied) ✓' : 'expected manual but tried to create']); continue; }
  if (manual) { results.push([label, 'FAIL', 'expected create but was routed to manual']); continue; }
  try {
    const { id, raw: fr } = await fd.create('slaPolicies', payload, {});
    created.fd.push(id);
    const ok = check(fr, conflicts);
    results.push([label, ok ? 'PASS' : 'FAIL', ok ? `Freshdesk accepted ✓ scope=${JSON.stringify(fr.applicable_to)}` : 'accepted but values wrong']);
  } catch (e) { results.push([label, 'FAIL', `Freshdesk REJECTED ${e.status}: ${JSON.stringify(e.body).slice(0, 90)}`]); }
}

// Re-run + edit (upsert, no duplicate) on the happy-path policy.
let rerun = 'n/a';
try {
  const raw = (await zd.list('slaPolicies')).find((p) => /E2E 1 —/.test(p.title));
  if (raw) {
    const t = transformers.sla(raw, { resolve, addConflict: () => {} }).payload;
    await fd.create('slaPolicies', { ...t, sla_target: { ...t.sla_target, priority_4: { ...t.sla_target.priority_4, respond_within: 600 } } }, {}); // edit 15m→10m
    const again = await fd.create('slaPolicies', t, {});
    const all = (await fd.http.get('/sla_policies')).data.filter((p) => p.name === raw.title);
    rerun = (all.length === 1) ? `PASS (1 policy, no dup; upsert id ${again.id})` : `FAIL (${all.length} duplicates!)`;
  }
} catch (e) { rerun = 'ERROR ' + e.status; }

// Cleanup
for (const id of created.zd) try { await zd.http.request('DELETE', '/slas/policies/' + id + '.json'); } catch {}
for (const id of [...new Set(created.fd)]) try { await fd.http.put('/sla_policies/' + id, { body: { name: 'e2e-test (ignore)', active: false } }); } catch {}

console.log('\n──────── SLA ENTERPRISE E2E MATRIX ────────');
for (const [label, status, note] of results) console.log(`  ${status.padEnd(5)} ${label.padEnd(34)} ${note}`);
console.log(`  ${(rerun.startsWith('PASS') ? 'PASS' : 'FAIL').padEnd(5)} Re-run + edit (idempotent upsert)   ${rerun}`);
const failed = results.filter((r) => r[1] === 'FAIL').length + (rerun.startsWith('PASS') ? 0 : 1);
console.log(`\n${results.filter((r) => r[1] === 'PASS').length + (rerun.startsWith('PASS') ? 1 : 0)} passed, ${failed} failed, ${results.filter((r) => r[1] === 'SKIP').length} skipped`);
console.log('🧹 cleaned up', created.zd.length, 'Zendesk +', new Set(created.fd).size, 'Freshdesk test policies');
process.exit(0);
