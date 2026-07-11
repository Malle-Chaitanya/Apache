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

// Human role label for a platform (Source vs Target).
const roleLabel = (p, sources, targets) =>
  sources.includes(p) && targets.includes(p) ? 'Source / Target' : sources.includes(p) ? 'Source' : targets.includes(p) ? 'Target' : '';

// A single platform card on the "All Platforms" tab: shows how many accounts are
// connected and opens the API-token form when you add one.
function PlatformCard({ platform, role, accounts, onRefresh }) {
  const [adding, setAdding] = useState(false);
  const mine = accounts.filter((a) => a.platform === platform && a.status !== 'deleted');
  const connected = mine.filter((a) => a.status === 'connected').length;
  return (
    <div className="pcard">
      <div className="pcard-head">
        <div className={`logo ${platform}`}><PlatformLogo platform={platform} /></div>
        <div className="pcard-meta">
          <div className="side">{role}</div>
          <div className="name">{platform}</div>
        </div>
      </div>
      <div className={`pcard-count ${connected ? 'ok' : ''}`}>
        {connected ? `${connected} account${connected > 1 ? 's' : ''} connected` : 'No account connected'}
      </div>
      {!adding && <button className="btn block" onClick={() => setAdding(true)}>{connected ? '+ Add Another' : `+ Connect ${platform}`}</button>}
      {adding && (
        <div className="pcard-form">
          <div className="dom" style={{ marginBottom: 8 }}>Enter {platform} API credentials</div>
          <AccountForm platform={platform} onDone={() => { setAdding(false); onRefresh(); }} onCancel={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}

// Step 1 — Connect Platforms. Tabbed: "All Platforms" (add/connect via API token)
// and "Manage Platforms" (table of connected accounts + remove).
export function ConnectPlatforms({ accounts, sources, targets, onRefresh }) {
  const [tab, setTab] = useState('all');
  const platforms = [...new Set([...sources, ...targets])];
  const live = accounts.filter((a) => a.status !== 'deleted');
  return (
    <div className="card">
      <h2>Connect Platforms</h2>
      <p className="hint">Connect the source and destination help desks with admin credentials. Connect once — stored encrypted and reused across migrations.</p>

      <div className="tabs">
        <button className={`tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>All Platforms</button>
        <button className={`tab ${tab === 'manage' ? 'active' : ''}`} onClick={() => setTab('manage')}>
          Manage Platforms {live.length > 0 && <span className="tab-check">✓</span>}
        </button>
      </div>

      {tab === 'all' ? (
        <>
          <p className="hint" style={{ marginTop: 16 }}>Click a platform to add and connect an account. You can add multiple accounts per platform.</p>
          <div className="pcards">
            {platforms.map((p) => (
              <PlatformCard key={p} platform={p} role={roleLabel(p, sources, targets)} accounts={accounts} onRefresh={onRefresh} />
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="hint" style={{ marginTop: 16 }}>Manage and remove your connected platform accounts.</p>
          <div className="acct-list">
            {live.length === 0 && <p className="empty">No accounts connected yet. Add one from All Platforms.</p>}
            {live.map((a) => <AccountRow key={a._id} acc={a} onRefresh={onRefresh} />)}
          </div>
        </>
      )}
    </div>
  );
}

// Step 2 — Choose Migration Pair. Pick one connected source account + one
// connected target account; renders the Source → Target combination card.
export function PairPicker({ accounts, sources, targets, value, onChange }) {
  const forSide = (list) => accounts.filter((a) => list.includes(a.platform) && a.status === 'connected');
  const srcAccts = forSide(sources);
  const tgtAccts = forSide(targets);
  const src = srcAccts.find((a) => a._id === value.sourceAccountId);
  const tgt = tgtAccts.find((a) => a._id === value.targetAccountId);

  const platformOf = (list) => list[0]?.platform;
  const Side = ({ tag, acct, list, field }) => {
    const platform = acct?.platform || platformOf(list);
    return (
      <div className="pair-card">
        <div className="pair-tag">{tag}</div>
        <div className="platform">
          <div className={`logo ${platform}`}><PlatformLogo platform={platform} /></div>
          <div className="meta"><div className="name">{platform}</div></div>
        </div>
        {list.length > 1 ? (
          <select className="acct-select" value={value[field] || ''} onChange={(e) => onChange({ ...value, [field]: e.target.value })}>
            <option value="">Select an account…</option>
            {list.map((a) => <option key={a._id} value={a._id}>{a.label}</option>)}
          </select>
        ) : (
          <div className="hint" style={{ margin: 0 }}>Using account <b>{acct?.label || list[0]?.label || '—'}</b></div>
        )}
        <span className={`pill ${acct ? 'connected' : 'pending'}`}>{acct ? 'connected' : 'select account'}</span>
      </div>
    );
  };

  return (
    <div className="card">
      <h2>Choose Migration Pair</h2>
      <p className="hint">Select the source and destination for your migration.</p>
      <div className="pair-row">
        <Side tag="SOURCE" acct={src} list={srcAccts} field="sourceAccountId" />
        <div className="arrow">→</div>
        <Side tag="TARGET" acct={tgt} list={tgtAccts} field="targetAccountId" />
      </div>
    </div>
  );
}
