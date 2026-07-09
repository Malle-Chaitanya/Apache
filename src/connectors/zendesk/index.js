import { config } from '../../config.js';
import { HttpClient } from '../../lib/httpClient.js';
import { zendeskFixtures } from './fixtures.js';

// entityType → { fixture key, live endpoint, JSON array key }
const MAP = {
  groups: { fx: 'groups', path: '/groups.json', key: 'groups' },
  roles: { fx: 'roles', path: '/custom_roles.json', key: 'custom_roles' },
  agents: { fx: 'agents', path: '/users.json', key: 'users', query: { 'role[]': 'agent' } },
  organizations: { fx: 'organizations', path: '/organizations.json', key: 'organizations' },
  users: { fx: 'users', path: '/users.json', key: 'users', query: { role: 'end-user' } },
  ticketFields: { fx: 'ticketFields', path: '/ticket_fields.json', key: 'ticket_fields' },
  brands: { fx: 'brands', path: '/brands.json', key: 'brands' },
  businessHours: { fx: 'businessHours', path: '/business_hours/schedules.json', key: 'schedules' },
  slaPolicies: { fx: 'slaPolicies', path: '/slas/policies.json', key: 'sla_policies' },
  triggers: { fx: 'triggers', path: '/triggers.json', key: 'triggers' },
  automations: { fx: 'automations', path: '/automations.json', key: 'automations' },
  macros: { fx: 'macros', path: '/macros.json', key: 'macros' },
  kbCategories: { fx: 'kbCategories', path: '/help_center/categories.json', key: 'categories' },
  kbSections: { fx: 'kbSections', path: '/help_center/sections.json', key: 'sections' },
  kbArticles: { fx: 'kbArticles', path: '/help_center/articles.json', key: 'articles' },
  tickets: { fx: 'tickets', path: '/tickets.json', key: 'tickets' },
};

export class ZendeskSource {
  constructor() {
    this.driver = config.driver;
    if (this.driver === 'live') {
      const auth = Buffer.from(`${config.zendesk.email}/token:${config.zendesk.apiToken}`).toString('base64');
      this.http = new HttpClient({ baseUrl: config.zendesk.baseUrl(), rpm: config.zendesk.rpm, headers: { Authorization: `Basic ${auth}` } });
    }
  }

  supportedTypes() { return Object.keys(MAP); }

  async discover() {
    const counts = {};
    for (const type of this.supportedTypes()) counts[type] = (await this.list(type)).length;
    return counts;
  }

  // Returns the raw source objects for an entity type (all pages).
  async list(type) {
    const m = MAP[type];
    if (!m) return [];
    if (this.driver === 'mock') return structuredClone(zendeskFixtures[m.fx] || []);
    return this._listLive(m);
  }

  async _listLive(m) {
    const out = [];
    let path = m.path;
    let query = { ...(m.query || {}), per_page: 100 };
    // Cursor/offset pagination — Zendesk returns next_page until exhausted.
    while (path) {
      const { data } = await this.http.get(path, { query });
      out.push(...(data[m.key] || []));
      path = data.next_page ? data.next_page.replace(config.zendesk.baseUrl(), '') : null;
      query = undefined; // next_page already carries params
    }
    return out;
  }

  // Ticket comments are a sub-resource in live mode; embedded in mock.
  async listComments(ticket) {
    if (this.driver === 'mock') return ticket.comments || [];
    const { data } = await this.http.get(`/tickets/${ticket.id}/comments.json`, { query: { per_page: 100 } });
    return data.comments || [];
  }
}
