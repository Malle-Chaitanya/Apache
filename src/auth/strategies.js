import { makeCredential, bareInstance } from './credential.js';

// ─────────────────────────────────────────────────────────────
// AuthStrategy layer. One uniform "Connect" UX; the strategy behind it varies
// per platform. Every strategy yields a normalized Credential (credential.js).
//   describe()      → what the UI should render (redirect vs form fields)
//   authorizeUrl()  → OAuth redirect target (oauth only)
//   exchangeCode()  → OAuth code → Credential (oauth only)
//   fromFields()    → pasted fields → Credential (api_key/pat/basic)
//   refresh()       → refreshed Credential (oauth only)
//   connectorCreds()→ shape the connector constructor expects
// ─────────────────────────────────────────────────────────────

const env = (name) => process.env[name] || '';

export const PLATFORMS = {
  zendesk: {
    defaultAuthType: 'oauth',
    instanceField: 'subdomain',
    oauth: {
      authorizeUrl: (inst) => `https://${inst}.zendesk.com/oauth/authorizations/new`,
      tokenUrl: (inst) => `https://${inst}.zendesk.com/oauth/tokens`,
      scopes: ['read', 'write'], clientIdEnv: 'ZENDESK_CLIENT_ID', clientSecretEnv: 'ZENDESK_CLIENT_SECRET',
    },
    fields: { oauth: ['subdomain'], api_token: ['subdomain', 'email', 'apiToken'] },
    connectorCreds: (c) => c.accessToken
      ? { subdomain: c.subdomain, oauthToken: c.accessToken }
      : { subdomain: c.subdomain, email: c.email, apiToken: c.apiKey },
  },
  freshdesk: {
    defaultAuthType: 'api_key',
    fields: { api_key: ['domain', 'apiKey'] },
    connectorCreds: (c) => ({ domain: c.domain, apiKey: c.apiKey }),
  },
  freshservice: {
    defaultAuthType: 'api_key',
    fields: { api_key: ['domain', 'apiKey'] },
    connectorCreds: (c) => ({ domain: c.domain, apiKey: c.apiKey }),
  },
  jira: {
    defaultAuthType: 'oauth',
    oauth: {
      authorizeUrl: () => 'https://auth.atlassian.com/authorize',
      tokenUrl: () => 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
      clientIdEnv: 'JIRA_CLIENT_ID', clientSecretEnv: 'JIRA_CLIENT_SECRET', audience: 'api.atlassian.com',
    },
    fields: { oauth: [] },
    connectorCreds: (c) => ({ accessToken: c.accessToken, cloudId: c.instanceUrl }),
  },
  servicenow: {
    defaultAuthType: 'instance_oauth',
    fields: { instance_oauth: ['instanceUrl', 'clientId', 'clientSecret', 'username', 'password'] },
    connectorCreds: (c) => ({ instanceUrl: c.instanceUrl, accessToken: c.accessToken }),
  },
};

const expiresAtFrom = (sec) => new Date(Date.now() + (Number(sec) || 3600) * 1000).toISOString();

async function postToken(url, body, style = 'json') {
  const init = style === 'json'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
    : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() };
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Field-based auth: API key, API token, PAT, basic. No redirect.
class FormStrategy {
  describe(platform, authType) { return { authType, mode: 'form', fields: PLATFORMS[platform].fields[authType] || [] }; }
  fromFields(platform, authType, f = {}) {
    const base = { platform, authType };
    if (authType === 'api_key') return makeCredential({ ...base, apiKey: f.apiKey, domain: f.domain, instanceUrl: f.instanceUrl });
    if (authType === 'api_token') return makeCredential({ ...base, apiKey: f.apiToken, email: f.email, subdomain: f.subdomain });
    if (authType === 'pat') return makeCredential({ ...base, accessToken: f.token, instanceUrl: f.instanceUrl });
    if (authType === 'basic') return makeCredential({ ...base, username: f.username, password: f.password, instanceUrl: f.instanceUrl, domain: f.domain });
    throw new Error(`FormStrategy cannot handle authType ${authType}`);
  }
  connectorCreds(platform, cred) { return PLATFORMS[platform].connectorCreds(cred); }
}

// OAuth 2.0 Authorization Code (Zendesk global client, Atlassian 3LO).
class OAuthStrategy {
  describe(platform) { return { authType: 'oauth', mode: 'redirect', instanceField: PLATFORMS[platform].instanceField || null }; }
  authorizeUrl(platform, { instance, state, redirectUri }) {
    instance = bareInstance(instance);
    const o = PLATFORMS[platform].oauth;
    const p = new URLSearchParams({
      response_type: 'code', client_id: env(o.clientIdEnv), redirect_uri: redirectUri,
      scope: o.scopes.join(' '), state,
    });
    if (o.audience) { p.set('audience', o.audience); p.set('prompt', 'consent'); }
    return `${o.authorizeUrl(instance)}?${p.toString()}`;
  }
  async exchangeCode(platform, { code, redirectUri, instance }) {
    instance = bareInstance(instance);
    const o = PLATFORMS[platform].oauth;
    const t = await postToken(o.tokenUrl(instance), {
      grant_type: 'authorization_code', code, client_id: env(o.clientIdEnv), client_secret: env(o.clientSecretEnv),
      redirect_uri: redirectUri, scope: o.scopes.join(' '),
    });
    return makeCredential({
      platform, authType: 'oauth', subdomain: instance, instanceUrl: instance,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAtFrom(t.expires_in), scopes: o.scopes,
    });
  }
  async refresh(platform, cred) {
    const o = PLATFORMS[platform].oauth;
    const t = await postToken(o.tokenUrl(cred.subdomain), {
      grant_type: 'refresh_token', refresh_token: cred.refreshToken, client_id: env(o.clientIdEnv), client_secret: env(o.clientSecretEnv),
    });
    return makeCredential({
      ...cred, accessToken: t.access_token, refreshToken: t.refresh_token || cred.refreshToken, expiresAt: expiresAtFrom(t.expires_in),
    });
  }
  connectorCreds(platform, cred) { return PLATFORMS[platform].connectorCreds(cred); }
}

// ServiceNow: customer registers an Application Registry entry in THEIR instance,
// gives us client id/secret (+ integration user) → password grant per instance.
class InstanceOAuthStrategy {
  describe(platform) { return { authType: 'instance_oauth', mode: 'form', fields: PLATFORMS[platform].fields.instance_oauth }; }
  async fromFields(platform, _authType, f = {}) {
    const t = await postToken(`${f.instanceUrl.replace(/\/$/, '')}/oauth_token.do`, {
      grant_type: 'password', client_id: f.clientId, client_secret: f.clientSecret, username: f.username, password: f.password,
    }, 'form');
    return makeCredential({
      platform, authType: 'instance_oauth', instanceUrl: f.instanceUrl,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAtFrom(t.expires_in),
    });
  }
  async refresh(platform, cred) {
    const t = await postToken(`${cred.instanceUrl.replace(/\/$/, '')}/oauth_token.do`, {
      grant_type: 'refresh_token', refresh_token: cred.refreshToken,
    }, 'form');
    return makeCredential({ ...cred, accessToken: t.access_token, refreshToken: t.refresh_token || cred.refreshToken, expiresAt: expiresAtFrom(t.expires_in) });
  }
  connectorCreds(platform, cred) { return PLATFORMS[platform].connectorCreds(cred); }
}

const OAUTH = new OAuthStrategy();
const FORM = new FormStrategy();
const INSTANCE = new InstanceOAuthStrategy();

// Pick the strategy for an (platform, authType). authType defaults to the
// platform's default (e.g. Zendesk=oauth) but callers can override (Zendesk=api_token).
export function strategyFor(platform, authType) {
  const meta = PLATFORMS[platform];
  if (!meta) throw new Error(`Unknown platform: ${platform}`);
  const type = authType || meta.defaultAuthType;
  if (type === 'oauth') return { strategy: OAUTH, authType: type };
  if (type === 'instance_oauth') return { strategy: INSTANCE, authType: type };
  return { strategy: FORM, authType: type }; // api_key | api_token | pat | basic
}
