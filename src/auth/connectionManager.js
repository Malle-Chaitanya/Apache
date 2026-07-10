import { repo } from '../db/repository.js';
import { getSecretService } from '../secrets/secretService.js';
import { strategyFor, PLATFORMS } from './strategies.js';
import { isExpired } from './credential.js';

// ─────────────────────────────────────────────────────────────
// ConnectionManager — the ONLY thing the engine and routes call for auth.
//
// GEM_CO model: credentials live in USER-SCOPED `cloudAccounts` (connect once,
// reuse across every migration). A project references one account per side, so
// users never re-enter API keys. The engine still calls get(projectId, side);
// internally that resolves the project's chosen account → decrypts → refreshes.
// ─────────────────────────────────────────────────────────────

export class ReauthRequiredError extends Error {
  constructor(side, platform) { super(`Re-authentication required for ${side} (${platform})`); this.reauth = true; this.side = side; this.platform = platform; }
}

// OAuth `state`: accounts use "a|<accountId>"; legacy project flow uses "<projectId>|<side>".
const encodeAcct = (accountId) => Buffer.from(`a|${accountId}`).toString('base64url');
const encodeState = (projectId, side) => Buffer.from(`${projectId}|${side}`).toString('base64url');
function decodeState(s) {
  const parts = Buffer.from(s, 'base64url').toString().split('|');
  return parts[0] === 'a' ? { account: true, accountId: parts[1] } : { projectId: parts[0], side: parts[1] };
}

class ConnectionManager {
  get secrets() { return getSecretService(); }

  // ═══ Cloud accounts (user-scoped, reusable) ═══════════════════

  async listAccounts(appUserId) {
    return (await repo('cloudAccounts').find({ appUserId }))
      .filter((a) => a.status !== 'deleted')
      .map((a) => this._safeAccount(a));
  }

  // Step 1: begin adding an account — OAuth redirect or a field form.
  async beginAddAccount(appUserId, platform, { authType, instance, redirectUri } = {}) {
    const { strategy, authType: type } = strategyFor(platform, authType);
    const acct = await repo('cloudAccounts').insertOne({ appUserId, platform, authType: type, instance: instance || null, status: 'pending' });
    const desc = strategy.describe(platform, type);
    if (desc.mode === 'redirect') {
      return { mode: 'redirect', authType: type, accountId: String(acct._id),
        redirectUrl: strategy.authorizeUrl(platform, { instance, state: encodeAcct(acct._id), redirectUri }) };
    }
    return { mode: 'form', authType: type, accountId: String(acct._id), fields: desc.fields };
  }

  // Step 2: complete — exchange OAuth code / accept fields → persist encrypted.
  async completeAddAccount(appUserId, { accountId, platform, authType, fields, code, instance, redirectUri } = {}) {
    const acct = accountId ? await repo('cloudAccounts').findOne({ _id: accountId }) : null;
    if (acct && String(acct.appUserId) !== String(appUserId)) throw new Error('forbidden');
    const p = platform || acct?.platform;
    const { strategy, authType: type } = strategyFor(p, authType || acct?.authType);
    const inst = instance || acct?.instance;

    const credential = type === 'oauth'
      ? await strategy.exchangeCode(p, { code, redirectUri, instance: inst })
      : await strategy.fromFields(p, type, fields || {});

    let secretId = acct?.secretId;
    if (secretId) await this.secrets.update(secretId, credential); else secretId = await this.secrets.create(credential);

    const doc = {
      appUserId, platform: p, authType: type, secretId,
      label: credential.subdomain || credential.domain || credential.instanceUrl || inst || p,
      subdomain: credential.subdomain, domain: credential.domain, instanceUrl: credential.instanceUrl,
      scopes: credential.scopes, status: 'connected', error: null, lastValidatedAt: new Date(),
    };
    const saved = acct
      ? await repo('cloudAccounts').updateOne({ _id: acct._id }, doc)
      : await repo('cloudAccounts').insertOne(doc);
    return this._safeAccount(saved);
  }

  reconnectAccount(appUserId, accountId, input) { return this.completeAddAccount(appUserId, { ...input, accountId }); }

  async deleteAccount(appUserId, accountId) {
    const acct = await repo('cloudAccounts').findOne({ _id: accountId });
    if (!acct || String(acct.appUserId) !== String(appUserId)) throw new Error('not found');
    if (acct.secretId) await this.secrets.remove(acct.secretId);
    await repo('cloudAccounts').updateOne({ _id: accountId }, { status: 'deleted', secretId: null });
    return { deleted: true };
  }

  // Resolve an account's live connector creds (refresh OAuth transparently).
  async getAccountCreds(accountId) {
    const acct = await repo('cloudAccounts').findOne({ _id: accountId });
    if (!acct || acct.status === 'reauth_required') { const e = new Error('re-authentication required'); e.reauth = true; e.platform = acct?.platform; throw e; }
    if (acct.status !== 'connected') throw new Error('account not connected');
    let cred = await this.secrets.get(acct.secretId);
    if (isExpired(cred)) {
      const { strategy } = strategyFor(acct.platform, acct.authType);
      try { cred = await strategy.refresh(acct.platform, cred); await this.secrets.update(acct.secretId, cred); }
      catch (err) {
        await repo('cloudAccounts').updateOne({ _id: accountId }, { status: 'reauth_required', error: `token refresh failed: ${err.message}` });
        const e = new Error('re-authentication required'); e.reauth = true; e.platform = acct.platform; throw e;
      }
    }
    return { platform: acct.platform, connectorCreds: PLATFORMS[acct.platform].connectorCreds(cred), accountId: String(acct._id) };
  }

  // ═══ Engine entrypoint ════════════════════════════════════════
  // Resolves the project's selected account for a side. Falls back to the
  // legacy project-scoped connection if a project predates cloud accounts.
  async get(projectId, side) {
    const project = await repo('projects').findOne({ _id: projectId });
    const accountId = project?.[side]?.accountId;
    if (accountId) {
      try { return await this.getAccountCreds(accountId); }
      catch (e) { if (e.reauth) throw new ReauthRequiredError(side, e.platform || project[side].platform); throw e; }
    }
    return this._getLegacy(projectId, side);
  }

  async markReauthRequired(projectId, side, message) {
    const project = await repo('projects').findOne({ _id: projectId });
    const accountId = project?.[side]?.accountId;
    if (accountId) return void repo('cloudAccounts').updateOne({ _id: accountId }, { status: 'reauth_required', error: message || 'authentication failed' });
    await repo('connections').updateOne({ projectId, side }, { status: 'reauth_required', error: message || 'authentication failed' });
  }

  // OAuth callback → account flow or legacy project flow, by state.
  async handleOAuthCallback(state, code, redirectUri) {
    const decoded = decodeState(state);
    if (decoded.account) {
      const acct = await repo('cloudAccounts').findOne({ _id: decoded.accountId });
      if (!acct) throw new Error('no pending account for callback state');
      return this.completeAddAccount(acct.appUserId, { accountId: decoded.accountId, platform: acct.platform, authType: 'oauth', code, redirectUri, instance: acct.instance });
    }
    const conn = await repo('connections').findOne({ projectId: decoded.projectId, side: decoded.side });
    if (!conn) throw new Error('no pending connection for callback state');
    return this.completeConnect(decoded.projectId, decoded.side, conn.platform, { authType: 'oauth', code, redirectUri, instance: conn.instance });
  }

  // ═══ Legacy project-scoped connection (back-compat) ═══════════
  async beginConnect(projectId, side, platform, { authType, redirectUri, instance } = {}) {
    const { strategy, authType: type } = strategyFor(platform, authType);
    await repo('connections').upsert({ projectId, side }, { projectId, side, platform, authType: type, instance: instance || null, status: 'pending', error: null });
    const desc = strategy.describe(platform, type);
    if (desc.mode === 'redirect') return { mode: 'redirect', authType: type, redirectUrl: strategy.authorizeUrl(platform, { instance, state: encodeState(projectId, side), redirectUri }) };
    return { mode: 'form', authType: type, fields: desc.fields };
  }
  async completeConnect(projectId, side, platform, { authType, code, redirectUri, instance, fields } = {}) {
    const conn = await repo('connections').findOne({ projectId, side });
    const { strategy, authType: type } = strategyFor(platform, authType || conn?.authType);
    const inst = instance || conn?.instance;
    const credential = type === 'oauth' ? await strategy.exchangeCode(platform, { code, redirectUri, instance: inst }) : await strategy.fromFields(platform, type, fields || {});
    let secretId = conn?.secretId;
    if (secretId) await this.secrets.update(secretId, credential); else secretId = await this.secrets.create(credential);
    const connDoc = await repo('connections').upsert({ projectId, side },
      { projectId, side, platform, authType: type, secretId, subdomain: credential.subdomain, domain: credential.domain, instanceUrl: credential.instanceUrl,
        instance: inst || credential.subdomain || null, scopes: credential.scopes, status: 'connected', error: null, lastValidatedAt: new Date() });
    return this._safe(connDoc);
  }
  reconnect(projectId, side, platform, input) { return this.completeConnect(projectId, side, platform, input); }
  async _getLegacy(projectId, side) {
    const conn = await repo('connections').findOne({ projectId, side });
    if (!conn || conn.status === 'pending') throw new Error(`${side} not connected`);
    if (conn.status === 'reauth_required') throw new ReauthRequiredError(side, conn.platform);
    let credential = await this.secrets.get(conn.secretId);
    if (isExpired(credential)) {
      const { strategy } = strategyFor(conn.platform, conn.authType);
      try { credential = await strategy.refresh(conn.platform, credential); await this.secrets.update(conn.secretId, credential); }
      catch (err) { await this.markReauthRequired(projectId, side, `token refresh failed: ${err.message}`); throw new ReauthRequiredError(side, conn.platform); }
    }
    return { platform: conn.platform, connection: this._safe(conn), connectorCreds: PLATFORMS[conn.platform].connectorCreds(credential) };
  }
  async list(projectId) { return (await repo('connections').find({ projectId })).map((c) => this._safe(c)); }

  _safe(conn) { if (!conn) return null; const { secretId, ...rest } = conn; return rest; }
  _safeAccount(a) { if (!a) return null; const { secretId, ...rest } = a; return rest; }
}

export const connectionManager = new ConnectionManager();
