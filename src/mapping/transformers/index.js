// Deterministic transformers: raw Zendesk object → Freshdesk-shaped payload.
// Signature: (raw, ctx) => { payload, targetType?, children?, manual?, notes? }
//   ctx.resolve(type, sourceId) → target id (from idmap cache) or null
//   ctx.addConflict(kind, detail, suggestion)
// No inference/LLM anywhere — pure rules + value maps.
import { mapStatus, mapPriority, mapSource, mapFieldType, ROLE_DEFAULT, mapAgentRole } from '../valueMaps.js';

const asId = (v) => (v == null ? null : Number(v));

export const transformers = {
  group: (r) => ({ payload: { name: r.name, description: r.description || '' } }),

  role: (r, ctx) => {
    const mapped = ROLE_DEFAULT[r.name] || 'Agent';
    ctx.addConflict('no_api', `Freshdesk has no API to create custom role "${r.name}". Mapped agents to default role "${mapped}".`, `Recreate role "${r.name}" in Admin → Roles, or accept "${mapped}".`);
    return { payload: { name: r.name, mappedTo: mapped }, manual: true };
  },

  agent: (r, ctx) => {
    const group_ids = (r.group_ids || []).map((g) => ctx.resolve('groups', g)).filter(Boolean).map(asId);
    const { role, ticketScope, billingAdmin } = mapAgentRole(r);
    if (billingAdmin) ctx.addConflict('unmapped_field', `Agent "${r.name}" is a Zendesk Billing admin → mapped to Freshdesk "Administrator" (no billing access on FD Administrator).`, 'Grant "Account Administrator" manually if this agent must manage billing.');
    // role name → resolved to the target account's role_id by the connector at load time.
    return {
      payload: { name: r.name, email: r.email, group_ids, ticket_scope: ticketScope },
      ctxOut: { role },
      notes: `role ${r.role}${r.role_type != null ? `/type ${r.role_type}` : ''} → Freshdesk "${role}" (scope ${ticketScope})`,
    };
  },

  ticketField: (r, ctx) => {
    const type = mapFieldType(r.type);
    const payload = { label: r.title, type, required_for_closure: !!r.required };
    if (r.custom_field_options) payload.choices = r.custom_field_options.map((o) => o.name);
    if (r.type === 'regexp') ctx.addConflict('unmapped_field', `Field "${r.title}" is a Zendesk regex field; Freshdesk has no regex type. Migrated as text; validation "${r.regexp_for_validation}" not enforced.`, 'Add front-end validation or a workflow check.');
    return { payload };
  },

  brand: (r, ctx) => {
    ctx.addConflict('no_api', `Freshdesk has no API to create Products (Zendesk brand "${r.name}").`, 'Create the Product in Admin → Products; then support email/DNS verification is manual.');
    return { payload: { name: r.name, description: `Migrated from Zendesk brand ${r.subdomain}` }, manual: true };
  },

  businessHours: (r, ctx) => {
    ctx.addConflict('no_api', `Freshdesk has no API to create Business Hours ("${r.name}").`, 'Recreate the weekly schedule + holidays in Admin → Business Hours (timezone ' + r.time_zone + ').');
    return { payload: { name: r.name, time_zone: r.time_zone, intervals: r.intervals }, manual: true };
  },

  sla: (r, ctx) => {
    ctx.addConflict('no_api', `SLA policy "${r.title}" — Freshdesk create-SLA API is VERIFY-LIVE; may be update-only.`, 'Confirm POST /sla_policies on target plan; else set default via PUT and add extras in UI.');
    return { payload: { name: r.title, sla_target: r.policy_metrics }, manual: true };
  },

  // ── automation logic translation → intermediate representation (IR) ──
  trigger: (r, ctx) => translateRule(r, 'trigger', ctx),
  automation: (r, ctx) => translateRule(r, 'automation', ctx),

  macro: (r, ctx) => {
    const reply = (r.actions || []).find((a) => a.field === 'comment_value');
    const otherActions = (r.actions || []).filter((a) => a.field !== 'comment_value').map((a) => mapAction(a, ctx));
    if (otherActions.length) ctx.addConflict('no_api', `Macro "${r.title}" has field actions ${JSON.stringify(otherActions)} — Scenario Automations aren't API-creatable.`, 'Deliver via Custom App scenario button or recreate as a Scenario Automation.');
    // Reply text IS creatable as a canned response (Tier-1).
    return { payload: { title: r.title, content_html: reply ? `<p>${reply.value}</p>` : '', content: reply ? reply.value : '' }, notes: 'reply→canned response (auto); field actions→conflict' };
  },

  organization: (r) => ({ payload: { name: r.name, domains: r.domain_names || [] } }),

  user: (r, ctx) => ({ payload: { name: r.name, email: r.email, company_id: asId(ctx.resolve('organizations', r.organization_id)) } }),

  kbCategory: (r) => ({ payload: { name: r.name, description: r.description || '' } }),

  kbSection: (r, ctx) => ({ payload: { name: r.name, visibility: 1 }, ctxOut: { categoryId: asId(ctx.resolve('kbCategories', r.category_id)) } }),

  kbArticle: (r, ctx) => {
    const { html, rehosted } = rehostImages(r.body || '');
    if (rehosted) ctx.addConflict('unmapped_field', `Article "${r.title}" had inline images; URLs rewritten to target host (rehost on load).`, null);
    return { payload: { title: r.title, description: html, status: r.draft ? 1 : 2 }, ctxOut: { folderId: asId(ctx.resolve('kbSections', r.section_id)) } };
  },

  ticket: (r, ctx) => {
    const custom = {};
    for (const cf of r.custom_fields || []) custom[`cf_${cf.id}`] = cf.value;
    const payload = {
      subject: r.subject,
      description: r.description || r.subject,
      status: mapStatus(r.status),
      priority: mapPriority(r.priority),
      source: mapSource(r.via?.channel),
      type: r.type ? capitalize(r.type) : undefined,
      group_id: asId(ctx.resolve('groups', r.group_id)),
      responder_id: asId(ctx.resolve('agents', r.assignee_id)),
      requester_id: asId(ctx.resolve('users', r.requester_id)),
      company_id: asId(ctx.resolve('organizations', r.organization_id)),
      tags: r.tags || [],
      custom_fields: custom,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    const children = (r.comments || []).map((c) => ({
      targetType: c.public ? 'ticketReply' : 'ticketNote',
      sourceId: String(c.id),
      payload: { body: c.body, private: !c.public, user_id: asId(ctx.resolve('users', c.author_id)) || asId(ctx.resolve('agents', c.author_id)) },
      attachments: (c.attachments || []).map((a) => ({ url: a.content_url, filename: a.file_name, contentType: a.content_type, size: a.size })),
    }));
    return { payload, children };
  },
};

// ── helpers ──
function translateRule(r, kind, ctx) {
  const ir = {
    name: r.title,
    event: classifyEvent(r),                 // ticket_creation | ticket_update | hourly
    conditions: (r.conditions?.all || []).map((c) => mapCondition(c, ctx)),
    actions: (r.actions || []).map((a) => mapAction(a, ctx)),
  };
  ctx.addConflict('no_api', `${kind} "${r.title}" → Freshdesk ${ir.event} rule. No public create API; translated to IR for Custom App / UI automation / guided rebuild.`, `Enforce via Custom App handler or recreate under Admin → Workflows → Automations (${ir.event}).`);
  return { payload: { ir }, manual: true };
}

function classifyEvent(r) {
  const fields = (r.conditions?.all || []).map((c) => c.field);
  if (fields.includes('status') && (r.conditions?.all || []).some((c) => c.value === 'new')) return 'ticket_creation';
  if (fields.some((f) => f === 'SOLVED' || f === 'hours')) return 'hourly';
  return 'ticket_update';
}

function mapCondition(c, ctx) {
  const field = c.field?.startsWith('custom_field_') ? c.field.replace('custom_field_', 'cf_') : c.field;
  return { field, operator: c.operator, value: resolveRefValue(field, c.value, ctx) };
}
function mapAction(a, ctx) {
  return { field: a.field === 'group_id' ? 'group' : a.field, value: resolveRefValue(a.field, a.value, ctx) };
}
function resolveRefValue(field, value, ctx) {
  if (field === 'group_id') { const t = ctx.resolve('groups', value); return t ?? value; }
  return value;
}

function rehostImages(html) {
  let rehosted = false;
  const out = html.replace(/src="https?:\/\/[^"]*zendesk[^"]*"/g, () => { rehosted = true; return 'src="{{TARGET_REHOSTED_IMAGE}}"'; });
  return { html: out, rehosted };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
