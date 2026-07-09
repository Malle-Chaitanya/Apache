import { repo } from '../db/repository.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';

// VERIFY: reconcile source vs target per object type and produce the report
// summary the dashboard renders.
export async function reconcile(ctx) {
  const { project } = ctx;
  const byType = [];
  let totals = { source: 0, migrated: 0, manual: 0, failed: 0 };

  for (const type of LOAD_ORDER) {
    const q = { projectId: project._id };
    const source = await repo(type).count(q);
    if (!source) continue;
    const migrated = await repo(type).count({ ...q, status: 'loaded' });
    const manual = await repo(type).count({ ...q, status: 'manual' });
    const failed = await repo(type).count({ ...q, status: 'failed' });
    byType.push({ type, domain: MATRIX[type].domain, feasibility: MATRIX[type].feasibility, source, migrated, manual, failed });
    totals.source += source; totals.migrated += migrated; totals.manual += manual; totals.failed += failed;
  }

  const comments = await repo('ticketComments').count({ projectId: project._id, status: 'loaded' });
  const conflicts = await repo('conflicts').count({ projectId: project._id });
  const summary = { totals: { ...totals, comments, conflicts }, byType, generatedAt: new Date().toISOString() };
  await repo('reports').upsert({ projectId: project._id }, { projectId: project._id, summary });
  return summary;
}
