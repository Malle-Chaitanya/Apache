import { config } from '../../config.js';
import { HttpClient } from '../../lib/httpClient.js';

// targetType → how to create it on Freshdesk. `creatable:false` = no public
// create API → loader routes it to conflicts (deferred enforcement: Custom App /
// UI automation / guided spec — see docs/CONFIG-FEASIBILITY.md).
const TARGET = {
  groups: { path: () => '/groups', creatable: true },
  agents: { path: () => '/agents', creatable: true },
  companies: { path: () => '/companies', creatable: true },
  contacts: { path: () => '/contacts', creatable: true },
  ticketFields: { path: () => '/admin/ticket_fields', creatable: true },
  skills: { path: () => '/skills', creatable: true },
  cannedResponses: { path: (c) => `/canned_response_folders/${c.folderId}/responses`, creatable: true },
  kbCategories: { path: () => '/solutions/categories', creatable: true },
  kbFolders: { path: (c) => `/solutions/categories/${c.categoryId}/folders`, creatable: true },
  kbArticles: { path: (c) => `/solutions/folders/${c.folderId}/articles`, creatable: true },
  tickets: { path: () => '/tickets', creatable: true },
  ticketReply: { path: (c) => `/tickets/${c.ticketId}/reply`, creatable: true },
  ticketNote: { path: (c) => `/tickets/${c.ticketId}/notes`, creatable: true },
  ticketForms: { path: () => '/admin/forms', creatable: true, verifyLive: true },
  // Best-effort: attempt the create; if the plan/endpoint rejects it the loader
  // turns it into a manual checklist item instead of a hard failure.
  slaPolicies: { path: () => '/sla_policies', creatable: true, bestEffort: true, verifyLive: true },
  businessHours: { path: () => '/business_hours', creatable: true, bestEffort: true },
  products: { path: () => '/products', creatable: true, bestEffort: true },
  roles: { path: () => '/roles', creatable: false },
  automationRules: { path: () => '/automations', creatable: false },
  scenarioAutomations: { path: () => '/scenario_automations', creatable: false },
};

// Freshdesk target connector (load). Freshdesk has NO OAuth for its API — auth
// is an API key via HTTP Basic (docs/ONBOARDING-AUTH.md). Key comes from the
// project connection and is decrypted from the secrets vault at run time.
export class FreshdeskTarget {
  constructor(creds = {}) {
    const c = { ...config.freshdesk, ...creds };
    // Only an explicit string override is honored; otherwise build from the
    // project connection's domain (config carries no baseUrl in this flow).
    this.baseUrl = (typeof c.baseUrl === 'string' && c.baseUrl)
      ? c.baseUrl
      : `https://${c.domain}.freshdesk.com/api/v2`;
    const auth = Buffer.from(`${c.apiKey}:X`).toString('base64');
    this.http = new HttpClient({ baseUrl: this.baseUrl, rpm: c.rpm || 600, headers: { Authorization: `Basic ${auth}` } });
  }

  capability(targetType) {
    const t = TARGET[targetType];
    return { known: !!t, creatable: !!t?.creatable, verifyLive: !!t?.verifyLive, bestEffort: !!t?.bestEffort };
  }

  // ctx.attachments (set by the loader for replies/notes carrying downloaded
  // files) routes the request through multipart/form-data instead of JSON —
  // Freshdesk requires multipart whenever attachments are present.
  async create(targetType, payload, ctx = {}) {
    const t = TARGET[targetType];
    if (!t) throw new Error(`Unknown target type: ${targetType}`);
    if (!t.creatable) throw new NoApiError(targetType);
    // Ticket fields: reuse an existing field with the same label instead of
    // creating a duplicate (Freshdesk auto-suffixes the cf_ name otherwise, which
    // is how the account accumulated cf_vip_flag / cf_vip_flag643652 / …).
    if (targetType === 'ticketFields') {
      const existing = await this._existingTicketField(payload.label);
      if (existing) return { id: existing.id, raw: existing };
    }
    // Solutions KB: Freshdesk ships a default "General" category, and category /
    // folder names must be unique. Creating a duplicate 409s — and a failed
    // category leaves folders/articles pointing at a null parent (404 cascade).
    // Reuse an existing category/folder by name so the whole KB chain resolves.
    if (targetType === 'kbCategories') {
      const existing = await this._existingCategory(payload.name);
      if (existing) return { id: existing.id, raw: existing };
    }
    if (targetType === 'kbFolders') {
      const existing = await this._existingFolder(ctx.categoryId, payload.name);
      if (existing) return { id: existing.id, raw: existing };
    }
    // Articles have no natural unique key on Freshdesk, so a re-run (or cleared
    // idmap) would duplicate them. Reuse an existing article by title within its
    // folder so KB stays idempotent like every other object.
    if (targetType === 'kbArticles') {
      const existing = await this._existingArticle(ctx.folderId, payload.title);
      if (existing) return { id: existing.id, raw: existing };
    }
    // Agents: resolve the mapped role NAME → this account's numeric role_id.
    // Freshdesk role_ids are account-specific, so we look them up live (cached).
    if (targetType === 'agents' && ctx.role) {
      const roleId = await this.roleIdByName(ctx.role);
      if (roleId) payload = { ...payload, role_ids: [roleId] };
    }
    // Tickets: stamp searchable provenance (Original Ticket ID / Source Platform)
    // into custom fields so agents can look up a migrated ticket by its old number
    // — the Freshdesk ticket ID itself can't be preserved (system-assigned).
    if (targetType === 'tickets' && ctx.migrationMeta) {
      const fields = await this.ensureMigrationFields();
      const cf = {};
      if (fields.originalId && ctx.migrationMeta.originalId != null) cf[fields.originalId] = String(ctx.migrationMeta.originalId);
      if (fields.sourcePlatform && ctx.migrationMeta.sourcePlatform) cf[fields.sourcePlatform] = ctx.migrationMeta.sourcePlatform;
      if (Object.keys(cf).length) payload = { ...payload, custom_fields: { ...(payload.custom_fields || {}), ...cf } };
    }
    // Tickets: attempt original created_at/updated_at (some plans allow it).
    // If THIS account rejects them, strip and retry once, then remember so every
    // subsequent ticket skips the doomed first attempt.
    // SLA policies: validate applicable_to.ticket_types against the target account's
    // REAL ticket types — a renamed/removed type would 400 the whole policy. Drop
    // any that don't exist; if that empties the scope, the bestEffort loader path
    // turns it into a checklist item rather than crashing the run.
    if (targetType === 'slaPolicies' && Array.isArray(payload.applicable_to?.ticket_types)) {
      const valid = await this._ticketTypes();
      if (valid.length) {
        const kept = payload.applicable_to.ticket_types.filter((t) => valid.includes(t));
        const applicable_to = { ...payload.applicable_to, ticket_types: kept };
        if (!kept.length) delete applicable_to.ticket_types;
        payload = { ...payload, applicable_to };
      }
    }

    if (targetType === 'tickets') {
      const post = async (b) => { const { data } = await this.http.post(t.path(ctx), { body: b }); return { id: data.id, raw: data }; };
      // A ticket must NEVER be lost to a mappable-but-missing reference or a bad
      // value (industry behaviour: migrate it unassigned/ungrouped and flag it).
      // Freshdesk validates SEQUENTIALLY — it reports one blocking field, and only
      // once that's fixed does it surface the next — so we LOOP, peeling whatever
      // it rejects each round until the ticket lands or hits something unfixable:
      //   • created_at/updated_at (plan-gated timestamps)
      //   • group_id / responder_id / company_id (assignee/group/company that
      //     didn't resolve to a live Freshdesk record → drop, land unassigned)
      //   • custom-field VALUES (best-effort)
      let body = this._ticketTimestampsUnsupported ? stripTimestamps(payload) : { ...payload };
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await post(body);
        } catch (err) {
          if (err.status !== 400) throw err;
          const tsErr = isTimestampFieldError(err.body);
          const cfErr = isCustomFieldError(err.body);
          const badRefs = offendingRefFields(err.body); // group_id / responder_id / company_id
          if (!tsErr && !cfErr && !badRefs.length) throw err; // nothing we can strip → surface it
          if (tsErr) { this._ticketTimestampsUnsupported = true; body = stripTimestamps(body); }
          for (const f of badRefs) delete body[f]; // migrate without the invalid reference
          if (cfErr && body.custom_fields) {
            const bad = offendingCustomFields(err.body);
            const cf = { ...body.custom_fields };
            if (bad.length) for (const n of bad) delete cf[n]; else Object.keys(cf).forEach((k) => delete cf[k]);
            if (Object.keys(cf).length) body = { ...body, custom_fields: cf };
            else body = (({ custom_fields, ...rest }) => rest)(body);
          }
          // loop: retry with the reduced body (peels the next sequential error)
        }
      }
      return await post(body); // final attempt — throws if still rejected (real, unfixable error)
    }
    try {
      const { data } = ctx.attachments?.length
        ? await this.http.post(t.path(ctx), { multipart: { fields: flattenForm(payload), files: ctx.attachments } })
        : await this.http.post(t.path(ctx), { body: payload });
      return { id: data.id, raw: data };
    } catch (err) {
      // A reply/note whose ORIGINAL author can't post — a deleted/deactivated
      // agent or an unmigratable contact → Freshdesk 403 "invalid_user"
      // ("not authorized … on behalf of this user"). Re-post WITHOUT user_id so
      // the message still migrates, attributed to the migrating (API) agent,
      // rather than being dropped. (Help Desk Migration behaves the same way.)
      if ((err.status === 403 || err.status === 400)
          && (targetType === 'ticketReply' || targetType === 'ticketNote')
          && payload.user_id
          && /invalid_user|not authorized|on behalf/i.test(JSON.stringify(err.body || ''))) {
        const { user_id, ...rest } = payload;
        const { data } = ctx.attachments?.length
          ? await this.http.post(t.path(ctx), { multipart: { fields: flattenForm(rest), files: ctx.attachments } })
          : await this.http.post(t.path(ctx), { body: rest });
        return { id: data.id, raw: data };
      }
      // Safety-net: if a KB category/folder name collided despite the check above
      // (pagination lag, concurrent create), re-read fresh and reuse the existing
      // one instead of hard-failing the whole KB chain.
      // A ticket field whose label/cf_ name already exists (a default field, or one
      // created concurrently by another worker → stale dedup cache). Re-read live
      // and reuse it instead of failing the field.
      // Freshdesk enforces UNIQUE SLA policy names → a re-run whose idmap doesn't
      // already track this policy 400s with "name already exists". Find it by name
      // and UPDATE it (PUT) instead of failing — makes re-runs idempotent AND
      // propagate changes. (There's no create-duplicate risk; Freshdesk blocks it.)
      if ((err.status === 400 || err.status === 409) && targetType === 'slaPolicies'
          && /already exists/i.test(JSON.stringify(err.body || ''))) {
        const all = await this._pageAll('/sla_policies');            // paginate — match may be page 2+
        const norm = (s) => String(s || '').trim().toLowerCase();     // Freshdesk name-uniqueness is not case-sensitive
        const match = all.find((p) => norm(p.name) === norm(payload.name));
        if (match) { const upd = await this.http.put(`/sla_policies/${match.id}`, { body: payload }); return { id: match.id, raw: upd.data || match }; }
      }
      if (err.status === 409 && targetType === 'ticketFields') {
        const existing = await this._existingTicketField(payload.label, true);
        if (existing) return { id: existing.id, raw: existing };
      }
      if (err.status === 409 && targetType === 'kbCategories') {
        const c = await this._existingCategory(payload.name, true);
        if (c) return { id: c.id, raw: c };
      }
      if (err.status === 409 && targetType === 'kbFolders') {
        const f = await this._existingFolder(ctx.categoryId, payload.name);
        if (f) return { id: f.id, raw: f };
      }
      throw err;
    }
  }

  // Re-apply fields a reused record can't infer from its existing profile.
  // Today: an agent's group membership — required for Freshdesk to accept a
  // ticket assignment to that agent. Best-effort; never blocks the migration.
  async afterReuse(targetType, id, payload = {}) {
    if (targetType === 'agents' && Array.isArray(payload.group_ids) && payload.group_ids.length) {
      try { await this.http.request('PUT', `/agents/${id}`, { body: { group_ids: payload.group_ids } }); } catch { /* best-effort */ }
    }
  }

  // Paginated GET for Freshdesk list endpoints (100/page). Enterprise KBs exceed
  // one page, so a single GET would miss existing records and 409 on create.
  async _pageAll(path) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      let data;
      try { ({ data } = await this.http.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)); }
      catch { break; }
      if (!Array.isArray(data) || !data.length) break;
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  }

  // Reuse an existing Solutions category by name — Freshdesk's default "General"
  // category (and any re-run) would otherwise 409 on the unique name. Cached, but
  // `fresh` forces a re-read for the 409 safety-net (cache may predate a collision).
  async _existingCategory(name, fresh = false) {
    if (fresh || !this._catCache) this._catCache = await this._pageAll('/solutions/categories');
    return this._catCache.find((c) => c.name === name) || null;
  }

  // Reuse an existing folder by name within a category (folder names are unique
  // per category). Always read live — folders are created as the run proceeds.
  async _existingFolder(categoryId, name) {
    if (categoryId == null) return null;
    const folders = await this._pageAll(`/solutions/categories/${categoryId}/folders`);
    return folders.find((f) => f.name === name) || null;
  }

  // Reuse an existing article by title within its folder, so re-runs don't create
  // duplicate articles (Freshdesk permits duplicate titles, so there's no 409 to
  // rely on — the check-first is the only safeguard besides the idmap).
  async _existingArticle(folderId, title) {
    if (folderId == null) return null;
    const arts = await this._pageAll(`/solutions/folders/${folderId}/articles`);
    return arts.find((a) => a.title === title) || null;
  }

  // Find an existing ticket field by label (cached) so we reuse instead of
  // creating duplicates on re-runs.
  // Promise-memoized: parallel workers share ONE in-flight fetch (no race that
  // would let two workers create the same field twice).
  // The account's real ticket-type names (memoized), for validating an SLA policy's
  // applicable_to.ticket_types — a renamed/removed type would otherwise 400.
  async _ticketTypes() {
    this._ttP ||= (async () => {
      try {
        const { data } = await this.http.get('/admin/ticket_fields');
        const tf = (Array.isArray(data) ? data : []).find((f) => f.name === 'ticket_type');
        if (!tf) return [];
        let choices = tf.choices;
        if (!choices) { try { const { data: full } = await this.http.get(`/admin/ticket_fields/${tf.id}`); choices = full.choices; } catch { choices = null; } }
        const arr = Array.isArray(choices) ? choices : (choices && typeof choices === 'object' ? Object.keys(choices) : []);
        return arr.map((c) => (typeof c === 'string' ? c : (c.value ?? c.label ?? c.name))).filter(Boolean);
      } catch { return []; }
    })();
    return this._ttP;
  }

  async _existingTicketField(label, fresh = false) {
    // `fresh` re-reads live — used after a 409 to catch a field created concurrently
    // by another worker (stale cache) or a default field the first read missed.
    if (fresh || !this._tfCacheP) {
      this._tfCacheP = this.http.get('/admin/ticket_fields').then(({ data }) => (Array.isArray(data) ? data : [])).catch(() => []);
    }
    const list = await this._tfCacheP;
    const norm = (s) => String(s || '').trim().toLowerCase();
    // Match by label case-insensitively, then by the cf_ name Freshdesk derives —
    // a duplicate 409 means one of these already exists, so reuse it not recreate.
    return list.find((f) => norm(f.label) === norm(label)) || null;
  }

  // Resolve a Freshdesk default-role name → its account-specific role_id.
  // Promise-memoized: /roles is fetched once, shared across concurrent callers.
  async roleIdByName(name) {
    this._roleCacheP ||= this.http.get('/roles')
      .then(({ data }) => new Map((Array.isArray(data) ? data : []).map((r) => [String(r.name).toLowerCase(), r.id])))
      .catch(() => new Map());
    const cache = await this._roleCacheP;
    return cache.get(String(name).toLowerCase()) || null;
  }

  // Ensure the searchable provenance custom fields exist (create once, reuse on
  // re-runs), and return their account-specific `cf_*` names. Best-effort: if a
  // field can't be created, its name is null and the connector simply skips it —
  // never blocks ticket migration. Freshdesk derives the cf_ name from the label.
  async ensureMigrationFields() {
    // Promise-memoized: called on EVERY ticket create, which under the concurrent
    // worker pool means many simultaneous callers — they must share ONE creation,
    // or the account fills with duplicate "Original Ticket ID" fields.
    this._migrationFieldsP ||= (async () => {
      const WANTED = { originalId: 'Original Ticket ID', sourcePlatform: 'Source Platform' };
      let existing = new Map();
      try {
        const { data } = await this.http.get('/admin/ticket_fields');
        existing = new Map((Array.isArray(data) ? data : []).map((f) => [f.label, f.name]));
      } catch { /* fall through to create */ }
      const out = {};
      for (const [key, label] of Object.entries(WANTED)) {
        if (existing.has(label)) { out[key] = existing.get(label); continue; }
        try {
          const { data } = await this.http.post('/admin/ticket_fields', {
            body: { label, label_for_customers: label, type: 'custom_text', customers_can_edit: false },
          });
          out[key] = data.name;
        } catch { out[key] = null; }
      }
      return out;
    })();
    return this._migrationFieldsP;
  }

  // Canned responses must live in a folder. Find/create one and cache its id,
  // so macro replies (→ canned responses) have a valid parent.
  async ensureCannedFolder(name = 'Migrated from Zendesk') {
    // Promise-memoized so concurrent macro loads share one folder create.
    this._cannedFolderP ||= (async () => {
      try {
        const { data } = await this.http.get('/canned_response_folders');
        const found = (Array.isArray(data) ? data : []).find((f) => f.name === name);
        if (found) return found.id;
      } catch { /* fall through to create */ }
      const { data } = await this.http.post('/canned_response_folders', { body: { name } });
      return data.id;
    })();
    return this._cannedFolderP;
  }

  // Dedup: reuse an existing contact/company instead of creating a duplicate.
  async findContactByEmail(email) {
    if (!email) return null;
    const { data } = await this.http.get('/contacts', { query: { email } });
    return Array.isArray(data) && data.length ? data[0] : null;
  }
  async findCompanyByName(name) {
    if (!name) return null;
    const { data } = await this.http.get('/companies/autocomplete', { query: { name } });
    const list = data?.companies || data || [];
    return list.find((c) => c.name === name) || null;
  }

  // Count on the target for reconciliation (per-type list endpoints).
  async countExisting(listPath) {
    const { data, headers } = await this.http.get(listPath, { query: { per_page: 1 } });
    const total = headers.get('x-total-count');
    return total ? Number(total) : (Array.isArray(data) ? data.length : 0);
  }
}

export class NoApiError extends Error {
  constructor(targetType) { super(`No public Freshdesk create API for ${targetType}`); this.targetType = targetType; this.noApi = true; }
}

const stripTimestamps = ({ created_at, updated_at, ...rest }) => rest;

// Optional ticket reference fields that must NEVER sink a whole ticket. When
// Freshdesk 400s because one of these points at a record it can't find (an
// assignee/group/company that didn't map, or a stale id), the retry drops just
// that field and the ticket migrates unassigned/ungrouped — the industry
// behaviour (Help Desk Migration does the same). requester_id/email are NOT here
// — those are required and handled upstream (email / unique_external_id fallback).
const DROPPABLE_REF_FIELDS = new Set(['group_id', 'responder_id', 'company_id', 'product_id']);
function offendingRefFields(body) {
  const errs = (body && body.errors) || [];
  const out = new Set();
  for (const e of errs) {
    if (typeof e.field === 'string' && DROPPABLE_REF_FIELDS.has(e.field) && (e.code === 'invalid_value' || e.code === 'invalid_field')) out.add(e.field);
  }
  return [...out];
}

// True when a 400 body complains specifically about created_at/updated_at being
// invalid — i.e. this account/plan won't accept backdated ticket timestamps.
function isTimestampFieldError(body) {
  const errs = body && body.errors;
  if (!Array.isArray(errs)) return false;
  return errs.some((e) => (e.field === 'created_at' || e.field === 'updated_at') && e.code === 'invalid_field');
}

// True when a 400 blames a custom field. Freshdesk reports these three ways:
//   field: "custom_fields"            (whole block)
//   field: "custom_fields.cf_summary" (dotted path — the actual live shape)
//   field: "cf_summary"               (bare)
// The dotted path was previously unmatched, so a bad value sank the whole ticket.
function isCustomFieldError(body) {
  const errs = body && body.errors;
  if (!Array.isArray(errs)) return false;
  return errs.some((e) => typeof e.field === 'string'
    && (e.field === 'custom_fields' || e.field.startsWith('custom_fields.') || e.field.startsWith('cf_')));
}

// The specific cf_* names a 400 blamed, so the retry drops ONLY those and keeps
// every other custom-field value (and the migration provenance fields) intact.
function offendingCustomFields(body) {
  const errs = (body && body.errors) || [];
  const names = new Set();
  for (const e of errs) {
    const f = typeof e.field === 'string' ? e.field : '';
    if (f.startsWith('custom_fields.')) names.add(f.slice('custom_fields.'.length));
    else if (f.startsWith('cf_')) names.add(f);
  }
  return [...names];
}

// Multipart form fields must be strings/Blobs — flatten scalars, JSON-encode the rest.
function flattenForm(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}
