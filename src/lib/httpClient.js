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

  async request(method, path, { query, body } = {}) {
    let url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...this.headers },
          body: body ? JSON.stringify(body) : undefined,
        });
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
    super(`HTTP ${status} at ${url}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function backoff(attempt, retryAfterSec) {
  const ms = retryAfterSec ? retryAfterSec * 1000 : Math.min(30000, 2 ** attempt * 250 + Math.floor(attempt * 137));
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
