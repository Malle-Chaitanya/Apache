import React, { useEffect, useRef, useState } from 'react';
import { api, auth } from './api.js';
import Login from './Login.jsx';
import Logo from './Logo.jsx';
import { Stepper, ReauthBanner, Configure, Kpis, MatrixTable, Log, Report, Progress, DryRunSummary } from './steps.jsx';
import { ConnectPlatforms, PairPicker } from './Clouds.jsx';

// The migration steps, in the order a real migration runs.
const STEPS = [
  { key: 'connect', label: 'Connect Platforms' },
  { key: 'pair', label: 'Choose Pair' },
  { key: 'select', label: 'Select Data' },
  { key: 'precheck', label: 'Dry Run' },
  { key: 'migrate', label: 'Live Migration' },
  { key: 'report', label: 'Report' },
];
const idx = (k) => STEPS.findIndex((s) => s.key === k);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [project, setProject] = useState(null);
  const [step, setStep] = useState(0);
  const [pair, setPair] = useState({ sourceAccountId: '', targetAccountId: '' });
  const [options, setOptions] = useState({ migrateConfig: true, migrateData: true });
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [matrix, setMatrix] = useState([]);
  const [report, setReport] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [dryDone, setDryDone] = useState(false);
  const [liveDone, setLiveDone] = useState(false);
  const poll = useRef(null);
  const runModeRef = useRef(null);   // 'dry' | 'live' — read inside the poll closure
  const armedRef = useRef(false);    // have we observed THIS run actually running yet?

  useEffect(() => {
    (async () => {
      try { setConfig(await api.config()); } catch { /* ignore */ }
      if (auth.token()) {
        try {
          setUser(await api.me());
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

  const sources = config?.sources || ['zendesk'];
  const targets = config?.targets || ['freshdesk'];
  const connectedFor = (list) => accounts.filter((a) => list.includes(a.platform) && a.status === 'connected');
  const srcConnected = connectedFor(sources);
  const tgtConnected = connectedFor(targets);
  const key = STEPS[step].key;

  // Poll accounts while on the connect step so OAuth callbacks land.
  useEffect(() => {
    if (!user || key !== 'connect') return;
    const id = setInterval(refreshAccounts, 2500);
    return () => clearInterval(id);
  }, [user, key]);

  // Default the pair selection to the single connected account per side.
  useEffect(() => {
    if (key !== 'pair') return;
    setPair((prev) => ({
      sourceAccountId: prev.sourceAccountId || (srcConnected.length === 1 ? srcConnected[0]._id : ''),
      targetAccountId: prev.targetAccountId || (tgtConnected.length === 1 ? tgtConnected[0]._id : ''),
    }));
  }, [key, accounts]);

  // Scan the source once we land on Select Data with a project.
  useEffect(() => {
    if (key !== 'select' || !project || scan || scanning) return;
    (async () => {
      setScanning(true);
      try { setScan(await api.scan(project._id)); } catch { setScan(null); }
      setScanning(false);
    })();
  }, [key, project]);

  async function refreshRun() {
    const id = project._id;
    const [p, m, r, c, e] = await Promise.all([api.getProject(id), api.matrix(id), api.report(id), api.conflicts(id), api.events(id)]);
    setProject(p); setMatrix(m); setReport(r); setConflicts(c); setEvents(e);
    const terminal = ['completed', 'failed', 'reauth_required'].includes(p.status);
    // Once we've seen the run actually running, a terminal status means done.
    // Until then, ignore a terminal status left over from a PREVIOUS run — this
    // is what makes the dry-run → live-run transition show live progress instead
    // of the previous run's finished/report view.
    if (!terminal) { armedRef.current = true; return; }
    if (!armedRef.current) return;
    clearInterval(poll.current); setRunning(false);
    if (p.status === 'completed') { if (runModeRef.current === 'dry') setDryDone(true); if (runModeRef.current === 'live') setLiveDone(true); }
    if (p.status === 'reauth_required') refreshAccounts();
  }
  function startRun(dryRun) {
    setRunning(true); runModeRef.current = dryRun ? 'dry' : 'live'; armedRef.current = false;
    if (dryRun) setDryDone(false); else setLiveDone(false);
    api.run(project._id, dryRun).catch(() => {});
    clearInterval(poll.current);
    poll.current = setInterval(refreshRun, 1000);
  }

  function clearRunState() {
    clearInterval(poll.current); setRunning(false);
    runModeRef.current = null; armedRef.current = false;
    setDryDone(false); setLiveDone(false);
    setMatrix([]); setReport(null); setConflicts([]); setEvents([]); setScan(null);
  }
  function resetToStart() {
    clearRunState(); setProject(null); setPair({ sourceAccountId: '', targetAccountId: '' }); setStep(0);
  }
  function signOut() { resetToStart(); auth.logout(); setUser(null); setAccounts([]); }

  // pair → select: create the project silently, bound to the chosen accounts.
  async function goToSelect() {
    const srcAcct = accounts.find((a) => a._id === pair.sourceAccountId);
    const tgtAcct = accounts.find((a) => a._id === pair.targetAccountId);
    const needNew = !project || project.source?.accountId !== pair.sourceAccountId || project.target?.accountId !== pair.targetAccountId;
    if (needNew) {
      clearRunState();
      const name = `${cap(srcAcct?.platform)} → ${cap(tgtAcct?.platform)}`;
      const p = await api.createProject({ name, source: { accountId: pair.sourceAccountId }, target: { accountId: pair.targetAccountId } });
      setProject(p);
    }
    setStep(idx('select'));
  }

  if (booting) return null;
  if (!user) return <Login onLogin={async (u) => { setUser(u); setAccounts(await api.listAccounts()); }} />;

  const acctFor = (side) => accounts.find((a) => a._id === project?.[side]?.accountId);
  const boundForBanner = project
    ? ['source', 'target'].map((side) => { const a = acctFor(side); return a ? { side, platform: a.platform, status: a.status } : null; }).filter(Boolean)
    : [];
  const statusText = running ? 'Running' : project ? cap(project.status) : 'Idle';
  const statusPill = running ? 'running' : project?.status === 'completed' ? 'completed' : 'idle';

  const topbar = (
    <header className="topbar">
      <div className="brand"><Logo color="#ffffff" height={30} /><div><p>ITSM migration · data + configuration</p></div></div>
      <div className="proj">
        <span className={`pill ${statusPill}`}>{statusText}</span>
        <span className="who">{user.name}</span>
        <button className="btn ghost" onClick={resetToStart}>↺ Reset</button>
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );

  // Bottom action bar: the Next button, gated per step. precheck / migrate drive
  // their primary action inline (Start dry run / Go live / Start migration).
  const nextButton = () => {
    if (key === 'connect') {
      const ok = srcConnected.length > 0 && tgtConnected.length > 0;
      return <button className="btn primary" disabled={!ok} onClick={() => setStep(idx('pair'))}>{ok ? 'Continue →' : 'Connect both sides to continue'}</button>;
    }
    if (key === 'pair') {
      const ok = pair.sourceAccountId && pair.targetAccountId;
      return <button className="btn primary" disabled={!ok} onClick={goToSelect}>{ok ? 'Continue →' : 'Select both accounts'}</button>;
    }
    if (key === 'select') {
      const ok = options.migrateConfig || options.migrateData;
      return <button className="btn primary" disabled={!ok} onClick={() => setStep(idx('precheck'))}>{ok ? 'Continue to dry run →' : 'Select at least one scope'}</button>;
    }
    if (key === 'migrate' && liveDone) {
      return <button className="btn primary" onClick={() => setStep(idx('report'))}>View report →</button>;
    }
    return null;
  };

  return (
    <>
      {topbar}
      <main>
        <Stepper steps={STEPS} current={step} />
        <ReauthBanner connections={boundForBanner} onReconnect={() => setStep(idx('connect'))} />

        {key === 'connect' && <ConnectPlatforms accounts={accounts} sources={sources} targets={targets} onRefresh={refreshAccounts} />}

        {key === 'pair' && <PairPicker accounts={accounts} sources={sources} targets={targets} value={pair} onChange={setPair} />}

        {key === 'select' && <Configure options={options} setOptions={setOptions} scan={scan} scanning={scanning} />}

        {key === 'precheck' && (running ? (
          <><Progress report={report} matrix={matrix} mode="dry" /><Log events={events} /></>
        ) : dryDone ? (
          <><DryRunSummary report={report} matrix={matrix} running={running} onGoLive={() => { setStep(idx('migrate')); startRun(false); }} /><Log events={events} /></>
        ) : (
          <div className="card">
            <h2>Dry Run (Pre-check)</h2>
            <p className="hint">A dry run reads both platforms and previews exactly what would migrate — no data is written. Recommended before the first live migration.</p>
            <button className="btn primary lg" onClick={() => startRun(true)}>🔍 Start Dry Run</button>
          </div>
        ))}

        {key === 'migrate' && (running ? (
          <><Progress report={report} matrix={matrix} mode="live" /><Log events={events} /></>
        ) : liveDone ? (
          <><Kpis totals={report?.totals} />{!!matrix.length && <MatrixTable rows={matrix} />}<Log events={events} /></>
        ) : (
          <div className="card">
            <h2>Live Migration</h2>
            <p className="hint">Configuration loads first, then data — batched, checkpointed, resumable. IDs are re-mapped so relationships stay intact.</p>
            <button className="btn primary lg" onClick={() => startRun(false)}>🚀 Start Migration (Live)</button>
          </div>
        ))}

        {key === 'report' && <Report report={report} conflicts={conflicts} projectId={project?._id} />}

        <div className="actions">
          <button className="btn" onClick={() => (step === 0 ? resetToStart() : setStep((s) => Math.max(0, s - 1)))} disabled={running}>← Back</button>
          <div className="spacer" />
          {nextButton()}
        </div>
      </main>
    </>
  );
}
