// API client with Layer-1 (portal) auth. The JWT is attached to every request;
// a 401 clears the session so the app falls back to the login screen.
let token = localStorage.getItem('cf_token');

function hdr(json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
async function handle(r) {
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { auth.set(null); const e = new Error('session expired'); e.unauth = true; throw e; }
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.reauth = data.reauth; e.status = r.status; throw e; }
  return data;
}
const get = (url) => fetch(url, { headers: hdr(false) }).then(handle);
const post = (url, body) => fetch(url, { method: 'POST', headers: hdr(true), body: JSON.stringify(body || {}) }).then(handle);
const del = (url) => fetch(url, { method: 'DELETE', headers: hdr(false) }).then(handle);

export const auth = {
  token: () => token,
  set: (t) => { token = t; if (t) localStorage.setItem('cf_token', t); else localStorage.removeItem('cf_token'); },
  login: async (email, password) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'login failed');
    auth.set(d.token);
    return d.user;
  },
  me: () => get('/api/auth/me'),
  logout: () => auth.set(null),
};

export const api = {
  config: () => get('/api/config'),

  // Cloud accounts (user-scoped, reusable — connect once, use everywhere)
  listAccounts: () => get('/api/accounts'),
  beginAddAccount: (body) => post('/api/accounts/begin', body),
  completeAddAccount: (body) => post('/api/accounts/complete', body),
  completeOAuth: (code, state) => post('/api/oauth/complete', { code, state }),
  reconnectAccount: (accountId, body) => post(`/api/accounts/${accountId}/reconnect`, body),
  deleteAccount: (accountId) => del(`/api/accounts/${accountId}`),

  createProject: (body) => post('/api/projects', body),
  getProject: (id) => get(`/api/projects/${id}`),
  listConnections: (id) => get(`/api/projects/${id}/connections`),
  beginConnect: (id, side, body) => post(`/api/projects/${id}/connections/${side}/begin`, body),
  completeConnect: (id, side, body) => post(`/api/projects/${id}/connections/${side}/complete`, body),
  reconnect: (id, side, body) => post(`/api/projects/${id}/connections/${side}/reconnect`, body),
  run: (id, dryRun) => post(`/api/projects/${id}/run`, { dryRun }),
  scan: (id) => get(`/api/projects/${id}/scan`),
  matrix: (id) => get(`/api/projects/${id}/matrix`),
  report: (id) => get(`/api/projects/${id}/report`),
  conflicts: (id) => get(`/api/projects/${id}/conflicts`),
  events: (id, n = 500) => get(`/api/projects/${id}/events?n=${n}`),
  failures: (id) => get(`/api/projects/${id}/failures`),
};
