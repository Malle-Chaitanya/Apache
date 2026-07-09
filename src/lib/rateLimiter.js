// Token-bucket rate limiter — one per connector. Respects per-plan RPM and
// smooths bursts so we never trip 429 storms. Deterministic, no external dep.
export class RateLimiter {
  constructor(rpm, burst) {
    this.capacity = burst || Math.max(1, Math.ceil(rpm / 10));
    this.tokens = this.capacity;
    this.refillPerMs = rpm / 60000; // tokens per ms
    this.last = Date.now();
    this.queue = [];
  }

  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }
}
