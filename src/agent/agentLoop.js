// src/agent/agentLoop.js
// ─────────────────────────────────────────────────────────────
// The migration-guide agent loop. One HTTP request = one user turn, streamed
// back as SSE. Ported from GEM_CO's agentLoop.js and adapted to our stack:
//   • JWT-derived appUserId (no sessions) as the identity + history key
//   • our 7-step Zendesk → Freshdesk wizard tools
//   • pending confirmations persisted in the agentChats doc (survive the turn)
//
// SSE event shapes the frontend consumes (see web/src/AgentGuide.jsx):
//   { type:'text', content }         — a whole (non-streamed) message
//   { type:'text_delta', content }   — a streamed token
//   { type:'text_done' }             — close the current streamed bubble
//   { type:'ui_event', event, ... }  — drive the wizard / quick_replies
//   { type:'done' }                  — end of turn
// ─────────────────────────────────────────────────────────────
import { callAI, callAIStream, aiConfigured } from './callAI.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, CONFIRMATION_MESSAGES, STEP_NAMES } from './tools.js';
import { buildSystemPrompt, buildStepContextInstruction, defaultChips } from './systemPrompt.js';
import { executeTool } from './toolExecutor.js';
import { loadHistory, saveTurn, getPending, setPending } from './store.js';
import { log } from '../lib/logger.js';

const MAX_ITERATIONS = 12;

/** Generate 3 contextual quick-reply chips with a fast model; fall back to rules. */
async function generateChips(agentReply, state) {
  const s = state ?? {};
  const stepIdx = s.step ?? 0;
  const currentStep = STEP_NAMES[stepIdx] || `step ${stepIdx}`;
  const nextStep = STEP_NAMES[stepIdx + 1] || null; // the ONLY valid forward step
  const stateCtx = [
    `currentStep=${currentStep}`,
    nextStep ? `nextStep=${nextStep}` : 'nextStep=none (last step)',
    `sourceConnected=${!!s.srcConnectedCount}`,
    `targetConnected=${!!s.tgtConnectedCount}`,
    s.hasProject ? 'project=yes' : 'project=no',
    s.running ? `running=${s.runMode || 'yes'}` : null,
    s.dryDone ? 'dryRun=done' : null,
    s.liveDone ? 'liveMigration=done' : null,
  ].filter(Boolean).join(', ');

  try {
    const res = await callAI([
      {
        role: 'system',
        content: `You generate exactly 3 quick-reply chips for a Zendesk→Freshdesk migration assistant chat. The user CLICKS a chip and it is sent as their next message, so each chip must be phrased as something the USER would say (a request/command), max 6 words, action-first, no trailing filler like "now"/"first".
The migration is a strict 7-step sequence: Connect Platforms → Choose Pair → Select Data → Select & Map → Dry Run → Live Migration → Report.
Rules:
- Chip 1 = move forward by exactly ONE step. If the assistant asked a direct question, chip 1 answers it; otherwise chip 1 is "Continue to <nextStep>" (use the nextStep given in State). NEVER skip ahead — e.g. do NOT suggest a dry run or migration while on Select Data; the next step there is Select & Map.
- Chip 2 = the best alternative action for the CURRENT step (e.g. adjust the scope, review mappings).
- Chip 3 = a useful help/explain action about the current step.
- Never suggest an action that is already done, unavailable, or more than one step ahead.
- Return ONLY a JSON array of 3 strings.`,
      },
      { role: 'user', content: `State: ${stateCtx}\nAssistant just said: "${(agentReply || '').slice(-300)}"\n\nReturn 3 chips as JSON array:` },
    ], null, { model: process.env.OPENAI_CHIP_MODEL || 'gpt-4.1-mini', maxTokens: 80 });

    const raw = (res.content || '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const chips = JSON.parse(match[0]);
      if (Array.isArray(chips) && chips.length) return chips.slice(0, 4).map((c) => String(c).trim()).filter(Boolean);
    }
  } catch (e) {
    log.warn(`agent generateChips failed: ${e.message}`);
  }
  return null;
}

export async function runAgentLoop(req, res, { message, migrationState, isSystemTrigger }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const appUserId = req.appUserId;
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const streamTextDelta = (content) => send({ type: 'text_delta', content });
  const streamTextDone = () => send({ type: 'text_done' });
  const streamText = (content) => send({ type: 'text', content });
  const streamEvent = (event, payload = {}) => send({ type: 'ui_event', event, ...payload });
  const streamQuickReplies = (replies) => streamEvent('quick_replies', { replies });
  const streamDone = () => { send({ type: 'done' }); res.end(); };

  // No provider configured → tell the user plainly instead of erroring out.
  if (!aiConfigured()) {
    streamText('The migration guide needs an AI key to answer. Add `OPENAI_API_KEY` (or the Azure OpenAI settings) to the server `.env`, then restart — after that I can walk you through the whole Zendesk → Freshdesk migration step by step.');
    streamQuickReplies(defaultChips(migrationState));
    return streamDone();
  }

  const toolCtx = { streamEvent, migrationState };

  try {
    // ── Pending confirmation (user replied to a "go live?" gate) ──
    const pending = await getPending(appUserId);
    if (pending) {
      await setPending(appUserId, null);
      if (message === 'Yes, proceed' || message === 'Yes') {
        const result = await executeTool(pending.tool, pending.args || {}, toolCtx);
        const replyMsg = await callAI([
          { role: 'system', content: buildSystemPrompt(migrationState) },
          { role: 'user', content: `I confirmed. Tool ${pending.tool} ran with result ${JSON.stringify(result)}. Tell me what happened in one friendly sentence.` },
        ], null);
        const replyText = replyMsg.content ?? 'Done — the live migration is starting.';
        streamText(replyText);
        streamQuickReplies((await generateChips(replyText, migrationState)) ?? defaultChips(migrationState));
        await saveTurn(appUserId, message, replyText);
        return streamDone();
      }
      if (message === 'Cancel') {
        const cancelText = 'No problem — cancelled. What would you like to do instead?';
        streamText(cancelText);
        streamQuickReplies(defaultChips(migrationState));
        await saveTurn(appUserId, message, cancelText);
        return streamDone();
      }
      // Any other message: drop the pending action and answer normally.
    }

    const history = await loadHistory(appUserId);
    const isReturningUser = history.length > 0;
    const systemPrompt = buildSystemPrompt(migrationState, { isReturningUser });

    const stepContextInstruction = isSystemTrigger ? buildStepContextInstruction(migrationState) : '';
    const isFirstGreeting = isSystemTrigger && !isReturningUser;
    const greetingInstruction = isFirstGreeting
      ? `\n\n[GREETING — FIRST VISIT] Introduce yourself as the CloudFuze migration guide, in 2-3 sentences: greet ${migrationState?.userName ? `**${migrationState.userName.split(' ')[0]}**` : 'the user'} by name, say you'll help move their help desk from Zendesk to Freshdesk step by step, and tell them the first step is connecting both platforms. Warm, not robotic.`
      : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction + greetingInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    // On a system step-context trigger, only give the model safe navigation tools.
    const SAFE_TOOLS = AGENT_TOOLS.filter((t) => ['navigate_to_step', 'get_migration_status'].includes(t.function?.name));
    const tools = isSystemTrigger ? SAFE_TOOLS : AGENT_TOOLS;

    log.info(`[agent] user=${appUserId} step=${migrationState?.step} sys=${!!isSystemTrigger} msg="${(message || '').slice(0, 80)}"`);

    let iterations = 0;
    let finalReply = null;
    let finalReplyStreamed = false;

    while (iterations++ < MAX_ITERATIONS) {
      let streamedThisIter = false;
      const aiMsg = await callAIStream(messages, tools, (delta) => { streamedThisIter = true; streamTextDelta(delta); });

      // Plain text answer → done.
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
        if (streamedThisIter) { streamTextDone(); finalReplyStreamed = true; }
        break;
      }

      // Tool call.
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        if (streamedThisIter) streamTextDone(); // close any narration bubble
        const call = aiMsg.tool_calls[0];
        const toolName = call.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(call.function.arguments || '{}'); } catch { /* empty args */ }

        // Gate destructive tools behind an explicit confirmation.
        if (DESTRUCTIVE_TOOLS.includes(toolName)) {
          const confirmText = CONFIRMATION_MESSAGES[toolName] || 'Are you sure?';
          await setPending(appUserId, { tool: toolName, args: toolArgs });
          streamText(confirmText);
          streamQuickReplies(['Yes, proceed', 'Cancel']);
          await saveTurn(appUserId, message, confirmText);
          return streamDone();
        }

        const result = await executeTool(toolName, toolArgs, toolCtx);
        log.info(`[agent] tool=${toolName} → ${JSON.stringify(result).slice(0, 160)}`);

        // Keep toolCtx state roughly in sync for a follow-up tool in the same turn.
        if (toolName === 'navigate_to_step' && typeof toolArgs.step === 'number') {
          toolCtx.migrationState = { ...toolCtx.migrationState, step: toolArgs.step };
        }

        messages.push({ role: 'assistant', tool_calls: [call] });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }

      finalReply = aiMsg.content || "I couldn't generate a response. Could you rephrase?";
      break;
    }

    if (!finalReply) finalReply = "I've been working through this but hit a limit — could you rephrase?";
    if (!finalReplyStreamed) streamText(finalReply);

    const chips = isSystemTrigger ? null : await generateChips(finalReply, migrationState);
    streamQuickReplies(chips ?? defaultChips(migrationState));

    if (!isSystemTrigger) await saveTurn(appUserId, message, finalReply);
    else await saveTurn(appUserId, null, finalReply); // persist greeting/step-context so it's not repeated
  } catch (err) {
    log.error(`[agent] error: ${err.message}`);
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
    streamQuickReplies(defaultChips(migrationState));
  }

  streamDone();
}
