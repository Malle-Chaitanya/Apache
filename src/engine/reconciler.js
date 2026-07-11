import { repo } from '../db/repository.js';
import { MATRIX, LOAD_ORDER } from '../mapping/matrix.js';
import { mapAgentRole } from '../mapping/valueMaps.js';

// VERIFY: reconcile source vs target per object type and produce the report
// summary the dashboard renders.
export async function reconcile(ctx) {
  const { project } = ctx;
  const byType = [];
  let totals = { source: 0, migrated: 0, validated: 0, manual: 0, failed: 0 };

  for (const type of LOAD_ORDER) {
    const q = { projectId: project._id };
    const source = await repo(type).count(q);
    if (!source) continue;
    const migrated = await repo(type).count({ ...q, status: 'loaded' });
    // In a dry run the loader marks entities 'validated' instead of creating
    // them — this is the "would migrate" count surfaced in the pre-check.
    const validated = await repo(type).count({ ...q, status: 'validated' });
    const manual = await repo(type).count({ ...q, status: 'manual' });
    const failed = await repo(type).count({ ...q, status: 'failed' });
    byType.push({ type, domain: MATRIX[type].domain, feasibility: MATRIX[type].feasibility, source, migrated, validated, manual, failed });
    totals.source += source; totals.migrated += migrated; totals.validated += validated; totals.manual += manual; totals.failed += failed;
  }

  const commentQ = { projectId: project._id };
  const comments = await repo('ticketComments').count({ ...commentQ, status: 'loaded' });
  const commentsFailed = await repo('ticketComments').count({ ...commentQ, status: 'failed' });
  const commentsManual = await repo('ticketComments').count({ ...commentQ, status: 'manual' });
  const conflicts = await repo('conflicts').count({ projectId: project._id });

  // Per-agent role mapping (source role → Freshdesk role) so the customer has an
  // explicit review list — the permission fidelity gap made visible, not hidden.
  const agentDocs = await repo('agents').find({ projectId: project._id });
  const roleMapping = agentDocs.map((a) => {
    const src = a.sourceRaw || {};
    const { role, ticketScope, light, billingAdmin } = mapAgentRole(src);
    return {
      name: src.name, email: src.email,
      sourceRole: src.role + (src.role_type != null ? `/type ${src.role_type}` : ''),
      targetRole: role, ticketScope,
      review: billingAdmin || light || src.custom_role_id != null, // needs a human look
      status: a.status,
    };
  });

  const summary = { totals: { ...totals, comments, commentsFailed, commentsManual, conflicts }, byType, roleMapping, generatedAt: new Date().toISOString() };
  await repo('reports').upsert({ projectId: project._id }, { projectId: project._id, summary });
  return summary;
}
