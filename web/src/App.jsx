import React, { useEffect, useRef, useState } from 'react';
import { api, auth } from './api.js';
import Login from './Login.jsx';
import Logo from './Logo.jsx';
import PlatformLogo from './PlatformLogo.jsx';
import { Stepper, ReauthBanner, Configure, Kpis, MatrixTable, Conflicts, Log, Report } from './steps.jsx';
import { ManageClouds, AccountPicker, ConnectSummary } from './Clouds.jsx';

const STEPS = [
  { key: 'connect', label: 'Connect' },
  { key: 'configure', label: 'Select data' },
  { key: 'precheck', label: 'Pre-check' },
  { key: 'migrate', label: 'Migrate' },
  { key: 'report', label: 'Report' },
];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [view, setView] = useState('wizard');       // wizard | clouds
  const [project, setProject] = useState(null);
  const [step, setStep] = useState(0);
  const [matrix, setMatrix] = useState([]);
  const [report, setReport] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [events, setEvents] = useState([]);
  const [options, setOptions] = useState({ migrateConfig: true, migrateData: true });
  const [running, setRunning] = useState(false);
  const poll = useRef(null);

  useEffect(() => {
    (async () => {
      try { setConfig(await api.config()); } catch { /* ignore */ }
      if (auth.token()) {
        try {
          setUser(await api.me());
          // OAuth return: Zendesk/Jira redirect back to the app with ?code&state.
          const q = new URLSearchParams(window.location.search);
          if (q.get('code') && q.get('state')) {
            try { await api.completeOAuth(q.get('code'), q.get('state')); } catch { /* surfaced via account status */ }
            window.history.replaceState({}, '', window.location.pathname);
          }
          setAccounts(await api.listAccounts());
        } catch { auth.logout(); }
      }
      setBooting(false);
    })();
    return () => clearInterval(poll.current);
  }, []);

  const refreshAccounts = async () => { try { setAccounts(await api.listAccounts()); } catch { /* ignore */ } };

  // While connecting (or managing clouds), poll accounts to catch OAuth callbacks.
  useEffect(() => {
    if (!user) return;
    if (view !== 'clouds' && !(project && STEPS[step].key === 'connect')) return;
    const id = setInterval(refreshAccounts, 2500);
    return () => clearInterval(id);
  }, [user, view, project, step]);

  async function refreshRun() {
    const id = project._id;
    const [p, m, r, c, e] = await Promise.all([api.getProject(id), api.matrix(id), api.report(id), api.conflicts(id), api.events(id)]);
    setProject(p); setMatrix(m); setReport(r); setConflicts(c); setEvents(e);
    if (['completed', 'failed', 'reauth_required'].includes(p.status)) {
      clearInterval(poll.current); setRunning(false);
      if (p.status === 'reauth_required') refreshAccounts();
    }
  }
  function startRun(dryRun) {
    setRunning(true);
    api.run(project._id, dryRun).catch(() => {});
    clearInterval(poll.current);
    poll.current = setInterval(refreshRun, 1000);
  }
  function resetToNew() {
    clearInterval(poll.current); setRunning(false); setView('wizard');
    setProject(null); setStep(0); setReport(null); setConflicts([]); setEvents([]); setMatrix([]);
  }
  function signOut() { resetToNew(); auth.logout(); setUser(null); setAccounts([]); }

  if (booting) return null;
  if (!user) return <Login onLogin={async (u) => { setUser(u); setAccounts(await api.listAccounts()); }} />;

  const platforms = [...new Set([...(config?.sources || []), ...(config?.targets || [])])];
  const acctFor = (side) => accounts.find((a) => a._id === project?.[side]?.accountId);
  const bothConnected = acctFor('source')?.status === 'connected' && acctFor('target')?.status === 'connected';
  const key = STEPS[step].key;
  const boundForBanner = project ? ['source', 'target'].map((side) => { const a = acctFor(side); return a ? { side, platform: a.platform, status: a.status } : null; }).filter(Boolean) : [];

  const topbar = (
    <header className="topbar">
      <div className="brand"><Logo color="#ffffff" height={30} /><div><p>ITSM migration · data + configuration</p></div></div>
      <div className="proj">
        {project && <><b>{project.name}</b> · {project.source.platform} → {project.target.platform} · <span className={`pill ${project.status === 'completed' ? 'connected' : project.status}`}>{project.status}</span> · </>}
        <button className="btn ghost" onClick={() => setView(view === 'clouds' ? 'wizard' : 'clouds')}>☁ Clouds</button>
        {project && <button className="btn ghost" onClick={resetToNew}>New migration</button>}
        <span className="who">{user.name}</span>
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );

  if (view === 'clouds') {
    return <>{topbar}<main><ManageClouds accounts={accounts} platforms={platforms} onRefresh={refreshAccounts} /></main></>;
  }

  if (!project) {
    return <>{topbar}<NewMigration config={config} accounts={accounts} onRefreshAccounts={refreshAccounts} onCreate={async (body) => {
      const p = await api.createProject(body); setProject(p); setStep(0); await refreshAccounts();
    }} /></>;
  }

  return (
    <>
      {topbar}
      <main>
        <Stepper steps={STEPS} current={step} />
        <ReauthBanner connections={boundForBanner} onReconnect={() => setStep(0)} />

        {key === 'connect' && <ConnectSummary project={project} accounts={accounts} onRefresh={refreshAccounts} />}
        {key === 'configure' && <Configure options={options} setOptions={setOptions} />}
        {key === 'precheck' && (<>
          <div className="card"><h2>Pre-check (dry run)</h2><p className="hint">Reads both platforms and produces the full mapping preview + conflict list. No data is written.</p>
            <button className="btn primary" disabled={running} onClick={() => startRun(true)}>{running ? 'Analyzing…' : '▶ Run pre-check'}</button></div>
          {!!matrix.length && <MatrixTable rows={matrix} />}
          <Conflicts items={conflicts} />
        </>)}
        {key === 'migrate' && (<>
          <div className="card"><h2>Run migration</h2><p className="hint">Configuration loads first, then data — batched, checkpointed, resumable. IDs are re-mapped so relationships stay intact.</p>
            <button className="btn primary lg" disabled={running} onClick={() => startRun(false)}>{running ? 'Migrating…' : '▶ Start migration'}</button></div>
          <Kpis totals={report?.totals} />
          {!!matrix.length && <MatrixTable rows={matrix} />}
          <Log events={events} />
        </>)}
        {key === 'report' && <Report report={report} conflicts={conflicts} projectId={project._id} />}

        <div className="actions">
          <button className="btn" onClick={() => (step === 0 ? resetToNew() : setStep((s) => Math.max(0, s - 1)))}>← Back</button>
          <div className="spacer" />
          {step < STEPS.length - 1 && (
            <button className="btn primary" disabled={key === 'connect' && !bothConnected}
              onClick={() => { setStep((s) => s + 1); if (STEPS[step + 1].key !== 'connect') refreshRun().catch(() => {}); }}>
              {key === 'connect' && !bothConnected ? 'Connect both to continue' : 'Next →'}
            </button>
          )}
        </div>
      </main>
    </>
  );
}

function NewMigration({ config, accounts, onRefreshAccounts, onCreate }) {
  const sources = config?.sources || ['zendesk'];
  const targets = config?.targets || ['freshdesk'];
  const [name, setName] = useState('');
  const [source, setSource] = useState(sources[0]);
  const [target, setTarget] = useState(targets[0]);
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [targetAccountId, setTargetAccountId] = useState('');
  const ready = name.trim() && sourceAccountId && targetAccountId;
  return (
    <main>
      <div className="card" style={{ maxWidth: 760, margin: '10px auto' }}>
        <h2>New migration</h2>
        <p className="hint">Name it, pick platforms, and choose a saved cloud account for each side (or add one — it's reused next time).</p>
        <div className="field"><label>Project name</label><input value={name} placeholder="Name this migration" onChange={(e) => setName(e.target.value)} /></div>
        <div className="row">
          <div>
            <div className="pgrid">{sources.map((p) => (
              <div key={p} className={`ptile ${source === p ? 'sel' : ''}`} onClick={() => { setSource(p); setSourceAccountId(''); }}><div className="logo"><PlatformLogo platform={p} /></div><div className="nm">{p}</div></div>
            ))}</div>
            <div style={{ marginTop: 10 }}>
              <AccountPicker label="Source" platform={source} accounts={accounts} value={sourceAccountId} onChange={setSourceAccountId} onRefresh={onRefreshAccounts} />
            </div>
          </div>
          <div className="arrow">→</div>
          <div>
            <div className="pgrid">{targets.map((p) => (
              <div key={p} className={`ptile ${target === p ? 'sel' : ''}`} onClick={() => { setTarget(p); setTargetAccountId(''); }}><div className="logo"><PlatformLogo platform={p} /></div><div className="nm">{p}</div></div>
            ))}</div>
            <div style={{ marginTop: 10 }}>
              <AccountPicker label="Destination" platform={target} accounts={accounts} value={targetAccountId} onChange={setTargetAccountId} onRefresh={onRefreshAccounts} />
            </div>
          </div>
        </div>
        <div className="actions"><div className="spacer" />
          <button className="btn primary lg" disabled={!ready}
            onClick={() => onCreate({ name: name.trim(), source: { accountId: sourceAccountId }, target: { accountId: targetAccountId } })}>Create migration →</button>
        </div>
      </div>
    </main>
  );
}
