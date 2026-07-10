import React, { useState } from 'react';
import { api } from './api.js';
import PlatformLogo from './PlatformLogo.jsx';

// Platform auth metadata (self-contained so this module stands alone).
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

// Add or reconnect a cloud account. `existing` → reconnect that account.
export function AccountForm({ platform, existing, onDone, onCancel }) {
  const [authType, setAuthType] = useState(existing?.authType || DEFAULT_AUTH[platform]);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields = FIELDS[platform]?.[authType] || [];
  const isOAuth = authType === 'oauth';
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true); setError('');
    try {
      if (isOAuth) {
        const out = await api.beginAddAccount({ platform, authType, instance: values.subdomain });
        // Same-window redirect → provider sends the browser back to the app
        // (redirect_uri), which captures ?code&state on load and completes.
        if (out.redirectUrl) { window.location.href = out.redirectUrl; return; }
        onDone(null);
      } else if (existing) {
        onDone(await api.reconnectAccount(existing._id, { platform, authType, fields: values, instance: values.subdomain }));
      } else {
        onDone(await api.completeAddAccount({ platform, authType, fields: values, instance: values.subdomain }));
      }
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="acct-form">
      {AUTH_OPTIONS[platform].length > 1 && !existing && (
        <div className="field"><label>Authentication method</label>
          <select value={authType} onChange={(e) => setAuthType(e.target.value)}>
            {AUTH_OPTIONS[platform].map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
          </select></div>
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
      <div className="actions" style={{ marginTop: 12 }}>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <div className="spacer" />
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Connecting…' : isOAuth ? `Authorize ${platform}` : existing ? 'Reconnect' : 'Connect'}</button>
      </div>
    </div>
  );
}

function AccountRow({ acc, onRefresh }) {
  const [reconnect, setReconnect] = useState(false);
  async function remove() { await api.deleteAccount(acc._id); onRefresh(); }
  return (
    <div className="acct-row">
      <div className="platform">
        <div className={`logo ${acc.platform}`}><PlatformLogo platform={acc.platform} /></div>
        <div className="meta"><div className="name">{acc.platform}</div><div className="side">{acc.label} · {AUTH_LABEL[acc.authType] || acc.authType}</div></div>
      </div>
      <span className={`pill ${acc.status}`}>{acc.status}</span>
      <div className="acct-actions">
        {acc.status === 'reauth_required' && <button className="btn" onClick={() => setReconnect((v) => !v)}>Reconnect</button>}
        <button className="btn ghost" onClick={remove}>Remove</button>
      </div>
      {reconnect && <div style={{ gridColumn: '1 / -1' }}><AccountForm platform={acc.platform} existing={acc} onDone={() => { setReconnect(false); onRefresh(); }} onCancel={() => setReconnect(false)} /></div>}
    </div>
  );
}

// Full "Manage Clouds" page.
export function ManageClouds({ accounts, platforms, onRefresh }) {
  const [addFor, setAddFor] = useState(null);
  return (
    <div className="card">
      <h2>Cloud accounts</h2>
      <p className="hint">Connect a platform once — it's stored encrypted and reused across every migration. No re-entering API keys.</p>

      <div className="acct-list">
        {accounts.length === 0 && <p className="empty">No accounts connected yet. Add one below.</p>}
        {accounts.map((a) => <AccountRow key={a._id} acc={a} onRefresh={onRefresh} />)}
      </div>

      <div style={{ marginTop: 18 }}>
        <div className="dom" style={{ marginBottom: 8 }}>Add an account</div>
        <div className="pgrid">
          {platforms.map((p) => (
            <div key={p} className={`ptile ${addFor === p ? 'sel' : ''}`} onClick={() => setAddFor(p)}>
              <div className="logo"><PlatformLogo platform={p} /></div><div className="nm">{p}</div>
            </div>
          ))}
        </div>
        {addFor && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="platform" style={{ marginBottom: 10 }}>
              <div className={`logo ${addFor}`}><PlatformLogo platform={addFor} /></div>
              <div className="meta"><div className="name">Connect {addFor}</div></div>
            </div>
            <AccountForm platform={addFor} onDone={() => { setAddFor(null); onRefresh(); }} onCancel={() => setAddFor(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

// Pick a saved account for a platform (used in New Migration), or add one.
export function AccountPicker({ label, platform, accounts, value, onChange, onRefresh }) {
  const [adding, setAdding] = useState(false);
  const mine = accounts.filter((a) => a.platform === platform && a.status !== 'deleted');
  return (
    <div>
      <label className="dom">{label} · {platform}</label>
      {mine.length > 0 && (
        <select className="acct-select" value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a saved account…</option>
          {mine.map((a) => <option key={a._id} value={a._id}>{a.label} ({a.status})</option>)}
        </select>
      )}
      {!adding && <button className="btn ghost" onClick={() => setAdding(true)}>+ Add {platform} account</button>}
      {adding && (
        <div className="card" style={{ marginTop: 8 }}>
          <AccountForm platform={platform} onDone={(acc) => { setAdding(false); onRefresh(); if (acc?._id) onChange(acc._id); }} onCancel={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}

// Connect-step summary: the project's bound accounts (already connected).
export function ConnectSummary({ project, accounts, onRefresh }) {
  const find = (side) => accounts.find((a) => a._id === project[side]?.accountId);
  const Side = ({ side }) => {
    const acc = find(side);
    return (
      <div className="card conn">
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div className="platform">
            <div className={`logo ${project[side].platform}`}><PlatformLogo platform={project[side].platform} /></div>
            <div className="meta"><div className="side">{side}</div><div className="name">{project[side].platform}</div></div>
          </div>
          <span className={`pill ${acc?.status || 'pending'}`}>{acc?.status || 'not selected'}</span>
        </div>
        {acc ? <div className="hint">Using saved account <b>{acc.label}</b>.</div>
             : <div className="hint">No account selected — add one in Clouds.</div>}
        {acc?.status === 'reauth_required' && <AccountForm platform={acc.platform} existing={acc} onDone={onRefresh} />}
      </div>
    );
  };
  return (
    <div className="card">
      <h2>Connected platforms</h2>
      <p className="hint">These migrations use your saved cloud accounts — credentials are already stored, no re-entry needed.</p>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <Side side="source" /><div className="arrow">→</div><Side side="target" />
      </div>
    </div>
  );
}
