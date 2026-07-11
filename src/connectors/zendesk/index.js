import { config } from '../../config.js';
import { HttpClient } from '../../lib/httpClient.js';

// entityType → { live endpoint, JSON array key, optional query }
const MAP = {
  groups: { path: '/groups.json', key: 'groups' },
  roles: { path: '/custom_roles.json', key: 'custom_roles' },
  agents: { path: '/users.json', key: 'users', query: { 'role[]': ['agent', 'admin'] } }, // admins are Freshdesk agents too
  organizations: { path: '/organizations.json', key: 'organizations' },
  users: { path: '/users.json', key: 'users', query: { role: 'end-user' } },
  ticketFields: { path: '/ticket_fields.json', key: 'ticket_fields' },
  brands: { path: '/brands.json', key: 'brands' },
  businessHours: { path: '/business_hours/schedules.json', key: 'schedules' },
  slaPolicies: { path: '/slas/policies.json', key: 'sla_policies' },
  triggers: { path: '/triggers.json', key: 'triggers' },
  automations: { path: '/automations.json', key: 'automations' },
  macros: { path: '/macros.json', key: 'macros' },
  kbCategories: { path: '/help_center/categories.json', key: 'categories' },
  kbSections: { path: '/help_center/sections.json', key: 'sections' },
  kbArticles: { path: '/help_center/articles.json', key: 'articles' },
  tickets: { path: '/tickets.json', key: 'tickets' },
};

// Zendesk source connector (extract). Auth is pluggable per the onboarding
// architecture (docs/ONBOARDING-AUTH.md): OAuth bearer (global client) OR the
// email/API-token basic scheme. Credentials come from the project connection.
export class ZendeskSource {
  constructor(creds = {}) {
    const c = { ...config.zendesk, ...creds };
    // Only an explicit string override is honored; otherwise build from the
    // project connection's subdomain (config carries no baseUrl in this flow).
    this.baseUrl = (typeof c.baseUrl === 'string' && c.baseUrl)
      ? c.baseUrl
      : `https://${c.subdomain}.zendesk.com/api/v2`;
    const headers = c.oauthToken
      ? { Authorization: `Bearer ${c.oauthToken}` }
      : { Authorization: `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}` };
    this.http = new HttpClient({ baseUrl: this.baseUrl, rpm: c.rpm || 650, headers });
  }

  supportedTypes() { return Object.keys(MAP); }

  async discover() {
    const counts = {};
    for (const type of this.supportedTypes()) counts[type] = (await this.list(type)).length;
    return counts;
  }

  // All pages for an entity type (cursor/next_page pagination).
  async list(type) {
    const m = MAP[type];
    if (!m) return [];
    const out = [];
    let path = m.path;
    let query = { ...(m.query || {}), per_page: 100 };
    while (path) {
      const { data } = await this.http.get(path, { query });
      out.push(...(data[m.key] || []));
      path = data.next_page ? data.next_page.replace(this.baseUrl, '') : null;
      query = undefined;
    }
    // Zendesk keeps group membership OUT of the user object — join it in so
    // agents migrate WITH their groups (Freshdesk needs the agent in the ticket's
    // group to accept an assignment).
    if (type === 'agents') await this._attachGroupMemberships(out);
    // CC/collaborators are user ids on the ticket; Freshdesk wants emails → resolve.
    if (type === 'tickets') await this._attachCollaboratorEmails(out);
    return out;
  }

  async _attachGroupMemberships(agents) {
    const byUser = new Map();
    let path = '/group_memberships.json';
    let query = { per_page: 100 };
    while (path) {
      const { data } = await this.http.get(path, { query });
      for (const gm of data.group_memberships || []) {
        if (!byUser.has(gm.user_id)) byUser.set(gm.user_id, []);
        byUser.get(gm.user_id).push(gm.group_id);
      }
      path = data.next_page ? data.next_page.replace(this.baseUrl, '') : null;
      query = undefined;
    }
    for (const a of agents) if (!a.group_ids?.length) a.group_ids = byUser.get(a.id) || [];
  }

  async _attachCollaboratorEmails(tickets) {
    const ids = [...new Set(tickets.flatMap((t) => t.collaborator_ids || []))];
    if (!ids.length) return;
    const emailById = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const { data } = await this.http.get('/users/show_many.json', { query: { ids: ids.slice(i, i + 100).join(',') } });
        for (const u of data.users || []) if (u.email) emailById.set(u.id, u.email);
      } catch { /* best-effort */ }
    }
    for (const t of tickets) t.collaborator_emails = (t.collaborator_ids || []).map((id) => emailById.get(id)).filter(Boolean);
  }

  async listComments(ticket) {
    const { data } = await this.http.get(`/tickets/${ticket.id}/comments.json`, { query: { per_page: 100 } });
    return data.comments || [];
  }

  // Stream an attachment's bytes for re-upload to the target.
  async fetchBinary(url) {
    const res = await fetch(url, { headers: this.http.headers });
    if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
