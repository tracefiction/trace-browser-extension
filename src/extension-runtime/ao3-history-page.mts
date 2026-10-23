/**
 * Reading one page of the reader's AO3 History (`/users/<name>/readings`).
 *
 * No DOM: the background is a service worker, so a page is read from its
 * markup. The reader fails closed: a page it does not recognise stops the
 * run with a reason, and is never taken for the end of the History. It reads
 * only what the History listing shows; it never opens a work.
 */

import { isChallengePage } from "./ffn-summary-fill.mjs";

export const AO3_HISTORY_ORIGIN = "https://archiveofourown.org";
/** Page text kept for reading, at most: 2 MiB. (Literal, so a build without the import drops it.) */
export const MAX_HISTORY_PAGE_CHARS = 2_097_152;
export const AO3_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/** One work as the History listing shows it. */
export interface HistoryWork {
  /** AO3 work id. */
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly fandoms: readonly string[];
  readonly tags: readonly string[];
  readonly summary: string;
  readonly words: number | null;
  /** "6/6", or "3/?" for a work in progress. */
  readonly chapters: string | null;
  /** AO3's last-visited day, `YYYY-MM-DD`. Null when marked for later. */
  readonly lastVisited: string | null;
  /** How many times AO3 counted a visit. Never a count of reads. */
  readonly visits: number | null;
  /** The row is "Marked for Later": an intent to read, not a read. */
  readonly later: boolean;
}

export type HistoryPageRead =
  | {
      readonly kind: "page";
      readonly works: readonly HistoryWork[];
      /** Rows of works deleted from AO3, which have no title or address. */
      readonly deleted: number;
      /** Rows that could not be read, such as a work hidden in a collection. */
      readonly unreadable: number;
      /** The next page number, or null on the last page. */
      readonly nextPage: number | null;
      /** The highest page number the page links show, at least this page. */
      readonly totalPages: number;
    }
  /**
   * A History page with no works listed at all. Never taken for the last
   * page: AO3 may have sent it while unwell, or the History may be empty or
   * turned off. Tried again later.
   */
  | { readonly kind: "empty" }
  /** A page that was cut short (no footer). Read again later. */
  | { readonly kind: "incomplete" }
  | { readonly kind: "stop"; readonly code: HistoryStopCode };

export type HistoryStopCode =
  | "challenge"
  | "signed_out"
  | "forbidden"
  | "wrong_host"
  | "redirected"
  | "unrecognized_page"
  | "pagination_unexpected"
  | "rows_unreadable"
  | "http_error";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function plainText(markup: string, max = 4_000): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max);
}

function classTokens(startTag: string): readonly string[] {
  const value = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(startTag);
  return (value?.[1] ?? value?.[2] ?? "").split(/\s+/).filter(Boolean);
}

/** The inner markup of each `<tag>` in `html` carrying every class token named. */
function elements(html: string, tag: string, tokens: readonly string[], limit = 50): string[] {
  const out: string[] = [];
  const start = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const end = new RegExp(`</${tag}\\s*>`, "i");
  for (let match = start.exec(html); match !== null && out.length < limit; match = start.exec(html)) {
    const classes = classTokens(match[0]);
    if (!tokens.every((token) => classes.includes(token))) continue;
    const from = match.index + match[0].length;
    const close = end.exec(html.slice(from));
    if (close === null) break;
    out.push(html.slice(from, from + close.index));
  }
  return out;
}

function anchorTexts(html: string, test: (startTag: string) => boolean, limit: number): string[] {
  const out: string[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (let match = anchor.exec(html); match !== null && out.length < limit; match = anchor.exec(html)) {
    if (!test(`<a ${match[1] ?? ""}>`)) continue;
    const text = plainText(match[2] ?? "", 300);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function attribute(startTag: string, name: string): string | null {
  const value = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(startTag);
  return value === null ? null : decodeEntities(value[1] ?? value[2] ?? "");
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:[1-9]\d{0,2}(?:,\d{3})+|\d{1,12})$/.test(trimmed)) return null;
  const value = Number(trimmed.replaceAll(",", ""));
  return Number.isSafeInteger(value) ? value : null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * AO3's "08 Oct 2026" as `2026-10-08`. Null for a day that does not exist or
 * is before 2000, as the page collector reads it (collector.js).
 */
export function historyDay(text: string): string | null {
  const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text.trim());
  if (match === null) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]!.toLowerCase()];
  const year = Number(match[3]);
  if (month === undefined || year < 2000) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function readRow(row: string, startTag: string): HistoryWork | "deleted" | "unreadable" {
  const classes = classTokens(startTag);
  if (classes.includes("deleted")) return "deleted";
  const id = /\bid\s*=\s*["']work_([1-9]\d{0,11})["']/i.exec(startTag)?.[1];
  if (id === undefined) return "unreadable";
  // The title heading comes first in a row; the visit line is a later h4.
  const heading = elements(row, "h4", ["heading"], 1)[0];
  if (heading === undefined) return "unreadable";
  const titleLink = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(heading);
  const href = titleLink ? attribute(`<a ${titleLink[1] ?? ""}>`, "href") : null;
  const title = titleLink ? plainText(titleLink[2] ?? "", 500) : "";
  if (href === null || !new RegExp(`^(?:https://archiveofourown\\.org)?/works/${id}(?:[/?#]|$)`).test(href) || !title) {
    return "unreadable";
  }
  const viewed = plainText(elements(row, "h4", ["viewed"], 1)[0] ?? "", 500);
  const later = /\(Marked for Later\.\)/i.test(viewed);
  const visited = later ? null : /Last visited:\s*(\d{1,2} [A-Z][a-z]{2} \d{4})/.exec(viewed)?.[1] ?? null;
  const visits = later
    ? null
    : /\bVisited once\b/i.test(viewed)
      ? 1
      : wholeNumber(/\bVisited\s+([\d,]+)\s+times?\b/i.exec(viewed)?.[1] ?? "");
  const words = wholeNumber(plainText(elements(row, "dd", ["words"], 1)[0] ?? "", 40));
  // "<a>6</a>/6" reads as "6 /6": the count has no spaces of its own.
  const chapters = plainText(elements(row, "dd", ["chapters"], 1)[0] ?? "", 40).replace(/\s+/g, "");
  return {
    id,
    title,
    authors: anchorTexts(heading, (tag) => attribute(tag, "rel") === "author", 20),
    fandoms: anchorTexts(elements(row, "h5", ["fandoms"], 1)[0] ?? "", (tag) => classTokens(tag).includes("tag"), 20),
    tags: anchorTexts(elements(row, "ul", ["tags", "commas"], 1)[0] ?? "", (tag) => classTokens(tag).includes("tag"), 75),
    summary: plainText(elements(row, "blockquote", ["summary"], 1)[0] ?? "", 4_000),
    words,
    chapters: /^\d+\/(?:\d+|\?)$/.test(chapters) ? chapters : null,
    lastVisited: visited === null ? null : historyDay(visited),
    visits: visits !== null && visits > 0 ? visits : null,
    later,
  };
}

/** The address of one History page of `user`. */
export function historyPageURL(user: string, page: number): string {
  if (!AO3_USERNAME_PATTERN.test(user) || !Number.isSafeInteger(page) || page < 1) throw new Error("invalid history page");
  return `${AO3_HISTORY_ORIGIN}/users/${user}/readings${page === 1 ? "" : `?page=${page}`}`;
}

/** The page number of `href` when it is `user`'s History, else null. */
export function historyPageNumber(href: string, user: string): number | null {
  let url: URL;
  try {
    url = new URL(href, AO3_HISTORY_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== AO3_HISTORY_ORIGIN || url.username || url.password || url.hash) return null;
  if (url.pathname.replace(/\/$/, "").toLowerCase() !== `/users/${user}/readings`.toLowerCase()) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "page") || url.searchParams.getAll("page").length > 1) return null;
  const raw = url.searchParams.get("page");
  if (raw === null) return 1;
  return /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null;
}

export const LOGIN_MARKERS = /<form\b[^>]*\baction\s*=\s*["'][^"']*\/users\/login\b|<body\b[^>]*\bclass\s*=\s*["'][^"']*\blogged-out\b/i;

/**
 * One History page of `user`, page `page`. Reads the listing rows, the
 * page's own Next link and its highest page link; no DOM and no network.
 */
export function readHistoryPage(html: string, user: string, page: number): HistoryPageRead {
  if (typeof html !== "string") return { kind: "stop", code: "unrecognized_page" };
  if (isChallengePage(html)) return { kind: "stop", code: "challenge" };
  const main = /<div\b[^>]*\bid\s*=\s*["']main["'][^>]*>/i.exec(html);
  if (main === null || !classTokens(main[0]).includes("readings-index")) {
    return { kind: "stop", code: LOGIN_MARKERS.test(html) ? "signed_out" : "unrecognized_page" };
  }
  const whole = html.slice(main.index);
  const footer = whole.search(/<div\b[^>]*\bid\s*=\s*["']footer["']/i);
  // Every AO3 page ends with its footer. A page without one was cut short
  // (a dropped connection, a page too long to keep): it says nothing about
  // the History, and is read again later.
  if (footer <= 0) return { kind: "incomplete" };
  const after = whole.slice(0, footer);
  // AO3 shows the page links both above and below the listing, so the rows
  // are read from the listing itself (`ol.reading.work.index`) to the page
  // links after it. A page with no listing has no rows.
  let list = "";
  const listTag = /<ol\b[^>]*>/gi;
  for (let match = listTag.exec(after); match !== null; match = listTag.exec(after)) {
    const classes = classTokens(match[0]);
    if (!classes.includes("reading") || !classes.includes("index")) continue;
    const rest = after.slice(match.index + match[0].length);
    const end = rest.search(/<ol\b[^>]*\bclass\s*=\s*["'][^"']*\bpagination\b/i);
    list = end >= 0 ? rest.slice(0, end) : rest;
    break;
  }
  const rowStart = /<li\b[^>]*>/gi;
  const starts: { index: number; tag: string }[] = [];
  for (let match = rowStart.exec(list); match !== null; match = rowStart.exec(list)) {
    const classes = classTokens(match[0]);
    if (classes.includes("reading") && classes.includes("work")) starts.push({ index: match.index, tag: match[0] });
  }
  const works: HistoryWork[] = [];
  let deleted = 0;
  let unreadable = 0;
  starts.forEach((start, index) => {
    const row = list.slice(start.index + start.tag.length, starts[index + 1]?.index ?? list.length);
    const read = readRow(row, start.tag);
    if (read === "deleted") deleted += 1;
    else if (read === "unreadable") unreadable += 1;
    else works.push(read);
  });
  // Every Next link on the page (AO3 shows the page links twice) must name
  // the following page of the same History. AO3's page links mark Next by
  // its list item (`li.next`), with no `rel`; a last page has a plain
  // "Next" there and no link. A `rel="next"` link is read too.
  const nexts = new Set<number | null>();
  let highest = page;
  const anchor = /<a\b[^>]*>/gi;
  for (let match = anchor.exec(after); match !== null; match = anchor.exec(after)) {
    const href = attribute(match[0], "href");
    const number = href === null ? null : historyPageNumber(href, user);
    if (number !== null) highest = Math.max(highest, number);
    if (attribute(match[0], "rel") === "next") nexts.add(number);
  }
  let disabledNexts = 0;
  let otherNexts = 0;
  const nextItem = /<li\b[^>]*>/gi;
  for (let match = nextItem.exec(after); match !== null; match = nextItem.exec(after)) {
    if (!classTokens(match[0]).includes("next")) continue;
    const item = after.slice(match.index + match[0].length);
    const close = item.search(/<\/li\s*>/i);
    const body = close >= 0 ? item.slice(0, close) : item;
    const link = /<a\b[^>]*>/i.exec(body);
    const href = link === null ? null : attribute(link[0], "href");
    if (href !== null) nexts.add(historyPageNumber(href, user));
    else if (link === null && elements(body, "span", ["disabled"], 1).length === 1) disabledNexts += 1;
    else otherNexts += 1;
  }
  if (nexts.size > 1 || nexts.has(null) || (nexts.size === 1 && !nexts.has(page + 1)) ||
      (nexts.size === 1 && disabledNexts > 0) || otherNexts > 0) {
    return { kind: "stop", code: "pagination_unexpected" };
  }
  // The last page is one with no page links at all (a History of one page),
  // or whose Next is AO3's plain, disabled "Next". Page links that have
  // neither are not understood, and are never taken for the end.
  const pageLinks = /<ol\b[^>]*\bclass\s*=\s*["'][^"']*\bpagination\b/i.test(after);
  if (nexts.size === 0 && pageLinks && disabledNexts === 0) {
    return { kind: "stop", code: "pagination_unexpected" };
  }
  if (starts.length === 0) return { kind: "empty" };
  // Rows were there and most could not be read: the page's markup is not
  // what this reader knows, which is never the end of the History.
  if (unreadable * 2 > starts.length) return { kind: "stop", code: "rows_unreadable" };
  const nextPage = nexts.size ? page + 1 : null;
  // A last page is the last, whatever stale links it shows.
  const totalPages = nextPage === null ? page : Math.max(highest, nextPage);
  return { kind: "page", works, deleted, unreadable, nextPage, totalPages };
}

// --- Classifying an answer -----------------------------------------------------

/** What a request for one History page came back with, from the reader's tab. */
export type LoadedPage =
  | {
      readonly kind: "response";
      readonly status: number;
      /** Where the request ended, after any redirect. */
      readonly url: string;
      readonly html: string;
      /** The page's full length in characters, before it was cut to `MAX_HISTORY_PAGE_CHARS`. */
      readonly chars: number;
      readonly retryAfter: string | null;
      readonly cfMitigated: string | null;
      readonly contentType: string | null;
    }
  | { readonly kind: "failed"; readonly code: LoadFailCode };

export type LoadFailCode = "timeout" | "network" | "tab_gone" | "tab_not_ao3" | "tab_no_result" | "no_site_access";

export type RetryCode = "rate_limited" | "unavailable" | "server_error" | "empty_page" | "incomplete_page" | "network" | "timeout";

export type ClassifiedAnswer =
  | { readonly kind: "page"; readonly read: Extract<HistoryPageRead, { kind: "page" }> }
  | { readonly kind: "retry"; readonly code: RetryCode; readonly retryAfterMs: number | null }
  | { readonly kind: "stop"; readonly code: HistoryStopCode | Exclude<LoadFailCode, "timeout" | "network"> };

/** AO3's Retry-After, in seconds or as an HTTP date, as a wait from `now`. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/^[A-Za-z]{3},\s/.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function classifyHistoryAnswer(answer: LoadedPage, user: string, page: number, now: number): ClassifiedAnswer {
  if (answer.kind === "failed") {
    return answer.code === "timeout" || answer.code === "network"
      ? { kind: "retry", code: answer.code, retryAfterMs: null }
      : { kind: "stop", code: answer.code };
  }
  if (answer.cfMitigated?.toLowerCase() === "challenge") return { kind: "stop", code: "challenge" };
  if (answer.status === 429) return { kind: "retry", code: "rate_limited", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
  if (answer.status === 503) {
    if (isChallengePage(answer.html)) return { kind: "stop", code: "challenge" };
    return { kind: "retry", code: "unavailable", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
  }
  if (answer.status === 502 || answer.status === 504 || (answer.status >= 520 && answer.status <= 526)) {
    return { kind: "retry", code: "server_error", retryAfterMs: retryAfterMs(answer.retryAfter, now) };
  }
  if (isChallengePage(answer.html)) return { kind: "stop", code: "challenge" };
  let landed: URL;
  try {
    landed = new URL(answer.url);
  } catch {
    return { kind: "stop", code: "redirected" };
  }
  if (landed.protocol !== "https:" || landed.hostname !== "archiveofourown.org") return { kind: "stop", code: "wrong_host" };
  if (/^\/users\/(?:login|sign_in)\b|^\/login\b/i.test(landed.pathname)) return { kind: "stop", code: "signed_out" };
  if (answer.status === 401) return { kind: "stop", code: "signed_out" };
  if (answer.status === 403) return { kind: "stop", code: LOGIN_MARKERS.test(answer.html) ? "signed_out" : "forbidden" };
  if (answer.status !== 200) return { kind: "stop", code: "http_error" };
  if (historyPageNumber(answer.url, user) !== page) {
    return { kind: "stop", code: LOGIN_MARKERS.test(answer.html) ? "signed_out" : "redirected" };
  }
  if (answer.contentType !== null && !/text\/html/i.test(answer.contentType)) return { kind: "stop", code: "unrecognized_page" };
  const read = readHistoryPage(answer.html, user, page);
  if (read.kind === "empty") return { kind: "retry", code: "empty_page", retryAfterMs: null };
  if (read.kind === "incomplete") return { kind: "retry", code: "incomplete_page", retryAfterMs: null };
  return read.kind === "page" ? { kind: "page", read } : { kind: "stop", code: read.code };
}
