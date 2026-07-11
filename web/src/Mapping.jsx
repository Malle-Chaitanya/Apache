import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// Step — "Select & Map". CloudFuze's object / field / value mapping, built on our
// own deterministic engine:
//   • pick which source objects migrate (per-object, grouped)
//   • per object, a FIELD mapping (source field → Freshdesk field, with Skip)
//   • enum fields drill into a VALUE map (source value → target, + empty default)
export function Mapping({ projectId }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState({});
  const [editing, setEditing] = useState(null); // { type }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      try {
        const [ov, s] = await Promise.all([api.mappingOverview(projectId), api.getSelection(projectId)]);
        setRows(ov); setSel(s);
      } catch { setRows([]); }
    })();
  }, [projectId]);

  async function toggle(type) {
    const next = { ...sel, [type]: !sel[type] };
    setSel(next);
    try { setBusy(true); await api.saveSelection(projectId, next); } finally { setBusy(false); }
  }

  if (!rows) return <div className="card"><div className="scan-loading"><span className="spin" /> Loading mapping…</div></div>;

  const SECTIONS = [
    ['config', 'Help desk configuration'],
    ['data',   'Help desk data'],
    ['kb',     'Knowledge base'],
  ];
  const inSection = (r, key) => (key === 'kb' ? r.type.startsWith('kb') : (r.domain === key && !r.type.startsWith('kb')));

  // Only render pills wired to real functionality — no dead buttons.
  const actionsFor = (r) => {
    const a = [];
    if (r.affordances.fields || r.affordances.valueMaps.length) a.push(<button key="m" className="pill" disabled={!sel[r.type]} onClick={() => setEditing({ type: r.type })}>Mapping</button>);
    return a;
  };

  const selectedCount = rows.filter((r) => sel[r.type]).length;

  return (
    <>
      <div className="card mapcard">
        <div className="map-head">
          <div>
            <h2>Select &amp; Map</h2>
            <p className="hint" style={{ margin: '4px 0 0' }}>Pick what migrates and control exactly how it lands on Freshdesk. Configuration migrates before data so tickets reference the new groups, agents and fields.</p>
          </div>
          <span className="sel-count">{selectedCount} selected</span>
        </div>

        <div className="obj-row head">
          <span className="obj-pick" /><span className="colh">Zendesk</span><span /><span /><span className="colh">Freshdesk</span>
        </div>

        {SECTIONS.map(([key, title]) => {
          const list = rows.filter((r) => inSection(r, key));
          if (!list.length) return null;
          return (
            <div key={key} className="objsec">
              <div className="objsec-h">{title}</div>
              {list.map((r) => (
                <div key={r.type} className={`obj-row ${sel[r.type] ? '' : 'off'}`}>
                  <label className="obj-pick"><input type="checkbox" checked={!!sel[r.type]} disabled={busy} onChange={() => toggle(r.type)} /></label>
                  <div className="obj-name">{r.type}</div>
                  <div className="obj-actions">{actionsFor(r)}</div>
                  <div className="obj-arrow">→</div>
                  <div className="obj-name dst">{r.targetType}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {editing && <MappingModal projectId={projectId} type={editing.type} onClose={() => setEditing(null)} />}
    </>
  );
}

// The per-object mapping modal: a FIELD list (Tier 1) that drills into a VALUE
// map (Tier 2) for enum fields — the two-tier structure of a mature wizard.
function MappingModal({ projectId, type, onClose }) {
  const [view, setView] = useState('fields'); // 'fields' | <valueMapName>
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div>
            <b>Field &amp; value mapping — {type}</b>
            <div className="hint" style={{ margin: 0 }}>{view === 'fields' ? 'Match each Zendesk field to its Freshdesk destination. Enum fields open a value map.' : 'Zendesk value → Freshdesk value. Blank/unmatched values use the “Use for empty values” default.'}</div>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        {view === 'fields'
          ? <FieldsPanel projectId={projectId} type={type} onEditValues={setView} onClose={onClose} />
          : <ValuePanel projectId={projectId} name={view} onBack={() => setView('fields')} />}
      </div>
    </div>
  );
}

// Tier 1 — the field list. Source field → Freshdesk field, with a Skip toggle
// (required fields are locked on) and a "Values →" drill-in for enum fields.
function FieldsPanel({ projectId, type, onEditValues, onClose }) {
  const [data, setData] = useState(null);
  const [skip, setSkip] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    (async () => {
      const d = await api.getFieldMap(projectId, type);
      setData(d); setSkip(new Set(d.fields.filter((f) => f.skipped).map((f) => f.key)));
    })();
  }, [projectId, type]);

  function toggle(f) {
    if (!f.skippable) return;
    const next = new Set(skip);
    next.has(f.key) ? next.delete(f.key) : next.add(f.key);
    setSkip(next); setNote('');
  }
  async function save() {
    setSaving(true);
    try { const d = await api.saveFieldMap(projectId, type, [...skip]); setData(d); setNote('Saved ✓'); }
    finally { setSaving(false); }
  }

  if (!data) return <div className="modal-body"><div className="scan-loading"><span className="spin" /> Loading fields…</div></div>;

  return (
    <>
      <div className="modal-body">
        <table className="matrix map-fields">
          <thead><tr><th className="c">Migrate</th><th>Zendesk field</th><th>→ Freshdesk field</th><th /></tr></thead>
          <tbody>
            {data.fields.map((f) => {
              const on = !skip.has(f.key);
              return (
                <tr key={f.key} className={on ? '' : 'row-off'}>
                  <td className="c">
                    <input type="checkbox" checked={on} disabled={!f.skippable} onChange={() => toggle(f)} title={f.skippable ? '' : 'Required by Freshdesk'} />
                  </td>
                  <td>{f.source}{f.fk && <span className="tag-fk">linked</span>}</td>
                  <td>{f.target}{!f.skippable && <span className="tag-req">required</span>}</td>
                  <td className="c">{f.valueMap && <button className="btn tiny" onClick={() => onEditValues(f.valueMap)}>Values →</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-f">
        <span className="saved-note">{note || (data.customized ? 'Customized' : '')}</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Close</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save field mapping'}</button>
      </div>
    </>
  );
}

// Tier 2 — one enum value map. Each source value → target dropdown + an empty /
// unmatched default. Saves as a diff vs the shipped default.
function ValuePanel({ projectId, name, onBack }) {
  const [data, setData] = useState(null);
  const [dirty, setDirty] = useState({});
  const [empty, setEmpty] = useState(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  async function load() {
    setData(null); setDirty({}); setNote('');
    const d = await api.getValueMap(projectId, name);
    setData(d); setEmpty(d.emptyDefault);
  }
  useEffect(() => { load(); }, [name]);

  const isNumeric = data?.targetOptions?.some((o) => typeof o.value === 'number');
  const coerce = (v) => (isNumeric ? Number(v) : v);
  const curValue = (row) => (row.sourceValue in dirty ? dirty[row.sourceValue] : row.target);

  async function save() {
    setSaving(true);
    try {
      const map = { ...dirty };
      if (empty != null && empty !== '') map.__default = coerce(empty);
      const d = await api.saveValueMap(projectId, name, map);
      setData(d); setDirty({}); setNote('Saved ✓');
    } finally { setSaving(false); }
  }
  async function reset() {
    setSaving(true);
    try { const d = await api.resetValueMap(projectId, name); setData(d); setDirty({}); setEmpty(d.emptyDefault); setNote('Reset to default'); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="modal-body">
        <button className="btn tiny ghost back" onClick={onBack}>← Back to fields</button>
        <div className="vp-title">{data?.label || name}</div>
        {!data ? <div className="scan-loading"><span className="spin" /> Loading…</div> : (
          <table className="matrix map-values">
            <thead><tr><th>Zendesk value</th><th>→ Freshdesk value</th></tr></thead>
            <tbody>
              <tr className="empty-row">
                <td><i>Use for empty / unmatched values</i></td>
                <td>
                  <select value={empty ?? ''} onChange={(e) => setEmpty(e.target.value)}>
                    <option value="">— leave unset —</option>
                    {data.targetOptions.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
              </tr>
              {data.rows.map((row) => (
                <tr key={row.sourceValue}>
                  <td>{row.sourceValue}</td>
                  <td>
                    <select value={curValue(row) ?? ''} onChange={(e) => setDirty({ ...dirty, [row.sourceValue]: e.target.value === '' ? null : coerce(e.target.value) })}>
                      <option value="">— skip —</option>
                      {data.targetOptions.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="modal-f">
        <span className="saved-note">{note || (data?.customized ? 'Customized' : '')}</span>
        <div className="spacer" />
        <button className="btn ghost" disabled={saving} onClick={reset}>Reset to default</button>
        <button className="btn primary" disabled={saving || (!Object.keys(dirty).length && empty === data?.emptyDefault)} onClick={save}>{saving ? 'Saving…' : 'Save mapping'}</button>
      </div>
    </>
  );
}
