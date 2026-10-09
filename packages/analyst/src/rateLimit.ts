/** Sliding-window limit on live model runs, per server process (e.g. 6 per hour). */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private stamps: number[] = [];
  constructor(o: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = o.limit;
    this.windowMs = o.windowMs;
    this.now = o.now ?? Date.now;
  }
  private prune() {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
  }
  /** Take one slot; false when none is left. */
  take(): boolean {
    this.prune();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(this.now());
    return true;
  }
  state(): { limit: number; remaining: number; resetInSec: number } {
    this.prune();
    const oldest = this.stamps[0];
    return {
      limit: this.limit,
      remaining: this.limit - this.stamps.length,
      resetInSec: oldest == null ? 0 : Math.ceil((oldest + this.windowMs - this.now()) / 1000),
    };
  }
}
