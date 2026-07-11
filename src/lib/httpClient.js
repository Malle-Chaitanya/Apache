import { RateLimiter } from './rateLimiter.js';
import { log } from './logger.js';

// Resilient HTTP client: rate-limited + exponential backoff on 429/5xx.
// Uses global fetch (Node 20+). One instance per connector.
export class HttpClient {
  constructor({ baseUrl, headers = {}, rpm = 600, maxRetries = 5 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = headers;
    this.limiter = new RateLimiter(rpm);
    this.maxRetries = maxRetries;
  }

  async request(method, path, { query, body, multipart } = {}) {
    let url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    if (query) {
      // Support array values as REPEATED params (e.g. role[]=agent&role[]=admin);
      // a plain URLSearchParams would comma-join them, which Zendesk rejects.
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((item) => usp.append(k, item));
        else usp.append(k, v);
      }
      const qs = usp.toString();
      if (qs) url += `?${qs}`;
    }
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();
      let res;
      try {
        res = await fetch(url, buildFetchInit(method, this.headers, body, multipart));
      } catch (err) {
        if (attempt === this.maxRetries) throw err;
        await backoff(attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        log.warn(`HTTP ${res.status} on ${method} ${path} — retrying`, { attempt });
        if (attempt === this.maxRetries) throw new HttpError(res.status, await safeText(res), url);
        await backoff(attempt, retryAfter);
        continue;
      }
      const text = await safeText(res);
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new HttpError(res.status, data, url);
      return { status: res.status, data, headers: res.headers };
    }
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, opts) { return this.request('POST', path, opts); }
  put(path, opts) { return this.request('PUT', path, opts); }
}

export class HttpError extends Error {
  constructor(status, body, url) {
    // Include the API's response body so logs/exports show WHY (not just the status).
    const detail = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    super(`HTTP ${status} at ${url}${detail ? ' — ' + detail.slice(0, 400) : ''}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// multipart: { fields?: object, files?: [{ field?, filename, contentType?, buffer }] }
// FormData sets its own Content-Type (with boundary) — must not set it ourselves.
function buildFetchInit(method, headers, body, multipart) {
  if (multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(multipart.fields || {})) form.append(k, v);
    for (const f of multipart.files || []) {
      form.append(f.field || 'attachments[]', new Blob([f.buffer], { type: f.contentType || 'application/octet-stream' }), f.filename);
    }
    return { method, headers: { ...headers }, body: form };
  }
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined };
}

function backoff(attempt, retryAfterSec) {
  const ms = retryAfterSec ? retryAfterSec * 1000 : Math.min(30000, 2 ** attempt * 250 + Math.floor(attempt * 137));
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
