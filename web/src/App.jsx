import React, { useEffect, useRef, useState } from 'react';
import { api, auth } from './api.js';
import Login from './Login.jsx';
import Logo from './Logo.jsx';
import { Stepper, ReauthBanner, Configure, Kpis, MatrixTable, Report, Progress, DryRunSummary } from './steps.jsx';
import { ConnectPlatforms, PairPicker } from './Clouds.jsx';
import { Mapping } from './Mapping.jsx';
import AgentGuide from './AgentGuide.jsx';

// The migration steps, in the order a real migration runs.
const STEPS = [
  { key: 'connect', label: 'Connect Platforms' },
  { key: 'pair', label: 'Choose Pair' },
  { key: 'select', label: 'Select Data' },
  { key: 'mapping', label: 'Select & Map' },
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
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [running, setRunning] = useState(false);
  const [dryDone, setDryDone] = useState(false);
  const [liveDone, setLiveDone] = useState(false);
  // Guide panel: user-resizable width + which side it sits on (persisted).
  const [guideWidth, setGuideWidth] = useState(() => { const v = Number(localStorage.getItem('cf_guide_w')); return v >= 300 && v <= 720 ? v : 400; });
  const [guideSwapped, setGuideSwapped] = useState(() => localStorage.getItem('cf_guide_swap') === '1');
  const guideWidthRef = useRef(guideWidth);
  guideWidthRef.current = guideWidth;
  const poll = useRef(null);
  const runModeRef = useRef(null);   // 'dry' | 'live' — read inside the poll closure
  const armedRef = useRef(false);    // have we observed THIS run actually running yet?
  const activeProjectIdRef = useRef(null); // id of the project the current run polls — decoupled from state timing (the guide can start a run on a just-created project)

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
    const id = activeProjectIdRef.current || project?._id;
    if (!id) return;
    const [p, m, r, c, pr] = await Promise.all([api.getProject(id), api.matrix(id), api.report(id), api.conflicts(id), api.progress(id).catch(() => null)]);
    setProject(p); setMatrix(m); setReport(r); setConflicts(c); setProgress(pr);
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
  function startRun(dryRun, projId = project?._id) {
    if (!projId) return;
    activeProjectIdRef.current = projId;
    setRunning(true); runModeRef.current = dryRun ? 'dry' : 'live'; armedRef.current = false;
    if (dryRun) setDryDone(false); else setLiveDone(false);
    // Clear any prior run's report/matrix so the progress ring starts at 0 and
    // climbs — otherwise the just-finished dry run's counts read as 100% until
    // the backend re-extracts and resets record statuses.
    setReport(null); setMatrix([]); setConflicts([]); setProgress(null);
    api.run(projId, dryRun).catch(() => {});
    clearInterval(poll.current);
    poll.current = setInterval(refreshRun, 1000);
  }

  function clearRunState() {
    clearInterval(poll.current); setRunning(false);
    runModeRef.current = null; armedRef.current = false;
    setDryDone(false); setLiveDone(false);
    setMatrix([]); setReport(null); setConflicts([]); setScan(null); setProgress(null);
  }
  function resetToStart() {
    clearRunState(); setProject(null); setPair({ sourceAccountId: '', targetAccountId: '' }); setStep(0);
  }
  function signOut() { resetToStart(); auth.logout(); setUser(null); setAccounts([]); }

  // ── Draggable / swappable guide panel (GEM_CO parity) ──
  function swapGuide() {
    setGuideSwapped((s) => { const n = !s; localStorage.setItem('cf_guide_swap', n ? '1' : '0'); return n; });
  }
  function startDividerDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = guideWidthRef.current;
    const swapped = guideSwapped; // guide on the left → drag right widens it
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(300, Math.min(720, swapped ? startW + dx : startW - dx));
      guideWidthRef.current = w; setGuideWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = ''; document.body.style.cursor = '';
      localStorage.setItem('cf_guide_w', String(Math.round(guideWidthRef.current)));
    };
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Create (or reuse) the project bound to a source/target account pair. Shared
  // by the manual pair → select flow and the AI guide's navigation.
  async function ensureProject(sp, tp) {
    const needNew = !project || project.source?.accountId !== sp || project.target?.accountId !== tp;
    if (!needNew) return project;
    clearRunState();
    const srcAcct = accounts.find((a) => a._id === sp);
    const tgtAcct = accounts.find((a) => a._id === tp);
    const name = `${cap(srcAcct?.platform)} → ${cap(tgtAcct?.platform)}`;
    const p = await api.createProject({ name, source: { accountId: sp }, target: { accountId: tp } });
    setProject(p);
    return p;
  }

  // pair → select: create the project silently, bound to the chosen accounts.
  async function goToSelect() {
    await ensureProject(pair.sourceAccountId, pair.targetAccountId);
    setStep(idx('select'));
  }

  // ── AI guide drives the same wizard the user clicks ─────────────────────────
  // Resolve the account pair, defaulting to the single connected account per side.
  function resolvePair() {
    const sp = pair.sourceAccountId || (srcConnected.length === 1 ? srcConnected[0]._id : '');
    const tp = pair.targetAccountId || (tgtConnected.length === 1 ? tgtConnected[0]._id : '');
    if (sp && tp && (!pair.sourceAccountId || !pair.targetAccountId)) setPair({ sourceAccountId: sp, targetAccountId: tp });
    return { sp, tp };
  }
  // Guarded navigation: clamp to reachable steps and create the project on the
  // way into Select Data (mirrors the manual pair → select flow).
  async function agentNavigate(target) {
    const t = Math.max(0, Math.min(STEPS.length - 1, target));
    const both = srcConnected.length > 0 && tgtConnected.length > 0;
    if (t >= idx('pair') && !both) { setStep(idx('connect')); return; }
    if (t >= idx('select')) {
      const { sp, tp } = resolvePair();
      if (!sp || !tp) { setStep(idx('pair')); return; }
      await ensureProject(sp, tp);
    }
    setStep(t);
  }
  // Start a dry run / live run from the guide: ensure prerequisites, land on the
  // right step, then run against the (possibly just-created) project id.
  async function agentStartRun(dryRun) {
    if (srcConnected.length === 0 || tgtConnected.length === 0) { setStep(idx('connect')); return; }
    const { sp, tp } = resolvePair();
    if (!sp || !tp) { setStep(idx('pair')); return; }
    const p = await ensureProject(sp, tp);
    setStep(idx(dryRun ? 'precheck' : 'migrate'));
    startRun(dryRun, p._id);
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
      return <button className="btn primary" disabled={!ok} onClick={() => setStep(idx('mapping'))}>{ok ? 'Continue to mapping →' : 'Select at least one scope'}</button>;
    }
    if (key === 'mapping') {
      return <button className="btn primary" onClick={() => setStep(idx('precheck'))}>Continue to dry run →</button>;
    }
    if (key === 'migrate' && liveDone) {
      return <button className="btn primary" onClick={() => setStep(idx('report'))}>View report →</button>;
    }
    return null;
  };

  // Live snapshot + drive-actions handed to the AI migration guide.
  const guideCtx = {
    state: {
      step, stepKey: key,
      srcPlatform: sources[0] || 'zendesk', tgtPlatform: targets[0] || 'freshdesk',
      srcConnectedCount: srcConnected.length, tgtConnectedCount: tgtConnected.length,
      bothConnected: srcConnected.length > 0 && tgtConnected.length > 0,
      hasProject: !!project, projectId: project?._id || null, projectStatus: project?.status || 'none',
      scope: { migrateConfig: options.migrateConfig, migrateData: options.migrateData },
      scan: scan ? { config: scan.totals?.config, data: scan.totals?.data, all: scan.totals?.all } : null,
      running, runMode: running ? runModeRef.current : null,
      dryDone, liveDone,
      reportTotals: report?.totals || null,
      userName: user?.name || '',
    },
    actions: {
      navigate: agentNavigate,
      setScope: (patch) => setOptions((o) => ({ ...o, ...patch })),
      startRun: agentStartRun,
    },
  };

  const guidePanel = <AgentGuide ctx={guideCtx} width={guideWidth} swapped={guideSwapped} onSwap={swapGuide} />;
  const wizard = (
      <main>
        <Stepper steps={STEPS} current={step} />
        <ReauthBanner connections={boundForBanner} onReconnect={() => setStep(idx('connect'))} />

        {key === 'connect' && <ConnectPlatforms accounts={accounts} sources={sources} targets={targets} onRefresh={refreshAccounts} />}

        {key === 'pair' && <PairPicker accounts={accounts} sources={sources} targets={targets} value={pair} onChange={setPair} />}

        {key === 'select' && <Configure options={options} setOptions={setOptions} scan={scan} scanning={scanning} />}

        {key === 'mapping' && <Mapping projectId={project?._id} />}

        {key === 'precheck' && (running ? (
          <Progress report={report} matrix={matrix} progress={progress} mode="dry" />
        ) : dryDone ? (
          <DryRunSummary report={report} matrix={matrix} running={running} onGoLive={() => { setStep(idx('migrate')); startRun(false); }} />
        ) : (
          <div className="card">
            <h2>Dry Run (Pre-check)</h2>
            <p className="hint">A dry run reads both platforms and previews exactly what would migrate — no data is written. Recommended before the first live migration.</p>
            <button className="btn primary lg" onClick={() => startRun(true)}>🔍 Start Dry Run</button>
          </div>
        ))}

        {key === 'migrate' && (running ? (
          <Progress report={report} matrix={matrix} progress={progress} mode="live" />
        ) : liveDone ? (
          <><Kpis totals={report?.totals} />{!!matrix.length && <MatrixTable rows={matrix} />}</>
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
  );

  return (
    <>
      {topbar}
      <div className={`workspace${guideSwapped ? ' swapped' : ''}`}>
        {guideSwapped ? guidePanel : wizard}
        <div className="guide-divider" onMouseDown={startDividerDrag} title="Drag to resize" />
        {guideSwapped ? wizard : guidePanel}
      </div>
    </>
  );
}
