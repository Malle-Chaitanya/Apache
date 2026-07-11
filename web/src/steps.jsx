import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from './api.js';

export function Stepper({ steps, current }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div key={s.key} className={`step ${i === current ? 'active' : i < current ? 'done' : ''}`}>
          <span className="n">{i < current ? '✓' : i + 1}</span>{s.label}
        </div>
      ))}
    </div>
  );
}

export function ReauthBanner({ connections, onReconnect }) {
  const bad = connections.filter((c) => c.status === 'reauth_required');
  if (!bad.length) return null;
  return (
    <div className="banner">
      <span>⚠️ Re-authentication required for <b>{bad.map((c) => `${c.side} (${c.platform})`).join(', ')}</b>. The credential was changed or revoked; reconnect to resume from the last checkpoint.</span>
      <button className="btn" onClick={() => onReconnect(bad[0].side)}>Reconnect</button>
    </div>
  );
}

const DATA_GROUPS = [
  ['migrateConfig', 'config', 'Configuration', 'Groups, agents, fields, SLAs, business hours, automations, macros, brands'],
  ['migrateData', 'data', 'Data', 'Tickets + conversations + attachments, contacts, companies, knowledge base'],
];

// Step 3 — Select data. Toggles for Configuration / Data, plus the live source
// scan showing how much was picked up and what will migrate.
export function Configure({ options, setOptions, scan, scanning }) {
  const domainTotal = (domain) => scan ? (domain === 'config' ? scan.totals.config : scan.totals.data) : null;
  return (
    <>
      <div className="card">
        <h2>Select Data</h2>
        <p className="hint">Choose the scope. Configuration migrates before data so tickets can reference the new groups, agents and fields.</p>
        <div className="toggle-list">
          {DATA_GROUPS.map(([k, domain, t, d]) => {
            const n = domainTotal(domain);
            return (
              <label className="toggle" key={k}>
                <input type="checkbox" checked={options[k]} onChange={(e) => setOptions({ ...options, [k]: e.target.checked })} />
                <span>
                  <span className="t">{t}{n != null && <span className="count-badge">{n.toLocaleString()} ready</span>}</span>
                  <br /><span className="d">{d}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2>Picked up from source</h2>
        <p className="hint">{scanning ? 'Scanning the source help desk…' : 'Live counts read from the source. Rows in a disabled scope won’t migrate.'}</p>
        {scanning && <div className="scan-loading"><span className="spin" /> Reading source data…</div>}
        {!scanning && !scan && <p className="empty">Source scan unavailable.</p>}
        {!scanning && scan && (
          <table className="matrix">
            <thead><tr><th>Source object</th><th>→ Destination</th><th>Scope</th><th className="num">Ready to migrate</th></tr></thead>
            <tbody>
              {scan.rows.map((r) => {
                const on = r.domain === 'config' ? options.migrateConfig : options.migrateData;
                return (
                  <tr key={r.type} className={on ? '' : 'row-off'}>
                    <td>{r.type}</td><td>{r.targetType}</td><td><span className="dom">{r.domain}</span></td>
                    <td className="num">{on ? r.count.toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function Kpis({ totals }) {
  const t = totals || {};
  const cells = [['discovered', t.source, 'blue'], ['migrated', t.migrated, 'green'], ['comments', t.comments, ''], ['manual', t.manual, 'amber'], ['failed', t.failed, 'red']];
  return <div className="kpis">{cells.map(([l, n, c]) => <div className={`kpi ${c}`} key={l}><div className="n">{n ?? 0}</div><div className="l">{l}</div></div>)}</div>;
}

export function MatrixTable({ rows }) {
  return (
    <div className="card">
      <h2>Object mapping &amp; progress</h2>
      <p className="hint">Every source object → the destination object it becomes, with counts and progress.</p>
      <table className="matrix">
        <thead><tr><th>Source</th><th>→ Destination</th><th>Scope</th><th className="num">Picked up</th><th className="num">Will migrate</th><th>Progress</th><th className="num">Manual</th><th className="num">Failed</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            // Dry run marks entities 'validated'; live marks them 'loaded'. Only
            // one is ever non-zero, so their sum is the "done" count either way.
            const done = (r.migrated || 0) + (r.validated || 0);
            const pct = r.source ? Math.round((done / r.source) * 100) : 0;
            return (
              <tr key={r.type}>
                <td>{r.type}</td><td>{r.targetType}</td><td><span className="dom">{r.domain}</span></td>
                <td className="num">{r.source}</td>
                <td className="num">{done}</td>
                <td><div className="bar"><i style={{ width: `${pct}%` }} /></div><span className="dom">{done}/{r.source}</span></td>
                <td className="num">{r.manual}</td><td className="num">{r.failed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A big circular percentage ring (CSS conic-gradient) used on the in-progress
// screens for both the dry run and the live migration.
function Ring({ pct, label }) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div className="ring" style={{ '--pct': p }}>
      <div className="ring-in"><div className="ring-pct">{p}%</div><div className="ring-lbl">{label}</div></div>
    </div>
  );
}

// In-progress dashboard for the running dry run / live migration.
export function Progress({ report, matrix, mode }) {
  const t = report?.totals || {};
  const rows = matrix || [];
  const source = t.source ?? rows.reduce((a, r) => a + (r.source || 0), 0);
  const done = (t.migrated || 0) + (t.validated || 0) || rows.reduce((a, r) => a + (r.migrated || 0) + (r.validated || 0), 0);
  const manual = t.manual ?? rows.reduce((a, r) => a + (r.manual || 0), 0);
  const failed = t.failed ?? rows.reduce((a, r) => a + (r.failed || 0), 0);
  const pct = source ? ((done + manual + failed) / source) * 100 : 0;
  const cells = [
    ['Objects', source, ''],
    [mode === 'dry' ? 'Would migrate' : 'Migrated', done, 'green'],
    ['Manual', manual, 'amber'],
    ['Errors', failed, 'red'],
  ];
  return (
    <div className="card">
      <h2>{mode === 'dry' ? 'Dry Run in Progress' : 'Migration in Progress'}</h2>
      <p className="hint">{mode === 'dry' ? 'No data is written during a dry run.' : 'Configuration loads first, then data.'}</p>
      <div className="progress-hero">
        <Ring pct={pct} label="Progress" />
        <div className="progress-cells">
          {cells.map(([l, n, c]) => <div className={`kpi ${c}`} key={l}><div className="n">{(n ?? 0).toLocaleString()}</div><div className="l">{l}</div></div>)}
        </div>
      </div>
    </div>
  );
}

// The "Dry Run Complete" summary screen — big-number cards, a one-line
// pre-flight verdict, the object mapping, and the go-live action.
export function DryRunSummary({ report, matrix, onGoLive, running }) {
  const t = report?.totals || {};
  const rows = (report?.byType?.length ? report.byType : matrix) || [];
  const source = t.source ?? rows.reduce((a, r) => a + (r.source || 0), 0);
  const would = (t.validated || 0) + (t.migrated || 0) || rows.reduce((a, r) => a + (r.validated || 0) + (r.migrated || 0), 0);
  const manual = t.manual ?? rows.reduce((a, r) => a + (r.manual || 0), 0);
  const failed = t.failed ?? rows.reduce((a, r) => a + (r.failed || 0), 0);
  const objectTypes = rows.filter((r) => r.source > 0).length;
  const blockers = failed;
  const ready = failed === 0;
  const cells = [
    ['Object types', objectTypes, ''],
    ['Total objects', source, 'blue'],
    ['Would migrate', would, 'green'],
    ['Manual', manual, 'amber'],
    ['Errors', failed, 'red'],
  ];
  return (
    <>
      <div className="card dryrun-hero">
        <div className="dryrun-check">◎</div>
        <h2>Dry Run Complete</h2>
        <p className="hint" style={{ textAlign: 'center' }}>Pre-check complete — no data was written.</p>
        <div className="kpis kpis-5">
          {cells.map(([l, n, c]) => <div className={`kpi ${c}`} key={l}><div className="n">{(n ?? 0).toLocaleString()}</div><div className="l">{l}</div></div>)}
        </div>
      </div>

      <div className={`card preflight ${ready ? 'ok' : 'warn'}`}>
        <div className="preflight-head">
          <b>🔍 Dry-Run Pre-Flight Report</b>
          <span>{objectTypes} ready · {manual} manual · {blockers} blocker{blockers === 1 ? '' : 's'}</span>
        </div>
        <p className="hint" style={{ margin: '6px 0 0' }}>
          {ready ? 'All checks passed. Safe to go live.' : `${blockers} object(s) failed validation — review the errors below before going live.`}
        </p>
      </div>

      {!!rows.length && <MatrixTable rows={rows} />}

      <button className="btn primary block lg" disabled={running} onClick={onGoLive}>
        {running ? 'Starting…' : '🚀 Start Migration (Live)'}
      </button>
    </>
  );
}

export function Report({ report, conflicts, projectId }) {
  if (!report) return <div className="card"><p className="empty">No report yet — run the migration.</p></div>;
  const [busy, setBusy] = useState(false);
  const dl = (name, content, type) => { const b = new Blob([content], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); };
  const jsonAll = () => dl('migration-report.json', JSON.stringify({ report, conflicts }, null, 2), 'application/json');

  // One .xlsx workbook with a sheet per section (Summary, Totals, Failures,
  // Logs, Checklist, Role mapping). Logs + failures are fetched on demand.
  const downloadExcel = async () => {
    setBusy(true);
    try {
      const [events, failures] = await Promise.all([api.events(projectId, 5000), api.failures(projectId)]);
      const wb = XLSX.utils.book_new();
      const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);
      add('Summary', report.byType.map((b) => ({ source: b.type, destination: b.targetType || '', scope: b.domain, feasibility: b.feasibility, discovered: b.source, migrated: b.migrated, manual: b.manual, failed: b.failed })));
      add('Totals', [report.totals]);
      add('Failures', (failures || []).map((f) => ({ type: f.type, sourceId: f.sourceId, error: f.error, at: f.at })));
      add('Logs', (events || []).map((e) => ({ time: e.createdAt, phase: e.phase, level: e.level, entity: e.entityType, message: e.message })));
      add('Checklist', (conflicts || []).map((c) => ({ object: c.entityType, kind: c.kind, detail: c.detail, suggestion: c.suggestion, status: c.status })));
      if (report.roleMapping?.length) add('RoleMapping', report.roleMapping.map((r) => ({ agent: r.name, email: r.email, zendeskRole: r.sourceRole, freshdeskRole: r.targetRole, scope: r.ticketScope, review: r.review })));
      XLSX.writeFile(wb, 'migration-report.xlsx');
    } finally { setBusy(false); }
  };

  return (
    <>
      <Kpis totals={report.totals} />
      <MatrixTable rows={report.byType.map((b) => ({ ...b, targetType: b.targetType || '' }))} />
      <RoleMapping rows={report.roleMapping} />
      <div className="card">
        <h2>Export</h2>
        <p className="hint">One Excel workbook — a tab each for Summary, Totals, Failures (with reasons), Logs, Config checklist, and Role mapping.</p>
        <div className="controls" style={{ flexWrap: 'wrap', marginBottom: 0 }}>
          <button className="btn primary" disabled={busy} onClick={downloadExcel}>{busy ? 'Building…' : '⬇ Download Excel (all-in-one)'}</button>
          <button className="btn ghost" onClick={jsonAll}>⬇ Full report (JSON)</button>
        </div>
      </div>
    </>
  );
}

// Per-agent role mapping (source role → Freshdesk role) — makes the permission
// fidelity gap explicit so admins know exactly which agents to review.
function RoleMapping({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h2>Agent role mapping</h2>
      <p className="hint">Zendesk role → nearest Freshdesk role. Rows flagged <b>Review</b> may need a manual adjustment on the target (custom roles, light agents, billing admins).</p>
      <table className="matrix">
        <thead><tr><th>Agent</th><th>Email</th><th>Zendesk role</th><th>Freshdesk role</th><th>Scope</th><th>Review</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td><td>{r.email}</td><td>{r.sourceRole}</td>
              <td><b>{r.targetRole}</b></td>
              <td>{{ 1: 'Global', 2: 'Group', 3: 'Restricted' }[r.ticketScope] || r.ticketScope}</td>
              <td>{r.review ? '⚠️ review' : '✓'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
