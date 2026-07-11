import { Router } from 'express';
import { repo, storeKind } from '../db/repository.js';
import { config } from '../config.js';
import { runMigration } from '../engine/orchestrator.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';
import { connectionManager } from '../auth/connectionManager.js';
import { requireAuth, login as portalLogin } from '../auth/appAuth.js';
import { sourcePlatforms, targetPlatforms, makeSource } from '../connectors/registry.js';
import { log } from '../lib/logger.js';

export function apiRouter() {
  const r = Router();

  // ── Public ──
  r.get('/config', (_req, res) => res.json({ store: storeKind(), sources: sourcePlatforms(), targets: targetPlatforms() }));

  r.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      res.json(await portalLogin(email, password));
    } catch { res.status(401).json({ error: 'invalid email or password' }); }
  });

  // OAuth provider redirect target (no bearer token here — resolved via state).
  r.get('/oauth/callback', async (req, res, next) => {
    try { await connectionManager.handleOAuthCallback(req.query.state, req.query.code, config.oauthRedirectUri); res.redirect('/?connected=1'); }
    catch (e) { next(e); }
  });

  // ── Everything below requires a valid session ──
  r.use(requireAuth());

  r.get('/auth/me', (req, res) => res.json(req.appUser));

  // ── Cloud accounts (user-scoped, reusable — connect once, use everywhere) ──
  r.get('/accounts', async (req, res) => res.json(await connectionManager.listAccounts(req.appUserId)));
  r.post('/accounts/begin', async (req, res, next) => {
    try { const { platform, authType, instance } = req.body || {};
      res.json(await connectionManager.beginAddAccount(req.appUserId, platform, { authType, instance, redirectUri: config.oauthRedirectUri })); }
    catch (e) { next(e); }
  });
  r.post('/accounts/complete', async (req, res, next) => {
    try { const { accountId, platform, authType, fields, code, instance } = req.body || {};
      res.json(await connectionManager.completeAddAccount(req.appUserId, { accountId, platform, authType, fields, code, instance, redirectUri: config.oauthRedirectUri })); }
    catch (e) { next(e); }
  });
  r.post('/accounts/:accountId/reconnect', async (req, res, next) => {
    try { const { platform, authType, fields, code, instance } = req.body || {};
      res.json(await connectionManager.reconnectAccount(req.appUserId, req.params.accountId, { platform, authType, fields, code, instance, redirectUri: config.oauthRedirectUri })); }
    catch (e) { next(e); }
  });
  r.delete('/accounts/:accountId', async (req, res, next) => {
    try { res.json(await connectionManager.deleteAccount(req.appUserId, req.params.accountId)); } catch (e) { next(e); }
  });

  // SPA OAuth return: the frontend (redirect_uri = the app itself) posts the
  // ?code&state it received back here to finish the token exchange.
  r.post('/oauth/complete', async (req, res, next) => {
    try { const { code, state } = req.body || {};
      res.json(await connectionManager.handleOAuthCallback(state, code, config.oauthRedirectUri)); }
    catch (e) { next(e); }
  });

  // Ownership guard: any /:id route must belong to the logged-in user.
  r.param('id', async (req, res, next, id) => {
    const p = await repo('projects').findOne({ _id: id });
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.appUserId && p.appUserId !== req.appUserId) return res.status(403).json({ error: 'forbidden' });
    req.project = p;
    next();
  });

  // ── Projects (scoped to owner) ──
  // A side may be given as { accountId } (reuse a saved cloud account) or just
  // { platform } (legacy per-project connect). accountId is validated to belong
  // to the logged-in user, and the platform is derived from the account.
  r.post('/projects', async (req, res, next) => {
    try {
      const { name = 'Untitled migration', source = {}, target = {} } = req.body || {};
      const resolveSide = async (sideObj, defPlatform) => {
        if (sideObj.accountId) {
          const acc = await repo('cloudAccounts').findOne({ _id: sideObj.accountId });
          if (!acc || String(acc.appUserId) !== String(req.appUserId) || acc.status === 'deleted') throw new Error('invalid account');
          return { platform: acc.platform, accountId: String(acc._id) };
        }
        return { platform: sideObj.platform || defPlatform };
      };
      const project = await repo('projects').insertOne({
        appUserId: req.appUserId, name,
        source: await resolveSide(source, 'zendesk'),
        target: await resolveSide(target, 'freshdesk'),
        options: { migrateConfig: true, migrateData: true, dryRun: false },
        status: 'created', currentPhase: 'connect',
      });
      res.status(201).json(project);
    } catch (e) { next(e); }
  });
  r.get('/projects', async (req, res) => res.json(await repo('projects').find({ appUserId: req.appUserId })));
  r.get('/projects/:id', (req, res) => res.json(req.project));

  // ── Connections (Connect Source / Connect Target) ──
  r.post('/projects/:id/connections/:side/begin', async (req, res, next) => {
    try {
      const { platform, authType, instance } = req.body || {};
      res.json(await connectionManager.beginConnect(req.params.id, req.params.side, platform, { authType, instance, redirectUri: config.oauthRedirectUri }));
    } catch (e) { next(e); }
  });
  r.post('/projects/:id/connections/:side/complete', async (req, res, next) => {
    try {
      const { platform, authType, fields, code, instance } = req.body || {};
      res.json(await connectionManager.completeConnect(req.params.id, req.params.side, platform, { authType, fields, code, instance, redirectUri: config.oauthRedirectUri }));
    } catch (e) { next(e); }
  });
  r.post('/projects/:id/connections/:side/reconnect', async (req, res, next) => {
    try {
      const { platform, authType, fields, code, instance } = req.body || {};
      res.json(await connectionManager.reconnect(req.params.id, req.params.side, platform, { authType, fields, code, instance, redirectUri: config.oauthRedirectUri }));
    } catch (e) { next(e); }
  });
  r.get('/projects/:id/connections', async (req, res) => res.json(await connectionManager.list(req.params.id)));

  // ── Run + monitor ──
  r.post('/projects/:id/run', async (req, res) => {
    const dryRun = !!(req.body && req.body.dryRun);
    // Flip to 'running' synchronously so the next status poll never reads the
    // previous run's terminal status (e.g. a dry run's 'completed') and mistakes
    // this fresh run for one that already finished.
    await repo('projects').updateOne({ _id: req.params.id }, { status: 'running', currentPhase: 'connect' });
    runMigration(req.params.id, { dryRun }).catch((e) => log.error(`run error: ${e.message}`));
    res.status(202).json({ started: true, dryRun });
  });
  r.get('/projects/:id/matrix', async (req, res) => {
    const id = req.params.id; const rows = [];
    for (const type of LOAD_ORDER) {
      const m = MATRIX[type];
      rows.push({ type, domain: m.domain, targetType: m.targetType, feasibility: m.feasibility,
        source: await repo(type).count({ projectId: id }), migrated: await repo(type).count({ projectId: id, status: 'loaded' }),
        validated: await repo(type).count({ projectId: id, status: 'validated' }),
        manual: await repo(type).count({ projectId: id, status: 'manual' }), failed: await repo(type).count({ projectId: id, status: 'failed' }) });
    }
    res.json(rows);
  });

  // Source scan — reads live counts from the source (the same discover() the
  // orchestrator runs) so "Select data" can show how much is picked up and what
  // will migrate, before any dry run. Mapped through MATRIX for target/domain.
  r.get('/projects/:id/scan', async (req, res, next) => {
    try {
      const p = req.project;
      const creds = await connectionManager.get(p._id, 'source');
      const source = makeSource(p.source.platform, creds.connectorCreds);
      const counts = await source.discover();
      const rows = [];
      let config = 0, data = 0;
      for (const type of LOAD_ORDER) {
        const m = MATRIX[type];
        const count = counts[type] || 0;
        rows.push({ type, targetType: m.targetType, domain: m.domain, count });
        if (m.domain === 'config') config += count; else data += count;
      }
      res.json({ rows, totals: { config, data, all: config + data } });
    } catch (e) { next(e); }
  });
  r.get('/projects/:id/report', async (req, res) => { const rep = await repo('reports').findOne({ projectId: req.params.id }); res.json(rep?.summary || null); });
  r.get('/projects/:id/conflicts', async (req, res) => res.json(await repo('conflicts').find({ projectId: req.params.id })));
  r.get('/projects/:id/events', async (req, res) => { const e = await repo('events').find({ projectId: req.params.id }); res.json(e.slice(-Number(req.query.n || 500))); });

  // Per-record failures across every object type (for the failures export/log).
  r.get('/projects/:id/failures', async (req, res) => {
    const id = req.params.id; const out = [];
    for (const type of LOAD_ORDER) {
      for (const row of await repo(type).find({ projectId: id, status: 'failed' })) {
        const last = (row.errors || []).slice(-1)[0];
        out.push({ type, sourceId: row.sourceId, error: last?.message || 'failed', at: last?.at || row.updatedAt });
      }
    }
    res.json(out);
  });

  // Error handler — surfaces reauth prompts distinctly.
  r.use((err, _req, res, _next) => {
    log.error(`api error: ${err.message}`);
    res.status(err.reauth ? 409 : 400).json({ error: err.message, reauth: !!err.reauth });
  });

  return r;
}
