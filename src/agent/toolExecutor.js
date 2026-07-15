// src/agent/toolExecutor.js
// ─────────────────────────────────────────────────────────────
// Executes a tool call. Read tools summarise state from the migrationState the
// frontend sent (plus the DB report when a project exists). Action tools emit a
// UI event over the SSE stream (ctx.streamEvent) that the React wizard applies —
// the guide never touches the write path directly; it drives the same UI the
// user would.
// ─────────────────────────────────────────────────────────────
import { STEP_NAMES } from './tools.js';
import { repo } from '../db/repository.js';

const clampStep = (n) => Math.max(0, Math.min(STEP_NAMES.length - 1, Number(n) || 0));

async function statusSummary(state) {
  const s = state || {};
  const out = {
    step: s.step ?? 0,
    stepName: STEP_NAMES[s.step ?? 0],
    source: s.srcPlatform || 'zendesk',
    target: s.tgtPlatform || 'freshdesk',
    sourceConnected: !!s.srcConnectedCount,
    targetConnected: !!s.tgtConnectedCount,
    bothConnected: !!s.bothConnected,
    projectExists: !!s.hasProject,
    projectStatus: s.projectStatus || 'none',
    scope: s.scope || { migrateConfig: true, migrateData: true },
    scan: s.scan || null,
    running: !!s.running,
    runMode: s.runMode || null,
    dryRunDone: !!s.dryDone,
    liveMigrationDone: !!s.liveDone,
  };
  // Freshest totals from the DB report, if a project has one.
  if (s.projectId) {
    try {
      const rep = await repo('reports').findOne({ projectId: s.projectId });
      if (rep?.summary?.totals) out.reportTotals = rep.summary.totals;
    } catch { /* ignore — the UI-supplied totals below still stand */ }
  }
  if (!out.reportTotals && s.reportTotals) out.reportTotals = s.reportTotals;
  return out;
}

export async function executeTool(name, args, ctx) {
  const { streamEvent, migrationState } = ctx;
  switch (name) {
    case 'get_migration_status':
      return statusSummary(migrationState);

    case 'navigate_to_step': {
      const step = clampStep(args?.step);
      streamEvent('navigate', { step });
      return { navigated: true, step, stepName: STEP_NAMES[step] };
    }

    case 'set_data_scope': {
      const patch = {};
      if (typeof args?.migrateConfig === 'boolean') patch.migrateConfig = args.migrateConfig;
      if (typeof args?.migrateData === 'boolean') patch.migrateData = args.migrateData;
      if (!Object.keys(patch).length) return { ok: false, error: 'no scope fields provided' };
      streamEvent('set_scope', patch);
      return { ok: true, ...patch };
    }

    case 'start_dry_run':
      streamEvent('start_run', { dryRun: true });
      return { started: true, dryRun: true };

    case 'start_live_migration':
      streamEvent('start_run', { dryRun: false });
      return { started: true, dryRun: false };

    case 'open_report':
      streamEvent('navigate', { step: 6 });
      return { navigated: true, step: 6, stepName: STEP_NAMES[6] };

    default:
      return { error: `unknown tool ${name}` };
  }
}
