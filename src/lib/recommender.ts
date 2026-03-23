import { RateLimiter } from "./rate-limiter.js";
import { fetchHtml, ao3Url, ThrottleError } from "./fetcher.js";
import { parseInputWork, parseBookmarkUsers, parsePage, parseNextHref, parseSeriesWorkUrls } from "./parser.js";
import type {
  RecommendConfig,
  ParsedBlurb,
  ScoredBlurb,
  WaitLevel,
  RunState,
  QueueItem,
} from "../types.js";

// --- Weights ---
const BKMRKR_WEIGHT = 21;
const KDSR_WEIGHT   = 10;
const TAG_WEIGHT    = 5;

// --- Preset limits ---
const PRESETS: Record<WaitLevel, {
  bkmrkrLimit: number; kdsrLimit: number; bkmrkPages: number; tagPageLimit: number;
  rateDelayMs: number;
}> = {
  "short":     { bkmrkrLimit: 10, kdsrLimit: 5,  bkmrkPages: 1,  tagPageLimit: 3,  rateDelayMs: 1000 },
  "medium":    { bkmrkrLimit: 20, kdsrLimit: 10, bkmrkPages: 2,  tagPageLimit: 5,  rateDelayMs: 1500 },
  "long":      { bkmrkrLimit: 35, kdsrLimit: 15, bkmrkPages: 4,  tagPageLimit: 10, rateDelayMs: 3000 },
  "very long": { bkmrkrLimit: 50, kdsrLimit: 20, bkmrkPages: 10, tagPageLimit: 20, rateDelayMs: 4500 },
};

function resolveConfig(cfg: RecommendConfig) {
  const preset = PRESETS[cfg.waitLevel];
  return {
    bkmrkrLimit:     cfg.bkmrkrLimit  || preset.bkmrkrLimit,
    kdsrLimit:       cfg.kdsrLimit    || preset.kdsrLimit,
    bkmrkPages:      cfg.bkmrkPages   || preset.bkmrkPages,
    tagPageLimit:    cfg.tagPageLimit || preset.tagPageLimit,
    blacklistTags:   cfg.blacklistTags,
    enforceTags:     cfg.enforceTags,
    softEnforcement: cfg.softEnforcement,
  };
}

export function getRateDelayMs(cfg: RecommendConfig): number {
  return PRESETS[cfg.waitLevel].rateDelayMs;
}

// --- Build initial run state ---

export function initRunState(urls: string[], config: RecommendConfig): RunState {
  const queue: QueueItem[] = urls.map(url =>
    /\/series\/\d+/.test(url)
      ? { kind: "input-series", url }
      : { kind: "input-work", url },
  );
  return {
    status: "running",
    queue,
    results: {},
    inputWorkIds: [],
    errors: [],
    config,
  };
}

// --- Scoring ---

function scoreAndMerge(
  blurbs: ParsedBlurb[],
  state: RunState,
  cfg: ReturnType<typeof resolveConfig>,
  onResult: (blurb: ScoredBlurb, isNew: boolean) => void,
): void {
  const inputIds = new Set(state.inputWorkIds);
  for (const blurb of blurbs) {
    if (inputIds.has(blurb.id)) continue;

    const tags = blurb.tags;
    if (cfg.blacklistTags.some((t) => tags.includes(t))) continue;
    if (!cfg.softEnforcement && cfg.enforceTags.length > 0) {
      if (!cfg.enforceTags.every((t) => tags.includes(t))) continue;
    }

    const softEnforced =
      cfg.softEnforcement && cfg.enforceTags.length > 0
        ? cfg.enforceTags.every((t) => tags.includes(t))
        : false;

    const isNew = !(blurb.id in state.results);
    const rec: ScoredBlurb = state.results[blurb.id] ?? {
      ...blurb,
      bkmrkrCount: 0,
      kdsrCount:   0,
      tagCount:    0,
      score:       0,
      softEnforced: false,
    };

    if (blurb.source === "bookmarker") rec.bkmrkrCount++;
    else if (blurb.source === "kudoser") rec.kdsrCount++;
    else rec.tagCount++;

    rec.softEnforced = rec.softEnforced || softEnforced;
    rec.score = (rec.bkmrkrCount * BKMRKR_WEIGHT)
              + (rec.kdsrCount   * KDSR_WEIGHT)
              + (rec.tagCount    * TAG_WEIGHT);
    if (rec.softEnforced) rec.score *= 2;

    state.results[blurb.id] = rec;
    onResult(rec, isNew);
  }
}

// --- Process one queue item ---

export interface RunCallbacks {
  onProgress: (msg: string) => void;
  onResult:   (blurb: ScoredBlurb, isNew: boolean) => void;
  onError:    (msg: string) => void;
}

export async function processNextItem(
  state: RunState,
  limiter: RateLimiter,
  callbacks: RunCallbacks,
): Promise<"continue" | "complete" | "throttled" | "cancelled"> {
  if (state.status === "cancelled") return "cancelled";
  if (state.queue.length === 0) {
    state.status = "complete";
    return "complete";
  }

  const cfg = resolveConfig(state.config);
  const item = state.queue[0];

  try {
    state.queue.shift();

    if (item.kind === "input-series") {
      callbacks.onProgress(`Fetching series: ${item.url}`);
      const html = await fetchHtml(item.url, limiter, 3, callbacks.onError, "input-work");
      if (html) {
        const workUrls = parseSeriesWorkUrls(html);
        if (workUrls.length === 0) {
          callbacks.onError(`No works found in series at ${item.url} — it may be private or empty`);
        } else {
          callbacks.onProgress(`Found ${workUrls.length} work(s) in series, queuing...`);
          const newItems: QueueItem[] = workUrls.map(url => ({ kind: "input-work", url }));
          // If the series paginates, queue the next page first so works stay in order
          const nextHref = parseNextHref(html);
          if (nextHref) newItems.push({ kind: "input-series", url: ao3Url(nextHref) });
          state.queue.unshift(...newItems);
        }
      }

    } else if (item.kind === "input-work") {
      callbacks.onProgress(`Fetching input work: ${item.url}`);
      const html = await fetchHtml(item.url + "?view_adult=true", limiter, 3, callbacks.onError, "input-work");
      if (html) {
        const work = parseInputWork(html, item.url);
        if (work) {
          state.inputWorkIds.push(work.id);
          const newItems: QueueItem[] = [
            { kind: "input-work-bookmarks", workUrl: work.url },
            ...work.kudosUsers.slice(0, cfg.kdsrLimit).map(u => ({
              kind: "fetch-page" as const,
              url: u + "/bookmarks",
              source: "kudoser" as const,
              pagesLeft: cfg.bkmrkPages,
            })),
            ...work.tagUrls.slice(0, cfg.tagPageLimit).flatMap(tagUrl => {
              const tagName = tagUrl.match(/\/tags\/([^/]+)/)?.[1];
              if (!tagName) return [];
              return [{
                kind: "fetch-page" as const,
                url: `https://archiveofourown.org/works?commit=Sort+and+Filter`
                   + `&work_search%5Bsort_column%5D=kudos_count`
                   + `&tag_id=${tagName}`,
                source: "tag" as const,
                pagesLeft: 1,
              }];
            }),
          ];
          state.queue.unshift(...newItems);
        } else {
          const msg = `Could not parse work at ${item.url} — it may be restricted or require login`;
          state.errors.push(msg);
          callbacks.onError(msg);
        }
      }

    } else if (item.kind === "input-work-bookmarks") {
      callbacks.onProgress(`Fetching bookmarks for input work...`);
      const html = await fetchHtml(item.workUrl + "/bookmarks", limiter, 3, callbacks.onError, "input-work");
      if (html) {
        const bookmarkerItems: QueueItem[] = parseBookmarkUsers(html)
          .slice(0, cfg.bkmrkrLimit)
          .map(u => ({
            kind: "fetch-page" as const,
            url: u + "/bookmarks",
            source: "bookmarker" as const,
            pagesLeft: cfg.bkmrkPages,
          }));

        // Collect the consecutive fetch-page items already queued (kudosers + tags)
        // and interleave with the new bookmarker items so the request pattern varies.
        const ahead: QueueItem[] = [];
        while (state.queue.length > 0 && state.queue[0].kind === "fetch-page") {
          ahead.push(state.queue.shift()!);
        }

        state.queue.unshift(...interleaveBySource(bookmarkerItems, ahead));
      }

    } else if (item.kind === "fetch-page") {
      callbacks.onProgress(`Fetching ${item.source} page...`);
      const html = await fetchHtml(item.url, limiter, 3, callbacks.onError, item.source);
      if (html) {
        scoreAndMerge(parsePage(html, item.source), state, cfg, callbacks.onResult);

        if (item.pagesLeft > 1) {
          const nextHref = parseNextHref(html);
          if (nextHref) {
            state.queue.unshift({
              kind: "fetch-page",
              url: ao3Url(nextHref),
              source: item.source,
              pagesLeft: item.pagesLeft - 1,
            });
          }
        }
      }
    }

  } catch (e) {
    if (e instanceof ThrottleError) {
      state.queue.unshift(item);  // restore for retry
      state.status = "throttled";
      state.throttledUntil = Date.now() + e.retryAfterSeconds * 1000;
      return "throttled";
    }
    throw e;
  }

  if (state.queue.length === 0) {
    state.status = "complete";
    return "complete";
  }
  return "continue";
}

// --- Round-robin interleave by source ---
// Groups fetch-page items by their source and interleaves them so the queue
// alternates between bookmarker / kudoser / tag requests rather than sending
// a solid block of one pattern.

function interleaveBySource(...lists: QueueItem[][]): QueueItem[] {
  // Build a map keyed by source (or kind for non-fetch-page)
  const groups = new Map<string, QueueItem[]>();
  for (const list of lists) {
    for (const item of list) {
      const key = item.kind === "fetch-page" ? item.source : item.kind;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
  }

  const buckets = [...groups.values()];
  const result: QueueItem[] = [];
  const maxLen = Math.max(...buckets.map(b => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) result.push(bucket[i]);
    }
  }
  return result;
}

// --- Build sorted output ---

export function buildOutput(state: RunState): ScoredBlurb[] {
  const inputIds = new Set(state.inputWorkIds);
  return Object.values(state.results)
    .filter((r) => !inputIds.has(r.id))
    .sort((a, b) => b.score - a.score);
}
