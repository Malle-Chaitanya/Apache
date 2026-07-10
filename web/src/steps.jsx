import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from './api.js';
import PlatformLogo from './PlatformLogo.jsx';

// ── platform metadata ──
const DEFAULT_AUTH = { zendesk: 'api_token', freshdesk: 'api_key', freshservice: 'api_key', jira: 'oauth', servicenow: 'instance_oauth' };
const AUTH_OPTIONS = { zendesk: ['api_token', 'oauth'], freshdesk: ['api_key'], freshservice: ['api_key'], jira: ['oauth'], servicenow: ['instance_oauth'] };
const FIELDS = {
  zendesk: { api_token: ['subdomain', 'email', 'apiToken'], oauth: ['subdomain'] },
  freshdesk: { api_key: ['domain', 'apiKey'] },
  freshservice: { api_key: ['domain', 'apiKey'] },
  jira: { oauth: [] },
  servicenow: { instance_oauth: ['instanceUrl', 'clientId', 'clientSecret', 'username', 'password'] },
};
const LABEL = {
  subdomain: ['Zendesk subdomain', 'yourcompany'], domain: ['Freshdesk domain', 'yourcompany.freshdesk.com'],
  email: ['Admin email', 'you@company.com'], apiToken: ['API token', '••••••••'], apiKey: ['API key', '••••••••'],
  instanceUrl: ['Instance URL', 'https://yourcompany.service-now.com'], clientId: ['Client ID', ''], clientSecret: ['Client secret', '••••••••'],
  username: ['Integration user', ''], password: ['Password', '••••••••'],
};
const SECRET_FIELDS = new Set(['apiToken', 'apiKey', 'clientSecret', 'password']);
const AUTH_LABEL = { api_token: 'API token', api_key: 'API key', oauth: 'OAuth (click-consent)', instance_oauth: 'Instance OAuth' };

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

function PlatformHead({ side, platform }) {
  return (
    <div className="platform">
      <div className={`logo ${platform}`}><PlatformLogo platform={platform} /></div>
      <div className="meta"><div className="side">{side}</div><div className="name">{platform}</div></div>
    </div>
  );
}

function ConnectCard({ projectId, side, platform, connection, onChanged }) {
  const [authType, setAuthType] = useState(connection?.authType || DEFAULT_AUTH[platform]);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = connection?.status === 'connected';
  const fields = FIELDS[platform]?.[authType] || [];
  const isOAuth = authType === 'oauth';

  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true); setError('');
    try {
      if (isOAuth) {
        const out = await api.beginConnect(projectId, side, { platform, authType, instance: values.subdomain });
        if (out.redirectUrl) window.open(out.redirectUrl, '_blank', 'noopener');
      } else {
        await api.completeConnect(projectId, side, { platform, authType, fields: values, instance: values.subdomain });
      }
      await onChanged();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="card conn">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <PlatformHead side={side} platform={platform} />
        <span className={`pill ${connection?.status || 'pending'}`}>{connection?.status || 'not connected'}</span>
      </div>

      {connected ? (
        <div className="hint">Connected as <b>{connection.subdomain || connection.domain || connection.instanceUrl}</b> via {AUTH_LABEL[connection.authType] || connection.authType}.</div>
      ) : (
        <>
          {AUTH_OPTIONS[platform].length > 1 && (
            <div className="field">
              <label>Authentication method</label>
              <select value={authType} onChange={(e) => setAuthType(e.target.value)}>
                {AUTH_OPTIONS[platform].map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
              </select>
            </div>
          )}
          {fields.map((f) => (
            <div className="field" key={f}>
              <label>{LABEL[f]?.[0] || f}</label>
              <input type={SECRET_FIELDS.has(f) ? 'password' : 'text'} placeholder={LABEL[f]?.[1] || ''}
                value={values[f] || ''} onChange={(e) => set(f, e.target.value)} />
            </div>
          ))}
          {isOAuth && <div className="hint">Opens the {platform} consent screen. Requires the registered OAuth app.</div>}
          {error && <div className="hint" style={{ color: 'var(--red)' }}>{error}</div>}
          <button className="btn primary block" disabled={busy} onClick={save}>
            {busy ? 'Connecting…' : isOAuth ? `Authorize ${platform}` : 'Connect'}
          </button>
        </>
      )}
    </div>
  );
}

export function ConnectStep({ project, connections, onRefresh }) {
  const src = connections.find((c) => c.side === 'source');
  const tgt = connections.find((c) => c.side === 'target');
  return (
    <div className="card">
      <h2>Connect your platforms</h2>
      <p className="hint">One admin credential per side. We store it encrypted and use it only through official APIs.</p>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <ConnectCard projectId={project._id} side="source" platform={project.source.platform} connection={src} onChanged={onRefresh} />
        <div className="arrow">→</div>
        <ConnectCard projectId={project._id} side="target" platform={project.target.platform} connection={tgt} onChanged={onRefresh} />
      </div>
    </div>
  );
}

const DATA_GROUPS = [
  ['migrateConfig', 'Configuration', 'Groups, agents, fields, SLAs, business hours, automations, macros, brands'],
  ['migrateData', 'Data', 'Tickets + conversations + attachments, contacts, companies, knowledge base, CSAT'],
];
export function Configure({ options, setOptions }) {
  return (
    <div className="card">
      <h2>What to migrate</h2>
      <p className="hint">Select the scope. Configuration is migrated before data so tickets can reference the new groups, agents and fields.</p>
      <div className="toggle-list">
        {DATA_GROUPS.map(([k, t, d]) => (
          <label className="toggle" key={k}>
            <input type="checkbox" checked={options[k]} onChange={(e) => setOptions({ ...options, [k]: e.target.checked })} />
            <span><span className="t">{t}</span><br /><span className="d">{d}</span></span>
          </label>
        ))}
      </div>
    </div>
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
      <p className="hint">Every source object → destination object, coloured by feasibility.</p>
      <table className="matrix">
        <thead><tr><th>Source</th><th>→ Destination</th><th>Scope</th><th>Feasibility</th><th className="num">Src</th><th>Progress</th><th className="num">Manual</th><th className="num">Failed</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.source ? Math.round((r.migrated / r.source) * 100) : 0;
            return (
              <tr key={r.type}>
                <td>{r.type}</td><td>{r.targetType}</td><td><span className="dom">{r.domain}</span></td>
                <td><span className={`pill ${r.feasibility}`}>{r.feasibility}</span></td>
                <td className="num">{r.source}</td>
                <td><div className="bar"><i style={{ width: `${pct}%` }} /></div><span className="dom">{r.migrated}/{r.source}</span></td>
                <td className="num">{r.manual}</td><td className="num">{r.failed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Conflicts({ items }) {
  return (
    <div className="card">
      <h2>⚙ Configuration automation &amp; checklist</h2>
      <p className="hint">Auto-migrated where an API exists; an exact checklist for the few items the destination locks behind its admin UI.</p>
      <div className="conflicts">
        {(!items || !items.length) && <p className="empty">Run a pre-check to see configuration results.</p>}
        {items && items.map((c, i) => (
          <div className={`conflict ${c.kind}`} key={i}>
            <div className="k">{(c.kind || '').replace(/_/g, ' ')}</div>
            <div className="d">{c.detail}</div>
            {c.suggestion && <div className="s">→ {c.suggestion}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Log({ events }) {
  const text = (events || []).map((e) => `[${(e.phase || '').padEnd(11)}] ${e.message}`).join('\n');
  return <div className="card"><h2>Activity</h2><pre className="log">{text || 'No activity yet.'}</pre></div>;
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
      <Conflicts items={conflicts} />
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
