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
 * sheet is closed or Safari restarts. A timer, a one-minute alarm, opening the
 * sheet and the background starting up all continue a running run.
 */

import { extensionCall, type AlarmsPort, type PermissionsPort, type RuntimePort, type ScriptingPort, type StorageArea, type TabsPort } from "./browser-platform.mjs";
import { isChallengePage } from "./ffn-summary-fill.mjs";
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
  | { readonly kind: "stop"; readonly code: StopCode };

export type StopCode =
  | "challenge"
  | "signed_out"
  | "forbidden"
  | "wrong_host"
  | "redirected"
  | "unrecognized_page"
  | "pagination_unexpected"
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
  const after = html.slice(main.index);
  const ends = [after.search(/<ol\b[^>]*\bclass\s*=\s*["'][^"']*\bpagination\b/i), after.search(/<div\b[^>]*\bid\s*=\s*["']footer["']/i)]
    .filter((index) => index > 0);
  const list = ends.length ? after.slice(0, Math.min(...ends)) : after;
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
  // Every Next link on the page (AO3 may show the pagination twice) must name
  // the following page of the same History.
  const nexts = new Set<number | null>();
  const anchor = /<a\b[^>]*>/gi;
  for (let match = anchor.exec(after); match !== null; match = anchor.exec(after)) {
    if (attribute(match[0], "rel") !== "next") continue;
    nexts.add(historyPageNumber(attribute(match[0], "href") ?? "", user));
  }
  if (nexts.size > 1 || nexts.has(null) || (nexts.size === 1 && !nexts.has(page + 1))) {
    return { kind: "stop", code: "pagination_unexpected" };
  }
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
      /** Whether the tab was hidden when it read the page (tab path only). */
      readonly hidden?: boolean;
    }
  | { readonly kind: "failed"; readonly code: FailCode };

export type FailCode = "timeout" | "network" | "cancelled" | "tab_gone" | "tab_not_ao3" | "tab_no_result" | "no_site_access";

export type Classified =
  | { readonly kind: "page"; readonly read: Extract<HistoryPageRead, { kind: "page" }> }
  | { readonly kind: "retry"; readonly code: "rate_limited" | "unavailable" | "server_error" | "network" | "timeout"; readonly retryAfterMs: number | null }
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
  return read.kind === "page" ? { kind: "page", read } : { kind: "stop", code: read.code };
}

// --- The run ---------------------------------------------------------------------

export type RunStatus = "running" | "paused" | "finished";
export type RunPath = "probe_background" | "probe_tab" | "background" | "tab";
export type WakeSource = "start" | "timer" | "alarm" | "sheet" | "boot";

export interface ExperimentState {
  v: 1;
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
  counts: {
    pagesRead: number; rows: number; distinct: number; duplicates: number;
    markedForLater: number; deleted: number; unreadable: number;
  };
  timing: {
    startedAt: number; finishedAt: number | null; pausedAt: number | null; pausedMs: number;
    lastRequestAt: number | null; countNextGap: boolean; dueAt: number; gapMs: number;
    requests: number; requestMsTotal: number; requestMsMax: number;
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
  };
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
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
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
  readonly loadPage: (path: "background" | "tab", url: string, tabId: number | null, signal: AbortSignal) => Promise<LoadedPage>;
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
  return state.v === 1 && typeof state.runId === "string" && typeof state.user === "string" &&
    USERNAME_PATTERN.test(state.user) && ["running", "paused", "finished"].includes(state.status as string) &&
    Number.isSafeInteger(state.nextPage) && Array.isArray(state.ids) && Array.isArray(state.pages) &&
    typeof state.counts === "object" && typeof state.timing === "object" && typeof state.pace === "object" &&
    typeof state.lifetime === "object" && typeof state.storage === "object" && typeof state.errors === "object";
}

function newState(runId: string, user: string, tabId: number | null, now: number, bootId: string): ExperimentState {
  return {
    v: 1, runId, status: "running", reason: null, user, tabId, path: "probe_background",
    probes: { background: null, tab: null }, nextPage: 1, pages: [], lastPageDigest: null, ids: [],
    counts: { pagesRead: 0, rows: 0, distinct: 0, duplicates: 0, markedForLater: 0, deleted: 0, unreadable: 0 },
    timing: {
      startedAt: now, finishedAt: null, pausedAt: null, pausedMs: 0, lastRequestAt: null, countNextGap: false,
      dueAt: now, gapMs: PAGE_GAP_MS, requests: 0, requestMsTotal: 0, requestMsMax: 0,
      pageCharsTotal: 0, pageCharsMax: 0, gapTotalMs: 0, gapCount: 0, maxGapMs: 0, stalls: 0, stalledMs: 0,
    },
    pace: {
      rateLimited: 0, unavailable: 0, serverErrors: 0, networkErrors: 0,
      retryAfterMaxMs: 0, consecutiveRetries: 0, waitsForSave: 0, backoffs: 0,
    },
    lifetime: { boots: [bootId], revivedBy: { start: 0, timer: 0, alarm: 0, sheet: 0, boot: 0 }, pauses: 0, resumes: 0, hiddenTabPages: 0 },
    storage: { pageBytes: 0, writeFailures: 0 },
    errors: {},
  };
}

/** Codes a background probe may fail with before the AO3 tab is tried. */
const TRY_THE_TAB = new Set(["signed_out", "redirected", "unrecognized_page", "forbidden", "http_error"]);

export class Ao3HistoryExperiment {
  readonly #ports: ExperimentPorts;
  #state: ExperimentState | null = null;
  #loaded = false;
  #busy = false;
  #timer: unknown = null;
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

  #clearTimer(): void {
    if (this.#timer !== null) this.#ports.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    this.#timer = this.#ports.clock.setTimeout(() => {
      this.#timer = null;
      void this.#step("timer");
    }, Math.max(0, delayMs));
  }

  async #alarm(on: boolean): Promise<void> {
    try {
      await (on ? this.#ports.alarm?.start() : this.#ports.alarm?.stop());
    } catch {
      // The timer and the sheet still continue the run.
    }
  }

  async view(): Promise<ExperimentView> {
    return describe(await this.#serial(() => this.#load()), this.#ports.clock.now());
  }

  /** Starts a new run for `user`, read first from the background, then from the tab. */
  async start(user: string, tabId: number | null): Promise<ExperimentView | { readonly error: string }> {
    if (!USERNAME_PATTERN.test(user)) return { error: "username_unclear" };
    const started = await this.#serial(async () => {
      if ((await this.#load()) !== null) return false;
      const now = this.#ports.clock.now();
      return await this.#write(newState(this.#ports.newId(), user, tabId, now, this.#ports.bootId));
    });
    if (!started) return { error: this.#state === null ? "storage_write_failed" : "already_started" };
    await this.#alarm(true);
    await this.#step("start");
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
      this.#clearTimer();
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
      return await this.#write(next);
    });
    if (resumed) {
      await this.#alarm(true);
      await this.#step("start");
    }
    return this.view();
  }

  /** Cancel and Clear: stops any request and removes everything stored. */
  async clear(): Promise<ExperimentView> {
    this.#abort?.abort();
    this.#clearTimer();
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

  /** Continues a running run when nothing in this background is already doing so. */
  async wake(source: WakeSource): Promise<void> {
    if (this.#busy || this.#timer !== null) return;
    await this.#step(source);
  }

  async #step(source: WakeSource): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#clearTimer();
    try {
      await this.#stepOnce(source);
    } finally {
      this.#busy = false;
    }
  }

  async #stepOnce(source: WakeSource): Promise<void> {
    const prepared = await this.#serial(async (): Promise<{ request: ExperimentState | null; wait: number } | null> => {
      const state = await this.#load();
      if (state === null || state.status !== "running") return null;
      const next = clone(state);
      const now = this.#ports.clock.now();
      if (!next.lifetime.boots.includes(this.#ports.bootId)) {
        // This background was started again since the run last made a request.
        next.lifetime.boots = [...next.lifetime.boots, this.#ports.bootId].slice(-MAX_BOOTS);
        next.lifetime.revivedBy[source] += 1;
      }
      if (next.nextPage > MAX_PAGES) return await this.#pauseWith(next, "page_limit", now);
      const saves = this.#ports.saveActivity();
      if (saves.inFlight > 0 || now - saves.lastEndedAt < SAVE_SETTLE_MS) {
        next.pace.waitsForSave += 1;
        await this.#write(next);
        return { request: null, wait: SAVE_RECHECK_MS };
      }
      if (now < next.timing.dueAt) {
        if (JSON.stringify(next.lifetime) !== JSON.stringify(state.lifetime)) await this.#write(next);
        return { request: null, wait: next.timing.dueAt - now };
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
      // background keeps the pace.
      next.timing.lastRequestAt = now;
      // Until this answer is in, a background started again waits out the
      // request's own time limit too, so two requests never overlap.
      next.timing.dueAt = now + REQUEST_TIMEOUT_MS + 5_000 + this.#gap(next);
      next.timing.countNextGap = true;
      next.timing.requests += 1;
      if (!(await this.#write(next))) {
        next.storage.writeFailures += 1;
        return await this.#pauseWith(next, "storage_write_failed", now);
      }
      return { request: next, wait: 0 };
    });
    if (prepared === null) {
      if (this.#state?.status !== "running") await this.#alarm(false);
      return;
    }
    if (prepared.request === null) {
      if (this.#state?.status === "running") this.#schedule(prepared.wait);
      return;
    }
    const state = prepared.request;
    const page = state.nextPage;
    const path = state.path === "probe_background" || state.path === "background" ? "background" : "tab";
    const abort = new AbortController();
    this.#abort = abort;
    const sentAt = this.#ports.clock.now();
    let answer: LoadedPage;
    try {
      answer = await this.#ports.loadPage(path, historyPageURL(state.user, page), state.tabId, abort.signal);
    } catch {
      answer = { kind: "failed", code: "network" };
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
    const answeredAt = this.#ports.clock.now();
    const keepGoing = await this.#serial(async () => {
      const current = this.#state;
      // Cancelled meanwhile: nothing is kept.
      if (abort.signal.aborted || current === null || current.runId !== state.runId) return false;
      const next = clone(current);
      const ms = Math.max(0, answeredAt - sentAt);
      next.timing.requestMsTotal += ms;
      next.timing.requestMsMax = Math.max(next.timing.requestMsMax, ms);
      if (answer.kind === "response") {
        next.timing.pageCharsTotal += answer.chars;
        next.timing.pageCharsMax = Math.max(next.timing.pageCharsMax, answer.chars);
        if (answer.hidden === true) next.lifetime.hiddenTabPages += 1;
      }
      const result = classifyHistoryAnswer(answer, next.user, page, answeredAt);
      if (result.kind === "page") return await this.#admit(next, page, result.read, path, answeredAt);
      next.errors[result.code] = (next.errors[result.code] ?? 0) + 1;
      if (result.kind === "retry") return await this.#retry(next, result, answeredAt);
      if (next.path === "probe_background" && TRY_THE_TAB.has(result.code)) {
        next.probes.background = result.code;
        next.path = "probe_tab";
        next.timing.dueAt = answeredAt + this.#gap(next);
        return await this.#write(next);
      }
      if (next.path === "probe_tab") {
        next.probes.tab = result.code;
        if (TRY_THE_TAB.has(result.code)) {
          await this.#pauseWith(next, "no_working_path", answeredAt);
          return false;
        }
      }
      await this.#pauseWith(next, result.code, answeredAt);
      return false;
    });
    if (keepGoing && this.#state?.status === "running") {
      this.#schedule(Math.max(0, this.#state.timing.dueAt - this.#ports.clock.now()));
    } else if (this.#state?.status !== "running") {
      await this.#alarm(false);
    }
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
    else next.pace.networkErrors += 1;
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
    if (!network) {
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
    ["Average answer", seconds(average(t.requestMsTotal, t.requests))],
    ["Slowest answer", seconds(t.requestMsMax)],
    ["Average page size", kb(average(t.pageCharsTotal, t.requests))],
    ["Largest page", kb(t.pageCharsMax)],
    ["Planned gap", seconds(t.gapMs)],
    ["Average gap", seconds(average(t.gapTotalMs, t.gapCount))],
    ["Longest gap", seconds(t.maxGapMs)],
    ["Stalls over 30 s", `${t.stalls} (${duration(t.stalledMs)})`],
    ["Background restarts", String(Math.max(0, state.lifetime.boots.length - 1))],
    ["Restarted by", `alarm ${state.lifetime.revivedBy.alarm}, sheet ${state.lifetime.revivedBy.sheet}, timer ${state.lifetime.revivedBy.timer}, start ${state.lifetime.revivedBy.start}, other ${state.lifetime.revivedBy.boot}`],
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
    "Trace AO3 History experiment v1",
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

// --- Safari wiring -----------------------------------------------------------------

/**
 * Reads one History page inside the reader's AO3 tab: a same-site request
 * with the tab's own sign-in. Runs in the page, so it must use nothing from
 * outside this function.
 */
async function readHistoryPageInTab(url: string, maxChars: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "follow", signal: controller.signal });
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      url: response.url,
      html: text.length > maxChars ? text.slice(0, maxChars) : text,
      chars: text.length,
      retryAfter: response.headers.get("retry-after"),
      cfMitigated: response.headers.get("cf-mitigated"),
      contentType: response.headers.get("content-type"),
      hidden: document.visibilityState === "hidden",
    };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
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

/** The background's own request, with Safari's own AO3 cookies if it sends them. */
export async function loadInBackground(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<LoadedPage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", signal: controller.signal });
    const text = await response.text();
    return {
      kind: "response",
      status: response.status,
      url: response.url,
      html: text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text,
      chars: text.length,
      retryAfter: response.headers.get("retry-after"),
      cfMitigated: response.headers.get("cf-mitigated"),
      contentType: response.headers.get("content-type"),
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

export function installAo3HistoryExperiment(environment: InstallEnvironment): Ao3HistoryExperiment {
  const { runtime, tabs, scripting, permissions, alarms, storageMode } = environment;
  const call = <T,>(target: unknown, method: string, args: readonly unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, storageMode);
  const area = environment.storageArea;

  /** One tab, by the id the sheet handed over with its message; never a search. */
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
      const results = await withTimeout(call<unknown>(scripting, "executeScript", [{ target: { tabId }, func, args }]), REQUEST_TIMEOUT_MS + 5_000);
      if (results === "timeout") return "timeout";
      const first: unknown = Array.isArray(results) ? results[0] : undefined;
      return isRecord(first) && "result" in first ? first.result as T : "tab_no_result";
    } catch {
      return "tab_no_result";
    }
  }

  async function loadInTab(url: string, tabId: number | null, signal: AbortSignal): Promise<LoadedPage> {
    const tab = await ao3Tab(tabId);
    if (typeof tab === "string") return { kind: "failed", code: tab };
    const result = await inTab<unknown>(tab.id, readHistoryPageInTab as (...args: never[]) => unknown, [url, MAX_PAGE_CHARS]);
    if (signal.aborted) return { kind: "failed", code: "cancelled" };
    if (typeof result === "string") return { kind: "failed", code: result as FailCode };
    if (!isRecord(result)) return { kind: "failed", code: "tab_no_result" };
    if (result.ok !== true) return { kind: "failed", code: result.error === "timeout" ? "timeout" : "network" };
    if (typeof result.status !== "number" || typeof result.url !== "string" || typeof result.html !== "string") {
      return { kind: "failed", code: "tab_no_result" };
    }
    return {
      kind: "response",
      status: result.status,
      url: result.url,
      html: result.html,
      chars: typeof result.chars === "number" ? result.chars : result.html.length,
      retryAfter: stringOrNull(result.retryAfter),
      cfMitigated: stringOrNull(result.cfMitigated),
      contentType: stringOrNull(result.contentType),
      hidden: result.hidden === true,
    };
  }

  const experiment = new Ao3HistoryExperiment({
    store: {
      get: (keys) => call<Record<string, unknown>>(area, "get", [keys]).then((value) => value ?? {}),
      set: (items) => call<void>(area, "set", [items]),
      remove: (keys) => call<void>(area, "remove", [keys]),
      keys: async () => Object.keys((await call<Record<string, unknown>>(area, "get", [null])) ?? {}),
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    random: () => Math.random(),
    newId: randomToken,
    bootId: randomToken(),
    saveActivity: environment.saveActivity,
    loadPage: (path, url, tabId, signal) =>
      path === "background" ? loadInBackground(environment.fetch, url, signal) : loadInTab(url, tabId, signal),
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

  async function handle(message: Record<string, unknown>): Promise<unknown> {
    const tabId = typeof message.tabId === "number" && Number.isSafeInteger(message.tabId) ? message.tabId : null;
    switch (message.action) {
      case "status":
        void experiment.wake("sheet");
        return { ok: true, view: await experiment.view() };
      case "start": {
        const user = await signedInUser(tabId);
        if (typeof user !== "string") return { ok: false, error: user.error, view: await experiment.view() };
        const started = await experiment.start(user, tabId);
        return "error" in started ? { ok: false, error: started.error, view: await experiment.view() } : { ok: true, view: started };
      }
      case "pause":
        return { ok: true, view: await experiment.pause() };
      case "resume":
        return { ok: true, view: await experiment.resume(tabId) };
      case "clear":
        return { ok: true, view: await experiment.clear() };
      default:
        return { ok: false, error: "unknown_action" };
    }
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || message.type !== AO3_HISTORY_EXPERIMENT_MESSAGE) return false;
    if (!isPopupSender(sender, runtime.id)) return false;
    void handle(message).then(sendResponse, () => sendResponse({ ok: false, error: "experiment_unavailable" }));
    return true;
  });
  alarms.onAlarm?.addListener((alarm) => {
    if (alarm.name === AO3_HISTORY_EXPERIMENT_ALARM) void experiment.wake("alarm");
  });
  // A background started for any reason carries on a running run. The event
  // that started it (the alarm, the sheet) answers first, so the report can
  // say what brought the background back.
  globalThis.setTimeout(() => void experiment.wake("boot"), 1_500);
  return experiment;
}
