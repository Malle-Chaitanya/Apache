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
    // Zendesk system fields already exist on Freshdesk as built-ins — don't recreate.
    const SYSTEM = new Set(['subject', 'description', 'status', 'priority', 'group', 'assignee', 'tickettype', 'custom_status', 'requester', 'organization']);
    if (SYSTEM.has(r.type)) {
      ctx.addConflict('skipped', `Zendesk system field "${r.title}" (${r.type}) already exists on Freshdesk — skipped.`, null);
      return { manual: true, payload: { label: r.title, systemField: r.type } };
    }
    const type = mapFieldType(r.type);
    // Freshdesk requires label_for_customers on customer-visible custom fields.
    const payload = { label: r.title, label_for_customers: r.title, type, customers_can_edit: false, required_for_closure: !!r.required };
    // Freshdesk dropdown choices must be {value, position} objects — a bare
    // string array makes POST /admin/ticket_fields return a generic HTTP 500
    // (verified live against the API). Position is 1-based, preserving source order.
    if (r.custom_field_options) payload.choices = r.custom_field_options.map((o, i) => ({ value: o.name, position: i + 1 }));
    if (r.type === 'regexp') ctx.addConflict('unmapped_field', `Field "${r.title}" is a Zendesk regex field; Freshdesk has no regex type. Migrated as text; validation "${r.regexp_for_validation}" not enforced.`, 'Add front-end validation or a workflow check.');
    return { payload };
  },

  // Best-effort (loader attempts the API; falls back to the checklist if the
  // plan/endpoint rejects it — see freshdesk connector `bestEffort`).
  brand: (r) => ({ payload: { name: r.name, description: `Migrated from Zendesk brand ${r.subdomain || r.name}` } }),

  businessHours: (r) => ({ payload: { name: r.name, time_zone: r.time_zone, business_hours: r.intervals } }),

  sla: (r) => ({ payload: { name: r.title, sla_target: r.policy_metrics } }),

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
    // Only Freshdesk's built-in ticket types are valid; others (e.g. Zendesk
    // "task") are omitted rather than rejected.
    const FD_TYPES = { question: 'Question', incident: 'Incident', problem: 'Problem' };
    const payload = {
      subject: r.subject || '(no subject)',
      description: r.description || r.subject || '(migrated from Zendesk)',
      status: mapStatus(r.status),
      priority: mapPriority(r.priority),
      source: mapSource(r.via?.channel),
      type: FD_TYPES[r.type] || undefined,
      group_id: asId(ctx.resolve('groups', r.group_id)),
      responder_id: asId(ctx.resolve('agents', r.assignee_id)),
      requester_id: asId(ctx.resolve('users', r.requester_id)),
      company_id: asId(ctx.resolve('organizations', r.organization_id)),
      tags: r.tags || [],
    };
    // NOTE: Freshdesk's create-ticket API rejects created_at/updated_at as
    // "invalid_field" (no backdating on the public endpoint) — including them
    // fails the whole ticket with HTTP 400. The original Zendesk timestamps are
    // preserved in staging (sourceRaw) for reporting, but the migrated ticket
    // carries the migration date.
    // Custom-field VALUES are deferred (v2): Zendesk cf ids need mapping to the
    // created Freshdesk field names first, else the ticket create is rejected.
    if (!payload.requester_id) ctx.addConflict('unmapped_field', `Ticket "${(r.subject || '').slice(0, 40)}" requester not among migrated contacts — Freshdesk needs a requester.`, 'Migrate the requester (end-user), or set a default requester.');
    const children = (r.comments || []).map((c) => {
      const author = asId(ctx.resolve('users', c.author_id)) || asId(ctx.resolve('agents', c.author_id));
      // Freshdesk splits conversations into two endpoints with DIFFERENT payloads:
      //   public comment  → POST /reply  (accepts body + user_id; rejects `private`)
      //   private comment → POST /notes  (accepts body + user_id + private:true)
      // Sending `private` to /reply fails with HTTP 400 invalid_field, so only
      // notes carry it.
      const payload = c.public
        ? { body: c.body, user_id: author }
        : { body: c.body, private: true, user_id: author };
      return {
        targetType: c.public ? 'ticketReply' : 'ticketNote',
        sourceId: String(c.id),
        payload,
        attachments: (c.attachments || []).map((a) => ({ url: a.content_url, filename: a.file_name, contentType: a.content_type, size: a.size })),
      };
    });
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
