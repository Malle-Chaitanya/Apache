// Minimal structured logger + in-memory ring buffer the dashboard can poll.
const buffer = [];
const MAX = 500;

function push(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  const line = `[${entry.ts}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line, meta || '');
  else console.log(line, meta || '');
  return entry;
}

export const log = {
  info: (m, meta) => push('info', m, meta),
  warn: (m, meta) => push('warn', m, meta),
  error: (m, meta) => push('error', m, meta),
  recent: (n = 100) => buffer.slice(-n),
};
