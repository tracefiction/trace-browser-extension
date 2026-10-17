/**
 * AO3 History experiment: an experiment build only, never a release build.
 *
 * It answers whether Trace in Safari can read the signed-in reader's own AO3
 * History (`/users/<name>/readings`) page by page, how fast AO3 is happy to
 * answer, and how long a run survives on iPhone. It is compiled only into a
 * build made with `TRACE_AO3_HISTORY_EXPERIMENT=1` (scripts/build.mjs), which
 * refuses release builds.
 *
 * What it does and does not do:
 * - One request at a time, only to the History list pages, never a work page.
 *   Pages are 8 to 10 seconds apart. A 429 or 503 waits at least a minute (or
 *   longer when AO3 says so) and doubles the gap; three in a row pause the run.
 * - It pauses on a challenge, a sign-out, an unexpected address or host, an
 *   unreadable page, and while a story save to Trace is under way.
 * - It sends no custom headers, so Safari's own user agent is used.
 * - Results stay in the extension's local storage. Nothing is sent to Trace
 *   and nothing enters the Library. Cancel and Clear remove all of it.
 * - The copied report has counts, timings and error codes only: never the
 *   reader's AO3 name, a title, an author or an address.
 *
 * A run is a checkpoint in storage: each page's works and the next page are
 * written together, so a run continues after the background is unloaded, the
 * sheet is closed or Safari restarts.
 *
 * On iPhone Safari unloads the background within about a minute, with its
 * timers, so the run is paced from the AO3 tab instead: a small loop put into
 * the visible AO3 tab asks the background, on its own page timer, whether a
 * page is due, makes the request when told (or the background makes its own),
 * and hands the answer back. The background only checks answers and stores
 * the checkpoint and results. A hidden tab waits until it is shown. The
 * alarm, the sheet, any AO3 page and the background starting only put the
 * loop back and are logged, so the alarm's real cadence can be measured.
 */

import { extensionCall, type AlarmsPort, type PermissionsPort, type RuntimePort, type ScriptingPort, type StorageArea, type TabsPort } from "./browser-platform.mjs";
import { FFN_SUMMARY_STATE_KEY, isChallengePage } from "./ffn-summary-fill.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";

export const AO3_HISTORY_EXPERIMENT_MESSAGE = "TRACE_AO3_HISTORY_EXPERIMENT";
export const AO3_HISTORY_EXPERIMENT_STATE_KEY = "traceAo3HistoryExperimentV1";
const PAGE_KEY_PREFIX = "traceAo3HistoryExperimentV1:page:";
export const AO3_HISTORY_EXPERIMENT_ALARM = "trace-ao3-history-experiment";
export const AO3_HISTORY_ORIGIN = "https://archiveofourown.org";
const AO3_SITE_PATTERN = "https://*.archiveofourown.org/*";

/** Least time between two History pages, before the jitter. */
export const PAGE_GAP_MS = 8_000;
/** Up to this much is added to each gap, so pages are 8 to 10 s apart. */
export const PAGE_GAP_JITTER_MS = 2_000;
/** The gap after backing off never grows past this. */
export const MAX_PAGE_GAP_MS = 60_000;
/** Least wait after a 429 or 503; doubles for each one in a row. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 15 * 60_000;
/** Least wait after a request that failed on the network or timed out. */
export const NETWORK_RETRY_MS = 30_000;
/** A run pauses after this many retried answers in a row. */
export const MAX_CONSECUTIVE_RETRIES = 3;
/** No request while a save is under way, nor this soon after one ends. */
export const SAVE_SETTLE_MS = 10_000;
export const SAVE_RECHECK_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 20_000;
/** A request this late after it was due counts as a stall. */
export const STALL_MS = 30_000;
export const MAX_PAGES = 1_000;
/** Page text kept for parsing, at most. */
export const MAX_PAGE_CHARS = 2 * 1_024 * 1_024;
const MAX_BOOTS = 100;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

// --- Page reading (no DOM: the background is a service worker) ---------------

export interface HistoryRecord {
  /** AO3 work id. */
  readonly id: string;
  readonly t: string;
  readonly a: readonly string[];
  readonly f: readonly string[];
  readonly g: readonly string[];
  readonly s: string;
  readonly w: number | null;
  readonly ch: string | null;
  readonly lv: string | null;
  readonly vc: number | null;
}

export type HistoryPageRead =
  | {
      readonly kind: "page";
      readonly records: readonly HistoryRecord[];
      readonly markedForLater: number;
      readonly deleted: number;
      readonly unreadable: number;
      /** The next page number, or null on the last page. */
      readonly nextPage: number | null;
    }
  /**
   * A History page with no works listed at all. Never taken for the last
   * page: AO3 may have sent it while unwell, or the History may be empty or
   * turned off. Tried again later, and reported as such.
   */
  | { readonly kind: "empty" }
  | { readonly kind: "stop"; readonly code: StopCode };

export type StopCode =
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

function readRow(row: string, startTag: string): HistoryRecord | "deleted" | "later" | "unreadable" {
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
  if (/\(Marked for Later\.\)/i.test(viewed)) return "later";
  const visited = /Last visited:\s*(\d{1,2} [A-Z][a-z]{2} \d{4})/.exec(viewed)?.[1] ?? null;
  const count = /\bVisited once\b/i.test(viewed)
    ? 1
    : wholeNumber(/\bVisited\s+([\d,]+)\s+times?\b/i.exec(viewed)?.[1] ?? "");
  const words = wholeNumber(plainText(elements(row, "dd", ["words"], 1)[0] ?? "", 40));
  // "<a>6</a>/6" reads as "6 /6": the count has no spaces of its own.
  const chapters = plainText(elements(row, "dd", ["chapters"], 1)[0] ?? "", 40).replace(/\s+/g, "");
  return {
    id,
    t: title,
    a: anchorTexts(heading, (tag) => attribute(tag, "rel") === "author", 20),
    f: anchorTexts(elements(row, "h5", ["fandoms"], 1)[0] ?? "", (tag) => classTokens(tag).includes("tag"), 20),
    g: anchorTexts(elements(row, "ul", ["tags", "commas"], 1)[0] ?? "", (tag) => classTokens(tag).includes("tag"), 75),
    s: plainText(elements(row, "blockquote", ["summary"], 1)[0] ?? "", 4_000),
    w: words,
    ch: /^\d+\/(?:\d+|\?)$/.test(chapters) ? chapters : null,
    lv: visited,
    vc: count,
  };
}

/** The address of one History page of `user`. */
export function historyPageURL(user: string, page: number): string {
  if (!USERNAME_PATTERN.test(user) || !Number.isSafeInteger(page) || page < 1) throw new Error("invalid history page");
  return `${AO3_HISTORY_ORIGIN}/users/${user}/readings${page === 1 ? "" : `?page=${page}`}`;
}

/** The page number of `href` when it is `user`'s History, else null. */
function historyPageNumber(href: string, user: string): number | null {
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

const LOGIN_MARKERS = /<form\b[^>]*\baction\s*=\s*["'][^"']*\/users\/login\b|<body\b[^>]*\bclass\s*=\s*["'][^"']*\blogged-out\b/i;

/**
 * One History page of `user`, page `page`. Reads the listing rows and the
 * page's own Next link; no DOM and no network.
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
  const after = footer > 0 ? whole.slice(0, footer) : whole;
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
  const records: HistoryRecord[] = [];
  let markedForLater = 0;
  let deleted = 0;
  let unreadable = 0;
  starts.forEach((start, index) => {
    const row = list.slice(start.index + start.tag.length, starts[index + 1]?.index ?? list.length);
    const read = readRow(row, start.tag);
    if (read === "deleted") deleted += 1;
    else if (read === "later") markedForLater += 1;
    else if (read === "unreadable") unreadable += 1;
    else records.push(read);
  });
  // Every Next link on the page (AO3 shows the page links twice) must name
  // the following page of the same History. AO3's page links mark Next by
  // its list item (`li.next`), with no `rel`; a last page has a plain
  // "Next" there and no link. A `rel="next"` link is read too.
  const nexts = new Set<number | null>();
  const anchor = /<a\b[^>]*>/gi;
  for (let match = anchor.exec(after); match !== null; match = anchor.exec(after)) {
    if (attribute(match[0], "rel") !== "next") continue;
    nexts.add(historyPageNumber(attribute(match[0], "href") ?? "", user));
  }
  const nextItem = /<li\b[^>]*>/gi;
  for (let match = nextItem.exec(after); match !== null; match = nextItem.exec(after)) {
    if (!classTokens(match[0]).includes("next")) continue;
    const item = after.slice(match.index + match[0].length);
    const close = item.search(/<\/li\s*>/i);
    const link = /<a\b[^>]*>/i.exec(close >= 0 ? item.slice(0, close) : item);
    const href = link === null ? null : attribute(link[0], "href");
    if (href !== null) nexts.add(historyPageNumber(href, user));
  }
  if (nexts.size > 1 || nexts.has(null) || (nexts.size === 1 && !nexts.has(page + 1))) {
    return { kind: "stop", code: "pagination_unexpected" };
  }
  if (starts.length === 0) return { kind: "empty" };
  // Rows were there and none could be read: the page's markup is not what
  // this reader knows, which is never the end of the History.
  if (unreadable === starts.length) return { kind: "stop", code: "rows_unreadable" };
  return { kind: "page", records, markedForLater, deleted, unreadable, nextPage: nexts.size ? page + 1 : null };
}

// --- Classifying an answer -----------------------------------------------------

export type LoadedPage =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly url: string;
      readonly html: string;
      /** The page's full length in characters, before it was cut to `MAX_PAGE_CHARS`. */
      readonly chars: number;
      readonly retryAfter: string | null;
      readonly cfMitigated: string | null;
      readonly contentType: string | null;
      readonly server?: string | null;
      readonly cfRay?: string | null;
      /** The page's own `<title>`, as it came. */
      readonly title?: string | null;
      /** Whether the tab was hidden when it read the page (tab path only). */
      readonly hidden?: boolean;
    }
  | { readonly kind: "failed"; readonly code: FailCode };

export type FailCode = "timeout" | "network" | "cancelled" | "tab_gone" | "tab_not_ao3" | "tab_no_result" | "no_site_access";

export type Classified =
  | { readonly kind: "page"; readonly read: Extract<HistoryPageRead, { kind: "page" }> }
  | { readonly kind: "retry"; readonly code: "rate_limited" | "unavailable" | "server_error" | "empty_page" | "network" | "timeout"; readonly retryAfterMs: number | null }
  | { readonly kind: "stop"; readonly code: StopCode | Exclude<FailCode, "timeout" | "network"> };

export function retryAfterMs(value: string | null, now: number): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/^[A-Za-z]{3},\s/.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function classifyHistoryAnswer(answer: LoadedPage, user: string, page: number, now: number): Classified {
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
  return read.kind === "page" ? { kind: "page", read } : { kind: "stop", code: read.code };
}

// --- What is kept about an answer that was not a page ----------------------------

/**
 * The facts of an answer that was not a readable History page: never the
 * page itself, the reader's AO3 name, or a work's title.
 */
export interface AnswerNote {
  readonly code: string;
  readonly status: number | null;
  readonly host: string | null;
  readonly path: "readings" | "login" | "other" | null;
  readonly type: string | null;
  readonly length: number | null;
  readonly cf: string | null;
  readonly server: string | null;
  readonly ray: string | null;
  readonly title: string | null;
  readonly at: number;
}

const tidy = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
};

export function answerNote(answer: LoadedPage, code: string, user: string, now: number): AnswerNote {
  if (answer.kind === "failed") {
    return { code, status: null, host: null, path: null, type: null, length: null, cf: null, server: null, ray: null, title: null, at: now };
  }
  let landed: URL | null = null;
  try {
    landed = new URL(answer.url);
  } catch {
    landed = null;
  }
  const pathname = landed?.pathname ?? "";
  const path = landed === null
    ? null
    : /^\/users\/[^/]+\/readings\/?$/i.test(pathname)
      ? "readings"
      : /^\/users\/(?:login|sign_in)\b|^\/login\b/i.test(pathname) ? "login" : "other";
  // A work page's title names the work: it is not kept.
  let title = /^\/(?:works|chapters|series)\//i.test(pathname) ? null : tidy(answer.title, 200);
  if (title !== null && user) title = title.split(new RegExp(user.replace(/[^A-Za-z0-9_]/g, ""), "gi")).join("‹you›");
  return {
    code,
    status: Number.isSafeInteger(answer.status) ? answer.status : null,
    host: landed !== null && /^[a-z0-9.-]{1,80}$/i.test(landed.hostname) ? landed.hostname.toLowerCase() : null,
    path,
    type: tidy(answer.contentType?.split(";")[0], 40),
    length: Number.isSafeInteger(answer.chars) ? answer.chars : null,
    cf: tidy(answer.cfMitigated, 20),
    server: tidy(answer.server, 40),
    ray: tidy(answer.cfRay, 40),
    title: title === null ? null : title.slice(0, 60),
    at: now,
  };
}

// --- The run ---------------------------------------------------------------------

export type RunStatus = "running" | "paused" | "finished";
export type RunPath = "probe_background" | "probe_tab" | "background" | "tab";
/**
 * What woke the background: the page loop's tick, the alarm, the sheet, an
 * AO3 page speaking to Trace, the background starting, or Start/Resume.
 */
export type WakeSource = "start" | "tick" | "alarm" | "sheet" | "page" | "boot";
const WAKE_SOURCES: readonly WakeSource[] = ["tick", "alarm", "page", "sheet", "boot", "start"];
/** Wake times kept per source, newest last. */
const WAKE_TIMES_MAX = 60;

/** What the page loop does next. */
export type Instruction =
  | { readonly wait: number }
  | { readonly fetch: string; readonly token: string }
  | { readonly stop: true };

export interface ExperimentState {
  v: 2;
  runId: string;
  status: RunStatus;
  reason: string | null;
  user: string;
  tabId: number | null;
  path: RunPath;
  probes: { background: string | null; tab: string | null };
  nextPage: number;
  /** Pages whose new works are stored under their own key. */
  pages: number[];
  lastPageDigest: string | null;
  ids: string[];
  /** The request made and not yet answered. */
  inFlight: { token: string; at: number; boot: string; path: "background" | "tab"; page: number } | null;
  counts: {
    pagesRead: number; rows: number; distinct: number; duplicates: number;
    markedForLater: number; deleted: number; unreadable: number;
  };
  timing: {
    startedAt: number; finishedAt: number | null; pausedAt: number | null; pausedMs: number;
    lastRequestAt: number | null; countNextGap: boolean; dueAt: number; gapMs: number;
    requests: number; answers: number; responses: number; lost: number;
    requestMsTotal: number; requestMsMax: number;
    pageCharsTotal: number; pageCharsMax: number;
    gapTotalMs: number; gapCount: number; maxGapMs: number; stalls: number; stalledMs: number;
  };
  pace: {
    rateLimited: number; unavailable: number; serverErrors: number; networkErrors: number;
    retryAfterMaxMs: number; consecutiveRetries: number; waitsForSave: number; backoffs: number;
  };
  lifetime: {
    boots: string[];
    revivedBy: Record<WakeSource, number>;
    pauses: number; resumes: number; hiddenTabPages: number;
    loopStarts: number; loopFailures: number;
  };
  wakes: Record<WakeSource, { n: number; t: number[] }>;
  lastAnswer: AnswerNote | null;
  storage: { pageBytes: number; writeFailures: number };
  errors: Record<string, number>;
}

export interface ExperimentStore {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  /** Every stored key, for a clear that does not trust the state. */
  keys?(): Promise<readonly string[]>;
}

export interface ExperimentClock {
  now(): number;
}

export interface ExperimentPorts {
  readonly store: ExperimentStore;
  readonly clock: ExperimentClock;
  readonly random: () => number;
  readonly newId: () => string;
  /** This background instance; a new one after Safari unloads it. */
  readonly bootId: string;
  /** Story saves to Trace under way, and when the last one ended. */
  readonly saveActivity: () => { readonly inFlight: number; readonly lastEndedAt: number };
  /** The background's own request, made while a page tick holds it awake. */
  readonly loadInBackground: (url: string, signal: AbortSignal) => Promise<LoadedPage>;
  /** Puts the page loop into an AO3 tab (it runs only while the tab is visible). */
  readonly ensureLoop?: (tabId: number) => Promise<"started" | "running" | "failed">;
  readonly alarm?: { start(): Promise<void> | void; stop(): Promise<void> | void };
}

export interface ExperimentView {
  readonly status: RunStatus | "idle";
  readonly reason: string | null;
  readonly nextPage: number | null;
  readonly waitingUntil: number | null;
  readonly lines: readonly (readonly [string, string])[];
  readonly report: string;
}

const pageKey = (page: number) => `${PAGE_KEY_PREFIX}${page}`;
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function isState(value: unknown): value is ExperimentState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ExperimentState>;
  return state.v === 2 && typeof state.runId === "string" && typeof state.user === "string" &&
    USERNAME_PATTERN.test(state.user) && ["running", "paused", "finished"].includes(state.status as string) &&
    Number.isSafeInteger(state.nextPage) && Array.isArray(state.ids) && Array.isArray(state.pages) &&
    typeof state.counts === "object" && typeof state.timing === "object" && typeof state.pace === "object" &&
    typeof state.lifetime === "object" && typeof state.wakes === "object" && typeof state.storage === "object" &&
    typeof state.errors === "object";
}

const perSource = <T,>(make: () => T): Record<WakeSource, T> =>
  Object.fromEntries(WAKE_SOURCES.map((source) => [source, make()])) as Record<WakeSource, T>;

function newState(runId: string, user: string, tabId: number | null, now: number, bootId: string): ExperimentState {
  return {
    v: 2, runId, status: "running", reason: null, user, tabId, path: "probe_background",
    probes: { background: null, tab: null }, nextPage: 1, pages: [], lastPageDigest: null, ids: [], inFlight: null,
    counts: { pagesRead: 0, rows: 0, distinct: 0, duplicates: 0, markedForLater: 0, deleted: 0, unreadable: 0 },
    timing: {
      startedAt: now, finishedAt: null, pausedAt: null, pausedMs: 0, lastRequestAt: null, countNextGap: false,
      dueAt: now, gapMs: PAGE_GAP_MS, requests: 0, answers: 0, responses: 0, lost: 0, requestMsTotal: 0, requestMsMax: 0,
      pageCharsTotal: 0, pageCharsMax: 0, gapTotalMs: 0, gapCount: 0, maxGapMs: 0, stalls: 0, stalledMs: 0,
    },
    pace: {
      rateLimited: 0, unavailable: 0, serverErrors: 0, networkErrors: 0,
      retryAfterMaxMs: 0, consecutiveRetries: 0, waitsForSave: 0, backoffs: 0,
    },
    lifetime: {
      boots: [bootId], revivedBy: perSource(() => 0), pauses: 0, resumes: 0, hiddenTabPages: 0,
      loopStarts: 0, loopFailures: 0,
    },
    wakes: perSource(() => ({ n: 0, t: [] })),
    lastAnswer: null,
    storage: { pageBytes: 0, writeFailures: 0 },
    errors: {},
  };
}

/** Codes a background probe may fail with before the AO3 tab is tried. */
const TRY_THE_TAB = new Set(["signed_out", "redirected", "unrecognized_page", "forbidden", "http_error"]);
/** A 5xx from the background probe also tries the tab, rather than waiting. */
const TRY_THE_TAB_ON_RETRY = new Set(["server_error", "unavailable", "empty_page"]);
/** An unanswered request counts as lost this long after it was made. */
export const LOST_AFTER_MS = REQUEST_TIMEOUT_MS + 10_000;

export class Ao3HistoryExperiment {
  readonly #ports: ExperimentPorts;
  #state: ExperimentState | null = null;
  #loaded = false;
  #abort: AbortController | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(ports: ExperimentPorts) {
    this.#ports = ports;
  }

  /** Runs state changes one after another. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #load(): Promise<ExperimentState | null> {
    if (this.#loaded) return this.#state;
    const values = await this.#ports.store.get([AO3_HISTORY_EXPERIMENT_STATE_KEY]).catch(() => ({} as Record<string, unknown>));
    const value = values[AO3_HISTORY_EXPERIMENT_STATE_KEY];
    this.#state = isState(value) ? clone(value) : null;
    this.#loaded = true;
    return this.#state;
  }

  /** Writes `next` (and a page of works); on failure the stored run stays as it was. */
  async #write(next: ExperimentState, extra: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await this.#ports.store.set({ ...extra, [AO3_HISTORY_EXPERIMENT_STATE_KEY]: next });
      this.#state = next;
      return true;
    } catch {
      return false;
    }
  }

  async #alarm(on: boolean): Promise<void> {
    try {
      await (on ? this.#ports.alarm?.start() : this.#ports.alarm?.stop());
    } catch {
      // The page loop and the sheet still continue the run.
    }
  }

  /** Puts the page loop into `tabId`, and counts how that went. */
  async #ensureLoop(tabId: number | null): Promise<void> {
    if (tabId === null || this.#ports.ensureLoop === undefined) return;
    let result: "started" | "running" | "failed" = "failed";
    try {
      result = await this.#ports.ensureLoop(tabId);
    } catch {
      result = "failed";
    }
    if (result === "running") return;
    await this.#serial(async () => {
      const state = this.#state;
      if (state === null || state.status !== "running") return;
      const next = clone(state);
      if (result === "started") next.lifetime.loopStarts += 1;
      else next.lifetime.loopFailures += 1;
      await this.#write(next);
    });
  }

  /** Records a wake: by what, when, and whether this background is new since. */
  #noteWake(next: ExperimentState, source: WakeSource, now: number): void {
    if (!next.lifetime.boots.includes(this.#ports.bootId)) {
      // This background was started again since the run last heard from one.
      next.lifetime.boots = [...next.lifetime.boots, this.#ports.bootId].slice(-MAX_BOOTS);
      next.lifetime.revivedBy[source] = (next.lifetime.revivedBy[source] ?? 0) + 1;
    }
    const log = next.wakes[source] ?? { n: 0, t: [] };
    next.wakes[source] = { n: log.n + 1, t: [...log.t, now].slice(-WAKE_TIMES_MAX) };
  }

  #instruction(state: ExperimentState | null): Instruction {
    if (state === null || state.status !== "running") return { stop: true };
    return { wait: Math.max(0, state.timing.dueAt - this.#ports.clock.now()) };
  }

  async view(): Promise<ExperimentView> {
    return describe(await this.#serial(() => this.#load()), this.#ports.clock.now());
  }

  /** Starts a new run for `user`; the page loop in `tabId` carries it. */
  async start(user: string, tabId: number | null): Promise<ExperimentView | { readonly error: string }> {
    if (!USERNAME_PATTERN.test(user)) return { error: "username_unclear" };
    const started = await this.#serial(async () => {
      if ((await this.#load()) !== null) return false;
      const now = this.#ports.clock.now();
      const state = newState(this.#ports.newId(), user, tabId, now, this.#ports.bootId);
      this.#noteWake(state, "start", now);
      return await this.#write(state);
    });
    if (!started) return { error: this.#state === null ? "storage_write_failed" : "already_started" };
    await this.#alarm(true);
    await this.#ensureLoop(tabId);
    return this.view();
  }

  async pause(): Promise<ExperimentView> {
    await this.#serial(async () => {
      const state = await this.#load();
      if (state === null || state.status !== "running") return;
      const next = clone(state);
      const now = this.#ports.clock.now();
      next.status = "paused";
      next.reason = "paused_by_you";
      next.timing.pausedAt = now;
      next.lifetime.pauses += 1;
      await this.#write(next);
    });
    await this.#alarm(false);
    return this.view();
  }

  async resume(tabId: number | null): Promise<ExperimentView> {
    const resumed = await this.#serial(async () => {
      const state = await this.#load();
      if (state === null || state.status !== "paused") return false;
      const next = clone(state);
      const now = this.#ports.clock.now();
      next.status = "running";
      if (next.reason === "no_working_path") {
        next.path = "probe_background";
        next.probes = { background: null, tab: null };
      }
      next.reason = null;
      next.lifetime.resumes += 1;
      if (next.timing.pausedAt !== null) next.timing.pausedMs += Math.max(0, now - next.timing.pausedAt);
      next.timing.pausedAt = null;
      next.timing.countNextGap = false;
      // A saved retry deadline still holds.
      next.timing.dueAt = Math.max(next.timing.dueAt, now);
      next.pace.consecutiveRetries = 0;
      if (tabId !== null) next.tabId = tabId;
      this.#noteWake(next, "start", now);
      return await this.#write(next);
    });
    if (resumed) {
      await this.#alarm(true);
      await this.#ensureLoop(this.#state?.tabId ?? null);
    }
    return this.view();
  }

  /** Cancel and Clear: stops any request and removes everything stored. */
  async clear(): Promise<ExperimentView> {
    this.#abort?.abort();
    await this.#serial(async () => {
      const state = await this.#load();
      const keys = new Set<string>([AO3_HISTORY_EXPERIMENT_STATE_KEY]);
      for (const page of state?.pages ?? []) keys.add(pageKey(page));
      try {
        for (const key of (await this.#ports.store.keys?.()) ?? []) {
          if (key.startsWith(PAGE_KEY_PREFIX)) keys.add(key);
        }
      } catch {
        // The state names its pages.
      }
      await this.#ports.store.remove([...keys]).catch(() => undefined);
      this.#state = null;
      this.#loaded = true;
    });
    await this.#alarm(false);
    return this.view();
  }

  /**
   * Something other than the page loop woke the background (the alarm, the
   * sheet, an AO3 page, the background starting). It is logged, and a
   * running run's page loop is put (back) into the AO3 tab. It never reads.
   */
  async wake(source: Exclude<WakeSource, "tick" | "start">, tabId: number | null = null): Promise<void> {
    const loopTab = await this.#serial(async () => {
      const state = await this.#load();
      if (state === null || state.status !== "running") return null;
      const next = clone(state);
      this.#noteWake(next, source, this.#ports.clock.now());
      if (source === "page" && tabId !== null) next.tabId = tabId;
      await this.#write(next);
      return tabId ?? next.tabId;
    });
    if (loopTab === null) {
      if (this.#state?.status !== "running") await this.#alarm(false);
      return;
    }
    await this.#ensureLoop(loopTab);
  }

  /**
   * The page loop's tick from the visible AO3 tab `tabId`: makes the next
   * request when it is due (the background's own, or tells the page to make
   * it), else says how long to wait.
   */
  async tick(tabId: number | null): Promise<Instruction> {
    const prepared = await this.#serial(async (): Promise<Instruction | { request: ExperimentState; token: string }> => {
      const state = await this.#load();
      if (state === null || state.status !== "running") return { stop: true };
      const next = clone(state);
      const now = this.#ports.clock.now();
      this.#noteWake(next, "tick", now);
      if (tabId !== null) next.tabId = tabId;
      if (next.inFlight !== null) {
        const lost = (next.inFlight.path === "background" && next.inFlight.boot !== this.#ports.bootId) ||
          now - next.inFlight.at > LOST_AFTER_MS;
        if (!lost) {
          await this.#write(next);
          return { wait: Math.max(1_000, next.inFlight.at + LOST_AFTER_MS - now) };
        }
        // Its answer never came: the background was unloaded under it, or
        // the tab moved on.
        next.timing.lost += 1;
        next.errors.lost_request = (next.errors.lost_request ?? 0) + 1;
        next.inFlight = null;
      }
      if (next.nextPage > MAX_PAGES) {
        await this.#pauseWith(next, "page_limit", now);
        return { stop: true };
      }
      const saves = this.#ports.saveActivity();
      if (saves.inFlight > 0 || now - saves.lastEndedAt < SAVE_SETTLE_MS) {
        next.pace.waitsForSave += 1;
        await this.#write(next);
        return { wait: SAVE_RECHECK_MS };
      }
      if (now < next.timing.dueAt) {
        await this.#write(next);
        return { wait: next.timing.dueAt - now };
      }
      if (next.timing.countNextGap && next.timing.lastRequestAt !== null) {
        const gap = now - next.timing.lastRequestAt;
        next.timing.gapTotalMs += gap;
        next.timing.gapCount += 1;
        next.timing.maxGapMs = Math.max(next.timing.maxGapMs, gap);
        const late = now - next.timing.dueAt;
        if (late > STALL_MS) {
          next.timing.stalls += 1;
          next.timing.stalledMs += late;
        }
      }
      // The request is on record before it is made, so a restarted
      // background keeps the pace and knows it was lost.
      const token = this.#ports.newId();
      const path = next.path === "probe_background" || next.path === "background" ? "background" : "tab";
      next.timing.lastRequestAt = now;
      next.timing.dueAt = now + LOST_AFTER_MS + this.#gap(next);
      next.timing.countNextGap = true;
      next.timing.requests += 1;
      next.inFlight = { token, at: now, boot: this.#ports.bootId, path, page: next.nextPage };
      if (!(await this.#write(next))) {
        next.storage.writeFailures += 1;
        await this.#pauseWith(next, "storage_write_failed", now);
        return { stop: true };
      }
      return { request: next, token };
    });
    if (!("request" in prepared)) {
      if (this.#state?.status !== "running") await this.#alarm(false);
      return prepared;
    }
    const { request, token } = prepared;
    const url = historyPageURL(request.user, request.nextPage);
    if (request.inFlight?.path === "tab") return { fetch: url, token };
    const abort = new AbortController();
    this.#abort = abort;
    let answer: LoadedPage;
    try {
      answer = await this.#ports.loadInBackground(url, abort.signal);
    } catch {
      answer = { kind: "failed", code: "network" };
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
    return this.answer(token, answer);
  }

  /** The answer to the request `token`, from the background or the tab. */
  async answer(token: string, answer: LoadedPage): Promise<Instruction> {
    const instruction = await this.#serial(async (): Promise<Instruction> => {
      const current = await this.#load();
      // Cancelled, or given up as lost meanwhile: nothing is kept.
      if (current === null || current.inFlight === null || current.inFlight.token !== token) {
        return this.#instruction(current);
      }
      const next = clone(current);
      const sent = current.inFlight!;
      const { page, path } = sent;
      next.inFlight = null;
      const answeredAt = this.#ports.clock.now();
      const ms = Math.max(0, answeredAt - sent.at);
      next.timing.answers += 1;
      next.timing.requestMsTotal += ms;
      next.timing.requestMsMax = Math.max(next.timing.requestMsMax, ms);
      if (answer.kind === "response") {
        next.timing.responses += 1;
        next.timing.pageCharsTotal += answer.chars;
        next.timing.pageCharsMax = Math.max(next.timing.pageCharsMax, answer.chars);
        if (answer.hidden === true) next.lifetime.hiddenTabPages += 1;
      }
      // An answer can come after the run was paused: it is counted, no more.
      if (next.status !== "running") {
        await this.#write(next);
        return this.#instruction(next);
      }
      const result = classifyHistoryAnswer(answer, next.user, page, answeredAt);
      if (result.kind === "page") {
        await this.#admit(next, page, result.read, path, answeredAt);
        return this.#instruction(this.#state);
      }
      next.lastAnswer = answerNote(answer, result.code, next.user, answeredAt);
      next.errors[result.code] = (next.errors[result.code] ?? 0) + 1;
      if (
        next.path === "probe_background" &&
        (TRY_THE_TAB.has(result.code) || (result.kind === "retry" && TRY_THE_TAB_ON_RETRY.has(result.code)))
      ) {
        next.probes.background = result.code;
        next.path = "probe_tab";
        next.timing.dueAt = answeredAt + this.#gap(next);
        await this.#write(next);
        return this.#instruction(next);
      }
      if (result.kind === "retry") {
        await this.#retry(next, result, answeredAt);
        return this.#instruction(this.#state);
      }
      if (next.path === "probe_tab") {
        next.probes.tab = result.code;
        if (TRY_THE_TAB.has(result.code)) {
          await this.#pauseWith(next, "no_working_path", answeredAt);
          return { stop: true };
        }
      }
      await this.#pauseWith(next, result.code, answeredAt);
      return { stop: true };
    });
    if ("stop" in instruction) await this.#alarm(false);
    return instruction;
  }

  #gap(state: ExperimentState): number {
    return state.timing.gapMs + Math.floor(Math.max(0, Math.min(1, this.#ports.random())) * PAGE_GAP_JITTER_MS);
  }

  async #pauseWith(next: ExperimentState, reason: string, now: number): Promise<null> {
    next.status = "paused";
    next.reason = reason;
    next.timing.pausedAt ??= now;
    if (!(await this.#write(next))) {
      // Not even the pause could be stored; this background stops anyway.
      this.#state = next;
    }
    return null;
  }

  async #retry(next: ExperimentState, result: Extract<Classified, { kind: "retry" }>, now: number): Promise<boolean> {
    next.pace.consecutiveRetries += 1;
    if (result.code === "rate_limited") next.pace.rateLimited += 1;
    else if (result.code === "unavailable") next.pace.unavailable += 1;
    else if (result.code === "server_error") next.pace.serverErrors += 1;
    else if (result.code === "network" || result.code === "timeout") next.pace.networkErrors += 1;
    if (result.retryAfterMs !== null) next.pace.retryAfterMaxMs = Math.max(next.pace.retryAfterMaxMs, result.retryAfterMs);
    const network = result.code === "network" || result.code === "timeout";
    const base = network ? NETWORK_RETRY_MS : RETRY_BASE_MS * 2 ** (next.pace.consecutiveRetries - 1);
    const retryAfter = result.retryAfterMs ?? 0;
    // Never before AO3's own time, even after a pause and Resume.
    next.timing.dueAt = now + Math.max(Math.min(RETRY_MAX_MS, base), retryAfter);
    if (next.pace.consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
      await this.#pauseWith(next, result.code === "timeout" ? "network" : result.code, now);
      return false;
    }
    if (retryAfter > RETRY_MAX_MS) {
      // A wait this long is the reader's to resume.
      await this.#pauseWith(next, "retry_later", now);
      return false;
    }
    if (!network && result.code !== "empty_page") {
      // AO3 asked for less: every later page waits longer too.
      next.timing.gapMs = Math.min(MAX_PAGE_GAP_MS, next.timing.gapMs * 2);
      next.pace.backoffs += 1;
    }
    return await this.#write(next);
  }

  async #admit(
    next: ExperimentState,
    page: number,
    read: Extract<HistoryPageRead, { kind: "page" }>,
    path: "background" | "tab",
    now: number,
  ): Promise<boolean> {
    const digest = read.records.length ? `${read.records[0]!.id}|${read.records.at(-1)!.id}|${read.records.length}` : null;
    if (digest !== null && digest === next.lastPageDigest) {
      next.errors.pagination_repeat = (next.errors.pagination_repeat ?? 0) + 1;
      await this.#pauseWith(next, "pagination_repeat", now);
      return false;
    }
    if (next.path === "probe_background" || next.path === "probe_tab") {
      next.probes[path] = "ok";
      next.path = path;
    }
    const seen = new Set(next.ids);
    const fresh: HistoryRecord[] = [];
    for (const record of read.records) {
      if (seen.has(record.id)) {
        next.counts.duplicates += 1;
        continue;
      }
      seen.add(record.id);
      fresh.push(record);
    }
    next.ids = [...seen];
    next.counts.pagesRead += 1;
    next.counts.rows += read.records.length + read.markedForLater;
    next.counts.distinct = next.ids.length;
    next.counts.markedForLater += read.markedForLater;
    next.counts.deleted += read.deleted;
    next.counts.unreadable += read.unreadable;
    next.lastPageDigest = digest;
    next.pace.consecutiveRetries = 0;
    const extra: Record<string, unknown> = {};
    if (fresh.length) {
      extra[pageKey(page)] = fresh;
      if (!next.pages.includes(page)) next.pages = [...next.pages, page];
      next.storage.pageBytes += utf8Bytes(fresh);
    }
    if (read.nextPage === null) {
      next.status = "finished";
      next.reason = "reached_last_page";
      next.timing.finishedAt = now;
    } else {
      next.nextPage = read.nextPage;
      next.timing.dueAt = now + this.#gap(next);
    }
    if (await this.#write(next, extra)) return next.status === "running";
    // Nothing of this page was kept, and the cursor stays where it was.
    const failed = clone(this.#state ?? next);
    failed.inFlight = null;
    failed.storage.writeFailures += 1;
    failed.errors.storage_write_failed = (failed.errors.storage_write_failed ?? 0) + 1;
    await this.#pauseWith(failed, "storage_write_failed", now);
    return false;
  }
}

// --- What the sheet shows, and what "Copy results" copies -----------------------

const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)} s`;
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}
const kb = (bytes: number) => `${(bytes / 1_024).toFixed(1)} KB`;
const average = (total: number, count: number) => (count > 0 ? total / count : 0);
/** A time of day, in the iPhone's own time zone. */
function clockTime(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** The median gap between consecutive times, or null with fewer than two. */
export function medianInterval(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((time, index) => time - times[index]!).sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[middle]! : (gaps[middle - 1]! + gaps[middle]!) / 2;
}

function describeWakes(wakes: ExperimentState["wakes"]): string {
  return WAKE_SOURCES
    .filter((source) => (wakes[source]?.n ?? 0) > 0)
    .map((source) => {
      const log = wakes[source]!;
      const median = medianInterval(log.t);
      return `${source} ${log.n}${median === null ? "" : ` (median ${duration(median)})`}`;
    })
    .join(", ") || "none";
}

function describeAnswer(note: AnswerNote | null): string {
  if (note === null) return "—";
  const parts = [
    note.code,
    note.status === null ? "no answer" : String(note.status),
    note.host === null ? null : `${note.host} ${note.path ?? "other"}`,
    note.type,
    note.length === null ? null : kb(note.length),
    `cf-mitigated ${note.cf ?? "none"}`,
    note.server === null ? null : `server ${note.server}`,
    note.ray === null ? null : `cf-ray ${note.ray}`,
    note.title === null ? null : `“${note.title}”`,
    clockTime(note.at),
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * Counts, timings and error codes only. The reader's AO3 name, titles,
 * authors and addresses never appear here.
 */
export function describe(state: ExperimentState | null, now: number): ExperimentView {
  if (state === null) {
    return { status: "idle", reason: null, nextPage: null, waitingUntil: null, lines: [], report: "" };
  }
  const t = state.timing;
  const end = t.finishedAt ?? t.pausedAt ?? now;
  const wall = Math.max(0, end - t.startedAt);
  const active = Math.max(0, wall - t.pausedMs);
  const stateBytes = utf8Bytes(state);
  const errors = Object.entries(state.errors)
    .filter(([code]) => /^[a-z_]{1,40}$/.test(code))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code}×${count}`)
    .join(", ");
  const revived = WAKE_SOURCES.map((source) => `${source} ${state.lifetime.revivedBy[source] ?? 0}`).join(", ");
  const lines: [string, string][] = [
    ["Status", state.reason ? `${state.status} (${state.reason})` : state.status],
    ["Read from", state.path],
    ["Background probe", state.probes.background ?? "—"],
    ["Tab probe", state.probes.tab ?? "—"],
    ["Pages read", String(state.counts.pagesRead)],
    ["Works found", String(state.counts.rows)],
    ["Different works", String(state.counts.distinct)],
    ["Repeats", String(state.counts.duplicates)],
    ["Marked for Later", String(state.counts.markedForLater)],
    ["Deleted works", String(state.counts.deleted)],
    ["Unreadable rows", String(state.counts.unreadable)],
    ["Time since start", duration(wall)],
    ["Time running", duration(active)],
    ["Requests", String(t.requests)],
    ["Answers", String(t.answers)],
    ["Lost requests", String(t.lost)],
    ["Average answer", seconds(average(t.requestMsTotal, t.answers))],
    ["Slowest answer", seconds(t.requestMsMax)],
    ["Average page size", kb(average(t.pageCharsTotal, t.responses))],
    ["Largest page", kb(t.pageCharsMax)],
    ["Last answer", describeAnswer(state.lastAnswer)],
    ["Planned gap", seconds(t.gapMs)],
    ["Average gap", seconds(average(t.gapTotalMs, t.gapCount))],
    ["Longest gap", seconds(t.maxGapMs)],
    ["Stalls over 30 s", `${t.stalls} (${duration(t.stalledMs)})`],
    ["Wake-ups", describeWakes(state.wakes)],
    ["Background restarts", String(Math.max(0, state.lifetime.boots.length - 1))],
    ["Restarted by", revived],
    ["Page loop starts / failures", `${state.lifetime.loopStarts} / ${state.lifetime.loopFailures}`],
    ["Pages read with tab hidden", String(state.lifetime.hiddenTabPages)],
    ["Pauses / resumes", `${state.lifetime.pauses} / ${state.lifetime.resumes}`],
    ["429 answers", String(state.pace.rateLimited)],
    ["503 answers", String(state.pace.unavailable)],
    ["Other server errors", String(state.pace.serverErrors)],
    ["Network errors", String(state.pace.networkErrors)],
    ["Longest Retry-After", seconds(state.pace.retryAfterMaxMs)],
    ["Backoffs", String(state.pace.backoffs)],
    ["Waits for a save", String(state.pace.waitsForSave)],
    ["Storage used", kb(stateBytes + state.storage.pageBytes)],
    ["Storage write failures", String(state.storage.writeFailures)],
    ["Errors", errors || "none"],
  ];
  const report = [
    "Trace AO3 History experiment v2",
    ...lines.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
  return {
    status: state.status,
    reason: state.reason,
    nextPage: state.status === "finished" ? null : state.nextPage,
    waitingUntil: state.status === "running" && state.timing.dueAt > now ? state.timing.dueAt : null,
    lines,
    report,
  };
}

/**
 * The FanFiction.net summary fill's own record (ffn-summary-fill.mts), as
 * one line for the test build: what the last step did, or what stopped it.
 */
export function describeSummaryFill(value: unknown, now: number): string {
  if (!isRecord(value) || typeof value.v !== "number") return "nothing yet";
  const note = (record: Record<string, unknown>) => [
    typeof record.status === "number" ? String(record.status) : null,
    typeof record.host === "string" ? `${record.host} ${typeof record.path === "string" ? record.path : ""}`.trim() : null,
    typeof record.cf === "string" ? `cf-mitigated ${record.cf}` : null,
  ];
  const count = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]).length : 0);
  const waiting = `waiting: ${count("pending")} saved, ${count("queue")} backfill`;
  const parts: (string | null)[] = [];
  const last = isRecord(value.last) ? value.last : null;
  if (last !== null) {
    parts.push(
      String(last.trigger ?? "?"),
      String(last.stage ?? "?"),
      String(last.outcome ?? "?"),
      ...note(last),
      typeof last.rows === "number" ? `rows ${last.rows}` : null,
      typeof last.found === "number" ? `found ${last.found}` : null,
      typeof last.send === "string" ? `sent ${last.send}` : null,
      typeof last.at === "number" ? clockTime(last.at) : null,
    );
  }
  const stop = isRecord(value.stop) ? value.stop : null;
  if (stop !== null && typeof stop.until === "number" && stop.until > now) {
    parts.push(
      `stopped: ${String(stop.reason ?? "?")}`,
      ...note(stop),
      typeof stop.at === "number" ? clockTime(stop.at) : null,
      `tries again ${clockTime(stop.until)}`,
    );
  }
  parts.push(waiting);
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ");
}

// --- Safari wiring -----------------------------------------------------------------

/**
 * The page loop, put into the reader's AO3 tab. Runs in the page, so it must
 * use nothing from outside this function. While the tab is visible it asks
 * the background what to do, makes a same-site request when told (with the
 * tab's own sign-in), hands the answer back, and waits as long as it is told;
 * the timer lives in the page, so it outlasts the background. Hidden, it
 * waits for the tab to be shown again.
 */
function ao3HistoryLoopInTab(message: string, maxChars: number): unknown {
  const scope = globalThis as unknown as Record<string, unknown>;
  const key = "__traceAo3HistoryLoopV2";
  const existing = scope[key] as { poke(): void } | undefined;
  if (existing) {
    existing.poke();
    return "running";
  }
  const api = (scope.browser ?? scope.chrome) as { runtime: { sendMessage(message: unknown): unknown } } | undefined;
  if (!api?.runtime) return "no_runtime";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let stopped = false;
  const send = (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      return Promise.resolve(api.runtime.sendMessage({ type: message, ...body }))
        .then((reply) => (reply && typeof reply === "object" ? reply as Record<string, unknown> : null), () => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  };
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const limit = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "follow", signal: controller.signal });
      const text = await response.text();
      const title = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(text.slice(0, 16_384));
      return {
        kind: "response",
        status: response.status,
        url: response.url,
        html: text.length > maxChars ? text.slice(0, maxChars) : text,
        chars: text.length,
        retryAfter: response.headers.get("retry-after"),
        cfMitigated: response.headers.get("cf-mitigated"),
        contentType: response.headers.get("content-type"),
        server: response.headers.get("server"),
        cfRay: response.headers.get("cf-ray"),
        title: title ? title[1] : null,
        hidden: document.visibilityState === "hidden",
      };
    } catch (_) {
      return { kind: "failed", code: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(limit);
    }
  };
  const schedule = (ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", shown);
    delete scope[key];
  };
  async function run(): Promise<void> {
    timer = null;
    if (stopped || busy || document.visibilityState !== "visible") return;
    busy = true;
    let next: Record<string, unknown> | null = null;
    try {
      next = await send({ action: "tab_tick" });
      // One request per tick: the background says when the next is due.
      if (next && typeof next.fetch === "string" && typeof next.token === "string") {
        const answer = await read(next.fetch);
        next = await send({ action: "tab_answer", token: next.token, answer });
      }
    } finally {
      busy = false;
    }
    if (next === null) {
      // The background did not answer: try again shortly.
      schedule(10_000);
      return;
    }
    if (next.stop === true) {
      stop();
      return;
    }
    const wait = typeof next.wait === "number" && Number.isFinite(next.wait) ? next.wait : 10_000;
    schedule(Math.min(Math.max(wait, 500), 16 * 60_000));
  }
  function shown(): void {
    if (document.visibilityState === "visible" && !busy) schedule(500);
  }
  document.addEventListener("visibilitychange", shown);
  scope[key] = { poke: () => { if (!busy) schedule(500); } };
  schedule(0);
  return "started";
}

/** The signed-in AO3 name a page shows: its own "My History" link. Runs in the page. */
function signedInNamesInTab(): unknown {
  const names = new Set<string>();
  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    const match = /^\/users\/([A-Za-z0-9_]{1,40})\/readings\/?$/.exec(link.getAttribute("href") ?? "");
    if (match?.[1]) names.add(match[1]);
  }
  const toggle = document.querySelector("#greeting a.dropdown-toggle[href^='/users/']");
  const own = /^\/users\/([A-Za-z0-9_]{1,40})\/?$/.exec(toggle?.getAttribute("href") ?? "");
  if (own?.[1]) names.add(own[1]);
  return Array.from(names);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 200) : null;
}

/** An answer handed over by the page loop, checked field by field. */
export function loadedPageFromTab(value: unknown): LoadedPage {
  if (!isRecord(value)) return { kind: "failed", code: "tab_no_result" };
  if (value.kind === "failed") return { kind: "failed", code: value.code === "timeout" ? "timeout" : "network" };
  if (
    value.kind !== "response" ||
    typeof value.status !== "number" ||
    typeof value.url !== "string" ||
    typeof value.html !== "string"
  ) {
    return { kind: "failed", code: "tab_no_result" };
  }
  const html = value.html.length > MAX_PAGE_CHARS ? value.html.slice(0, MAX_PAGE_CHARS) : value.html;
  return {
    kind: "response",
    status: value.status,
    url: value.url,
    html,
    chars: typeof value.chars === "number" && Number.isSafeInteger(value.chars) ? value.chars : html.length,
    retryAfter: stringOrNull(value.retryAfter),
    cfMitigated: stringOrNull(value.cfMitigated),
    contentType: stringOrNull(value.contentType),
    server: stringOrNull(value.server),
    cfRay: stringOrNull(value.cfRay),
    title: stringOrNull(value.title),
    hidden: value.hidden === true,
  };
}

/** The background's own request, with Safari's own AO3 cookies if it sends them. */
export async function loadInBackground(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<LoadedPage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", signal: controller.signal });
    const text = await response.text();
    const title = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(text.slice(0, 16_384));
    return {
      kind: "response",
      status: response.status,
      url: response.url,
      html: text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text,
      chars: text.length,
      retryAfter: response.headers.get("retry-after"),
      cfMitigated: response.headers.get("cf-mitigated"),
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
      title: title ? title[1]! : null,
    };
  } catch {
    return { kind: "failed", code: signal.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

interface InstallEnvironment {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly scripting?: ScriptingPort;
  readonly permissions?: PermissionsPort;
  readonly alarms: AlarmsPort;
  readonly storageArea: StorageArea;
  /** `storage.session`, where the summary fill keeps its state. */
  readonly sessionArea?: StorageArea | null;
  readonly storageMode: "callback" | "promise";
  readonly fetch: typeof fetch;
  readonly saveActivity: () => { readonly inFlight: number; readonly lastEndedAt: number };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a message came from a page on AO3 itself, in a tab. */
function ao3TabSender(sender: unknown, extensionId: string | undefined): number | null {
  if (!isRecord(sender) || !isRecord(sender.tab) || typeof sender.tab.id !== "number") return null;
  if (typeof extensionId === "string" && sender.id !== extensionId) return null;
  const raw = typeof sender.url === "string" ? sender.url : sender.tab.url;
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? sender.tab.id : null;
  } catch {
    return null;
  }
}

export function installAo3HistoryExperiment(environment: InstallEnvironment): Ao3HistoryExperiment {
  const { runtime, tabs, scripting, permissions, alarms, storageMode } = environment;
  const call = <T,>(target: unknown, method: string, args: readonly unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, storageMode);
  const area = environment.storageArea;
  const sessionArea = environment.sessionArea ?? null;

  /** One tab, by the id a message handed over; never a search. */
  async function ao3Tab(sourceTabId: number | null): Promise<{ readonly id: number; readonly url: URL } | FailCode> {
    if (sourceTabId === null || tabs.get === undefined) return "tab_gone";
    let tab: unknown;
    try {
      tab = await call(tabs, "get", [sourceTabId]);
    } catch {
      return "tab_gone";
    }
    if (!isRecord(tab) || typeof tab.url !== "string") return "no_site_access";
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      return "tab_not_ao3";
    }
    return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? { id: sourceTabId, url } : "tab_not_ao3";
  }

  async function inTab<T>(tabId: number, func: (...args: never[]) => unknown, args: readonly unknown[]): Promise<T | FailCode> {
    if (scripting?.executeScript === undefined) return "tab_no_result";
    try {
      const results = await withTimeout(call<unknown>(scripting, "executeScript", [{ target: { tabId, frameIds: [0] }, func, args }]), REQUEST_TIMEOUT_MS + 5_000);
      if (results === "timeout") return "timeout";
      const first: unknown = Array.isArray(results) ? results[0] : undefined;
      return isRecord(first) && "result" in first ? first.result as T : "tab_no_result";
    } catch {
      return "tab_no_result";
    }
  }

  const experiment = new Ao3HistoryExperiment({
    store: {
      get: (keys) => call<Record<string, unknown>>(area, "get", [keys]).then((value) => value ?? {}),
      set: (items) => call<void>(area, "set", [items]),
      remove: (keys) => call<void>(area, "remove", [keys]),
      keys: async () => Object.keys((await call<Record<string, unknown>>(area, "get", [null])) ?? {}),
    },
    clock: { now: () => Date.now() },
    random: () => Math.random(),
    newId: randomToken,
    bootId: randomToken(),
    saveActivity: environment.saveActivity,
    loadInBackground: (url, signal) => loadInBackground(environment.fetch, url, signal),
    async ensureLoop(sourceTabId) {
      const tab = await ao3Tab(sourceTabId);
      if (typeof tab === "string") return "failed";
      const result = await inTab<unknown>(tab.id, ao3HistoryLoopInTab as (...args: never[]) => unknown, [AO3_HISTORY_EXPERIMENT_MESSAGE, MAX_PAGE_CHARS]);
      return result === "started" || result === "running" ? result : "failed";
    },
    ...(alarms.create === undefined
      ? {}
      : {
          alarm: {
            start: () => call<void>(alarms, "create", [AO3_HISTORY_EXPERIMENT_ALARM, { periodInMinutes: 1 }]),
            stop: () => call<void>(alarms, "clear", [AO3_HISTORY_EXPERIMENT_ALARM]).then(() => undefined),
          },
        }),
  });

  /** The reader's AO3 name, from the tab the sheet was opened on. */
  async function signedInUser(tabId: number | null): Promise<string | { readonly error: string }> {
    if (permissions?.contains !== undefined) {
      const allowed = await call<boolean>(permissions, "contains", [{ origins: [AO3_SITE_PATTERN] }]).catch(() => false);
      if (allowed !== true) return { error: "no_site_access" };
    }
    const tab = await ao3Tab(tabId);
    if (tab === "no_site_access") return { error: "no_site_access" };
    if (typeof tab === "string") return { error: "open_ao3_first" };
    const own = /^\/users\/([A-Za-z0-9_]{1,40})\/readings\/?$/.exec(tab.url.pathname)?.[1];
    if (own !== undefined) return own;
    const names = await inTab<unknown>(tab.id, signedInNamesInTab as (...args: never[]) => unknown, []);
    if (!Array.isArray(names)) return { error: names === "timeout" ? "open_ao3_first" : "no_site_access" };
    const valid = names.filter((name): name is string => typeof name === "string" && USERNAME_PATTERN.test(name));
    const unique = [...new Set(valid.map((name) => name.toLowerCase()))];
    if (unique.length === 0) return { error: "signed_out" };
    if (unique.length > 1) return { error: "username_unclear" };
    return valid[0]!;
  }

  /** The summary fill's record, from wherever the fill keeps it. */
  async function summaryFill(): Promise<string> {
    const read = async (from: unknown) => {
      if (from === null) return undefined;
      const values = await call<Record<string, unknown>>(from, "get", [FFN_SUMMARY_STATE_KEY]).catch(() => null);
      return values?.[FFN_SUMMARY_STATE_KEY];
    };
    const value = (await read(sessionArea)) ?? (await read(area));
    return describeSummaryFill(value, Date.now());
  }

  /** Reset summary fill: removes the fill's session state (test build only). */
  async function resetSummaryFill(): Promise<void> {
    for (const from of [sessionArea, area]) {
      if (from === null) continue;
      await call<void>(from, "remove", [FFN_SUMMARY_STATE_KEY]).catch(() => undefined);
    }
  }

  async function withFill(view: ExperimentView): Promise<ExperimentView & { readonly fill: string }> {
    const fill = await summaryFill();
    return { ...view, fill, report: view.report ? `${view.report}\nSummary fill: ${fill}` : "" };
  }

  async function handle(message: Record<string, unknown>): Promise<unknown> {
    const tabId = typeof message.tabId === "number" && Number.isSafeInteger(message.tabId) ? message.tabId : null;
    switch (message.action) {
      case "status":
        void experiment.wake("sheet", tabId);
        return { ok: true, view: await withFill(await experiment.view()) };
      case "start": {
        const user = await signedInUser(tabId);
        if (typeof user !== "string") return { ok: false, error: user.error, view: await withFill(await experiment.view()) };
        const started = await experiment.start(user, tabId);
        return "error" in started
          ? { ok: false, error: started.error, view: await withFill(await experiment.view()) }
          : { ok: true, view: await withFill(started) };
      }
      case "pause":
        return { ok: true, view: await withFill(await experiment.pause()) };
      case "resume":
        return { ok: true, view: await withFill(await experiment.resume(tabId)) };
      case "clear":
        return { ok: true, view: await withFill(await experiment.clear()) };
      case "reset_fill":
        await resetSummaryFill();
        return { ok: true, view: await withFill(await experiment.view()) };
      default:
        return { ok: false, error: "unknown_action" };
    }
  }

  /** The last time each AO3 tab was given the page loop, so a busy page is not asked again and again. */
  const loopOffered = new Map<number, number>();

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message)) return false;
    const pageTab = ao3TabSender(sender, runtime.id);
    if (message.type === AO3_HISTORY_EXPERIMENT_MESSAGE && pageTab !== null) {
      // The page loop, from the AO3 tab it runs in.
      if (message.action === "tab_tick") {
        void experiment.tick(pageTab).then(sendResponse, () => sendResponse({ wait: 10_000 }));
        return true;
      }
      if (message.action === "tab_answer" && typeof message.token === "string") {
        void experiment.answer(message.token, loadedPageFromTab(message.answer))
          .then(sendResponse, () => sendResponse({ wait: 10_000 }));
        return true;
      }
      return false;
    }
    if (pageTab !== null) {
      // Any other AO3 page speaking to Trace: the reader is on AO3, so a
      // running run's loop is put into that tab. Never answered here.
      const now = Date.now();
      if (now - (loopOffered.get(pageTab) ?? 0) >= 5_000) {
        loopOffered.set(pageTab, now);
        void experiment.wake("page", pageTab);
      }
      return false;
    }
    if (message.type !== AO3_HISTORY_EXPERIMENT_MESSAGE) return false;
    if (!isPopupSender(sender, runtime.id)) return false;
    void handle(message).then(sendResponse, () => sendResponse({ ok: false, error: "experiment_unavailable" }));
    return true;
  });
  alarms.onAlarm?.addListener((alarm) => {
    if (alarm.name === AO3_HISTORY_EXPERIMENT_ALARM) void experiment.wake("alarm");
  });
  // A background started for any reason puts a running run's loop back. The
  // event that started it (the alarm, the sheet, a page) is logged first, so
  // the report can say what brought the background back.
  globalThis.setTimeout(() => void experiment.wake("boot"), 1_500);
  return experiment;
}
