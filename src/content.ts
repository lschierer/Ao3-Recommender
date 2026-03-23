// Injected on archiveofourown.org/works/* and /series/* pages.
// Adds a small "Recommend Similar" button near the work/series title.

const pageUrl = window.location.href.replace(/\?.*$/, "").replace(/\/$/, "");

const isWork   = /\/works\/\d+/.test(pageUrl);
const isSeries = /\/series\/\d+/.test(pageUrl);
if (!isWork && !isSeries) {
  // e.g. /works/search — nothing to do
} else {

function injectButton(): void {
  if (document.getElementById("ao3rec-btn")) return;

  const heading = isWork
    ? (document.querySelector("div.preface.group h2.title")
        ?? document.querySelector("#workskin .preface h2.title"))
    : (document.querySelector("#main h2.heading")
        ?? document.querySelector("div.series.meta dl"));
  if (!heading) return;

  const btn = document.createElement("button");
  btn.id = "ao3rec-btn";
  btn.textContent = isSeries ? "Recommend from Series" : "Recommend Similar";
  btn.style.cssText = [
    "display: inline-block",
    "margin-left: 1em",
    "padding: 2px 8px",
    "font-size: 0.75em",
    "vertical-align: middle",
    "cursor: pointer",
    "background: #990000",
    "color: #fff",
    "border: none",
    "border-radius: 3px",
  ].join(";");

  btn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "set-pending-url", url: pageUrl });
    chrome.runtime.sendMessage({ type: "open-panel" });
  });

  heading.appendChild(btn);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectButton);
} else {
  injectButton();
}

} // end isWork/isSeries guard
