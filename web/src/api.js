// Thin API client for the Express backend (proxied via Vite in dev).
const j = (r) => r.json();

export const api = {
  config: () => fetch('/api/config').then(j),
  reset: () => fetch('/api/reset', { method: 'POST' }).then(j),
  run: (id, dryRun) => fetch(`/api/projects/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun }) }).then(j),
  project: (id) => fetch(`/api/projects/${id}`).then(j),
  matrix: (id) => fetch(`/api/projects/${id}/matrix`).then(j),
  report: (id) => fetch(`/api/projects/${id}/report`).then(j),
  conflicts: (id) => fetch(`/api/projects/${id}/conflicts`).then(j),
  events: (id, n = 60) => fetch(`/api/projects/${id}/events?n=${n}`).then(j),
};
