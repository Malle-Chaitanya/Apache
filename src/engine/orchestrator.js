import { repo } from '../db/repository.js';
import { ZendeskSource } from '../connectors/zendesk/index.js';
import { FreshdeskTarget } from '../connectors/freshdesk/index.js';
import { LOAD_ORDER, MATRIX } from '../mapping/matrix.js';
import { extract } from './extractor.js';
import { loadType } from './loader.js';
import { reconcile } from './reconciler.js';
import { log } from '../lib/logger.js';

// The orchestrator runs the phased state machine (PRD §6). Each phase is
// resumable because state lives in Mongo, not memory.
export async function runMigration(projectId, { dryRun = false } = {}) {
  const project = await repo('projects').findOne({ _id: projectId });
  if (!project) throw new Error('project not found');

  const job = await repo('jobs').insertOne({ projectId, mode: dryRun ? 'dry_run' : 'full', status: 'running', startedAt: new Date(), phasesCompleted: [] });
  const ctx = {
    project, dryRun,
    source: new ZendeskSource(),
    target: new FreshdeskTarget(),
    idCache: new Map(),
    conflicts: [],
    stats: { migrated: 0, manual: 0, failed: 0, comments: 0 },
    emit: (phase, entityType, message, level = 'info') => {
      log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`[${phase}] ${message}`);
      return repo('events').insertOne({ projectId, phase, entityType, level, message });
    },
  };

  try {
    await setPhase(project, 'connect', 'running');
    // Re-hydrate idmap cache (resume support).
    for (const m of await repo('idmap').find({ projectId })) ctx.idCache.set(`${m.entityType}:${m.sourceId}`, m.targetId);

    await setPhase(project, 'discover');
    const counts = await ctx.source.discover();
    await repo('projects').updateOne({ _id: projectId }, { 'stats.totalEntities': Object.values(counts).reduce((a, b) => a + b, 0) });
    ctx.emit('discover', null, `discovered ${JSON.stringify(counts)}`);

    await setPhase(project, 'extract');
    await extract(ctx);

    // LOAD — config first, then data. Emit phase transitions for the dashboard.
    for (const type of LOAD_ORDER) {
      await setPhase(project, MATRIX[type].domain === 'config' ? 'load_config' : 'load_data');
      await loadType(ctx, type);
    }

    // Persist conflicts (dedupe by detail).
    const seen = new Set();
    for (const c of ctx.conflicts) {
      if (seen.has(c.detail)) continue;
      seen.add(c.detail);
      await repo('conflicts').upsert({ projectId, detail: c.detail }, c);
    }

    await setPhase(project, 'verify');
    const summary = await reconcile(ctx);

    await repo('projects').updateOne({ _id: projectId }, {
      status: 'completed', currentPhase: 'report',
      stats: { totalEntities: summary.totals.source, migrated: summary.totals.migrated, failed: summary.totals.failed, manual: summary.totals.manual },
    });
    await repo('jobs').updateOne({ _id: job._id }, { status: 'completed', finishedAt: new Date() });
    ctx.emit('report', null, `migration ${dryRun ? '(dry-run) ' : ''}complete: ${summary.totals.migrated} migrated, ${summary.totals.manual} manual, ${summary.totals.failed} failed`);
    return summary;
  } catch (err) {
    log.error(`migration failed: ${err.message}`);
    await repo('projects').updateOne({ _id: projectId }, { status: 'failed' });
    await repo('jobs').updateOne({ _id: job._id }, { status: 'failed', error: err.message, finishedAt: new Date() });
    throw err;
  }
}

async function setPhase(project, phase, status) {
  const patch = { currentPhase: phase };
  if (status) patch.status = status;
  await repo('projects').updateOne({ _id: project._id }, patch);
}
