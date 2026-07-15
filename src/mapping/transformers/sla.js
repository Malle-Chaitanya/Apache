// src/mapping/transformers/sla.js
// ─────────────────────────────────────────────────────────────
// Zendesk SLA policy → Freshdesk SLA policy.
//
// Freshdesk constraints (all verified live against the API, not assumed):
//   • sla_target MUST contain all four priorities (priority_1..4).
//   • each priority MUST have respond_within, resolve_within, business_hours,
//     escalation_enabled (all mandatory; units = SECONDS).
//   • next_respond_within, if present, must be ≥ 30s.
//   • a policy MUST have a scope (applicable_to or advanced_conditions); there is
//     no "applies to all" custom policy — that's Freshdesk's Default policy.
//   • applicable_to scope fields we can target: ticket_types, group_ids,
//     company_ids. advanced_conditions only allows group/company/source/product —
//     NOT priority/brand/tags/custom-fields.
//   • `position` is NOT settable via the API.
//
// Design decisions for a CONTRACT object (SLAs):
//   1. Targets can't be omitted (API mandates them) → unset ones are defaulted
//      and EVERY default is reported (audit), never silently fabricated.
//   2. Scope is only produced when it can be reproduced FAITHFULLY. If any Zendesk
//      condition can't be mapped (would broaden the policy), or the policy uses
//      OR-logic we can't express, or it applies to all tickets — the policy is
//      marked MANUAL (checklist with its exact targets + intended conditions),
//      NOT auto-created with a wrong/broader scope.
//   3. Business hours are flagged (the calendar itself can't be migrated).
// ─────────────────────────────────────────────────────────────

const asId = (v) => (v == null ? null : Number(v));

const PRI = { low: 'priority_1', normal: 'priority_2', high: 'priority_3', urgent: 'priority_4' };
const LABEL = { priority_1: 'Low', priority_2: 'Normal', priority_3: 'High', priority_4: 'Urgent' };
const TYPE = { question: 'Question', incident: 'Incident', problem: 'Problem', task: 'Question' };
const TYPE_ID = { 1: 'Question', 2: 'Incident', 3: 'Problem', 4: 'Question' };

// Fallbacks when Freshdesk-mandatory targets aren't set in Zendesk. Kept moderate
// and ALWAYS reported so an admin can correct them (never silent).
const RESPOND_DEFAULT = 3600;   // 1h
const RESOLVE_DEFAULT = 86400;  // 24h

const toSec = (min) => Math.max(0, Math.round((Number(min) || 0) * 60)); // Zendesk targets are MINUTES

function describeConds(conds) {
  return conds.map((c) => `${c.field} ${c.operator || 'is'} ${c.value}`).join(' AND ');
}

export function transformSla(r, ctx) {
  const addConflict = ctx?.addConflict ? ctx.addConflict.bind(ctx) : () => {};
  const resolve = ctx?.resolve ? ctx.resolve.bind(ctx) : () => null;

  // ── Targets ──────────────────────────────────────────────────────────────
  // Group Zendesk metrics by priority; prefer target_in_seconds (exact).
  const byPri = {};
  for (const m of (r.policy_metrics || [])) {
    const key = PRI[m.priority];
    if (!key) continue;
    const sec = m.target_in_seconds != null ? Number(m.target_in_seconds) : toSec(m.target);
    (byPri[key] ||= {})[m.metric] = { sec, business_hours: !!m.business_hours };
  }

  const defaults = [];          // audit trail of every target we had to fill
  let usesBusinessHours = false;

  const row = (key) => {
    const metrics = byPri[key] || {};
    const s = (n) => metrics[n]?.sec;
    const respond = s('first_reply_time');
    const nextRespond = s('next_reply_time') ?? s('periodic_update_time');
    // Zendesk resolution is Agent work time / Requester wait time / Total resolution
    // time (name varies by plan) — take whichever is present.
    const resolve = s('agent_work_time') ?? s('requester_wait_time') ?? s('resolution_time') ?? s('total_resolution_time');
    const bh = Object.values(metrics).some((v) => v.business_hours);
    if (bh) usesBusinessHours = true;

    const out = { respond_within: respond, resolve_within: resolve, business_hours: bh, escalation_enabled: false };
    if (out.respond_within == null) {
      out.respond_within = RESPOND_DEFAULT;
      defaults.push(`${LABEL[key]} first-response → ${RESPOND_DEFAULT / 3600}h (not set in Zendesk)`);
    }
    if (out.resolve_within == null) {
      out.resolve_within = respond != null ? respond * 8 : RESOLVE_DEFAULT;
      defaults.push(`${LABEL[key]} resolution → ${(out.resolve_within / 3600).toFixed(1)}h (${respond != null ? 'derived from first-response ×8' : 'default'}; Zendesk had none)`);
    }
    if (nextRespond != null && nextRespond >= 30) out.next_respond_within = nextRespond;
    return out;
  };

  const sla_target = {};
  for (const key of ['priority_1', 'priority_2', 'priority_3', 'priority_4']) sla_target[key] = row(key);
  const targetsSummary = ['priority_4', 'priority_3', 'priority_2', 'priority_1']
    .map((k) => `${LABEL[k]} ${Math.round(sla_target[k].respond_within / 60)}m/${Math.round(sla_target[k].resolve_within / 3600)}h`).join(', ');

  // ── Scope: faithful-or-manual ──────────────────────────────────────────────
  const allConds = [...(r.filter?.all || []), ...(r.filter?.any || [])];
  const usesOr = (r.filter?.any || []).length > 0 && (r.filter?.all || []).length > 0; // mixed AND+OR
  const applicable_to = {};
  const unmapped = [];
  const push = (k, v) => (applicable_to[k] ||= []).push(v);

  for (const c of allConds) {
    const f = c.field;
    if ((f === 'type' || f === 'ticket_type') && TYPE[c.value]) push('ticket_types', TYPE[c.value]);
    else if (f === 'ticket_type_id' && TYPE_ID[Number(c.value)]) push('ticket_types', TYPE_ID[Number(c.value)]);
    else if (f === 'group_id') { const g = resolve('groups', c.value); g ? push('group_ids', asId(g)) : unmapped.push('group (not migrated)'); }
    else if (f === 'organization_id') { const o = resolve('organizations', c.value); o ? push('company_ids', asId(o)) : unmapped.push('organization (not migrated)'); }
    else unmapped.push(f); // priority / brand / tags / custom fields / requester / …
  }
  for (const k of Object.keys(applicable_to)) applicable_to[k] = [...new Set(applicable_to[k])];

  // Reasons we canNOT faithfully reproduce the scope → checklist instead of
  // creating a wrongly-scoped contract SLA.
  const reason = allConds.length === 0
    ? 'it applies to ALL tickets (Freshdesk custom SLAs require a scope — configure this on the Default SLA policy)'
    : unmapped.length
      ? `it uses conditions Freshdesk SLA can't target: ${[...new Set(unmapped)].join(', ')}`
      : usesOr
        ? "it uses mixed ANY/ALL (OR) conditions Freshdesk SLA can't express"
        : null;

  if (reason) {
    addConflict('manual_step',
      `SLA "${r.title}" was not auto-created because ${reason}. Recreate it in Freshdesk (Admin → SLA Policies) — conditions: ${describeConds(allConds) || '(all tickets)'}; targets: ${targetsSummary}${usesBusinessHours ? '; uses business hours (set the calendar)' : ''}.`,
      'Create the policy manually with these targets and conditions.');
    return { manual: true, payload: { name: r.title, sla_target }, notes: `SLA scope not reproducible: ${reason}` };
  }

  // ── Faithful create ─────────────────────────────────────────────────────────
  const payload = { name: r.title, description: r.description || `Migrated from Zendesk SLA "${r.title}"`, active: true, sla_target, applicable_to };
  if (defaults.length) {
    addConflict('unmapped_field',
      `SLA "${r.title}": Freshdesk requires a target for every priority, so these were auto-completed (not defined in Zendesk): ${defaults.join('; ')}.`,
      'Review/adjust these targets in Freshdesk if the defaults are not appropriate.');
  }
  if (usesBusinessHours) {
    addConflict('manual_step',
      `SLA "${r.title}" uses BUSINESS HOURS. Freshdesk's business-hours calendar can't be created via API, so timers use the target account's existing calendar — verify it matches, or due-times will be wrong.`,
      'Set/confirm business hours in Freshdesk → Admin → Business Hours.');
  }
  // position isn't API-settable; carry it so the loader/report can note ordering.
  return { payload, notes: `sla source position=${r.position ?? '?'}; targets ${targetsSummary}`, sortKey: r.position ?? 0 };
}
