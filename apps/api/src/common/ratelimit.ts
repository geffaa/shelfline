/** Fixed-window in-memory limiter (per process). Fine for one API process; revisit if scaled out. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  /** returns true if the call is allowed */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) { this.hits.set(key, { n: 1, reset: t + this.windowMs }); return true; }
    h.n += 1;
    return h.n <= this.max;
  }
  clear(key: string) { this.hits.delete(key); }
}
