// Reduce whatever the user pasted — a full URL, a bare host, or just the slug —
// to the bare instance slug the connectors expect (they append `.zendesk.com` /
// `.freshdesk.com` themselves). Accepts: "acme", "acme.freshdesk.com",
// "https://acme.zendesk.com/agent/tickets", "ACME.Freshdesk.com/". This is what
// prevents the "…freshdesk.com.freshdesk.com" double-domain error when a user
// pastes their full help-desk URL instead of the raw slug.
export function bareInstance(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  if (!s) return s;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');      // strip scheme (https://)
  s = s.split(/[/?#]/)[0];                            // drop path/query/fragment
  s = s.split('@').pop().split(':')[0];               // drop userinfo + port
  s = s.replace(/\.(zendesk|freshdesk|freshservice|myfreshworks)\.com$/i, ''); // drop known suffix
  return s.replace(/\.+$/, '').toLowerCase();
}

// The normalized Credential every AuthStrategy produces and every connector
// consumes. Connectors/engine never see HOW it was obtained (OAuth vs key vs PAT).
export function makeCredential({
  platform, authType, instanceUrl, subdomain, domain,
  accessToken, refreshToken, expiresAt, apiKey, email, username, password, scopes,
} = {}) {
  return {
    platform, authType,
    instanceUrl: instanceUrl || null,
    subdomain: subdomain ? bareInstance(subdomain) : null,
    domain: domain ? bareInstance(domain) : null,
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    expiresAt: expiresAt || null,     // ISO string
    apiKey: apiKey || null,
    email: email || null,
    username: username || null,
    password: password || null,
    scopes: scopes || null,
  };
}

// OAuth access tokens are refreshed proactively (before a 401), with clock skew.
export const isExpired = (cred, skewMs = 120000) =>
  !!cred?.authType?.includes('oauth') && !!cred.expiresAt && Date.parse(cred.expiresAt) - skewMs < Date.now();
