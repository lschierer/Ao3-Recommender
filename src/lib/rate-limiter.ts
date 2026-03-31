// Token-bucket rate limiter with adaptive backoff.
//
// acquire() atomically reserves the next available time slot — safe in JS's
// single-threaded async model because the read-modify-write on nextSlotAt
// has no await between the steps.
//
// Similarity backoff: after 3 consecutive requests with the same tag the
// delay grows by 15% per additional request (capped at 2.5×).
//
// Adaptive backoff: when AO3 returns a 429, call backoff() to permanently
// increase the base delay for the rest of the run.

export class RateLimiter {
  private nextSlotAt = 0;
  private lastTag = "";
  private runLength = 0;
  private baseDelayMs: number;

  constructor(initialDelayMs: number) {
    this.baseDelayMs = initialDelayMs;
  }

  async acquire(tag = ""): Promise<void> {
    const now = Date.now();
    const slot = Math.max(this.nextSlotAt, now);

    if (tag && tag === this.lastTag) {
      this.runLength++;
    } else {
      this.runLength = 1;
      this.lastTag = tag;
    }

    // Ramp delay after 3 consecutive same-type requests, up to 2.5× base.
    const extra = this.runLength > 3
      ? Math.min(2.5, 1 + (this.runLength - 3) * 0.15)
      : 1.0;
    this.nextSlotAt = slot + Math.round(this.baseDelayMs * extra);

    const wait = slot - now;
    if (wait > 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  /** Permanently increase base delay by the given factor (called after 429). */
  backoff(factor = 1.5): void {
    this.baseDelayMs = Math.round(this.baseDelayMs * factor);
  }

  get currentDelayMs(): number {
    return this.baseDelayMs;
  }

  reset(): void {
    this.nextSlotAt = 0;
    this.lastTag = "";
    this.runLength = 0;
  }
}
