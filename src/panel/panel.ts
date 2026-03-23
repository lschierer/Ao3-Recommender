import type {
  PanelToBackground,
  BackgroundToPanel,
  RecommendConfig,
  ScoredBlurb,
  SessionData,
} from "../types.js";

// --- DOM refs ---
const formSection     = document.getElementById("form-section")!;
const progressSection = document.getElementById("progress-section")!;
const resultsSection  = document.getElementById("results-section")!;

const configForm    = document.getElementById("config-form") as HTMLFormElement;
const urlsInput     = document.getElementById("urls") as HTMLTextAreaElement;
const waitLevelSel  = document.getElementById("wait-level") as HTMLSelectElement;
const blacklistInput = document.getElementById("blacklist") as HTMLInputElement;
const enforceInput  = document.getElementById("enforce") as HTMLInputElement;
const softCheck     = document.getElementById("soft-enforcement") as HTMLInputElement;
const bkmrkrLimitIn = document.getElementById("bkmrkr-limit") as HTMLInputElement;
const kdsrLimitIn   = document.getElementById("kdsr-limit") as HTMLInputElement;
const bkmrkPagesIn  = document.getElementById("bkmrk-pages") as HTMLInputElement;
const tagLimitIn    = document.getElementById("tag-page-limit") as HTMLInputElement;

const progressLog   = document.getElementById("progress-log")!;
const liveCount     = document.getElementById("live-count")!;
const throttleBox   = document.getElementById("throttle-box")!;
const throttleCountdown = document.getElementById("throttle-countdown")!;
const resumeBtn     = document.getElementById("resume-btn")!;
const cancelBtn     = document.getElementById("cancel-btn")!;
const liveResultsSection = document.getElementById("live-results-section")!;
const liveResultsList    = document.getElementById("live-results-list")!;

const resultCount   = document.getElementById("result-count")!;
const newSearchBtn  = document.getElementById("new-search-btn")!;
const errorsBox     = document.getElementById("errors-box")!;
const errorsList    = document.getElementById("errors-list")!;
const resultsList   = document.getElementById("results-list")!;

// --- State ---
let port: chrome.runtime.Port | null = null;
let liveResults: ScoredBlurb[] = [];
let errors: string[] = [];
let liveResultCount = 0;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
const liveCardMap = new Map<string, HTMLElement>();

// --- View switching ---
function showForm()     { formSection.hidden = false; progressSection.hidden = true;  resultsSection.hidden = true; }
function showProgress() { formSection.hidden = true;  progressSection.hidden = false; resultsSection.hidden = true; }
function showResults()  { formSection.hidden = true;  progressSection.hidden = true;  resultsSection.hidden = false; }

// --- Port management ---
function connectPort(): chrome.runtime.Port {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // If the service worker was killed mid-run, show whatever was found
    if (!progressSection.hidden) {
      errors.push("Background connection lost — results may be incomplete.");
      clearCountdown();
      renderResults();
      showResults();
    }
  });
  return port;
}

function send(msg: PanelToBackground): void {
  (port ?? connectPort()).postMessage(msg);
}

// --- Countdown helpers ---
function clearCountdown(): void {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  throttleBox.hidden = true;
  cancelBtn.hidden = false;
}

function showThrottled(seconds: number): void {
  showProgress();
  clearCountdown();

  let remaining = Math.max(1, seconds);
  throttleCountdown.textContent = String(remaining);
  throttleBox.hidden = false;
  cancelBtn.hidden = true;

  countdownInterval = setInterval(() => {
    remaining--;
    throttleCountdown.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) {
      clearCountdown();
      send({ type: "resume" });
    }
  }, 1000);
}

// --- Message handler ---
function handleMessage(msg: BackgroundToPanel): void {
  if (msg.type === "progress") {
    addProgressLine(msg.message, false);
  } else if (msg.type === "error") {
    addProgressLine(msg.message, true);
    errors.push(msg.message);
  } else if (msg.type === "result") {
    const idx = liveResults.findIndex((r) => r.id === msg.blurb.id);
    if (idx >= 0) liveResults[idx] = msg.blurb;
    else liveResults.push(msg.blurb);
    if (msg.isNew) liveResultCount++;
    liveCount.textContent = `${liveResultCount} result(s) found so far...`;
    updateLiveCard(msg.blurb, msg.isNew);
  } else if (msg.type === "throttled") {
    showThrottled(msg.retryAfterSeconds);
  } else if (msg.type === "complete") {
    clearCountdown();
    liveResults = msg.results;
    renderResults();
    showResults();
  }
}

function addProgressLine(msg: string, isError: boolean): void {
  const p = document.createElement("p");
  if (isError) p.className = "error";
  p.textContent = msg;
  progressLog.appendChild(p);
  progressLog.scrollTop = progressLog.scrollHeight;
}

// --- Live results rendering ---
function updateLiveCard(blurb: ScoredBlurb, isNew: boolean): void {
  liveResultsSection.hidden = false;
  const card = buildCard(blurb);
  card.dataset.workId = blurb.id;

  if (!isNew) {
    // Replace existing card in place
    const existing = liveCardMap.get(blurb.id);
    if (existing) {
      existing.replaceWith(card);
      liveCardMap.set(blurb.id, card);
      return;
    }
  }

  // Insert new card in score order (highest first)
  liveCardMap.set(blurb.id, card);
  const children = Array.from(liveResultsList.children) as HTMLElement[];
  const insertBefore = children.find((c) => {
    const existing = liveResults.find((r) => r.id === c.dataset.workId);
    return existing !== undefined && existing.score < blurb.score;
  });
  if (insertBefore) {
    liveResultsList.insertBefore(card, insertBefore);
  } else {
    liveResultsList.appendChild(card);
  }
}

// --- Form submission ---
configForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const urls = urlsInput.value
    .split(/[\n,]+/)
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter((u) => u.match(/^https?:\/\/archiveofourown\.org\/(works\/\d+|series\/\d+)/));

  if (urls.length === 0) {
    alert("Please enter at least one valid AO3 work URL.");
    return;
  }

  const config: RecommendConfig = {
    waitLevel:       waitLevelSel.value as RecommendConfig["waitLevel"],
    blacklistTags:   splitTags(blacklistInput.value),
    enforceTags:     splitTags(enforceInput.value),
    softEnforcement: softCheck.checked,
    bkmrkrLimit:     parseInt(bkmrkrLimitIn.value) || 0,
    kdsrLimit:       parseInt(kdsrLimitIn.value)   || 0,
    bkmrkPages:      parseInt(bkmrkPagesIn.value)  || 0,
    tagPageLimit:    parseInt(tagLimitIn.value)     || 0,
  };

  liveResults    = [];
  errors         = [];
  liveResultCount = 0;
  liveCardMap.clear();
  progressLog.innerHTML = "";
  liveCount.textContent = "";
  liveResultsList.innerHTML = "";
  liveResultsSection.hidden = true;
  clearCountdown();

  showProgress();
  connectPort();
  send({ type: "start", urls, config });
});

cancelBtn.addEventListener("click", () => {
  clearCountdown();
  send({ type: "cancel" });
  renderResults();
  showResults();
});

resumeBtn.addEventListener("click", () => {
  clearCountdown();
  send({ type: "resume" });
});

newSearchBtn.addEventListener("click", showForm);

// --- Results rendering ---
function renderResults(): void {
  const sorted = [...liveResults].sort((a, b) => b.score - a.score);

  resultCount.textContent = `${sorted.length} recommendation(s)`;

  if (errors.length > 0) {
    errorsBox.hidden = false;
    errorsList.innerHTML = "";
    for (const e of errors) {
      const li = document.createElement("li");
      li.textContent = e;
      errorsList.appendChild(li);
    }
  } else {
    errorsBox.hidden = true;
  }

  resultsList.innerHTML = "";
  for (const rec of sorted) {
    resultsList.appendChild(buildCard(rec));
  }
}

function buildCard(rec: ScoredBlurb): HTMLElement {
  const card = document.createElement("div");
  card.className = "work-card" + (rec.softEnforced ? " soft-enforced" : "");

  const titleDiv = document.createElement("div");
  titleDiv.className = "work-title";
  const titleA = document.createElement("a");
  titleA.href = rec.url;
  titleA.target = "_blank";
  titleA.rel = "noopener";
  titleA.textContent = rec.title;
  titleDiv.appendChild(titleA);

  const metaDiv = document.createElement("div");
  metaDiv.className = "work-meta";
  if (rec.authorUrl) {
    const authorA = document.createElement("a");
    authorA.href = rec.authorUrl;
    authorA.target = "_blank";
    authorA.rel = "noopener";
    authorA.textContent = rec.author;
    metaDiv.appendChild(document.createTextNode("by "));
    metaDiv.appendChild(authorA);
  } else {
    metaDiv.textContent = "by " + rec.author;
  }

  const tagsDiv = document.createElement("div");
  tagsDiv.className = "work-tags";
  tagsDiv.textContent = rec.tags;

  const summaryDiv = document.createElement("div");
  summaryDiv.className = "work-summary";
  summaryDiv.textContent = rec.summary;

  const statsDiv = document.createElement("div");
  statsDiv.className = "work-stats";
  statsDiv.innerHTML = [
    rec.wordCount ? `<span>Words: ${rec.wordCount}</span>` : "",
    `<span>Chapters: ${rec.chapters}</span>`,
    rec.kudos ? `<span>Kudos: ${rec.kudos}</span>` : "",
    rec.hits   ? `<span>Hits: ${rec.hits}</span>`  : "",
    rec.updateDate ? `<span>${rec.updateDate}</span>` : "",
  ].filter(Boolean).join("");

  const scoreDiv = document.createElement("div");
  scoreDiv.className = "work-score";
  scoreDiv.textContent = `Score: ${rec.score} `
    + `(bk:${rec.bkmrkrCount} kd:${rec.kdsrCount} tag:${rec.tagCount})`;

  card.append(titleDiv, metaDiv, tagsDiv, summaryDiv, statsDiv, scoreDiv);
  return card;
}

// --- Helpers ---
function splitTags(s: string): string[] {
  return s.split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// --- Pre-fill URL from content script click ---
async function init(): Promise<void> {
  const data = await chrome.storage.session.get("pendingUrl") as SessionData;
  if (data.pendingUrl) {
    urlsInput.value = data.pendingUrl;
    await chrome.storage.session.remove("pendingUrl");
  }
}

init();
connectPort();  // establish port early so service worker is ready
