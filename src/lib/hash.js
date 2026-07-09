import { createHash } from 'node:crypto';

// Stable content hash for idempotency / change detection.
export function contentHash(obj) {
  return createHash('sha1').update(stableStringify(obj)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
