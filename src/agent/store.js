// src/agent/store.js
// ─────────────────────────────────────────────────────────────
// Persistence for the migration-guide chat. One `agentChats` doc per appUser
// holds the rolling message history and any pending confirmation. We keep the
// whole thing in a single document (upsert) so it works identically on both the
// Mongo and in-memory repository adapters — neither needs sort/delete support.
// ─────────────────────────────────────────────────────────────
import { repo } from '../db/repository.js';
import { log } from '../lib/logger.js';

const MAX_HISTORY = 40;   // trim the stored transcript to the last N messages
const LOAD_LIMIT = 20;    // how many prior turns to feed the LLM as context

async function loadDoc(appUserId) {
  try {
    const d = await repo('agentChats').findOne({ appUserId });
    return d || { appUserId, messages: [], pendingAction: null };
  } catch (e) {
    log.warn(`agent store loadDoc failed for ${appUserId}: ${e.message}`);
    return { appUserId, messages: [], pendingAction: null };
  }
}

async function writeDoc(appUserId, messages, pendingAction) {
  try {
    await repo('agentChats').upsert({ appUserId }, { appUserId, messages, pendingAction: pendingAction ?? null });
  } catch (e) {
    log.warn(`agent store writeDoc failed for ${appUserId}: ${e.message}`);
  }
}

/** Prior conversation as OpenAI messages (user/assistant only), oldest-first. */
export async function loadHistory(appUserId) {
  const d = await loadDoc(appUserId);
  return (d.messages || [])
    .slice(-LOAD_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }))
    .filter((m) => m.role && m.content);
}

/** Append a user+assistant turn (either may be omitted) and trim. */
export async function saveTurn(appUserId, userMsg, assistantMsg) {
  const d = await loadDoc(appUserId);
  const messages = [...(d.messages || [])];
  if (userMsg) messages.push({ role: 'user', content: userMsg, at: new Date() });
  if (assistantMsg) messages.push({ role: 'assistant', content: assistantMsg, at: new Date() });
  await writeDoc(appUserId, messages.slice(-MAX_HISTORY), d.pendingAction);
}

export async function getPending(appUserId) {
  const d = await loadDoc(appUserId);
  return d.pendingAction || null;
}

export async function setPending(appUserId, pendingAction) {
  const d = await loadDoc(appUserId);
  await writeDoc(appUserId, d.messages || [], pendingAction);
}

export async function clearHistory(appUserId) {
  await writeDoc(appUserId, [], null);
}
