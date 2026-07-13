// scripts/run-migration.js
// Kick off a migration for a project directly (same entry the API /run route
// uses). Usage: node scripts/run-migration.js [projectId] [--dry]
import { config } from '../src/config.js';
import { initStore, repo } from '../src/db/repository.js';
import { runMigration } from '../src/engine/orchestrator.js';

const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

await initStore();
let pid = arg;
if (!pid) {
  const projects = await repo('projects').find({});
  projects.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  pid = projects[0]?._id;
}
if (!pid) { console.error('no project found'); process.exit(1); }

console.log(`▶ running ${dry ? 'DRY RUN' : 'LIVE'} migration for project ${pid} (freshdesk rpm=${config.freshdesk.rpm}, zendesk rpm=${config.zendesk.rpm})`);
const t0 = Date.now();
try {
  const summary = await runMigration(pid, { dryRun: dry });
  console.log(`✅ done in ${Math.round((Date.now() - t0) / 1000)}s — totals:`, JSON.stringify(summary.totals));
  process.exit(0);
} catch (e) {
  console.error('❌ migration failed:', e.message);
  process.exit(1);
}
