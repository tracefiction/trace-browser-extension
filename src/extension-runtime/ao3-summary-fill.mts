/**
 * AO3 summaries for saved works Trace has none for.
 *
 * AO3 shows a work's summary only on its first chapter (and on a one-shot or
 * the Entire Work view). A work saved from a later chapter, or imported from
 * an open tab, can reach the Library without one. This reads the summaries
 * of the reader's saved AO3 works that no one in Trace has a summary for.
 * It is the only place the extension reads an AO3 page for a summary.
 *
 * A save whose reply says Trace has no summary for the work
 * (`summary_known: false`) puts that work first. Trace's server lists the
 * others (`/api/extension/library/summary-gaps`, at most 50, newest first).
 * Each is read from its own first page,
 * `/works/<id>?view_adult=true`, inside the reader's own AO3 tab, as a
 * same-site request from that page, so the reader's own AO3 session applies
 * (a work for signed-in readers only is read only when they are signed in).
 * The page is parsed in the tab, read only as far as the work's own preface,
 * and only the summary's text comes back; nothing else of the page leaves
 * the tab. The summary is sent as a metadata contribution, identity and
 * summary only.
 *
 * Nothing waits on a timer. On iPhone Safari unloads the background within
 * about a minute and its timers with it, so the work still to do is kept in
 * session-only storage (or, without it, local storage that expires) and
 * picked up whenever an AO3 page speaks to Trace.
 *
 * It stays polite: one request at a time, at least 30 s apart and a minute
 * apart between works (the time of the last one is stored, so a background
 * started again keeps the pace), at most 30 works in six hours, never during
 * or just after a save, only while the reader is on AO3 and only while
 * **Improve story details** is on. A refusal, a check page, an unexpected
 * site or an error pauses it for an hour (longer when AO3 asks for longer,
 * at most a day); a work AO3 says is gone, one only signed-in readers can
 * see, one with no summary, or one whose page could not be read is skipped,
 * and three unreadable pages in a row pause it like a refusal. What stopped
 * it is recorded (reason, status, host, kind of address, `cf-mitigated`,
 * time), never page text. The ids of up to 200 works already tried are kept
 * so each listing tries others first; they and the state are removed on
 * sign-out or when the account changes.
 */

import { archiveHostKindFromSender } from "./archive-sender.mjs";
import {
  StoredAttemptedIds,
  StoredSessionState,
  type AttemptedPort,
  type SessionStatePort,
  type StorageAreaLike,
} from "./summary-fill-storage.mjs";

/** Firefox's page-world window in a content script; absent elsewhere. */
declare const content: { readonly fetch?: typeof fetch } | undefined;

export const AO3_SUMMARY_STATE_KEY = "traceAo3SummaryFillV1";
export const AO3_SUMMARY_ATTEMPTED_KEY = "traceAo3SummaryAttemptedV1";

/** Least time between two reads of an AO3 page. */
export const REQUEST_GAP_MS = 30_000;
/** Least time between two steps (a listing or a work's page). */
export const BACKFILL_GAP_MS = 60_000;
/** Nothing is read this soon after a save to Trace. */
export const SAVE_SETTLE_MS = 20_000;
/** Pages read per window, at most. */
export const WINDOW_MAX_READS = 30;
export const WINDOW_MS = 6 * 60 * 60_000;
/** With nothing left to read, the gaps are listed again after this long. */
export const RELIST_MS = 30 * 60_000;
/** After the Library changed, the gaps are listed again, but never sooner than this. */
export const RELIST_MIN_MS = 5 * 60_000;
/** How long a refusal, check page or error pauses the fill. */
export const STOP_MS = 60 * 60_000;
/** The longest pause AO3 may ask for with `Retry-After`. */
export const STOP_MAX_MS = 24 * 60 * 60_000;
/** Unreadable pages in a row that pause the fill. */
export const MISSES_MAX = 3;
/** Works kept to read, at most (the server lists at most 50). */
export const QUEUE_MAX = 50;
/** Without session storage, the state is kept in local storage this long. */
export const LOCAL_STATE_TTL_MS = 12 * 60 * 60_000;
/** Works already tried, remembered across sessions so each listing tries others. */
export const ATTEMPTED_MAX = 200;
export const TAB_READ_TIMEOUT_MS = 15_000;
/** No page is read in the tab further than this. */
export const MAX_TAB_READ_BYTES = 1_024 * 1_024;
/** A summary's text, at most (AO3 itself allows 1,250 characters). */
export const SUMMARY_MAX_CHARS = 4_000;
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;

// --- One work's page, read in the reader's tab ----------------------------------

/** What a read in the tab came back with: the answer's facts and the summary, never page text. */
export type Ao3TabRead =
  | {
      readonly kind: "response";
      readonly status: number;
      /** Where the request ended, after any redirect. */
      readonly url: string;
      readonly contentType: string | null;
      readonly cfMitigated: string | null;
      readonly retryAfter: string | null;
      /** What the page was: a work's page, a check page, or something else. */
      readonly page: "work" | "challenge" | "other";
      /** The work's own summary, when the page had one. */
      readonly summary: string | null;
    }
  | { readonly kind: "failed"; readonly code: TabFailCode };

/**
 * Why there was no answer. `timeout` and `network` mean a request may have
 * been made; the others mean none was.
 */
export type TabFailCode =
  | "tab_gone"
  | "tab_not_ao3"
  | "not_allowed"
  | "no_result"
  | "timeout"
  | "network";

export type StopReason =
  | "status"
  | "redirect"
  | "challenge"
  | "not_html"
  | "missing"
  | "error"
  | "send"
  | "gaps";

/** Why a work was skipped, the fill carrying on. */
export type SkipOutcome = "gone" | "restricted" | "no_summary" | "unreadable";

export type PathType = "work" | "login" | "other";

/** What is recorded about an answer: never page text. */
export interface FillNote {
  readonly status: number | null;
  readonly host: string | null;
  readonly path: PathType | null;
  readonly cf: string | null;
}

const NO_NOTE: FillNote = Object.freeze({ status: null, host: null, path: null, cf: null });

function workPathPattern(workId: string): RegExp {
  return new RegExp(`^(?:/collections/[^/]+)?/works/${workId}(?:/chapters/[1-9][0-9]{0,19})?/?$`);
}

export function ao3PathType(pathname: string, workId: string): PathType {
  if (workPathPattern(workId).test(pathname)) return "work";
  if (/^\/users\/login(?:\/|$)/.test(pathname)) return "login";
  return "other";
}

function cfNote(value: string | null): string | null {
  if (value === null || value === "") return null;
  const lower = value.trim().toLowerCase();
  return /^[a-z_-]{1,20}$/.test(lower) ? lower : "other";
}

/**
 * How long `Retry-After` asks to wait, in milliseconds, or null when it says
 * nothing usable. Seconds or an HTTP date.
 */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^[0-9]{1,9}$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at - now : null;
}

export type Classified =
  | { readonly kind: "summary"; readonly summary: string; readonly note: FillNote }
  | { readonly kind: "skip"; readonly outcome: SkipOutcome; readonly note: FillNote }
  | {
      readonly kind: "stop";
      readonly reason: StopReason;
      readonly note: FillNote;
      /** How long the site asked to wait, when it did. */
      readonly waitMs: number | null;
    }
  /** The tab could not be used; nothing was asked of the site. */
  | { readonly kind: "tab"; readonly code: TabFailCode; readonly note: FillNote };

/**
 * What a read of `/works/<workId>` in the tab means for the fill: a summary,
 * a work to skip, a reason to pause, or a tab that could not be used.
 */
export function classifyAo3Answer(answer: Ao3TabRead, host: string, workId: string, now: number): Classified {
  if (answer.kind === "failed") {
    const note = { ...NO_NOTE, host, path: "work" as const };
    return answer.code === "timeout" || answer.code === "network"
      ? { kind: "stop", reason: "error", note, waitMs: null }
      : { kind: "tab", code: answer.code, note };
  }
  let landed: URL | null = null;
  try {
    landed = new URL(answer.url);
  } catch {
    landed = null;
  }
  const note: FillNote = {
    status: Number.isSafeInteger(answer.status) ? answer.status : null,
    host: landed !== null && /^[a-z0-9.-]{1,80}$/i.test(landed.hostname) ? landed.hostname.toLowerCase() : host,
    path: landed !== null ? ao3PathType(landed.pathname, workId) : null,
    cf: cfNote(answer.cfMitigated),
  };
  const stop = (reason: StopReason): Classified => ({
    kind: "stop",
    reason,
    note,
    waitMs: retryAfterMs(answer.retryAfter, now),
  });
  if (note.cf === "challenge") return stop("challenge");
  if (landed === null || landed.protocol !== "https:" || landed.hostname !== host) {
    return stop(answer.page === "challenge" ? "challenge" : "redirect");
  }
  // A work only signed-in readers can see, and the reader is signed out.
  if (note.path === "login") return { kind: "skip", outcome: "restricted", note };
  if (note.path !== "work") return { kind: "skip", outcome: "unreadable", note };
  if (answer.status === 404 || answer.status === 410) return { kind: "skip", outcome: "gone", note };
  if (answer.status !== 200) return stop(answer.page === "challenge" ? "challenge" : "status");
  if (!/text\/html/i.test(answer.contentType ?? "")) return stop("not_html");
  if (answer.page === "challenge") return stop("challenge");
  if (answer.page !== "work") return { kind: "skip", outcome: "unreadable", note };
  const summary = (answer.summary ?? "").trim().slice(0, SUMMARY_MAX_CHARS);
  return summary ? { kind: "summary", summary, note } : { kind: "skip", outcome: "no_summary", note };
}

/**
 * Reads one work's first page inside the reader's AO3 tab. Runs in the page,
 * so it must use nothing from outside this function. The request carries the
 * tab's own cookies; the page is read only as far as the work's own preface
 * (the chapters start after it), or `maxBytes`, is parsed in the page, and
 * only the summary's text comes back. On Firefox the script's own `fetch` is
 * the extension's request, so the page's `content.fetch` is used.
 */
async function readAo3WorkSummaryInTab(host: string, workId: string, maxBytes: number, maxChars: number): Promise<unknown> {
  // The tab moved on: nothing is asked of another site.
  if (location.protocol !== "https:" || location.hostname !== host) return { ok: false, error: "moved" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const pageFetch: typeof fetch =
      typeof content !== "undefined" && content !== null && typeof content.fetch === "function"
        ? content.fetch.bind(content)
        : fetch;
    const response = await pageFetch(`https://${host}/works/${workId}?view_adult=true`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    const chaptersStart = /<div\b[^>]*\bid\s*=\s*["']?chapters\b/i;
    let text = "";
    const body = response.body;
    if (/text\/html/i.test(contentType || "") && body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          const before = text.length;
          text += decoder.decode(chunk.value, { stream: true });
          // The work's preface is complete once the chapters start.
          if (chaptersStart.test(text.slice(Math.max(0, before - 64)))) break;
          if (bytes >= maxBytes) break;
        }
      } finally {
        // The rest of the page is never downloaded.
        reader.cancel().catch(() => undefined);
      }
    } else if (/text\/html/i.test(contentType || "")) {
      // A body that cannot be streamed is read whole, and kept only up to the limit.
      const whole = await response.text();
      const end = whole.search(chaptersStart);
      text = (end < 0 ? whole : whole.slice(0, end)).slice(0, maxBytes);
    } else if (body) {
      body.cancel().catch(() => undefined);
    }
    const head = text.slice(0, 8_192);
    const challenge =
      /<title>\s*(?:just a moment|attention required|please wait)/i.test(head) ||
      /\/cdn-cgi\/challenge-platform\//i.test(head) ||
      /\bcf[-_]chl[-_]/i.test(head) ||
      /\bchallenge-form\b/i.test(head);
    let page: "work" | "challenge" | "other" = challenge ? "challenge" : "other";
    let summary: string | null = null;
    if (!challenge && text) {
      const parsed = new DOMParser().parseFromString(text, "text/html");
      const skin = parsed.getElementById("workskin");
      if (skin !== null) {
        page = "work";
        // The work's own preface, never a chapter's.
        const preface = Array.from(skin.children).find((element) =>
          element.classList.contains("preface") &&
          element.classList.contains("group") &&
          !element.classList.contains("chapter"));
        const quote = preface?.querySelector(".summary blockquote.userstuff") ?? null;
        if (quote !== null) {
          // Paragraphs and line breaks are kept, as the page's own script keeps them.
          const blocks = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CENTER|DD|DETAILS|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|OL|P|PRE|SECTION|TABLE|TR|UL)$/;
          let out = "";
          const walk = (node: Node) => {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              if (child.nodeType === 3) {
                out += String(child.nodeValue || "").replace(/\s+/g, " ");
              } else if (child.nodeType === 1) {
                const tag = String((child as Element).tagName || "").toUpperCase();
                if (tag === "BR") {
                  out += "\n";
                } else if (tag !== "SCRIPT" && tag !== "STYLE") {
                  const block = blocks.test(tag);
                  if (block) out += "\n\n";
                  walk(child);
                  if (block) out += "\n\n";
                }
              }
            }
          };
          walk(quote);
          const clean = out
            .split("\n")
            .map((line) => line.replace(/[ \t ]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          summary = clean ? clean.slice(0, maxChars) : null;
        }
      }
    }
    return {
      ok: true,
      status: response.status,
      url: response.url,
      contentType,
      cfMitigated: response.headers.get("cf-mitigated"),
      retryAfter: response.headers.get("retry-after"),
      page,
      summary,
    };
  } catch (_) {
    return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown, max = 200): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export interface TabReaderEnvironment {
  /** `tabs.get`, `scripting.executeScript` and `permissions.contains`, already promised. */
  getTab(tabId: number): Promise<unknown>;
  executeScript(details: Record<string, unknown>): Promise<unknown>;
  containsOrigin(origin: string): Promise<boolean>;
  readonly hasScripting: boolean;
  readonly timeoutMs?: number;
}

export interface Ao3TabReader {
  /** The tab's AO3 host, when a page may be read in it now. */
  tabHost(tabId: number): Promise<{ readonly host: string } | { readonly code: TabFailCode }>;
  readWork(tabId: number, host: string, workId: string): Promise<Ao3TabRead>;
}

/** Reads AO3 works' first pages in the reader's own tab, through `scripting`. */
export function createAo3TabReader(environment: TabReaderEnvironment): Ao3TabReader {
  const timeoutMs = environment.timeoutMs ?? TAB_READ_TIMEOUT_MS + 5_000;
  return {
    async tabHost(tabId) {
      if (!environment.hasScripting) return { code: "no_result" };
      let tab: unknown;
      try {
        tab = await environment.getTab(tabId);
      } catch {
        return { code: "tab_gone" };
      }
      if (!isRecord(tab) || typeof tab.url !== "string") return { code: "tab_not_ao3" };
      let url: URL;
      try {
        url = new URL(tab.url);
      } catch {
        return { code: "tab_not_ao3" };
      }
      if (url.protocol !== "https:" || archiveHostKindFromSender({ url: url.href }) !== "ao3") {
        return { code: "tab_not_ao3" };
      }
      const host = url.hostname.toLowerCase();
      // Only where the reader has allowed Trace on the site itself.
      const allowed = await environment.containsOrigin(`https://${host}/*`).catch(() => false);
      if (!allowed) return { code: "not_allowed" };
      return { host };
    },
    async readWork(tabId, host, workId) {
      let results: unknown;
      try {
        results = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => resolve("timeout"), timeoutMs);
          environment.executeScript({
            target: { tabId, frameIds: [0] },
            func: readAo3WorkSummaryInTab,
            args: [host, workId, MAX_TAB_READ_BYTES, SUMMARY_MAX_CHARS],
          }).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(error); },
          );
        });
      } catch {
        return { kind: "failed", code: "no_result" };
      }
      if (results === "timeout") return { kind: "failed", code: "timeout" };
      const first: unknown = Array.isArray(results) ? results[0] : undefined;
      const result: unknown = isRecord(first) ? first.result : undefined;
      if (!isRecord(result)) return { kind: "failed", code: "no_result" };
      if (result.ok !== true) {
        if (result.error === "moved") return { kind: "failed", code: "tab_not_ao3" };
        return { kind: "failed", code: result.error === "timeout" ? "timeout" : "network" };
      }
      if (
        typeof result.status !== "number" ||
        typeof result.url !== "string" ||
        (result.page !== "work" && result.page !== "challenge" && result.page !== "other") ||
        (result.summary !== null && typeof result.summary !== "string")
      ) {
        return { kind: "failed", code: "no_result" };
      }
      return {
        kind: "response",
        status: result.status,
        url: result.url,
        contentType: stringOrNull(result.contentType),
        cfMitigated: stringOrNull(result.cfMitigated),
        retryAfter: stringOrNull(result.retryAfter, 64),
        page: result.page,
        summary: typeof result.summary === "string" ? result.summary.slice(0, SUMMARY_MAX_CHARS) : null,
      };
    },
  };
}

// --- State ------------------------------------------------------------------------

export type FillStage = "check" | "gaps" | "work_page" | "send";

export type ContributionOutcome = "accepted" | "skipped" | "failed";

/** Why the fill stopped, kept until it may try again. */
export interface FillStop extends FillNote {
  readonly reason: StopReason;
  readonly at: number;
  readonly until: number;
}

/** What the last step did. */
export interface FillLast extends FillNote {
  readonly stage: FillStage;
  /** What came of it, or why it stopped. */
  readonly outcome: string;
  /** Works listed, on a listing. */
  readonly listed: number | null;
  readonly send: ContributionOutcome | null;
  readonly at: number;
}

export interface FillState {
  readonly v: 1;
  /** The account the state belongs to (`accountId:epoch`). */
  readonly account: string;
  /** Works still to read, in order, at most `QUEUE_MAX`. */
  readonly queue: readonly string[];
  /** When the gaps were last listed. */
  readonly listedAt: number;
  /** The Library changed since: list again once `RELIST_MIN_MS` has passed. */
  readonly stale: boolean;
  /** When the current window of reads began, and the pages read in it. */
  readonly windowStart: number;
  readonly reads: number;
  /** Unreadable pages in a row. */
  readonly misses: number;
  /** When a page was last read: no other read within `REQUEST_GAP_MS`. */
  readonly lastRequestAt: number;
  /** When the fill last took a step. */
  readonly lastStepAt: number;
  readonly stop: FillStop | null;
  readonly last: FillLast | null;
  /** When local-storage state expires (absent in session storage). */
  readonly exp?: number;
}

export type FillStatePort = SessionStatePort<FillState>;

export type { AttemptedPort };

const CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

function validNote(value: Record<string, unknown>): boolean {
  return (
    (value.status === null || Number.isSafeInteger(value.status)) &&
    (value.host === null || (typeof value.host === "string" && /^[a-z0-9.-]{1,80}$/.test(value.host))) &&
    (value.path === null || value.path === "work" || value.path === "login" || value.path === "other") &&
    (value.cf === null || (typeof value.cf === "string" && /^[a-z_-]{1,20}$/.test(value.cf)))
  );
}

function validStop(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value) && validNote(value) && typeof value.reason === "string" &&
    CODE_PATTERN.test(value.reason) && finite(value.at) && finite(value.until);
}

function validLast(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value) && validNote(value) &&
    typeof value.stage === "string" && CODE_PATTERN.test(value.stage) &&
    typeof value.outcome === "string" && CODE_PATTERN.test(value.outcome) &&
    (value.listed === null || Number.isSafeInteger(value.listed)) &&
    (value.send === null || value.send === "accepted" || value.send === "skipped" || value.send === "failed") &&
    finite(value.at);
}

function validState(value: unknown): FillState | null {
  if (!isRecord(value)) return null;
  if (
    value.v !== 1 ||
    typeof value.account !== "string" ||
    !Array.isArray(value.queue) ||
    value.queue.length > QUEUE_MAX ||
    !value.queue.every((id) => typeof id === "string" && ID_PATTERN.test(id)) ||
    !finite(value.listedAt) ||
    typeof value.stale !== "boolean" ||
    !finite(value.windowStart) ||
    !Number.isSafeInteger(value.reads) ||
    !Number.isSafeInteger(value.misses) ||
    !finite(value.lastRequestAt) ||
    !finite(value.lastStepAt) ||
    !validStop(value.stop) ||
    !validLast(value.last) ||
    (value.exp !== undefined && !finite(value.exp))
  ) {
    return null;
  }
  return value as unknown as FillState;
}

/**
 * The AO3 fill's state in one storage area (see `StoredSessionState`):
 * session-only storage where the browser has it, otherwise local storage
 * that expires.
 */
export class StoredFillState extends StoredSessionState<FillState> {
  constructor(
    area: StorageAreaLike | null | undefined,
    options: { readonly ttlMs?: number; readonly now?: () => number } = {},
  ) {
    super(area, AO3_SUMMARY_STATE_KEY, validState, options);
  }
}

/** The attempted AO3 work ids, in the extension's local storage. */
export class StoredAttempted extends StoredAttemptedIds {
  constructor(area: StorageAreaLike | null | undefined) {
    super(area, { key: AO3_SUMMARY_ATTEMPTED_KEY, idPattern: ID_PATTERN, max: ATTEMPTED_MAX });
  }
}

// --- The filler --------------------------------------------------------------

export interface FilledSummary {
  readonly storyId: string;
  readonly summary: string;
}

export interface Ao3SummaryFillPorts {
  readonly clock: { now(): number };
  readonly state: FillStatePort;
  readonly attempted: AttemptedPort;
  readonly tabs: Ao3TabReader;
  /** A number in [0, 1) for shuffling the works to fill. */
  readonly random?: () => number;
  /** The signed-in account, or null when no one is signed in. */
  account(): string | null;
  /** The metadata-contribution preference (`prefMetadataImproveEnabled`). */
  contributionsEnabled(): Promise<boolean>;
  /** The reader's saved AO3 work ids that no one has a summary for; null when unavailable. */
  listGaps(): Promise<readonly string[] | null>;
  /** Sends the summaries of saved works, nothing else. */
  contribute(summaries: readonly FilledSummary[]): Promise<ContributionOutcome>;
}

export interface SavedStory {
  readonly hostKind: string;
  readonly workKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function freshState(account: string): FillState {
  return Object.freeze({
    v: 1,
    account,
    queue: Object.freeze([]),
    listedAt: Number.MIN_SAFE_INTEGER,
    stale: false,
    windowStart: Number.MIN_SAFE_INTEGER,
    reads: 0,
    misses: 0,
    lastRequestAt: Number.MIN_SAFE_INTEGER,
    lastStepAt: Number.MIN_SAFE_INTEGER,
    stop: null,
    last: null,
  });
}

type Work = { readonly kind: "list" } | { readonly kind: "read"; readonly workId: string };

export class Ao3SummaryFill {
  readonly #ports: Ao3SummaryFillPorts;
  #tail: Promise<void> = Promise.resolve();
  /** A step waiting its turn, and the tab it should run in. */
  #queued: Promise<void> | null = null;
  #nextTab: number | null = null;
  #savesInFlight = 0;
  #lastSaveAt = Number.NEGATIVE_INFINITY;
  /** Raised by every sign-out, account change or reset; a step from before writes nothing. */
  #generation = 0;
  /** The generation the running step started in. */
  #runGeneration = 0;

  constructor(ports: Ao3SummaryFillPorts) {
    this.#ports = ports;
  }

  /** A save to Trace is starting. */
  saveStarted(): void {
    this.#savesInFlight += 1;
    this.#lastSaveAt = this.#ports.clock.now();
  }

  /** A save to Trace has ended. */
  saveEnded(): void {
    this.#savesInFlight = Math.max(0, this.#savesInFlight - 1);
    this.#lastSaveAt = this.#ports.clock.now();
  }

  /**
   * A save to Trace was confirmed. Only when its reply says Trace has no
   * summary for the AO3 work (`summary_known: false`) does the work go to
   * the front of the queue, to be read at the next step the pacing allows,
   * in whichever AO3 tab speaks then. A work already tried, from any tab, is
   * not put first again; a later listing still brings it back after the
   * works not tried yet. `account` is the account the save was made for;
   * when another is signed in by the time the work's turn comes, it is
   * dropped.
   */
  storySaved(story: SavedStory, summaryKnown: boolean | undefined, account: string | null): Promise<void> {
    if (summaryKnown !== false || story.hostKind !== "ao3" || account === null) return Promise.resolve();
    const workId = /^ao3:([1-9][0-9]{0,19})$/.exec(story.workKey)?.[1];
    if (workId === undefined) return Promise.resolve();
    return this.#serial(async () => {
      if (this.#ports.account() !== account) return;
      const state = await this.#state();
      if (state === null || state.account !== account || state.queue[0] === workId) return;
      let attempted: readonly string[] = [];
      try {
        attempted = await this.#ports.attempted.read(state.account);
      } catch {
        attempted = [];
      }
      if (!this.#current() || attempted.includes(workId)) return;
      await this.#write(Object.freeze({
        ...state,
        queue: Object.freeze([workId, ...state.queue.filter((id) => id !== workId)].slice(0, QUEUE_MAX)),
      }));
    });
  }

  /**
   * Works were added to the Library some other way (an import of open tabs):
   * the gaps are listed again at the next step allowed.
   */
  libraryChanged(): Promise<void> {
    return this.#serial(async () => {
      const state = await this.#state();
      if (state === null || state.stale) return;
      await this.#write(Object.freeze({ ...state, stale: true }));
    });
  }

  /**
   * An AO3 page spoke to Trace (it loaded, or the reader moved on it): any
   * work due is done now, in that page's tab.
   */
  ao3PageActivity(tabId: number): Promise<void> {
    if (!Number.isSafeInteger(tabId)) return Promise.resolve();
    this.#nextTab = tabId;
    this.#queued ??= this.#serial(async () => {
      this.#queued = null;
      const tab = this.#nextTab;
      this.#nextTab = null;
      if (tab !== null) await this.#step(tab);
    });
    return this.#queued;
  }

  /** The fill's stored state, for a test build's status line. */
  async status(): Promise<FillState | null> {
    try {
      return await this.#ports.state.read();
    } catch {
      return null;
    }
  }

  /** Sign-out or another account: forget everything. */
  async clear(): Promise<void> {
    await this.reset();
    await this.#ports.attempted.clear();
  }

  /** Forgets the session's state (work, counters, stop and record); the tried list stays. */
  async reset(): Promise<void> {
    this.#generation += 1;
    this.#nextTab = null;
    await this.#ports.state.clear();
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(async () => {
      this.#runGeneration = this.#generation;
      try {
        await work();
      } catch {
        // A failed step stops nothing else; the state records any stop.
      }
    });
    this.#tail = run;
    return run;
  }

  /** Whether the running step still belongs to the current sign-in. */
  #current(): boolean {
    return this.#runGeneration === this.#generation;
  }

  /** Writes state only for the current sign-in; false when the step is stale. */
  async #write(state: FillState): Promise<boolean> {
    if (!this.#current()) return false;
    await this.#ports.state.write(state);
    return this.#current();
  }

  /** The session's state for the signed-in account, or null when signed out. */
  async #state(): Promise<FillState | null> {
    const account = this.#ports.account();
    if (account === null) {
      await this.clear();
      return null;
    }
    const stored = await this.#ports.state.read();
    if (!this.#current()) return null;
    if (stored !== null && stored.account === account) return stored;
    // Another account (or none yet): nothing of the previous one is kept.
    await this.#ports.attempted.keepOnly(account).catch(() => undefined);
    const fresh = freshState(account);
    return await this.#write(fresh) ? fresh : null;
  }

  #shuffled<T>(items: readonly T[]): T[] {
    const random = this.#ports.random ?? Math.random;
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [out[index], out[other]] = [out[other]!, out[index]!];
    }
    return out;
  }

  /** What is due now, if anything. */
  #due(state: FillState, now: number): Work | null {
    if (state.stop !== null && now < state.stop.until) return null;
    // Without lasting state the pace and the caps would reset with every
    // background start, so the fill does not run at all.
    if (!this.#ports.state.durable) return null;
    if (this.#savesInFlight > 0 || now - this.#lastSaveAt < SAVE_SETTLE_MS) return null;
    if (now - state.lastRequestAt < REQUEST_GAP_MS) return null;
    if (now - state.lastStepAt < BACKFILL_GAP_MS) return null;
    const sinceListed = now - state.listedAt;
    if (
      (state.stale && sinceListed >= RELIST_MIN_MS) ||
      (state.queue.length === 0 && sinceListed >= RELIST_MS)
    ) {
      return { kind: "list" };
    }
    const head = state.queue[0];
    if (head === undefined) return null;
    if (now - state.windowStart < WINDOW_MS && state.reads >= WINDOW_MAX_READS) return null;
    return { kind: "read", workId: head };
  }

  #last(
    stage: FillStage,
    outcome: string,
    note: FillNote = NO_NOTE,
    extra: { listed?: number; send?: ContributionOutcome } = {},
  ): FillLast {
    return Object.freeze({
      stage,
      outcome,
      ...note,
      listed: extra.listed ?? null,
      send: extra.send ?? null,
      at: this.#ports.clock.now(),
    });
  }

  /** Pauses the fill, with what stopped it; the rest of the work is kept. */
  async #stop(state: FillState, reason: StopReason, note: FillNote, last: FillLast, waitMs: number | null = null): Promise<void> {
    const now = this.#ports.clock.now();
    const pause = Math.min(STOP_MAX_MS, Math.max(STOP_MS, waitMs ?? 0));
    await this.#write(Object.freeze({
      ...state,
      stop: Object.freeze({ reason, ...note, at: now, until: now + pause }),
      last,
    }));
  }

  async #step(tabId: number): Promise<void> {
    const state = await this.#state();
    if (state === null) return;
    const now = this.#ports.clock.now();
    const work = this.#due(state, now);
    if (work === null) return;

    let enabled = false;
    try {
      enabled = await this.#ports.contributionsEnabled();
    } catch {
      enabled = false;
    }
    if (!enabled) {
      // Off: nothing is read, and nothing is kept to read later.
      await this.#write(Object.freeze({
        ...state,
        queue: Object.freeze([]),
        stale: false,
        listedAt: now,
        lastStepAt: now,
        last: this.#last("check", "off"),
      }));
      return;
    }

    if (work.kind === "list") {
      await this.#list(state, now);
      return;
    }

    const tab = await this.#ports.tabs.tabHost(tabId);
    if (!this.#current()) return;
    if ("code" in tab) {
      // The tab cannot be read now; the work waits for another page.
      await this.#write(Object.freeze({ ...state, last: this.#last("check", tab.code) }));
      return;
    }
    await this.#read(state, work.workId, tabId, tab.host, now);
  }

  async #list(state: FillState, now: number): Promise<void> {
    const gaps = await this.#ports.listGaps().catch(() => null);
    if (!this.#current()) return;
    const listedAt: FillState = Object.freeze({ ...state, lastStepAt: now });
    if (gaps === null) {
      await this.#stop(listedAt, "gaps", NO_NOTE, this.#last("gaps", "gaps"));
      return;
    }
    let attempted: readonly string[] = [];
    try {
      attempted = await this.#ports.attempted.read(state.account);
    } catch {
      attempted = [];
    }
    // Works still waiting that the server still lists keep their place (a
    // work a save put first stays first). Then works not tried before, in a
    // random order, so a work that cannot be filled never holds up the
    // others listing after listing.
    const fresh = gaps
      .filter((id) => typeof id === "string" && ID_PATTERN.test(id))
      .filter((id, index, all) => all.indexOf(id) === index);
    const waiting = state.queue.filter((id) => fresh.includes(id) && !attempted.includes(id));
    const queue = [
      ...waiting,
      ...this.#shuffled(fresh.filter((id) => !attempted.includes(id) && !waiting.includes(id))),
      ...fresh.filter((id) => attempted.includes(id))
        .sort((a, b) => attempted.indexOf(a) - attempted.indexOf(b)),
    ].slice(0, QUEUE_MAX);
    // The listing is this step; the first page read waits a step gap.
    await this.#write(Object.freeze({
      ...listedAt,
      queue: Object.freeze(queue),
      listedAt: now,
      stale: false,
      last: this.#last("gaps", "listed", NO_NOTE, { listed: queue.length }),
    }));
  }

  /** This step's one request: the work's first page, for its summary. */
  async #read(state: FillState, workId: string, tabId: number, host: string, now: number): Promise<void> {
    // Whatever comes of it, the work leaves the queue; a later listing
    // brings it back, after the works not tried yet.
    const rest = Object.freeze(state.queue.filter((id) => id !== workId));
    const newWindow = now - state.windowStart >= WINDOW_MS;
    // The request is on record before it is made, so a background started
    // again keeps the pace and the caps.
    const counted: FillState = Object.freeze({
      ...state,
      queue: rest,
      lastRequestAt: now,
      lastStepAt: now,
      windowStart: newWindow ? now : state.windowStart,
      reads: (newWindow ? 0 : state.reads) + 1,
    });
    if (!(await this.#write(counted))) return;
    const answer = await this.#ports.tabs.readWork(tabId, host, workId);
    if (!this.#current()) return;
    const read = classifyAo3Answer(answer, host, workId, this.#ports.clock.now());
    if (read.kind === "tab") {
      // Nothing was asked of the site: the work stays at the front, and the
      // request does not count.
      await this.#write(Object.freeze({
        ...state,
        last: this.#last("work_page", read.code, read.note),
      }));
      return;
    }
    try {
      await this.#ports.attempted.add(state.account, [workId]);
    } catch {
      // Only ordering depends on it.
    }
    if (!this.#current()) return;
    if (read.kind === "stop") {
      await this.#stop(counted, read.reason, read.note, this.#last("work_page", read.reason, read.note), read.waitMs);
      return;
    }
    if (read.kind === "skip") {
      const misses = read.outcome === "unreadable" ? counted.misses + 1 : 0;
      const next: FillState = Object.freeze({ ...counted, misses });
      if (misses >= MISSES_MAX) {
        await this.#stop(
          Object.freeze({ ...next, misses: 0 }),
          "missing",
          read.note,
          this.#last("work_page", "missing", read.note),
        );
        return;
      }
      await this.#write(Object.freeze({ ...next, last: this.#last("work_page", read.outcome, read.note) }));
      return;
    }
    const found: FilledSummary = Object.freeze({ storyId: workId, summary: read.summary });
    const filled: FillState = Object.freeze({ ...counted, misses: 0 });
    if (!(await this.#write(filled))) return;
    if (this.#ports.account() !== state.account || !this.#current()) return;
    let outcome: ContributionOutcome = "failed";
    try {
      outcome = await this.#ports.contribute([found]);
    } catch {
      outcome = "failed";
    }
    if (!this.#current()) return;
    const last = this.#last("send", outcome === "accepted" ? "filled" : "send", read.note, { send: outcome });
    if (outcome !== "accepted") {
      await this.#stop(filled, "send", read.note, last);
      return;
    }
    await this.#write(Object.freeze({ ...filled, last }));
  }
}
