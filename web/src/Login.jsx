import React, { useState } from 'react';
import { auth } from './api.js';
import Logo from './Logo.jsx';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { onLogin(await auth.login(email, password)); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-brand">
        <div className="lb-top"><Logo color="#ffffff" height={34} /></div>
        <div className="lb-mid">
          <div className="eyebrow">Enterprise ITSM Migration</div>
          <h1>CloudFuze<br />Migration</h1>
          <p>Move the whole helpdesk — data <em>and</em> configuration — from Zendesk to Freshdesk. Automated, secure, auditable.</p>
          <ul>
            <li><span>✓</span> Data + configuration migrated in one run</li>
            <li><span>✓</span> Batch-wise, checkpointed, resumable with retry</li>
            <li><span>✓</span> Full reconciliation reports + manual checklist</li>
          </ul>
        </div>
        <div className="lb-foot">CloudFuze © 2026. All rights reserved.</div>
      </div>
      <div className="login-form">
        <form className="login-card" onSubmit={submit}>
          <Logo color="#0129AC" height={40} />
          <h2>Welcome back</h2>
          <p className="sub">Sign in to access the migration tool</p>
          <div className="field"><label>EMAIL</label>
            <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></div>
          <div className="field"><label>PASSWORD</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
          {error && <div className="login-err">{error}</div>}
          <button className="btn primary block lg" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign In'}</button>
        </form>
      </div>
    </div>
  );
}
