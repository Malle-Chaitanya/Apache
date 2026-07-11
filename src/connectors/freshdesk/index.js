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
    // Agents: resolve the mapped role NAME → this account's numeric role_id.
    // Freshdesk role_ids are account-specific, so we look them up live (cached).
    if (targetType === 'agents' && ctx.role) {
      const roleId = await this.roleIdByName(ctx.role);
      if (roleId) payload = { ...payload, role_ids: [roleId] };
    }
    const { data } = ctx.attachments?.length
      ? await this.http.post(t.path(ctx), { multipart: { fields: flattenForm(payload), files: ctx.attachments } })
      : await this.http.post(t.path(ctx), { body: payload });
    return { id: data.id, raw: data };
  }

  // Resolve a Freshdesk default-role name → its account-specific role_id.
  // Cached: /roles is a small, static list per account.
  async roleIdByName(name) {
    if (!this._roleCache) {
      const { data } = await this.http.get('/roles');
      this._roleCache = new Map((Array.isArray(data) ? data : []).map((r) => [String(r.name).toLowerCase(), r.id]));
    }
    return this._roleCache.get(String(name).toLowerCase()) || null;
  }

  // Canned responses must live in a folder. Find/create one and cache its id,
  // so macro replies (→ canned responses) have a valid parent.
  async ensureCannedFolder(name = 'Migrated from Zendesk') {
    if (this._cannedFolderId) return this._cannedFolderId;
    try {
      const { data } = await this.http.get('/canned_response_folders');
      const found = (Array.isArray(data) ? data : []).find((f) => f.name === name);
      if (found) { this._cannedFolderId = found.id; return found.id; }
    } catch { /* fall through to create */ }
    const { data } = await this.http.post('/canned_response_folders', { body: { name } });
    this._cannedFolderId = data.id;
    return data.id;
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

// Multipart form fields must be strings/Blobs — flatten scalars, JSON-encode the rest.
function flattenForm(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}
