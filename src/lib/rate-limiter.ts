// Token-bucket rate limiter.  acquire() atomically reserves the next
// available time slot — safe in JS's single-threaded async model because
// the read-modify-write on nextSlotAt has no await between the steps.
//
// Passing a `tag` enables similarity backoff: after 5 consecutive requests
// with the same tag the delay grows by 10 % per additional request (capped
// at 2×).  This slows down runs of identical endpoint patterns that tend to
// trigger AO3's session throttle.

export class RateLimiter {
  private nextSlotAt = 0;
  private lastTag = "";
  private runLength = 0;

  constructor(private readonly delayMs: number) {}

  async acquire(tag = ""): Promise<void> {
    const now = Date.now();
    const slot = Math.max(this.nextSlotAt, now);

    if (tag && tag === this.lastTag) {
      this.runLength++;
    } else {
      this.runLength = 1;
      this.lastTag = tag;
    }

    // Ramp delay after 5 consecutive same-type requests, up to 2× base.
    const extra = this.runLength > 5
      ? Math.min(2.0, 1 + (this.runLength - 5) * 0.1)
      : 1.0;
    this.nextSlotAt = slot + Math.round(this.delayMs * extra);

    const wait = slot - now;
    if (wait > 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  reset(): void {
    this.nextSlotAt = 0;
    this.lastTag = "";
    this.runLength = 0;
  }
}
