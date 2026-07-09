import React from 'react';

const PHASES = [
  ['connect', 'Connect'], ['discover', 'Discover'], ['extract', 'Extract'],
  ['load_config', 'Load config'], ['load_data', 'Load data'], ['verify', 'Verify'], ['report', 'Report'],
];

export function Topbar({ cfg, status }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">⇄</span>
        <div>
          <h1>ITSM Migrator</h1>
          <p className="sub">Zendesk → Freshdesk · data <em>and</em> configuration</p>
        </div>
      </div>
      <div className="badges">
        <span className="badge">store: {cfg?.store || '—'}</span>
        <span className="badge">driver: {cfg?.driver || '—'}</span>
        <span className={`badge badge-status ${status}`}>{status}</span>
      </div>
    </header>
  );
}

export function Stepper({ current, status }) {
  const idx = PHASES.findIndex((p) => p[0] === current);
  return (
    <section className="card">
      <h2>Pipeline</h2>
      <ol className="stepper">
        {PHASES.map(([key, label], i) => {
          const done = status === 'completed' || i < idx;
          const active = i === idx && status !== 'completed';
          return <li key={key} className={done ? 'done' : active ? 'active' : ''}>{label}</li>;
        })}
      </ol>
    </section>
  );
}

export function Kpis({ totals }) {
  const t = totals || {};
  const cells = [
    ['discovered', t.source, ''], ['migrated', t.migrated, 'green'],
    ['comments', t.comments, ''], ['manual', t.manual, 'amber'], ['failed', t.failed, 'red'],
  ];
  return (
    <section className="kpis">
      {cells.map(([l, n, c]) => (
        <div className={`kpi ${c}`} key={l}><div className="n">{n ?? 0}</div><div className="l">{l}</div></div>
      ))}
    </section>
  );
}

export function MatrixTable({ rows }) {
  return (
    <section className="card">
      <h2>Object mapping &amp; migration status</h2>
      <p className="hint">Every Zendesk object → Freshdesk object, colour-coded by feasibility.</p>
      <table className="matrix">
        <thead><tr><th>Zendesk</th><th>→ Freshdesk</th><th>Domain</th><th>Feasibility</th>
          <th className="num">Src</th><th className="num">Migrated</th><th className="num">Manual</th><th className="num">Failed</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type}>
              <td>{r.type}</td>
              <td>{r.targetType}</td>
              <td><span className="dom">{r.domain}</span></td>
              <td><span className={`pill ${r.feasibility}`}>{r.feasibility}</span></td>
              <td className="num">{r.source}</td>
              <td className="num">{r.migrated}</td>
              <td className="num">{r.manual}</td>
              <td className="num">{r.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Conflicts({ items }) {
  return (
    <section className="card highlight">
      <h2>⚙ Configuration automation <span className="tag">the differentiator</span></h2>
      <p className="hint">What we rebuild automatically, and the exact checklist for the few items Freshdesk locks behind its admin UI.</p>
      <div className="conflicts">
        {(!items || items.length === 0) && <p className="empty">Run a migration to see configuration results.</p>}
        {items && items.map((c, i) => (
          <div className={`conflict ${c.kind}`} key={i}>
            <div className="k">{c.kind?.replace(/_/g, ' ')}</div>
            <div className="d">{c.detail}</div>
            {c.suggestion && <div className="s">→ {c.suggestion}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function LogView({ events }) {
  const text = (events || []).map((e) => `[${(e.phase || '').padEnd(11)}] ${e.message}`).join('\n');
  return (
    <section className="card">
      <h2>Activity</h2>
      <pre className="log">{text || 'No activity yet.'}</pre>
    </section>
  );
}
