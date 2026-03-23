export type WaitLevel = "short" | "medium" | "long" | "very long";

export interface RecommendConfig {
  waitLevel: WaitLevel;
  blacklistTags: string[];
  enforceTags: string[];
  softEnforcement: boolean;
  // Advanced overrides — zero means "use waitLevel preset"
  bkmrkrLimit: number;
  kdsrLimit: number;
  bkmrkPages: number;
  tagPageLimit: number;
}

export interface InputWork {
  id: string;
  url: string;
  bookmarkUsers: string[];
  kudosUsers: string[];
  tagUrls: string[];
}

export interface ParsedBlurb {
  id: string;
  url: string;
  title: string;
  author: string;
  authorUrl: string | null;
  tags: string;
  summary: string;
  wordCount: string;
  chapters: string;
  updateDate: string;
  hits: string;
  kudos: string;
  source: "bookmarker" | "kudoser" | "tag";
}

export interface ScoredBlurb extends ParsedBlurb {
  bkmrkrCount: number;
  kdsrCount: number;
  tagCount: number;
  score: number;
  softEnforced: boolean;
}

// Each entry in the persistent fetch queue is one HTTP request
export type QueueItem =
  | { kind: "input-work"; url: string }
  | { kind: "input-work-bookmarks"; workUrl: string }
  | { kind: "input-series"; url: string }
  | { kind: "fetch-page"; url: string; source: ParsedBlurb["source"]; pagesLeft: number };

// Full run state persisted in chrome.storage.session after every item
export interface RunState {
  status: "running" | "complete" | "cancelled" | "throttled";
  queue: QueueItem[];
  results: Record<string, ScoredBlurb>;
  inputWorkIds: string[];
  errors: string[];
  config: RecommendConfig;
  throttledUntil?: number;   // ms timestamp; present only when status === 'throttled'
}

// Messages over the panel ↔ background port
export type PanelToBackground =
  | { type: "start"; urls: string[]; config: RecommendConfig }
  | { type: "resume" }
  | { type: "cancel" };

export type BackgroundToPanel =
  | { type: "progress"; message: string }
  | { type: "result"; blurb: ScoredBlurb; isNew: boolean }
  | { type: "error"; message: string }
  | { type: "throttled"; retryAfterSeconds: number }
  | { type: "complete"; results: ScoredBlurb[] };

export interface SessionData {
  pendingUrl?: string;
  runState?: RunState;
}
