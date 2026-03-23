// DOMParser is not available in Chrome extension service workers;
// node-html-parser provides the same querySelector/querySelectorAll API
// and works in any JS environment.
import { parse } from "node-html-parser";
import type { HTMLElement as NHTMLElement } from "node-html-parser";
import { ao3Url } from "./fetcher.js";
import type { InputWork, ParsedBlurb } from "../types.js";

const AO3_ORIGIN = "https://archiveofourown.org";

// --- Input work page ---

export function parseInputWork(html: string, url: string): InputWork | null {
  const doc = parse(html);

  if (!doc.querySelector("blockquote.userstuff")) {
    const title = doc.querySelector("title")?.textContent ?? "unknown page";
    console.warn(`[AO3 Recommender] No summary found at ${url} — got: ${title}`);
    return null;
  }

  const id = url.match(/\/works\/(\d+)/)?.[1];
  if (!id) return null;

  const tagUrls = doc.querySelectorAll("a.tag")
    .map((a) => a.getAttribute("href"))
    .filter((h): h is string => !!h && h.includes("/tags/"))
    .map((h) => AO3_ORIGIN + h.replace(/\?.*$/, ""));

  const kudosUsers = doc.querySelectorAll("p.kudos a[href*='/users/']")
    .map((a) => ao3Url(a.getAttribute("href")!));

  const bookmarkUsers = doc.querySelectorAll("h5.byline a[href*='/users/']")
    .map((a) => ao3Url(a.getAttribute("href")!));

  const bkBases = new Set(
    bookmarkUsers.map((u) => u.match(/(\/users\/[^/]+)/)?.[1]).filter(Boolean),
  );
  const filteredKudos = kudosUsers.filter((u) => {
    const base = u.match(/(\/users\/[^/]+)/)?.[1];
    return base && !bkBases.has(base);
  });

  return { id, url, bookmarkUsers, kudosUsers: filteredKudos, tagUrls };
}

// Re-extract bookmark users from a dedicated /bookmarks page
export function parseBookmarkUsers(html: string): string[] {
  const doc = parse(html);
  return doc.querySelectorAll("h5.byline a[href*='/users/']")
    .map((a) => ao3Url(a.getAttribute("href")!));
}

// --- Blurb pages (bookmark listings and tag search results) ---

export function parsePage(
  html: string,
  source: ParsedBlurb["source"],
): ParsedBlurb[] {
  const doc = parse(html);
  return doc.querySelectorAll("li.bookmark.blurb, li.work.blurb")
    .map((el) => parseBlurb(el, source))
    .filter((b): b is ParsedBlurb => b !== null);
}

function parseBlurb(
  el: NHTMLElement,
  source: ParsedBlurb["source"],
): ParsedBlurb | null {
  const titleA = el.querySelector("h4.heading a[href*='/works/']");
  const titleHref = titleA?.getAttribute("href");
  if (!titleA || !titleHref) return null;

  const workUrl = titleHref.startsWith("http") ? titleHref : AO3_ORIGIN + titleHref;
  const id = workUrl.match(/\/works\/(\d+)/)?.[1];
  if (!id) return null;

  const authorEls = el.querySelectorAll("h4.heading a[href*='/users/']");
  const author = authorEls.length
    ? authorEls.map((a) => a.textContent.trim()).join(", ")
    : "Anonymous";
  const authorUrl = authorEls.length
    ? ao3Url(authorEls[0].getAttribute("href")!)
    : null;

  const tags = el.querySelectorAll("a.tag")
    .map((a) => a.textContent.trim().toLowerCase())
    .filter(Boolean)
    .join(", ");

  const text = (sel: string) => el.querySelector(sel)?.textContent ?? "";

  const wordCount  = text("dd.words").replace(/,/g, "").trim();
  const hits       = text("dd.hits").replace(/,/g, "").trim() || "0";
  const kudos      = text("dd.kudos").replace(/,/g, "").trim() || "0";
  const chapters   = text("dd.chapters").trim() || "?/?";
  const summary    = text("blockquote.userstuff").trim();
  const updateDate = text("p.datetime").trim();

  return {
    id,
    url: workUrl,
    title: titleA.textContent.trim(),
    author,
    authorUrl,
    tags,
    summary,
    wordCount,
    chapters,
    updateDate,
    hits,
    kudos,
    source,
  };
}

export function parseNextHref(html: string): string | null {
  return parse(html).querySelector("a[rel='next']")?.getAttribute("href") ?? null;
}

// Returns deduplicated work URLs found on a series page (handles pagination via
// the caller re-queuing with the next-page href from parseNextHref).
export function parseSeriesWorkUrls(html: string): string[] {
  const doc = parse(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const a of doc.querySelectorAll("li.work.blurb h4.heading a[href*='/works/']")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const url = (href.startsWith("http") ? href : AO3_ORIGIN + href).replace(/\?.*$/, "");
    if (/\/works\/\d+/.test(url) && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}
