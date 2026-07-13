// Deterministic transformers: raw Zendesk object → Freshdesk-shaped payload.
// Signature: (raw, ctx) => { payload, targetType?, children?, manual?, notes? }
//   ctx.resolve(type, sourceId) → target id (from idmap cache) or null
//   ctx.addConflict(kind, detail, suggestion)
// No inference/LLM anywhere — pure rules + value maps.
import { mapStatus, mapPriority, mapSource, mapFieldType, ROLE_DEFAULT, mapAgentRole } from '../valueMaps.js';
import { transformSla } from './sla.js';

const asId = (v) => (v == null ? null : Number(v));

// Human-readable source timestamp for provenance. Freshdesk can't backdate
// individual messages, so we surface the original time inline on each message.
const origStamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

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

  // Zendesk SLA policy → Freshdesk SLA policy. See src/mapping/transformers/sla.js
  // (extracted for readability + unit tests). Freshdesk MANDATES all 4 priorities
  // and respond+resolve+business_hours+escalation on each (proven live), so unset
  // targets are defaulted and every default is REPORTED. A scope Freshdesk can't
  // faithfully reproduce (priority/brand/tags conditions, OR-logic, or applies-to-all)
  // is checklisted — never silently broad-applied to a contract object.
  sla: (r, ctx) => transformSla(r, ctx),

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
    const { html, count } = cleanInlineImages(r.body || '');
    if (count) ctx.addConflict('unmapped_field', `Article "${r.title}" had ${count} Zendesk inline image(s); body shows a marker (article-image rehosting is a separate step).`, null);
    // Freshdesk requires a non-empty title AND description — guard both so an
    // empty Zendesk article can't reject the whole create.
    return {
      payload: { title: r.title || '(untitled)', description: html || '<p></p>', status: r.draft ? 1 : 2 },
      ctxOut: { folderId: asId(ctx.resolve('kbSections', r.section_id)) },
    };
  },

  ticket: (r, ctx) => {
    // Value translations prefer the customer's per-project maps (ctx.mapValue),
    // falling back to the deterministic JS defaults when nothing is overridden —
    // behavior is identical unless the admin edited a map in the mapping step.
    // The default `type` map folds Zendesk "task" → Question (no FD equivalent).
    const FD_TYPES = { question: 'Question', incident: 'Incident', problem: 'Problem' };
    const mv = ctx.mapValue;
    const payload = {
      subject: r.subject || '(no subject)',
      // Freshdesk's description field renders HTML. Zendesk's first comment holds
      // the RICH version (`html_body`) — use it so bold/lists/links/headings
      // survive; `r.description` is the plain/markdown fallback only.
      description: cleanInlineImages(r.comments?.[0]?.html_body || r.description || r.subject || '(migrated from Zendesk)').html,
      status: mv ? mv('status', r.status, mapStatus(r.status)) : mapStatus(r.status),
      priority: mv ? mv('priority', r.priority, mapPriority(r.priority)) : mapPriority(r.priority),
      source: mv ? mv('source', r.via?.channel, mapSource(r.via?.channel)) : mapSource(r.via?.channel),
      type: (mv ? mv('type', r.type, FD_TYPES[r.type]) : FD_TYPES[r.type]) || undefined,
      group_id: asId(ctx.resolve('groups', r.group_id)),
      responder_id: asId(ctx.resolve('agents', r.assignee_id)),
      requester_id: asId(ctx.resolve('users', r.requester_id)),
      company_id: asId(ctx.resolve('organizations', r.organization_id)),
      tags: r.tags || [],
      // Best-effort: some Freshdesk plans/accounts accept original timestamps on
      // create. The Freshdesk connector attempts these and transparently retries
      // WITHOUT them if the account rejects them (HTTP 400 invalid_field), so the
      // ticket still migrates. Per-message original times are surfaced inline
      // (see child bodies below) since Freshdesk can't backdate replies/notes.
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    // CC / collaborators → Freshdesk `cc_emails` (resolved to emails at extraction).
    if (r.collaborator_emails?.length) payload.cc_emails = r.collaborator_emails;
    // Custom-field VALUES: map each Zendesk value onto the migrated Freshdesk
    // field by NAME (the loader records the name for SAFE-typed custom fields:
    // text/number/checkbox/date). Dropdown value-translation and Zendesk system
    // fields are intentionally excluded — resolve returns no name for them, so
    // they're skipped rather than risking a rejected ticket.
    const cfv = {};
    for (const c of (r.custom_fields || [])) {
      if (c.value == null) continue;
      const name = ctx.resolve('ticketFieldName', c.id);
      if (!name) continue;
      // Coerce the value to what Freshdesk's field type expects. Zendesk sends
      // everything as-is (e.g. a number as a string), and Freshdesk rejects the
      // WHOLE ticket on a datatype/length mismatch — so we fit the value here.
      const coerced = coerceCustomValue(c.value, ctx.resolve('ticketFieldType', c.id), name, ctx);
      if (coerced !== undefined) cfv[name] = coerced;
    }
    if (Object.keys(cfv).length) payload.custom_fields = { ...(payload.custom_fields || {}), ...cfv };
    // Freshdesk needs a requester. If the source requester wasn't migrated as a
    // contact (it's an agent, or an end-user outside the selected set), fall back
    // to the requester's EMAIL — Freshdesk find-or-creates the contact from it,
    // so the ticket migrates instead of 400-ing on "requester_id required". Only
    // when we have NEITHER is the ticket un-migratable → conflict.
    if (!payload.requester_id) {
      if (r.requester_email) {
        payload.email = r.requester_email;
      } else if (r.requester_id) {
        // Emailless Zendesk requester (phone-only / API-created / bulk contact).
        // Freshdesk accepts unique_external_id as a requester identifier — key a
        // placeholder contact on the Zendesk user id (+ name) so the ticket
        // migrates with a distinct, stable requester instead of being dropped.
        payload.unique_external_id = String(r.requester_id);
        payload.name = r.requester_name || `Zendesk user ${r.requester_id}`;
        ctx.addConflict('unmapped_field', `Ticket "${(r.subject || '').slice(0, 40)}" requester "${payload.name}" has no email in Zendesk — migrated with a placeholder contact keyed on the source id.`, 'Add an email to this contact in Freshdesk if you need to reach them.');
      } else {
        ctx.addConflict('unmapped_field', `Ticket "${(r.subject || '').slice(0, 40)}" has no requester — Freshdesk needs one.`, 'Set a default requester for orphaned tickets.');
      }
    }
    const comments = r.comments || [];
    // Zendesk's FIRST comment IS the ticket description. Re-importing it as a
    // reply produces a DUPLICATE opening message (a real migration bug), so skip
    // it — UNLESS it carries attachments, which would otherwise be lost, in which
    // case keep it (a minor text repeat beats dropping files).
    const conv = comments.filter((c, i) => i > 0 || (c.attachments && c.attachments.length));
    const children = conv.map((c) => {
      const author = asId(ctx.resolve('users', c.author_id)) || asId(ctx.resolve('agents', c.author_id));
      // Freshdesk splits conversations into two endpoints with DIFFERENT payloads:
      //   public comment  → POST /reply  (accepts body + user_id; rejects `private`)
      //   private comment → POST /notes  (accepts body + user_id + private:true)
      // Sending `private` to /reply fails with HTTP 400 invalid_field, so only
      // notes carry it.
      // CLEAN (default): no per-message prefix — the destination reads native,
      // and the original timeline lives in the migration report. FORENSIC (opt-in
      // via project.options.provenanceMode) prefixes each message with its source
      // time for regulated/audit migrations. Freshdesk bodies are HTML, so the
      // stamp is wrapped in a tag rather than a literal newline.
      const stamp = ctx.forensic ? origStamp(c.created_at) : '';
      const cleaned = cleanInlineImages(c.html_body || c.body || '').html;
      let body = (stamp ? `<div>[Originally sent ${stamp}]</div>` : '') + cleaned;
      // Freshdesk rejects an empty reply/note body (HTTP 400) — placeholder when
      // the message is attachment-only or a system comment with no text.
      if (!body.replace(/<[^>]*>/g, '').trim()) body += '(no message text)';
      const payload = c.public
        ? { body, user_id: author }
        : { body, private: true, user_id: author };
      return {
        targetType: c.public ? 'ticketReply' : 'ticketNote',
        sourceId: String(c.id),
        payload,
        attachments: (c.attachments || []).map((a) => ({ url: a.content_url, filename: a.file_name, contentType: a.content_type, size: a.size })),
      };
    });
    // Migration provenance lives entirely in searchable CUSTOM FIELDS (no in-thread
    // note — keeps the conversation clean). The connector resolves the account-
    // specific field names live and writes these at load time.
    return {
      payload,
      children,
      // Native destination + minimal searchable provenance (matches Help Desk
      // Migration's approach): only Original Ticket ID + Source Platform go on the
      // ticket. Full created/updated/timeline history lives in the migration
      // report (persisted in staging `sourceRaw`), not on the ticket.
      ctxOut: { migrationMeta: {
        originalId: String(r.id),
        sourcePlatform: 'Zendesk',
      } },
    };
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

// Fit a Zendesk custom-field value to what its Freshdesk field type accepts.
// Freshdesk rejects the ENTIRE ticket on a datatype/length mismatch, so we coerce
// here (and flag lossy adjustments as conflicts). Returns `undefined` to skip a
// value that can't be safely coerced. `ftype` is the Zendesk source field type.
function coerceCustomValue(value, ftype, name, ctx) {
  switch (ftype) {
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) { ctx.addConflict('value_out_of_range', `Custom field "${name}": "${value}" is not a number — value skipped so the ticket still migrates.`, 'Set the value manually on the target if needed.'); return undefined; }
      return Math.trunc(n);
    }
    case 'decimal': {
      const n = Number(value);
      if (!Number.isFinite(n)) { ctx.addConflict('value_out_of_range', `Custom field "${name}": "${value}" is not a number — value skipped.`, null); return undefined; }
      return n;
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'text': {
      // Freshdesk single-line custom_text caps at 255 chars; longer values are
      // truncated (rather than sinking the ticket) with a conflict for the report.
      const s = String(value);
      if (s.length > 255) { ctx.addConflict('value_out_of_range', `Custom field "${name}": value was ${s.length} chars; Freshdesk text fields cap at 255, so it was truncated.`, 'Recreate this as a multi-line (paragraph) field on the target if full text is required.'); return s.slice(0, 255); }
      return s;
    }
    case 'textarea':
      return String(value); // Freshdesk custom_paragraph — no single-line cap.
    case 'date':
      return value;          // ISO date string, accepted as-is.
    default:
      return value;
  }
}

// Zendesk-hosted inline images can't be linked from the destination — their URLs
// require Zendesk auth and die with the source. The image FILE is migrated
// automatically as a message attachment (Zendesk includes inline images in the
// comment's `attachments`, which loadChild downloads → re-uploads — no manual
// step). So we just replace the broken <img> in the body with a marker. External
// (non-Zendesk) images are left intact.
function cleanInlineImages(html) {
  let count = 0;
  const out = String(html || '').replace(/<img\b[^>]*\bsrc="[^"]*zendesk[^"]*"[^>]*>/gi, () => { count += 1; return '<em>[inline image — see attachment]</em>'; });
  return { html: out, count };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
