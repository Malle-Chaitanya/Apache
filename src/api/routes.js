import { Router } from 'express';
import { repo, clearAll, storeKind } from '../db/repository.js';
import { config } from '../config.js';
import { runMigration } from '../engine/orchestrator.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';
import { log } from '../lib/logger.js';

export function apiRouter() {
  const r = Router();

  r.get('/config', (_req, res) => res.json({ store: storeKind(), driver: config.driver, source: 'zendesk', target: 'freshdesk' }));

  // Create a project (defaults suit the mock demo).
  r.post('/projects', async (req, res) => {
    const { name = 'Acme Zendesk → Freshdesk', dryRun = false } = req.body || {};
    const project = await repo('projects').insertOne({
      name, source: { platform: 'zendesk', subdomain: config.zendesk.subdomain || 'acme' },
      target: { platform: 'freshdesk', domain: config.freshdesk.domain || 'acme' },
      options: { migrateConfig: true, migrateData: true, dryRun }, status: 'created', currentPhase: 'connect',
    });
    res.status(201).json(project);
  });

  r.get('/projects', async (_req, res) => res.json(await repo('projects').find({})));
  r.get('/projects/:id', async (req, res) => {
    const p = await repo('projects').findOne({ _id: req.params.id });
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json(p);
  });

  // Kick off a migration run (async — dashboard polls status/report).
  r.post('/projects/:id/run', async (req, res) => {
    const id = req.params.id;
    const dryRun = !!(req.body && req.body.dryRun);
    const p = await repo('projects').findOne({ _id: id });
    if (!p) return res.status(404).json({ error: 'not found' });
    runMigration(id, { dryRun }).catch((e) => log.error(`run error: ${e.message}`));
    res.status(202).json({ started: true, dryRun });
  });

  // Mapping matrix + live per-type counts (the feasibility preview).
  r.get('/projects/:id/matrix', async (req, res) => {
    const id = req.params.id;
    const rows = [];
    for (const type of LOAD_ORDER) {
      const m = MATRIX[type];
      const source = await repo(type).count({ projectId: id });
      const migrated = await repo(type).count({ projectId: id, status: 'loaded' });
      const manual = await repo(type).count({ projectId: id, status: 'manual' });
      const failed = await repo(type).count({ projectId: id, status: 'failed' });
      rows.push({ type, domain: m.domain, targetType: m.targetType, feasibility: m.feasibility, source, migrated, manual, failed });
    }
    res.json(rows);
  });

  r.get('/projects/:id/report', async (req, res) => {
    const rep = await repo('reports').findOne({ projectId: req.params.id });
    res.json(rep?.summary || null);
  });
  r.get('/projects/:id/conflicts', async (req, res) => res.json(await repo('conflicts').find({ projectId: req.params.id })));
  r.get('/projects/:id/events', async (req, res) => {
    const events = await repo('events').find({ projectId: req.params.id });
    res.json(events.slice(-Number(req.query.n || 60)));
  });
  r.get('/projects/:id/entities/:type', async (req, res) => {
    const rows = await repo(req.params.type).find({ projectId: req.params.id }, { limit: Number(req.query.limit || 25) });
    res.json(rows);
  });

  // Demo convenience: wipe + create a fresh project in one call.
  r.post('/reset', async (_req, res) => {
    await clearAll();
    const project = await repo('projects').insertOne({
      name: 'Acme Zendesk → Freshdesk', source: { platform: 'zendesk', subdomain: 'acme' },
      target: { platform: 'freshdesk', domain: 'acme' }, options: { migrateConfig: true, migrateData: true }, status: 'created', currentPhase: 'connect',
    });
    res.json(project);
  });

  return r;
}
