import { RateLimiter } from "./rate-limiter.js";

const AO3 = "https://archiveofourown.org";

// Thrown when AO3 returns a 429 with a Retry-After longer than we can
// reasonably wait within the service worker's lifetime.  Callers should
// abort the run and surface the message to the user.
export class ThrottleError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      `AO3 is rate-limiting requests (retry after ${retryAfterSeconds}s ≈ `
      + `${Math.ceil(retryAfterSeconds / 60)} min). `
      + `Wait a while, then try again with a lower depth setting.`,
    );
  }
}

// Maximum Retry-After we'll actually sleep through (90 s is well under the
// ~5 min Chrome MV3 service-worker lifetime even with a port open).
const MAX_WAIT_MS = 90_000;

// Fetches URL with AO3 session cookies, rate-limited, with retry on
// transient failures (429, 5xx).  Returns HTML text or null on permanent
// failure.  Throws ThrottleError if AO3 demands a wait we can't survive.
export async function fetchHtml(
  url: string,
  limiter: RateLimiter,
  maxRetries = 3,
  onError?: (msg: string) => void,
  tag?: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    await limiter.acquire(tag);

    let resp: Response;
    try {
      resp = await fetch(url, { credentials: "include" });
    } catch (e) {
      onError?.(`Network error fetching ${url} (attempt ${attempt}): ${e}`);
      if (attempt > maxRetries) return null;
      await sleep(5000 * attempt);
      continue;
    }

    if (resp.ok) return resp.text();

    if (resp.status === 429 || resp.status >= 500) {
      const retryAfterSec = parseInt(resp.headers.get("Retry-After") ?? "0");
      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 30_000 * attempt;

      if (waitMs > MAX_WAIT_MS) {
        throw new ThrottleError(retryAfterSec > 0 ? retryAfterSec : 30 * attempt);
      }

      // Permanently slow down after a 429 so we don't immediately trigger another
      if (resp.status === 429) {
        limiter.backoff(1.5);
        onError?.(`HTTP 429 — slowing down (base delay now ${limiter.currentDelayMs}ms), retrying in ${Math.round(waitMs / 1000)}s...`);
      } else {
        onError?.(`HTTP ${resp.status} from AO3 (attempt ${attempt}), retrying in ${Math.round(waitMs / 1000)}s...`);
      }

      await sleep(waitMs);
      continue;
    }

    // Permanent failure (404, 403, etc.)
    onError?.(`HTTP ${resp.status} for ${url}`);
    return null;
  }

  return null;
}

export function ao3Url(href: string): string {
  return href.startsWith("http") ? href : AO3 + href;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
