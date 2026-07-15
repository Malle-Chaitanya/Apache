// scripts/reset-target.js
// ─────────────────────────────────────────────────────────────
// DESTRUCTIVE: wipes the Freshdesk (target) account so you can re-run a clean
// bulk migration for testing. Deletes EVERYTHING of the supported types —
// tickets, KB, contacts, companies, custom ticket fields, groups, agents —
// not just what we migrated.
//
// Safe by default: with NO flag it only PREVIEWS counts. Pass --confirm to
// actually delete. Targets the same Freshdesk the migration writes to (resolved
// from the latest project's target account, or a projectId arg, or .env).
//
//   node scripts/reset-target.js                 # dry run (counts only)
//   node scripts/reset-target.js --confirm        # delete everything
//   node scripts/reset-target.js <projectId> --confirm
//
// After a wipe, start a FRESH migration in the UI (Reset → new project) so the
// staging/idmap are clean too.
// ─────────────────────────────────────────────────────────────
import { config } from '../src/config.js';
import { initStore, repo } from '../src/db/repository.js';
import { connectionManager } from '../src/auth/connectionManager.js';
import { makeTarget } from '../src/connectors/registry.js';
import { log } from '../src/lib/logger.js';

const CONFIRM = process.argv.includes('--confirm');
const projectIdArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

// Page through a Freshdesk list endpoint (100/page) until it runs dry.
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

async function del(http, path, res) {
  if (!CONFIRM) { res.would++; return; }
  try { await http.request('DELETE', path); res.deleted++; }
  catch (e) { res.failed++; if (res.errors.length < 8) res.errors.push(`${path} → ${e.status || ''} ${(e.message || '').slice(0, 100)}`); }
}

async function resolveTargetHttp() {
  let projectId = projectIdArg;
  if (!projectId) {
    const projects = await repo('projects').find({});
    const withTarget = projects.filter((p) => p.target?.accountId || p.target?.platform);
    withTarget.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    projectId = withTarget[0]?._id || null;
  }
  if (projectId) {
    try {
      const creds = await connectionManager.get(projectId, 'target');
      const target = makeTarget(creds.platform, creds.connectorCreds);
      return { http: target.http, baseUrl: target.baseUrl, via: `project ${projectId} target account` };
    } catch (e) { log.warn(`could not resolve project ${projectId} target creds (${e.message}); falling back to .env FRESHDESK_*`); }
  }
  if (!config.freshdesk.domain || !config.freshdesk.apiKey) throw new Error('No target creds: no project target account and FRESHDESK_DOMAIN/FRESHDESK_API_KEY not set in .env');
  const target = makeTarget('freshdesk', {});
  return { http: target.http, baseUrl: target.baseUrl, via: '.env FRESHDESK_*' };
}

async function main() {
  await initStore();
  const { http, baseUrl, via } = await resolveTargetHttp();

  // Never delete the API user itself (that's the credential we're using).
  let meId = null;
  try { const { data } = await http.get('/agents/me'); meId = data?.id ?? null; } catch { /* older plans lack /agents/me */ }

  console.log(`\n${CONFIRM ? '🗑️  DELETING' : '👀 DRY RUN (no deletes)'} — target: ${baseUrl}  (via ${via})`);
  if (!CONFIRM) console.log('    Re-run with --confirm to actually delete.\n');
  else console.log('    This permanently removes data from the account above.\n');

  const results = {};
  const R = (name) => (results[name] = { count: 0, deleted: 0, failed: 0, would: 0, errors: [] });

  // 1) Tickets first (they reference contacts/companies/agents/fields).
  {
    const res = R('tickets');
    const tickets = await listAll(http, '/tickets');
    res.count = tickets.length;
    for (const t of tickets) await del(http, `/tickets/${t.id}`, res);
  }

  // 2) Knowledge base: articles → folders → categories.
  {
    const res = R('kb (articles/folders/categories)');
    const categories = await listAll(http, '/solutions/categories');
    for (const c of categories) {
      let folders = [];
      try { ({ data: folders } = await http.get(`/solutions/categories/${c.id}/folders`)); } catch { folders = []; }
      for (const f of folders || []) {
        let articles = [];
        try { ({ data: articles } = await http.get(`/solutions/folders/${f.id}/articles`)); } catch { articles = []; }
        for (const a of articles || []) { res.count++; await del(http, `/solutions/articles/${a.id}`, res); }
        res.count++; await del(http, `/solutions/folders/${f.id}`, res);
      }
      res.count++; await del(http, `/solutions/categories/${c.id}`, res); // default "General" may refuse — logged, skipped
    }
  }

  // 3) Agents BEFORE contacts. Freshdesk does NOT remove a deleted agent — it
  //    DOWNGRADES them into a contact. So agents must go first; the contacts
  //    sweep below then hard-deletes those downgraded ex-agents too. (Skip the
  //    API user we're authenticated as.)
  {
    const res = R('agents');
    const agents = await listAll(http, '/agents');
    const deletable = agents.filter((a) => a.id !== meId);
    res.count = deletable.length;
    for (const a of deletable) await del(http, `/agents/${a.id}`, res);
  }

  // 4) Contacts — hard delete (so re-migration can't reuse a soft-deleted
  //    contact), and this catches the ex-agents downgraded in step 3.
  {
    const res = R('contacts');
    const contacts = await listAll(http, '/contacts');
    res.count = contacts.length;
    for (const c of contacts) await del(http, `/contacts/${c.id}/hard_delete?force=true`, res);
  }

  // 4) Companies.
  {
    const res = R('companies');
    const companies = await listAll(http, '/companies');
    res.count = companies.length;
    for (const c of companies) await del(http, `/companies/${c.id}`, res);
  }

  // 5) Custom ticket fields only (default fields can't be deleted).
  {
    const res = R('ticketFields (custom)');
    let fields = [];
    try { fields = await listAll(http, '/admin/ticket_fields'); } catch { try { fields = await listAll(http, '/ticket_fields'); } catch { fields = []; } }
    const custom = fields.filter((f) => f && f.default === false);
    res.count = custom.length;
    for (const f of custom) await del(http, `/admin/ticket_fields/${f.id}`, res);
  }

  // 7) Groups.
  {
    const res = R('groups');
    const groups = await listAll(http, '/groups');
    res.count = groups.length;
    for (const g of groups) await del(http, `/groups/${g.id}`, res);
  }

  // Summary.
  console.log('\n──────── summary ────────');
  for (const [name, r] of Object.entries(results)) {
    const action = CONFIRM ? `deleted ${r.deleted}, failed ${r.failed}` : `would delete ${r.would}`;
    console.log(`${name.padEnd(30)} found ${String(r.count).padStart(5)} · ${action}`);
    for (const e of r.errors) console.log(`    ⚠ ${e}`);
  }
  console.log('─────────────────────────');
  if (!CONFIRM) console.log('\nNothing was deleted. Re-run with --confirm to wipe the account.\n');
  else console.log('\nDone. Start a fresh migration (UI → Reset) for a clean staging/idmap, then run the bulk migration.\n');
  process.exit(0);
}

main().catch((e) => { log.error(`reset-target fatal: ${e.stack || e.message}`); process.exit(1); });
