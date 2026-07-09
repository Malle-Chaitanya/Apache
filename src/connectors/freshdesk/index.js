import { config } from '../../config.js';
import { HttpClient } from '../../lib/httpClient.js';

// targetType → how to create it on Freshdesk.
// `path` may be a function of ctx (for sub-resources needing a parent id).
// `creatable:false` = no public create API → loader routes it to conflicts
// (deferred enforcement: Custom App / UI automation / guided spec — see PRD §10).
const TARGET = {
  groups: { path: () => '/groups', creatable: true },
  agents: { path: () => '/agents', creatable: true },
  companies: { path: () => '/companies', creatable: true },
  contacts: { path: () => '/contacts', creatable: true },
  ticketFields: { path: () => '/admin/ticket_fields', creatable: true },
  skills: { path: () => '/skills', creatable: true },
  cannedResponses: { path: (ctx) => `/canned_response_folders/${ctx.folderId}/responses`, creatable: true },
  kbCategories: { path: () => '/solutions/categories', creatable: true },
  kbFolders: { path: (ctx) => `/solutions/categories/${ctx.categoryId}/folders`, creatable: true },
  kbArticles: { path: (ctx) => `/solutions/folders/${ctx.folderId}/articles`, creatable: true },
  tickets: { path: () => '/tickets', creatable: true },
  ticketReply: { path: (ctx) => `/tickets/${ctx.ticketId}/reply`, creatable: true },
  ticketNote: { path: (ctx) => `/tickets/${ctx.ticketId}/notes`, creatable: true },
  // Tier-2 (verify live) / Tier-3 (no create API):
  ticketForms: { path: () => '/admin/forms', creatable: true, verifyLive: true },
  slaPolicies: { path: () => '/sla_policies', creatable: false, verifyLive: true },
  businessHours: { path: () => '/business_hours', creatable: false },
  products: { path: () => '/products', creatable: false },
  roles: { path: () => '/roles', creatable: false },
  automationRules: { path: () => '/automations', creatable: false },
  scenarioAutomations: { path: () => '/scenario_automations', creatable: false },
};

export class FreshdeskTarget {
  constructor() {
    this.driver = config.driver;
    this._mockSeq = 5000;
    this._mockStore = {}; // targetType -> [created payloads] (reconciliation in mock)
    if (this.driver === 'live') {
      const auth = Buffer.from(`${config.freshdesk.apiKey}:X`).toString('base64');
      this.http = new HttpClient({ baseUrl: config.freshdesk.baseUrl(), rpm: config.freshdesk.rpm, headers: { Authorization: `Basic ${auth}` } });
    }
  }

  capability(targetType) {
    const t = TARGET[targetType];
    return { known: !!t, creatable: !!t?.creatable, verifyLive: !!t?.verifyLive };
  }

  // Create one object. Returns { id } (Freshdesk id).
  async create(targetType, payload, ctx = {}) {
    const t = TARGET[targetType];
    if (!t) throw new Error(`Unknown target type: ${targetType}`);
    if (!t.creatable) throw new NoApiError(targetType);

    if (this.driver === 'mock') {
      const id = this._mockSeq++;
      (this._mockStore[targetType] ||= []).push({ id, ...payload });
      return { id };
    }
    const { data } = await this.http.post(t.path(ctx), { body: payload });
    return { id: data.id, raw: data };
  }

  async countCreated(targetType) {
    if (this.driver === 'mock') return (this._mockStore[targetType] || []).length;
    return null; // live reconciliation reads target list endpoints (not shown here)
  }
}

// Signals "no public create API" — loader converts to a conflict/manual item.
export class NoApiError extends Error {
  constructor(targetType) { super(`No public Freshdesk create API for ${targetType}`); this.targetType = targetType; this.noApi = true; }
}
