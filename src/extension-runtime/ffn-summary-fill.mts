/**
 * FanFiction.net summaries for stories saved from a page that shows none.
 *
 * On iPhone, FanFiction.net serves its mobile layout for a story (at www and
 * at m.), and that layout has no summary, so a story saved there reaches the
 * Library without one. The author's story list (`/u/<author>/?a=s`) shows
 * every story of theirs with its summary. This reads that list and sends only
 * the summaries, as a metadata contribution for stories already in the
 * reader's Library.
 *
 * Every page is read inside the reader's own FanFiction.net tab, as a
 * same-site request from that page, so the reader's own session and the
 * site's own check of their browser apply. Nothing is read from the
 * background itself, and no tab, frame or page is opened.
 *
 * Nothing waits on a timer. On iPhone Safari unloads the background within
 * about a minute and its timers with it, so the work still to do is kept in
 * session-only storage (or, without it, local storage that expires) and
 * picked up whenever a FanFiction.net page speaks to Trace:
 *
 * - On save: a story newly saved from an FFN story page with no summary is
 *   added to the work. The save names the story's author, so its author's
 *   list is one request; when it did not, the story's own page is read first
 *   for the author, and the list at a later turn.
 * - Backfill: the reader's other saved FFN stories that no one has a summary
 *   for (the server lists at most 50) are read one request at a time, minutes
 *   apart, only while the reader is on FanFiction.net, never during or just
 *   after a save, and a few requests per browsing session. One author's list
 *   fills every waiting story of theirs on it.
 *
 * It stays polite and leaves nothing behind: one request at a time, at least
 * 30 s apart (the time of the last one is stored, so a background started
 * again keeps the pace); page text is read only as far as needed and then
 * dropped; nothing is cached. A challenge page, refusal, unexpected address,
 * unreadable page or error pauses it for an hour, then it tries once more;
 * what stopped it is recorded (reason, status, host, kind of page,
 * `cf-mitigated`, time), never page text. A story FanFiction.net says is
 * gone, or that is missing from its author's first page of stories, is
 * skipped. The state is story and author ids, counters and those records; it
 * and the ids of up to 200 stories already tried are removed on sign-out or
 * when the account changes.
 */

import {
  StoredAttemptedIds,
  StoredSessionState,
  type AttemptedPort,
  type SessionStatePort,
  type StorageAreaLike,
} from "./summary-fill-storage.mjs";

export const FFN_SUMMARY_STATE_KEY = "traceFfnSummaryFillV1";
export const FFN_SUMMARY_ATTEMPTED_KEY = "traceFfnSummaryAttemptedV1";

/** Least time between two reads of a FanFiction.net page. */
export const REQUEST_GAP_MS = 30_000;
/** The backfill waits this long after a save before it reads. */
export const SAVE_SETTLE_MS = 20_000;
/** Least time between two backfill steps. */
export const BACKFILL_GAP_MS = 3 * 60_000;
/** Backfill requests per browsing session. */
export const BACKFILL_MAX_PER_SESSION = 10;
/** Requests made for saves, per browsing session. */
export const ON_SAVE_MAX_PER_SESSION = 30;
/** How long a challenge or failure pauses the fill before one more try. */
export const STOP_MS = 60 * 60_000;
/** Saves waiting to be read, at most. */
export const PENDING_MAX = 5;
/** A waiting save is dropped after this many failed reads. */
export const PENDING_TRIES_MAX = 2;
/** Stories kept for the backfill, at most. */
export const QUEUE_MAX = 50;
/** Without session storage, the state is kept in local storage this long. */
export const LOCAL_STATE_TTL_MS = 12 * 60 * 60_000;
/** A page a FanFiction.net tab spoke from this recently is used for a save's read. */
export const RECENT_TAB_MS = 2 * 60_000;
/** Stories already tried, remembered across sessions so each tries others. */
export const ATTEMPTED_MAX = 200;
export const TAB_READ_TIMEOUT_MS = 15_000;
/** No page is read in the tab further than this. */
export const MAX_TAB_READ_BYTES = 2 * 1_024 * 1_024;
/** Page text handed from the tab to the background, at most. */
export const MAX_RETURN_CHARS = 256 * 1_024;
const ROW_MAX_CHARS = 8_192;
const SUMMARY_MAX_CHARS = 4_000;
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const FFN_HOSTS: readonly string[] = Object.freeze(["www.fanfiction.net", "m.fanfiction.net"]);
const RECENT_MAX = 50;

// --- Reading page text ---------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
});

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function plainText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The class names on a start tag. FanFiction.net writes attributes quoted
 * with either quote and unquoted (`<div class=gray>`), so all three count.
 */
function classTokens(startTag: string): readonly string[] {
  const value = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(startTag);
  return (value?.[1] ?? value?.[2] ?? value?.[3] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

const STORY_CONTENT_PATTERN = /<div\b[^>]*\bid\s*=\s*["']?(?:content|profile_top)\b[^>]*>/i;
const AUTHOR_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']?[^"'\s>]*\/u\/([1-9][0-9]{0,19})(?:[/?#"'\s>])/i;
const STORY_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']?[^"'\s>]*\/s\/([1-9][0-9]{0,19})\/[^>]*>/i;
const DIV_START_PATTERN = /<div\b[^>]*>/gi;

/**
 * The author's id on a FanFiction.net story page: the first author link
 * (`/u/<id>/`) in the story's own block (`#content` on the mobile layout,
 * `#profile_top` on the desktop one). Links before that block, such as the
 * signed-in reader's own profile, are never read.
 */
export function ffnAuthorIdFromStoryHtml(html: string): string | null {
  if (typeof html !== "string") return null;
  const content = STORY_CONTENT_PATTERN.exec(html);
  if (content === null) return null;
  const block = html.slice(content.index, content.index + ROW_MAX_CHARS);
  return AUTHOR_LINK_PATTERN.exec(block)?.[1] ?? null;
}

type RowKind = "mobile" | "desktop";

/** The first `<div>` in `markup` carrying every class named, or null. */
function divWithClasses(markup: string, names: readonly string[]): { index: number; end: number } | null {
  const pattern = new RegExp(DIV_START_PATTERN.source, "gi");
  for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
    const classes = classTokens(match[0]);
    if (names.every((name) => classes.includes(name))) {
      return { index: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

function summaryFromRow(row: string, kind: RowKind): string | null {
  if (kind === "mobile") {
    // The summary is the text after the row's last link, before its gray
    // details line.
    const gray = divWithClasses(row, ["gray"]);
    if (gray === null) return null;
    const beforeGray = row.slice(0, gray.index);
    const lastLinkEnd = beforeGray.toLowerCase().lastIndexOf("</a>");
    return lastLinkEnd === -1 ? "" : plainText(beforeGray.slice(lastLinkEnd + 4));
  }
  // The desktop layout keeps the summary in its own block, before the
  // details line inside it.
  const indent = divWithClasses(row, ["z-indent"]);
  if (indent === null) return null;
  const inside = row.slice(indent.end);
  const details = divWithClasses(inside, ["z-padtop2"]) ?? divWithClasses(inside, ["xgray"]);
  if (details === null) return null;
  return plainText(inside.slice(0, details.index));
}

/**
 * The stories on a FanFiction.net story list: an author's own stories, or
 * any list in the same rows. Reads the mobile layout (each row a `div.bs`,
 * www and m. alike on a phone) and the desktop one (each of the author's own
 * stories a `div.z-list.mystories`; their favourites are not read). A bounded
 * string read: no DOM and no rendering. Returns the summaries it could read,
 * by story id, and how many story rows the page had.
 */
export function ffnSummariesFromStoryListHtml(html: string): {
  readonly rows: number;
  readonly summaries: ReadonlyMap<string, string>;
} {
  const summaries = new Map<string, string>();
  if (typeof html !== "string") return { rows: 0, summaries };
  const starts: { index: number; kind: RowKind }[] = [];
  const pattern = new RegExp(DIV_START_PATTERN.source, "gi");
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const classes = classTokens(match[0]);
    if (classes.includes("bs")) starts.push({ index: match.index, kind: "mobile" });
    else if (classes.includes("z-list") && classes.includes("mystories")) {
      starts.push({ index: match.index, kind: "desktop" });
    }
  }
  let rows = 0;
  starts.forEach((start, index) => {
    const end = Math.min(starts[index + 1]?.index ?? html.length, start.index + ROW_MAX_CHARS);
    const row = html.slice(start.index, end);
    const story = STORY_LINK_PATTERN.exec(row);
    if (story === null) return;
    const summary = summaryFromRow(row, start.kind);
    if (summary === null) return;
    rows += 1;
    const storyId = story[1]!;
    const text = summary.slice(0, SUMMARY_MAX_CHARS);
    if (text && !summaries.has(storyId)) summaries.set(storyId, text);
  });
  return { rows, summaries };
}

/**
 * FanFiction.net's answer for a story that is gone (deleted, or never
 * existed): a normal page saying so. Such a story is skipped, not a reason
 * to stop.
 */
export function isFfnStoryNotFoundPage(html: string): boolean {
  if (typeof html !== "string") return false;
  // Only FanFiction.net's own warning box counts, never the words elsewhere.
  const warning = /<[^>]*\bclass\s*=\s*["']?[^"'>]*\bgui_warning\b[^>]*>([\s\S]{0,400})/i.exec(html);
  const text = warning?.[1] ?? "";
  return /Story\s+Not\s+Found/i.test(text) || /Unable\s+to\s+locate\s+story/i.test(text);
}

/** Whether a page is a Cloudflare (or similar) check instead of the page asked for. */
export function isChallengePage(html: string, headers?: { get(name: string): string | null }): boolean {
  if (headers?.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  const head = html.slice(0, 8_192);
  return /<title>\s*(?:just a moment|attention required|please wait)/i.test(head) ||
    /\/cdn-cgi\/challenge-platform\//i.test(head) ||
    /\bcf[-_]chl[-_]/i.test(head) ||
    /\bchallenge-form\b/i.test(head);
}

// --- One page, read in the reader's tab ------------------------------------------

/** What a read in the tab came back with. */
export type TabRead =
  | {
      readonly kind: "response";
      readonly status: number;
      /** Where the request ended, after any redirect. */
      readonly url: string;
      readonly html: string;
      readonly contentType: string | null;
      readonly cfMitigated: string | null;
    }
  | { readonly kind: "failed"; readonly code: TabFailCode };

/**
 * Why there was no answer. `timeout` and `network` mean a request may have
 * been made; the others mean none was.
 */
export type TabFailCode =
  | "tab_gone"
  | "tab_not_ffn"
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

export type PathType = "author" | "story" | "other";

/** What is recorded about an answer: never page text. */
export interface FillNote {
  readonly status: number | null;
  readonly host: string | null;
  readonly path: PathType | null;
  readonly cf: string | null;
}

const NO_NOTE: FillNote = Object.freeze({ status: null, host: null, path: null, cf: null });

export function ffnPathType(pathname: string): PathType {
  if (/^\/u\/[1-9][0-9]{0,19}(?:\/|$)/.test(pathname)) return "author";
  if (/^\/s\/[1-9][0-9]{0,19}(?:\/|$)/.test(pathname)) return "story";
  return "other";
}

function cfNote(value: string | null): string | null {
  if (value === null || value === "") return null;
  const lower = value.trim().toLowerCase();
  return /^[a-z_-]{1,20}$/.test(lower) ? lower : "other";
}

export type Classified =
  | { readonly kind: "page"; readonly html: string; readonly note: FillNote }
  | { readonly kind: "stop"; readonly reason: StopReason; readonly note: FillNote }
  /** The tab could not be used; nothing was asked of the site. */
  | { readonly kind: "tab"; readonly code: TabFailCode; readonly note: FillNote };

/**
 * Whether a read in the tab is the page asked for: an HTML 200 on the tab's
 * own host at the address asked for, not a challenge.
 */
export function classifyFfnAnswer(
  answer: TabRead,
  host: string,
  expectedPath: (pathname: string) => boolean,
  requestedPath: PathType,
): Classified {
  if (answer.kind === "failed") {
    const note = { ...NO_NOTE, host, path: requestedPath };
    return answer.code === "timeout" || answer.code === "network"
      ? { kind: "stop", reason: "error", note }
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
    path: landed !== null ? ffnPathType(landed.pathname) : requestedPath,
    cf: cfNote(answer.cfMitigated),
  };
  if (note.cf === "challenge") return { kind: "stop", reason: "challenge", note };
  if (
    landed === null ||
    landed.protocol !== "https:" ||
    landed.hostname !== host ||
    !expectedPath(landed.pathname)
  ) {
    return { kind: "stop", reason: isChallengePage(answer.html) ? "challenge" : "redirect", note };
  }
  if (answer.status !== 200) {
    return { kind: "stop", reason: isChallengePage(answer.html) ? "challenge" : "status", note };
  }
  if (!/text\/html/i.test(answer.contentType ?? "")) return { kind: "stop", reason: "not_html", note };
  if (isChallengePage(answer.html)) return { kind: "stop", reason: "challenge", note };
  return { kind: "page", html: answer.html, note };
}

/**
 * Reads one same-site FanFiction.net page inside the reader's tab. Runs in
 * the page, so it must use nothing from outside this function. The request
 * carries the tab's own cookies and Safari's own headers; the page is read
 * only as far as `maxBytes`, and only `maxChars` of it come back.
 */
async function readFfnPageInTab(host: string, path: string, maxBytes: number, maxChars: number): Promise<unknown> {
  // The tab moved on: nothing is asked of another site.
  if (location.protocol !== "https:" || location.hostname !== host) return { ok: false, error: "moved" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://${host}${path}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
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
          text += decoder.decode(chunk.value, { stream: true });
          if (bytes >= maxBytes) break;
        }
      } finally {
        // The rest of the page is never downloaded.
        reader.cancel().catch(() => undefined);
      }
    } else if (body) {
      body.cancel().catch(() => undefined);
    }
    // The desktop layout lists the author's favourites before their own
    // stories, so what comes back starts at the first of their own.
    const own = text.search(/<div\b[^>]*\bclass\s*=\s*["']?z-list mystories\b/i);
    const html = text.slice(Math.max(0, own), Math.max(0, own) + maxChars);
    return {
      ok: true,
      status: response.status,
      url: response.url,
      html,
      contentType,
      cfMitigated: response.headers.get("cf-mitigated"),
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 200) : null;
}

export interface TabReaderEnvironment {
  /** `tabs.get`, `scripting.executeScript` and `permissions.contains`, already promised. */
  getTab(tabId: number): Promise<unknown>;
  executeScript(details: Record<string, unknown>): Promise<unknown>;
  containsOrigin(origin: string): Promise<boolean>;
  readonly hasScripting: boolean;
  readonly timeoutMs?: number;
}

export interface FfnTabReader {
  /** The tab's FanFiction.net host when a page may be read in it now. */
  tabHost(tabId: number): Promise<{ readonly host: string } | { readonly code: TabFailCode }>;
  readInTab(tabId: number, host: string, path: string): Promise<TabRead>;
}

/** Reads FanFiction.net pages in the reader's own tab, through `scripting`. */
export function createFfnTabReader(environment: TabReaderEnvironment): FfnTabReader {
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
      if (!isRecord(tab) || typeof tab.url !== "string") return { code: "tab_not_ffn" };
      let url: URL;
      try {
        url = new URL(tab.url);
      } catch {
        return { code: "tab_not_ffn" };
      }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !FFN_HOSTS.includes(host)) return { code: "tab_not_ffn" };
      // Only where the reader has allowed Trace on the site itself.
      const allowed = await environment.containsOrigin(`https://${host}/*`).catch(() => false);
      return allowed ? { host } : { code: "not_allowed" };
    },
    async readInTab(tabId, host, path) {
      let results: unknown;
      try {
        results = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => resolve("timeout"), timeoutMs);
          environment.executeScript({
            target: { tabId, frameIds: [0] },
            func: readFfnPageInTab,
            args: [host, path, MAX_TAB_READ_BYTES, MAX_RETURN_CHARS],
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
        if (result.error === "moved") return { kind: "failed", code: "tab_not_ffn" };
        return { kind: "failed", code: result.error === "timeout" ? "timeout" : "network" };
      }
      if (typeof result.status !== "number" || typeof result.url !== "string" || typeof result.html !== "string") {
        return { kind: "failed", code: "no_result" };
      }
      return {
        kind: "response",
        status: result.status,
        url: result.url,
        html: result.html.slice(0, MAX_RETURN_CHARS),
        contentType: stringOrNull(result.contentType),
        cfMitigated: stringOrNull(result.cfMitigated),
      };
    },
  };
}

// --- State ------------------------------------------------------------------------

export interface StoryToFill {
  /** The story's FanFiction.net id. */
  readonly s: string;
  /** Its author's id, once known. */
  readonly a?: string;
  /** Failed reads so far (waiting saves only). */
  readonly n?: number;
}

export type FillTrigger = "save" | "page";
export type FillStage = "check" | "gaps" | "story_page" | "author_list" | "send";

export type ContributionOutcome = "accepted" | "skipped" | "failed";

/** Why the fill stopped, kept until it may try again. */
export interface FillStop extends FillNote {
  readonly reason: StopReason;
  readonly at: number;
  readonly until: number;
}

/** What the last step did. */
export interface FillLast extends FillNote {
  readonly trigger: FillTrigger;
  readonly stage: FillStage;
  /** What came of it, or why it stopped. */
  readonly outcome: string;
  /** Story rows on the author's list. */
  readonly rows: number | null;
  /** Summaries found for the stories asked for. */
  readonly found: number | null;
  readonly send: ContributionOutcome | null;
  readonly at: number;
}

export interface FillState {
  readonly v: 3;
  /** The account the state belongs to (`accountId:epoch`). */
  readonly account: string;
  /** Saves still to read, oldest first, at most `PENDING_MAX`. */
  readonly pending: readonly StoryToFill[];
  /** Stories for the backfill, at most `QUEUE_MAX`. */
  readonly queue: readonly StoryToFill[];
  readonly listed: boolean;
  readonly backfills: number;
  readonly saves: number;
  /** When a page was last read: no other read within `REQUEST_GAP_MS`. */
  readonly lastRequestAt: number;
  /** When the backfill last took a step. */
  readonly lastBackfillAt: number;
  readonly stop: FillStop | null;
  readonly last: FillLast | null;
  /** When local-storage state expires (absent in session storage). */
  readonly exp?: number;
}

export type FillStatePort = SessionStatePort<FillState>;

export type { AttemptedPort };

/** The attempted FanFiction.net story ids, in the extension's local storage. */
export class StoredAttempted extends StoredAttemptedIds {
  constructor(area: StorageAreaLike | null | undefined) {
    super(area, { key: FFN_SUMMARY_ATTEMPTED_KEY, idPattern: ID_PATTERN, max: ATTEMPTED_MAX });
  }
}

const CODE_PATTERN = /^[a-z_]{1,32}$/;

function validStory(value: unknown, withTries: boolean): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) => key === "s" || key === "a" || (withTries && key === "n")) &&
    typeof value.s === "string" &&
    ID_PATTERN.test(value.s) &&
    (value.a === undefined || (typeof value.a === "string" && ID_PATTERN.test(value.a))) &&
    (value.n === undefined || (Number.isSafeInteger(value.n) && (value.n as number) >= 0))
  );
}

function validNote(value: Record<string, unknown>): boolean {
  return (
    (value.status === null || Number.isSafeInteger(value.status)) &&
    (value.host === null || (typeof value.host === "string" && /^[a-z0-9.-]{1,80}$/.test(value.host))) &&
    (value.path === null || value.path === "author" || value.path === "story" || value.path === "other") &&
    (value.cf === null || (typeof value.cf === "string" && /^[a-z_-]{1,20}$/.test(value.cf)))
  );
}

const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

function validStop(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value) && validNote(value) && typeof value.reason === "string" &&
    CODE_PATTERN.test(value.reason) && finite(value.at) && finite(value.until);
}

function validLast(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value) && validNote(value) &&
    (value.trigger === "save" || value.trigger === "page") &&
    typeof value.stage === "string" && CODE_PATTERN.test(value.stage) &&
    typeof value.outcome === "string" && CODE_PATTERN.test(value.outcome) &&
    (value.rows === null || Number.isSafeInteger(value.rows)) &&
    (value.found === null || Number.isSafeInteger(value.found)) &&
    (value.send === null || value.send === "accepted" || value.send === "skipped" || value.send === "failed") &&
    finite(value.at);
}

function validState(value: unknown): FillState | null {
  if (!isRecord(value)) return null;
  if (
    value.v !== 3 ||
    typeof value.account !== "string" ||
    !Array.isArray(value.pending) ||
    value.pending.length > PENDING_MAX ||
    !value.pending.every((item) => validStory(item, true)) ||
    !Array.isArray(value.queue) ||
    value.queue.length > QUEUE_MAX ||
    !value.queue.every((item) => validStory(item, false)) ||
    typeof value.listed !== "boolean" ||
    !Number.isSafeInteger(value.backfills) ||
    !Number.isSafeInteger(value.saves) ||
    !finite(value.lastRequestAt) ||
    !finite(value.lastBackfillAt) ||
    !validStop(value.stop) ||
    !validLast(value.last) ||
    (value.exp !== undefined && !finite(value.exp))
  ) {
    return null;
  }
  return value as unknown as FillState;
}

/**
 * The FanFiction.net fill's state in one storage area (see
 * `StoredSessionState`): session-only storage where the browser has it,
 * otherwise local storage that expires.
 */
export class StoredFillState extends StoredSessionState<FillState> {
  constructor(
    area: StorageAreaLike | null | undefined,
    options: { readonly ttlMs?: number; readonly now?: () => number } = {},
  ) {
    super(area, FFN_SUMMARY_STATE_KEY, validState, options);
  }
}

// --- The filler --------------------------------------------------------------

export interface FilledSummary {
  readonly storyId: string;
  readonly summary: string;
}

export interface FfnSummaryFillPorts {
  readonly clock: { now(): number };
  readonly state: FillStatePort;
  readonly attempted: AttemptedPort;
  readonly tabs: FfnTabReader;
  /** A number in [0, 1) for shuffling the stories to fill. */
  readonly random?: () => number;
  /** The signed-in account, or null when no one is signed in. */
  account(): string | null;
  /** The metadata-contribution preference (`prefMetadataImproveEnabled`). */
  contributionsEnabled(): Promise<boolean>;
  /** The reader's saved FFN story ids that no one has a summary for; null when unavailable. */
  listGaps(): Promise<readonly string[] | null>;
  /** Sends the summaries of saved stories, nothing else. */
  contribute(summaries: readonly FilledSummary[]): Promise<ContributionOutcome>;
}

export interface SavedStory {
  readonly hostKind: string;
  readonly workKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The story's author on FanFiction.net, as its own page linked it. */
  readonly ffnAuthorId?: string;
}

function freshState(account: string): FillState {
  return Object.freeze({
    v: 3,
    account,
    pending: Object.freeze([]),
    queue: Object.freeze([]),
    listed: false,
    backfills: 0,
    saves: 0,
    lastRequestAt: Number.MIN_SAFE_INTEGER,
    lastBackfillAt: Number.MIN_SAFE_INTEGER,
    stop: null,
    last: null,
  });
}

function storyIdFromWorkKey(workKey: string): string | null {
  const match = /^ffn:([1-9][0-9]{0,19})$/.exec(workKey);
  return match?.[1] ?? null;
}

type Work =
  | { readonly kind: "list" }
  | { readonly kind: "read"; readonly from: "pending" | "queue"; readonly story: StoryToFill };

export class FfnSummaryFill {
  readonly #ports: FfnSummaryFillPorts;
  #tail: Promise<void> = Promise.resolve();
  /** A step waiting its turn, and what it should run with. */
  #queued: Promise<void> | null = null;
  #next: { trigger: FillTrigger; tabId: number } | null = null;
  #savesInFlight = 0;
  #lastSaveAt = Number.NEGATIVE_INFINITY;
  /** The FanFiction.net tab that last spoke to Trace, and when. */
  #tab: { id: number; at: number } | null = null;
  /** Raised by every sign-out, account change or reset; a step from before writes nothing. */
  #generation = 0;
  /** The generation the running step started in. */
  #runGeneration = 0;
  /** Stories added on save in this background's lifetime, so a later chapter does not add again. */
  readonly #recent: string[] = [];

  constructor(ports: FfnSummaryFillPorts) {
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
   * A save to Trace was confirmed. When it was a new FFN story saved from a
   * story page that showed no summary, its read is added to the stored work
   * and tried now in the tab it was saved from, when there is one.
   */
  storySaved(story: SavedStory, alreadyInLibrary: boolean, tabId?: number): Promise<void> {
    if (story.hostKind !== "ffn" || alreadyInLibrary) return Promise.resolve();
    const item = story.payload.item as Record<string, unknown> | undefined;
    if (item === undefined || item === null || typeof item !== "object" || item.ctx !== "story") {
      return Promise.resolve();
    }
    if (typeof item.sm === "string" && item.sm.trim().length > 0) return Promise.resolve();
    const storyId = storyIdFromWorkKey(story.workKey);
    if (storyId === null || this.#recent.includes(storyId)) return Promise.resolve();
    const authorId = typeof story.ffnAuthorId === "string" && ID_PATTERN.test(story.ffnAuthorId)
      ? story.ffnAuthorId
      : undefined;
    this.#recent.push(storyId);
    if (this.#recent.length > RECENT_MAX) this.#recent.shift();
    const tab = typeof tabId === "number" && Number.isSafeInteger(tabId) ? tabId : this.#recentTab();
    return this.#serial(() => this.#addPending(storyId, authorId))
      .then(() => (tab === null ? undefined : this.#kick("save", tab)));
  }

  /**
   * A FanFiction.net page spoke to Trace (it loaded, or the reader moved on
   * it): any work due is done now, in that page's tab.
   */
  ffnPageActivity(tabId: number): Promise<void> {
    if (!Number.isSafeInteger(tabId)) return Promise.resolve();
    this.#tab = { id: tabId, at: this.#ports.clock.now() };
    return this.#kick("page", tabId);
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
    this.#recent.length = 0;
    this.#tab = null;
    await this.#ports.state.clear();
  }

  #recentTab(): number | null {
    if (this.#tab === null) return null;
    return this.#ports.clock.now() - this.#tab.at <= RECENT_TAB_MS ? this.#tab.id : null;
  }

  /** Runs a step in `tabId`; steps asked for while one waits share it. */
  #kick(trigger: FillTrigger, tabId: number): Promise<void> {
    // A save's step outranks a page's: it is the one with work.
    if (this.#next === null || trigger === "save" || this.#next.trigger !== "save") {
      this.#next = { trigger, tabId };
    }
    this.#queued ??= this.#serial(async () => {
      this.#queued = null;
      const next = this.#next;
      this.#next = null;
      if (next !== null) await this.#step(next.trigger, next.tabId);
    });
    return this.#queued;
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

  /** Remembers stories tried, for the signed-in account only. */
  async #attempt(state: FillState, storyIds: readonly string[]): Promise<void> {
    if (!this.#current() || storyIds.length === 0) return;
    try {
      await this.#ports.attempted.add(state.account, storyIds);
    } catch {
      // Only ordering depends on it.
    }
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

  async #addPending(storyId: string, authorId: string | undefined): Promise<void> {
    const state = await this.#state();
    if (state === null) return;
    const known = state.pending.find(({ s }) => s === storyId);
    if (known !== undefined && (known.a !== undefined || authorId === undefined)) return;
    if (known === undefined && state.pending.length >= PENDING_MAX) return;
    const entry: StoryToFill = Object.freeze({
      s: storyId,
      ...(authorId === undefined ? {} : { a: authorId }),
      ...(known?.n === undefined ? {} : { n: known.n }),
    });
    const pending = known === undefined
      ? [...state.pending, entry]
      : state.pending.map((story) => (story.s === storyId ? entry : story));
    await this.#write(Object.freeze({
      ...state,
      pending: Object.freeze(pending),
      // A save's read comes first; the backfill does not read it again.
      queue: Object.freeze(state.queue.filter(({ s }) => s !== storyId)),
    }));
  }

  /** What is due now, if anything. */
  #due(state: FillState, now: number): Work | null {
    if (state.stop !== null && now < state.stop.until) return null;
    if (now - state.lastRequestAt < REQUEST_GAP_MS) return null;
    if (this.#savesInFlight > 0) return null;
    const waiting = state.pending[0];
    if (waiting !== undefined && state.saves < ON_SAVE_MAX_PER_SESSION) {
      return { kind: "read", from: "pending", story: waiting };
    }
    // Without lasting state the session's caps would reset with every
    // background start, so the backfill does not run at all.
    if (!this.#ports.state.durable) return null;
    if (now - this.#lastSaveAt < SAVE_SETTLE_MS) return null;
    if (state.backfills >= BACKFILL_MAX_PER_SESSION) return null;
    if (now - state.lastBackfillAt < BACKFILL_GAP_MS) return null;
    if (!state.listed) return { kind: "list" };
    const head = state.queue[0];
    return head === undefined ? null : { kind: "read", from: "queue", story: head };
  }

  #last(
    trigger: FillTrigger,
    stage: FillStage,
    outcome: string,
    note: FillNote = NO_NOTE,
    extra: { rows?: number; found?: number; send?: ContributionOutcome } = {},
  ): FillLast {
    return Object.freeze({
      trigger,
      stage,
      outcome,
      ...note,
      rows: extra.rows ?? null,
      found: extra.found ?? null,
      send: extra.send ?? null,
      at: this.#ports.clock.now(),
    });
  }

  /** Pauses the fill for `STOP_MS`, with what stopped it; the work is kept. */
  async #stop(
    state: FillState,
    work: Work,
    reason: StopReason,
    note: FillNote,
    last: FillLast,
  ): Promise<void> {
    const now = this.#ports.clock.now();
    let pending = state.pending;
    if (work.kind === "read" && work.from === "pending") {
      // A save that failed twice is given up; the backfill may find it later.
      const tries = (work.story.n ?? 0) + 1;
      pending = tries >= PENDING_TRIES_MAX
        ? state.pending.filter(({ s }) => s !== work.story.s)
        : state.pending.map((story) => (story.s === work.story.s ? Object.freeze({ ...story, n: tries }) : story));
    }
    await this.#write(Object.freeze({
      ...state,
      pending: Object.freeze(pending),
      stop: Object.freeze({ reason, ...note, at: now, until: now + STOP_MS }),
      last,
    }));
  }

  async #step(trigger: FillTrigger, tabId: number): Promise<void> {
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
        pending: Object.freeze([]),
        queue: Object.freeze([]),
        listed: false,
        lastBackfillAt: now,
        last: this.#last(trigger, "check", "off"),
      }));
      return;
    }

    if (work.kind === "list") {
      await this.#list(state, trigger, now);
      return;
    }

    const tab = await this.#ports.tabs.tabHost(tabId);
    if (!this.#current()) return;
    if ("code" in tab) {
      // The tab cannot be read now; the work waits for another page.
      await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "check", tab.code) }));
      return;
    }
    // The request is on record before it is made, so a background started
    // again keeps the pace and the caps.
    const counted: FillState = Object.freeze({
      ...state,
      lastRequestAt: now,
      ...(work.from === "pending"
        ? { saves: state.saves + 1 }
        : { backfills: state.backfills + 1, lastBackfillAt: now }),
    });
    if (!(await this.#write(counted))) return;
    if (work.story.a === undefined) {
      await this.#lookUpAuthor(counted, work, trigger, tabId, tab.host);
    } else {
      await this.#readAuthor(counted, work, work.story.a, trigger, tabId, tab.host);
    }
  }

  async #list(state: FillState, trigger: FillTrigger, now: number): Promise<void> {
    const gaps = await this.#ports.listGaps().catch(() => null);
    if (!this.#current()) return;
    const listedAt: FillState = Object.freeze({ ...state, lastBackfillAt: now });
    if (gaps === null) {
      await this.#stop(listedAt, { kind: "list" }, "gaps", NO_NOTE, this.#last(trigger, "gaps", "gaps"));
      return;
    }
    let attempted: readonly string[] = [];
    try {
      attempted = await this.#ports.attempted.read(state.account);
    } catch {
      attempted = [];
    }
    // Stories not tried before come first, in a random order, so a story
    // that cannot be filled never holds up the others session after session.
    const waiting = new Set(state.pending.map(({ s }) => s));
    const fresh = gaps
      .filter((id) => typeof id === "string" && ID_PATTERN.test(id))
      .filter((id, index, all) => all.indexOf(id) === index && !waiting.has(id) && !this.#recent.includes(id));
    const queue = [
      ...this.#shuffled(fresh.filter((id) => !attempted.includes(id))),
      ...fresh.filter((id) => attempted.includes(id))
        .sort((a, b) => attempted.indexOf(a) - attempted.indexOf(b)),
    ]
      .slice(0, QUEUE_MAX)
      .map((s) => Object.freeze({ s }));
    // The list is this step; the first page read waits a backfill gap.
    await this.#write(Object.freeze({
      ...listedAt,
      listed: true,
      queue: Object.freeze(queue),
      last: this.#last(trigger, "gaps", "listed", NO_NOTE, { rows: queue.length }),
    }));
  }

  /** Drops stories from the work, wherever they wait. */
  #without(state: FillState, storyIds: ReadonlySet<string>): FillState {
    return Object.freeze({
      ...state,
      pending: Object.freeze(state.pending.filter(({ s }) => !storyIds.has(s))),
      queue: Object.freeze(state.queue.filter(({ s }) => !storyIds.has(s))),
    });
  }

  /** This step's one request: the story's own page, for its author. */
  async #lookUpAuthor(state: FillState, work: Extract<Work, { kind: "read" }>, trigger: FillTrigger, tabId: number, host: string): Promise<void> {
    const storyId = work.story.s;
    await this.#attempt(state, [storyId]);
    const answer = await this.#ports.tabs.readInTab(tabId, host, `/s/${storyId}/1/`);
    if (!this.#current()) return;
    const read = classifyFfnAnswer(
      answer,
      host,
      (pathname) => pathname === `/s/${storyId}` || pathname.startsWith(`/s/${storyId}/`),
      "story",
    );
    if (read.kind === "tab") {
      await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "story_page", read.code, read.note) }));
      return;
    }
    if (read.kind === "stop") {
      await this.#stop(state, work, read.reason, read.note, this.#last(trigger, "story_page", read.reason, read.note));
      return;
    }
    const authorId = ffnAuthorIdFromStoryHtml(read.html);
    if (authorId === null) {
      if (isFfnStoryNotFoundPage(read.html)) {
        // The story is gone from FanFiction.net: skip it, carry on.
        await this.#write(Object.freeze({
          ...this.#without(state, new Set([storyId])),
          last: this.#last(trigger, "story_page", "gone", read.note),
        }));
        return;
      }
      await this.#stop(state, work, "missing", read.note, this.#last(trigger, "story_page", "missing", read.note));
      return;
    }
    // The author's list is read at a later turn, at least a request gap on.
    const named = (story: StoryToFill) => (story.s === storyId ? Object.freeze({ ...story, a: authorId }) : story);
    await this.#write(Object.freeze({
      ...state,
      pending: Object.freeze(state.pending.map(named)),
      queue: Object.freeze(state.queue.map(named)),
      last: this.#last(trigger, "story_page", "author_found", read.note),
    }));
  }

  /**
   * Reads one author's story list and sends the summaries of every waiting
   * story of theirs on it.
   */
  async #readAuthor(
    state: FillState,
    work: Extract<Work, { kind: "read" }>,
    authorId: string,
    trigger: FillTrigger,
    tabId: number,
    host: string,
  ): Promise<void> {
    const storyIds = [
      work.story.s,
      ...[...state.pending, ...state.queue]
        .filter(({ s, a }) => a === authorId && s !== work.story.s)
        .map(({ s }) => s),
    ].filter((id, index, all) => all.indexOf(id) === index);
    // Every story asked for counts as tried, found on the page or not.
    await this.#attempt(state, storyIds);
    const answer = await this.#ports.tabs.readInTab(tabId, host, `/u/${authorId}/?a=s`);
    if (!this.#current()) return;
    const read = classifyFfnAnswer(
      answer,
      host,
      (pathname) => pathname === `/u/${authorId}` || pathname.startsWith(`/u/${authorId}/`),
      "author",
    );
    if (read.kind === "tab") {
      await this.#write(Object.freeze({ ...state, last: this.#last(trigger, "author_list", read.code, read.note) }));
      return;
    }
    if (read.kind === "stop") {
      await this.#stop(state, work, read.reason, read.note, this.#last(trigger, "author_list", read.reason, read.note));
      return;
    }
    const { rows, summaries } = ffnSummariesFromStoryListHtml(read.html);
    if (rows === 0) {
      await this.#stop(state, work, "missing", read.note, this.#last(trigger, "author_list", "missing", read.note, { rows: 0 }));
      return;
    }
    const found: FilledSummary[] = [];
    for (const storyId of storyIds) {
      const summary = summaries.get(storyId);
      if (summary !== undefined) found.push(Object.freeze({ storyId, summary }));
    }
    // Every story asked for is done with: filled, or not on the first page.
    const next = this.#without(state, new Set(storyIds));
    if (found.length === 0) {
      await this.#write(Object.freeze({
        ...next,
        last: this.#last(trigger, "author_list", "not_listed", read.note, { rows, found: 0 }),
      }));
      return;
    }
    if (!(await this.#write(next))) return;
    if (this.#ports.account() !== state.account || !this.#current()) return;
    let outcome: ContributionOutcome = "failed";
    try {
      outcome = await this.#ports.contribute(found);
    } catch {
      outcome = "failed";
    }
    if (!this.#current()) return;
    const last = this.#last(trigger, "send", outcome === "accepted" ? "filled" : "send", read.note, {
      rows,
      found: found.length,
      send: outcome,
    });
    if (outcome !== "accepted") {
      await this.#stop(next, work, "send", read.note, last);
      return;
    }
    await this.#write(Object.freeze({ ...next, last }));
  }
}
