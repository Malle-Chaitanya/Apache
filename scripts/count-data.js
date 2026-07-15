// scripts/count-data.js
// ─────────────────────────────────────────────────────────────
// READ-ONLY validation report: object counts on BOTH sides, so you can compare
// before/after a migration. Shows the Freshdesk (destination) DEFAULTS too — the
// built-in ticket fields, the "General" KB category, the API-user agent — so you
// know the baseline that exists before anything migrates. After a run, expect
// roughly:  destination ≈ source + destination-defaults  (dedup aside).
//
//   node scripts/count-data.js                 # latest project
//   node scripts/count-data.js <projectId>
//
// Nothing is written or deleted.
// ─────────────────────────────────────────────────────────────
import { initStore, repo } from '../src/db/repository.js';
import { connectionManager } from '../src/auth/connectionManager.js';
import { makeSource, makeTarget } from '../src/connectors/registry.js';
import { log } from '../src/lib/logger.js';

const projectIdArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

async function listAll(http, path) {
  const out = [];
  for (let page = 1; page <= 500; page++) {
    let data;
    try { ({ data } = await http.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)); }
    catch (e) { if (e.status === 404) break; throw e; }
    const arr = Array.isArray(data) ? data : [];
    if (!arr.length) break;
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out;
}

async function pickProject() {
  if (projectIdArg) return projectIdArg;
  const projects = await repo('projects').find({});
  const withBoth = projects.filter((p) => (p.source?.accountId || p.source?.platform) && (p.target?.accountId || p.target?.platform));
  withBoth.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return withBoth[0]?._id || null;
}

async function main() {
  await initStore();
  const projectId = await pickProject();
  if (!projectId) throw new Error('No project found. Create/connect one in the UI first, or pass a projectId.');

  const srcCreds = await connectionManager.get(projectId, 'source');
  const tgtCreds = await connectionManager.get(projectId, 'target');
  const source = makeSource(srcCreds.platform, srcCreds.connectorCreds);
  const target = makeTarget(tgtCreds.platform, tgtCreds.connectorCreds);
  const http = target.http;

  console.log(`\n📊 Data counts for project ${projectId}`);
  console.log(`   source: ${srcCreds.platform}   →   destination: ${tgtCreds.platform} (${target.baseUrl})\n`);

  // ── SOURCE (Zendesk) — the connector's own discovery counts ──
  let src = {};
  try { src = await source.discover(); } catch (e) { log.warn(`source.discover failed: ${e.message}`); }

  console.log('── SOURCE (Zendesk) ──');
  const srcRows = Object.entries(src).filter(([, v]) => typeof v === 'number');
  for (const [k, v] of srcRows) console.log(`   ${k.padEnd(16)} ${String(v).padStart(6)}`);
  const srcTotal = srcRows.reduce((a, [, v]) => a + v, 0);
  console.log(`   ${'TOTAL'.padEnd(16)} ${String(srcTotal).padStart(6)}`);

  // ── DESTINATION (Freshdesk) — live counts + defaults breakdown ──
  const [tickets, contacts, companies, groups, agents] = await Promise.all([
    listAll(http, '/tickets'), listAll(http, '/contacts'), listAll(http, '/companies'),
    listAll(http, '/groups'), listAll(http, '/agents'),
  ]);
  let fields = [];
  try { fields = await listAll(http, '/admin/ticket_fields'); } catch { try { fields = await listAll(http, '/ticket_fields'); } catch { fields = []; } }
  const defaultFields = fields.filter((f) => f && f.default === true).length;
  const customFields = fields.length - defaultFields;

  const cats = await listAll(http, '/solutions/categories');
  let folderCount = 0, articleCount = 0;
  for (const c of cats) {
    let folders = [];
    try { ({ data: folders } = await http.get(`/solutions/categories/${c.id}/folders`)); } catch { folders = []; }
    folderCount += (folders || []).length;
    for (const f of folders || []) {
      let arts = [];
      try { ({ data: arts } = await http.get(`/solutions/folders/${f.id}/articles`)); } catch { arts = []; }
      articleCount += (arts || []).length;
    }
  }
  const defaultCats = cats.filter((c) => c.is_default === true || /^general$/i.test(c.name || '')).length;

  // The API user is a pre-existing/default agent (the credential we authenticate as).
  let meId = null;
  try { const { data } = await http.get('/agents/me'); meId = data?.id ?? null; } catch { /* ignore */ }
  const defaultAgents = agents.filter((a) => a.id === meId).length;

  const destRows = [
    ['tickets', tickets.length, 0],
    ['contacts', contacts.length, 0],
    ['companies', companies.length, 0],
    ['groups', groups.length, 0],
    ['agents', agents.length, defaultAgents],
    ['ticketFields', fields.length, defaultFields],
    ['kbCategories', cats.length, defaultCats],
    ['kbFolders', folderCount, 0],
    ['kbArticles', articleCount, 0],
  ];

  console.log('\n── DESTINATION (Freshdesk) ──');
  console.log(`   ${'type'.padEnd(16)} ${'total'.padStart(6)} ${'default'.padStart(8)} ${'custom'.padStart(7)}`);
  for (const [name, total, def] of destRows) {
    console.log(`   ${name.padEnd(16)} ${String(total).padStart(6)} ${String(def).padStart(8)} ${String(total - def).padStart(7)}`);
  }
  const destTotal = destRows.reduce((a, [, t]) => a + t, 0);
  const destDefault = destRows.reduce((a, [, , d]) => a + d, 0);
  console.log(`   ${'TOTAL'.padEnd(16)} ${String(destTotal).padStart(6)} ${String(destDefault).padStart(8)} ${String(destTotal - destDefault).padStart(7)}`);

  console.log('\nℹ️  "default" = Freshdesk built-ins that exist without migrating anything');
  console.log('   (built-in ticket fields, the "General" KB category, the API-user agent).');
  console.log('   Validation after a run:  destination custom ≈ source (minus dedup/manual).\n');
  process.exit(0);
}

main().catch((e) => { log.error(`count-data fatal: ${e.stack || e.message}`); process.exit(1); });
