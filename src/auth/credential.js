// The normalized Credential every AuthStrategy produces and every connector
// consumes. Connectors/engine never see HOW it was obtained (OAuth vs key vs PAT).
export function makeCredential({
  platform, authType, instanceUrl, subdomain, domain,
  accessToken, refreshToken, expiresAt, apiKey, email, username, password, scopes,
} = {}) {
  return {
    platform, authType,
    instanceUrl: instanceUrl || null,
    subdomain: subdomain || null,
    domain: domain || null,
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
