import { initRunState, processNextItem, buildOutput, getRateDelayMs } from "./lib/recommender.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import type { PanelToBackground, BackgroundToPanel, SessionData, RunState } from "./types.js";

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Content script messages: open panel and store pending URL
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "open-panel" && sender.tab?.windowId) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
  }
  if (msg.type === "set-pending-url" && typeof msg.url === "string") {
    const data: SessionData = { pendingUrl: msg.url };
    chrome.storage.session.set(data);
  }
});

// Each run loop is identified by a token. Incrementing it stops any in-flight loop.
let loopToken = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;

  function send(msg: BackgroundToPanel) {
    try { port.postMessage(msg); } catch { /* panel closed */ }
  }

  async function runLoop(state: RunState, token: number) {
    const limiter = new RateLimiter(getRateDelayMs(state.config));

    while (token === loopToken) {
      let result: "continue" | "complete" | "throttled" | "cancelled";
      try {
        result = await processNextItem(state, limiter, {
          onProgress: (msg) => send({ type: "progress", message: msg }),
          onResult:   (blurb, isNew) => send({ type: "result", blurb, isNew }),
          onError:    (msg) => send({ type: "error", message: msg }),
        });
      } catch (e) {
        send({ type: "error", message: `Unexpected error: ${e}` });
        break;
      }

      await chrome.storage.session.set({ runState: state });

      if (result === "complete") {
        send({ type: "complete", results: buildOutput(state) });
        break;
      }
      if (result === "throttled") {
        const secondsLeft = Math.ceil(((state.throttledUntil ?? Date.now()) - Date.now()) / 1000);
        send({ type: "throttled", retryAfterSeconds: Math.max(1, secondsLeft) });
        break;
      }
      if (result === "cancelled") break;
      // "continue" -- keep going
    }
  }

  // On connect, replay throttled state if present so the panel shows the countdown
  chrome.storage.session.get("runState").then((data) => {
    const state = (data as { runState?: RunState }).runState;
    if (state?.status === "throttled" && state.throttledUntil) {
      const secondsLeft = Math.ceil((state.throttledUntil - Date.now()) / 1000);
      if (secondsLeft > 0) {
        send({ type: "throttled", retryAfterSeconds: secondsLeft });
      }
    }
  });

  port.onMessage.addListener(async (msg: PanelToBackground) => {
    if (msg.type === "cancel") {
      loopToken++;
      const data = await chrome.storage.session.get("runState") as { runState?: RunState };
      if (data.runState) {
        data.runState.status = "cancelled";
        await chrome.storage.session.set({ runState: data.runState });
      }
      return;
    }

    if (msg.type === "start") {
      loopToken++;
      const token = loopToken;
      const state = initRunState(msg.urls, msg.config);
      await chrome.storage.session.set({ runState: state });
      runLoop(state, token);
      return;
    }

    if (msg.type === "resume") {
      const data = await chrome.storage.session.get("runState") as { runState?: RunState };
      if (!data.runState) return;
      const state = data.runState;
      if (state.status !== "throttled" && state.status !== "running") return;
      state.status = "running";
      loopToken++;
      const token = loopToken;
      await chrome.storage.session.set({ runState: state });
      runLoop(state, token);
    }
  });

  port.onDisconnect.addListener(() => {
    loopToken++;  // stop the in-flight loop
  });
});
