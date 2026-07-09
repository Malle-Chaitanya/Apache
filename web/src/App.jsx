import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Topbar, Stepper, Kpis, MatrixTable, Conflicts, LogView } from './components.jsx';

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [project, setProject] = useState(null);
  const [matrix, setMatrix] = useState([]);
  const [report, setReport] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const poll = useRef(null);

  // Bootstrap: load config + a fresh project.
  useEffect(() => {
    (async () => {
      setCfg(await api.config());
      const p = await api.reset();
      setProject(p);
      setMatrix(await api.matrix(p._id));
    })();
    return () => clearInterval(poll.current);
  }, []);

  async function refresh(id) {
    const [p, m, r, c, e] = await Promise.all([
      api.project(id), api.matrix(id), api.report(id), api.conflicts(id), api.events(id),
    ]);
    setProject(p); setMatrix(m); setReport(r); setConflicts(c); setEvents(e);
    if (p.status === 'completed' || p.status === 'failed') { clearInterval(poll.current); setBusy(false); }
  }

  async function run(dryRun) {
    if (!project) return;
    setBusy(true);
    await api.run(project._id, dryRun);
    clearInterval(poll.current);
    poll.current = setInterval(() => refresh(project._id), 900);
  }

  async function reset() {
    clearInterval(poll.current); setBusy(false);
    const p = await api.reset();
    setProject(p); setMatrix(await api.matrix(p._id));
    setReport(null); setConflicts([]); setEvents([]);
  }

  const status = project?.status || 'idle';
  return (
    <>
      <Topbar cfg={cfg} status={status} />
      <main>
        <section className="controls">
          <button className="btn primary" disabled={busy} onClick={() => run(false)}>▶ Run migration</button>
          <button className="btn" disabled={busy} onClick={() => run(true)}>Dry run (preview)</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </section>
        <Stepper current={project?.currentPhase} status={status} />
        <Kpis totals={report?.totals} />
        <div className="grid">
          <MatrixTable rows={matrix} />
          <Conflicts items={conflicts} />
        </div>
        <LogView events={events} />
      </main>
    </>
  );
}
