import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api.js';

// ─────────────────────────────────────────────────────────────
// Fuze — the right-side AI migration guide. Streams from POST /api/agent and
// drives the wizard via ui_events (navigate / set scope / start run). The guide
// walks the user through the Zendesk → Freshdesk migration in sequence: it fires
// a __step_context__ system trigger whenever the wizard step changes so the
// assistant always explains the step the user just landed on.
//
// Props:
//   ctx.state   — live wizard snapshot sent to the backend each turn
//   ctx.actions — { navigate(step), setScope(patch), startRun(dryRun) }
// ─────────────────────────────────────────────────────────────

// Minimal **bold** renderer — the assistant uses markdown bold for emphasis.
function renderContent(text) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>
  );
}

export default function AgentGuide({ ctx, width = 400, swapped = false, onSwap }) {
  const [messages, setMessages] = useState([]); // { id, role:'user'|'bot', content }
  const [chips, setChips] = useState([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);

  const busyRef = useRef(false);
  const scrollRef = useRef(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // always read the freshest state/actions inside callbacks
  const sendRef = useRef(null);
  const prevStepRef = useRef(null);
  const agentNavTsRef = useRef(0); // when the agent last drove navigation itself
  const pendingStepCtxRef = useRef(false); // a UI step change arrived while busy — narrate it once free

  const addMsg = (role, content) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setMessages((prev) => [...prev, { id, role, content }]);
    return id;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing, chips]);

  const applyUIEvent = useCallback((evt) => {
    const a = ctxRef.current.actions;
    if (evt.event === 'navigate' && typeof evt.step === 'number') { agentNavTsRef.current = Date.now(); a.navigate(evt.step); }
    else if (evt.event === 'set_scope') { const p = {}; if (typeof evt.migrateConfig === 'boolean') p.migrateConfig = evt.migrateConfig; if (typeof evt.migrateData === 'boolean') p.migrateData = evt.migrateData; a.setScope(p); }
    else if (evt.event === 'start_run') { agentNavTsRef.current = Date.now(); a.startRun(!!evt.dryRun); }
  }, []);

  const send = useCallback(async (overrideMsg, isSystem = false) => {
    const userMsg = overrideMsg ?? input.trim();
    if (!userMsg || busyRef.current) return;
    busyRef.current = true;
    if (!isSystem) { setInput(''); addMsg('user', userMsg); }
    setChips([]);
    setTyping(true);

    let streamId = null; // id of the bubble currently being streamed into
    try {
      const res = await api.agentChat({ message: userMsg, isSystemTrigger: isSystem, migrationState: ctxRef.current.state });
      if (!res.ok || !res.body) { addMsg('bot', `Sorry — the guide is unavailable (error ${res.status}).`); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;
      let pendingChips = [];
      while (!ended) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let evt;
          try { evt = JSON.parse(json); } catch { continue; }
          if (evt.type === 'text') {
            addMsg('bot', evt.content); streamId = null;
          } else if (evt.type === 'text_delta') {
            setTyping(false);
            if (streamId === null) { streamId = addMsg('bot', evt.content); }
            else { const id = streamId; setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: (m.content || '') + evt.content } : m))); }
          } else if (evt.type === 'text_done') {
            streamId = null;
          } else if (evt.type === 'ui_event') {
            if (evt.event === 'quick_replies' && Array.isArray(evt.replies)) pendingChips = evt.replies;
            else applyUIEvent(evt);
          } else if (evt.type === 'done') {
            ended = true; break;
          }
        }
      }
      setChips(pendingChips);
    } catch (e) {
      addMsg('bot', "Sorry, I couldn't connect right now. Please try again.");
    } finally {
      setTyping(false);
      busyRef.current = false;
      // A step change landed while we were mid-reply — narrate the current step now.
      if (pendingStepCtxRef.current) { pendingStepCtxRef.current = false; setTimeout(() => sendRef.current && sendRef.current('__step_context__', true), 150); }
    }
  }, [input, applyUIEvent]);
  sendRef.current = send;

  // Keep CloudFuze in lockstep with the wizard. It re-narrates on any MEANINGFUL
  // state change — not just the step, but also connecting/removing a platform
  // (same Connect step) and project creation — so it never shows stale "both
  // connected" text after you disconnect on Manage Platforms. Skips only when
  // CloudFuze itself just drove here (already spoke) or a run is in progress. A
  // change mid-reply is queued and narrated once the current reply finishes.
  const stateKey = `${ctx.state.step}|${ctx.state.srcConnectedCount > 0 ? 1 : 0}|${ctx.state.tgtConnectedCount > 0 ? 1 : 0}|${ctx.state.hasProject ? 1 : 0}`;
  useEffect(() => {
    if (ctx.state.running) { prevStepRef.current = stateKey; return; }
    if (prevStepRef.current === stateKey) return;
    const firstMount = prevStepRef.current === null;
    prevStepRef.current = stateKey;
    if (!firstMount && Date.now() - agentNavTsRef.current < 4000) return; // CloudFuze drove here; don't double-speak
    const t = setTimeout(() => {
      if (busyRef.current) { pendingStepCtxRef.current = true; return; } // busy → flush after the current reply
      sendRef.current && sendRef.current('__step_context__', true);
    }, firstMount ? 250 : 450);
    return () => clearTimeout(t);
  }, [stateKey, ctx.state.running]);

  const clearChat = async () => {
    setMessages([]); setChips([]); prevStepRef.current = null;
    try { await api.clearAgentHistory(); } catch { /* ignore */ }
    setTimeout(() => sendRef.current && sendRef.current('__step_context__', true), 150);
  };

  const onSubmit = (e) => { e.preventDefault(); send(); };

  return (
    <aside className={`guide${swapped ? ' left' : ''}`} style={{ '--gw': `${width}px` }}>
      <div className="guide-head">
        <div className="guide-head-txt">
          <div className="guide-title">CloudFuze <span className="guide-badge">Guide</span></div>
          <div className="guide-sub">Zendesk → Freshdesk assistant</div>
        </div>
        <button className="guide-clear" title="Clear chat" onClick={clearChat}>Clear</button>
      </div>

      <div className="guide-msgs" ref={scrollRef}>
        {messages.length === 0 && !typing && (
          <div className="guide-empty">CloudFuze walks you through the migration step by step. Say hello or ask what to do next.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`gmsg ${m.role}`}>{renderContent(m.content)}</div>
        ))}
        {typing && <div className="gtyping"><span className="gdot" /><span className="gdot" /><span className="gdot" /></div>}
      </div>

      {chips.length > 0 && (
        <div className="gchips">
          {chips.map((c, i) => (
            <button key={i} className="gchip" onClick={() => send(c)}>{c}</button>
          ))}
        </div>
      )}

      <form className="ginput" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask CloudFuze or tell it what to do…"
          aria-label="Message the migration guide"
        />
        <button type="submit" disabled={!input.trim() || busyRef.current}>Send</button>
      </form>
    </aside>
  );
}
