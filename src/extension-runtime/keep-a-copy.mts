/**
 * Keep a Copy: AO3's own download file of every work the reader keeps, saved
 * on their device and replaced when the work updates.
 *
 * A work is kept when the reader bookmarks it, marks it for later, subscribes
 * to it or leaves kudos (each can be turned off), when they open it with
 * **Every work I open** on, or when a backup of their own Bookmarks, Marked
 * for Later and Subscriptions lists finds it. Nothing else is ever read: no
 * tag, author or search pages.
 *
 * Courtesy to AO3 comes first, with the pace the History import already
 * holds to:
 * - One request at a time. Work the reader asked for (a trigger, a backup)
 *   goes 6 to 7 s apart; the weekly check goes 30 s apart and at most 30
 *   reads in six hours.
 * - The file comes from the work page's own Download menu, never a link
 *   built here. A work page is read only to download, and a copy is fetched
 *   again only when the link's `updated_at` changes.
 * - Only a real file is saved: an EPUB must open as one. Anything else, a
 *   check page, a 403 or 418 stops the queue for an hour, or as long as AO3
 *   asks (at most a day). A 429 or 503 waits a minute or as AO3 says, doubling,
 *   up to 15 minutes; three in a row stop it the same way.
 *
 * Everything lives in local storage on this device. Nothing is sent anywhere
 * but AO3.
 */

import {
  MAX_CONSECUTIVE_RETRIES,
  NETWORK_RETRY_MS,
  PAGE_GAP_JITTER_MS,
  PAGE_GAP_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from "./ao3-history-import.mjs";
import { AO3_USERNAME_PATTERN, LOGIN_MARKERS, retryAfterMs } from "./ao3-history-page.mjs";
import { isChallengePage } from "./ffn-summary-fill.mjs";

export const KEEP_A_COPY_KEY = "keepACopyV1";
/** Least time between two requests at the weekly check's pace. */
export const REQUEST_GAP_MS = 30_000;
/** Requests at the weekly check's pace per window, at most. */
export const WINDOW_MAX_READS = 30;
export const WINDOW_MS = 6 * 60 * 60_000;
/** How long a refusal, check page or error stops the queue. */
export const STOP_MS = 60 * 60_000;
/** The longest stop AO3 may ask for with `Retry-After`. */
export const STOP_MAX_MS = 24 * 60 * 60_000;
/** Unreadable works in a row that stop the queue. */
export const MISSES_MAX = 3;
export const KEEP_A_COPY_MESSAGE = {
  page: "KEEP_A_COPY_PAGE",
  view: "KEEP_A_COPY_VIEW",
  settings: "KEEP_A_COPY_SETTINGS",
  backup: "KEEP_A_COPY_BACKUP",
} as const;
export const AO3_ORIGIN = "https://archiveofourown.org";
export const COPY_FORMATS = ["epub", "azw3", "mobi", "pdf", "html"] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];
/** No file larger than this is kept. */
export const MAX_FILE_BYTES = 50 * 1_024 * 1_024;
/** No page is read further than this. */
export const MAX_PAGE_CHARS = 2_097_152;
/** A new file under this share of the old one's size keeps the old one too. */
export const SHRINK_KEEP_RATIO = 0.8;
export const CHECK_EVERY_MS = 7 * 24 * 60 * 60_000;
/** A list longer than this is cut off; far past any seen. */
export const MAX_LIST_PAGES = 1_000;

export type Trigger = "bookmark" | "later" | "subscribe" | "kudos" | "open";
export type ListName = "bookmarks" | "later" | "subscriptions";
const BACKUP_LISTS: readonly ListName[] = ["bookmarks", "later", "subscriptions"];
/** Subscriptions show no Updated date, so the weekly check reads only these. */
const CHECK_LISTS: readonly ListName[] = ["bookmarks", "later"];

export interface Settings {
  enabled: boolean;
  triggers: Record<Trigger, boolean>;
  weeklyCheck: boolean;
  format: CopyFormat;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  triggers: { bookmark: true, later: true, subscribe: true, kudos: true, open: false },
  weeklyCheck: false,
  format: "epub",
};

// --- Reading AO3 pages ------------------------------------------------------------

export interface DownloadLink {
  readonly url: string;
  /** The link's own `updated_at`: changes whenever the work does. */
  readonly updatedAt: string;
}

export interface WorkPageRead {
  readonly workId: string;
  readonly title: string;
  readonly author: string;
  readonly fandom: string;
  readonly complete: boolean;
  /** Archive users only: copied only through the reader's own signed-in session. */
  readonly restricted: boolean;
  /** Whether the page was served to a signed-in reader (`body.logged-in`), when the page says. */
  readonly signedIn: boolean | null;
  readonly downloads: Partial<Record<CopyFormat, DownloadLink>>;
}

const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/** The lock beside a restricted work's title: lockblue.png, "(Restricted)". */
const RESTRICTED_LOCK = /<img\b[^>]*(?:\bsrc\s*=\s*"[^"]*\/lockblue\.png"|\balt\s*=\s*"\(Restricted\)")/i;

function decode(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Download menu link, only on AO3's own hosts. */
export function readDownloadLink(href: string): { workId: string; format: CopyFormat; link: DownloadLink } | null {
  let url: URL;
  try {
    url = new URL(href.replace(/&amp;/g, "&"), AO3_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(?:download\.)?archiveofourown\.org$/.test(url.hostname)) return null;
  const path = /^\/downloads\/([1-9][0-9]{0,19})\/[^/]+\.([a-z0-9]+)$/i.exec(url.pathname);
  const format = path?.[2]?.toLowerCase() as CopyFormat | undefined;
  const updatedAt = url.searchParams.get("updated_at");
  if (!path?.[1] || !format || !COPY_FORMATS.includes(format) || !updatedAt || !/^[0-9]{1,12}$/.test(updatedAt)) return null;
  return { workId: path[1], format, link: { url: url.href, updatedAt } };
}

/** Whether a work page's title carries the lock, Download menu or not. */
export function isRestrictedPage(html: string): boolean {
  return RESTRICTED_LOCK.test(/<h2\b[^>]*\bclass\s*=\s*"[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(html.slice(0, MAX_PAGE_CHARS))?.[1] ?? "");
}

/** A work page (or its preface and Download menu) as the facts a copy needs. */
export function readWorkPage(html: string): WorkPageRead | null {
  const head = html.slice(0, MAX_PAGE_CHARS);
  const downloads: Partial<Record<CopyFormat, DownloadLink>> = {};
  let workId: string | null = null;
  // Only the work's own Download menu: a notes section can link other works' files.
  const menu = /<li\b[^>]*\bclass\s*=\s*"[^"]*\bdownload\b[^"]*"[^>]*>([\s\S]*?<\/ul>)/i.exec(head)?.[1] ?? "";
  for (const match of menu.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*\/downloads\/[^"]*)"/gi)) {
    const read = readDownloadLink(match[1] ?? "");
    if (!read) continue;
    if (workId !== null && read.workId !== workId) return null;
    workId = read.workId;
    downloads[read.format] = read.link;
  }
  if (workId === null) return null;
  const titleBlock = /<h2\b[^>]*\bclass\s*=\s*"[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(head)?.[1] ?? "";
  const title = decode(titleBlock);
  // `<body class="logged-in">` or `"logged-out"`.
  const bodyClass = /<body\b[^>]*\bclass\s*=\s*"([^"]*)"/i.exec(head)?.[1] ?? "";
  const signedIn = /\blogged-in\b/.test(bodyClass) ? true : /\blogged-out\b/.test(bodyClass) ? false : null;
  const author = decode(/<a\b[^>]*\brel\s*=\s*"author"[^>]*>([\s\S]*?)<\/a>/i.exec(head)?.[1] ?? "");
  const fandomBlock = /<dd\b[^>]*\bclass\s*=\s*"[^"]*\bfandom\b[^"]*"[^>]*>([\s\S]*?)<\/dd>/i.exec(head)?.[1] ?? "";
  const fandom = decode(/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(fandomBlock)?.[1] ?? "");
  return {
    workId, title: title || "Untitled", author: author || "Anonymous", fandom: fandom || "Unknown fandom",
    complete: isComplete(head), restricted: RESTRICTED_LOCK.test(titleBlock), signedIn, downloads,
  };
}

function isComplete(html: string): boolean {
  const chapters = decode(/<dd\b[^>]*\bclass\s*=\s*"[^"]*\bchapters\b[^"]*"[^>]*>([\s\S]*?)<\/dd>/i.exec(html)?.[1] ?? "");
  const counts = /^([0-9,]+)\s*\/\s*([0-9,]+|\?)$/.exec(chapters);
  return Boolean(counts && counts[2] !== "?" && counts[1] === counts[2]);
}

export interface ListedWork {
  readonly workId: string;
  /**
   * The work's `updated_at`, from the comment in each blurb
   * (`<!-- updated_at=… -->`): the same value as the Download link's. The shown date is no use, as it reads "3 days ago"
   * for a month.
   */
  readonly updatedAt: string | null;
  readonly complete: boolean;
  readonly restricted: boolean;
}

export function listPageURL(user: string, list: ListName, page: number): string {
  const name = encodeURIComponent(user);
  const path = list === "bookmarks" ? `/users/${name}/bookmarks?page=${page}`
    : list === "later" ? `/users/${name}/readings?show=to-read&page=${page}`
    : `/users/${name}/subscriptions?type=works&page=${page}`;
  return `${AO3_ORIGIN}${path}`;
}

/** The works on one page of the reader's own list, and whether a page follows. */
export function readListPage(html: string, list: ListName): { works: ListedWork[]; next: boolean } {
  const head = html.slice(0, MAX_PAGE_CHARS);
  const works: ListedWork[] = [];
  const seen = new Set<string>();
  const add = (work: ListedWork) => {
    if (seen.has(work.workId)) return;
    seen.add(work.workId);
    works.push(work);
  };
  if (list === "subscriptions") {
    for (const match of head.matchAll(/<dt\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*"\/works\/([1-9][0-9]{0,19})"/gi)) {
      add({ workId: match[1] ?? "", updatedAt: null, complete: false, restricted: false });
    }
  } else {
    // A listing row: a bookmark of a work, or a Marked for Later reading.
    for (const block of head.split(/(?=<li\b[^>]*\bclass\s*=\s*"[^"]*\bblurb\b)/i).filter((part) => /^<li\b/i.test(part))) {
      // The heading's first work link is the title (an "Anonymous:" status can come before it).
      const heading = /<h4\b[^>]*\bclass\s*=\s*"[^"]*\bheading\b[^"]*"[^>]*>([\s\S]*?)<\/h4>/i.exec(block)?.[1] ?? "";
      const id = /<a\b[^>]*\bhref\s*=\s*"\/works\/([1-9][0-9]{0,19})"/i.exec(heading)?.[1];
      if (!id) continue;
      const updatedAt = /<!--\s*updated_at=([0-9]{1,12})\s*-->/.exec(block)?.[1] ?? null;
      add({ workId: id, updatedAt, complete: isComplete(block), restricted: RESTRICTED_LOCK.test(heading) });
    }
  }
  return { works, next: /<li\b[^>]*\bclass\s*=\s*"next"[^>]*>\s*<a\b/i.test(head) };
}

/**
 * What a form a reader submits on AO3 does, from the path it posts to:
 * the work page's bookmark form, Mark for Later, kudos, and subscribing
 * (which posts to the reader's list; unsubscribing posts to one
 * subscription).
 */
export function formTriggerFor(path: string): Exclude<Trigger, "open"> | null {
  if (/^\/(?:collections\/[^/]+\/)?works\/[0-9]+\/bookmarks$/.test(path)) return "bookmark";
  if (/^\/works\/[0-9]+\/mark_for_later$/.test(path)) return "later";
  if (path === "/kudos") return "kudos";
  if (/^\/users\/[^/]+\/subscriptions$/.test(path)) return "subscribe";
  return null;
}

// --- Classifying AO3's answer -----------------------------------------------------

export type Fetched =
  | {
      readonly kind: "response";
      readonly status: number;
      /** Where the request ended, after any redirect. */
      readonly url: string;
      readonly contentType: string | null;
      readonly retryAfter: string | null;
      readonly cfMitigated: string | null;
      readonly text?: string;
      /** A file's first bytes (at least 8 KiB, or all of it), for checking what it is. */
      readonly bytes?: Uint8Array;
      /** A file's whole size, and a URL the downloads API can save it from. */
      readonly size?: number;
      readonly handle?: string;
    }
  /** `busy`: another file is still being fetched (Chrome's offscreen document takes one at a time). */
  | { readonly kind: "failed"; readonly code: "network" | "timeout" | "too_large" | "busy" };

/** Why the whole queue stopped: AO3 itself is refusing, checking or struggling. */
export type StopCode = "challenge" | "forbidden" | "wrong_host" | "unreadable" | "slow_down" | "save_failed";
/** Why one work has no copy, while the rest go on. */
export type SkipCode = "gone" | "needs_sign_in" | "no_download" | "not_a_file" | "too_large" | "http_error" | "save_failed" | "failed";

export type Verdict =
  | { readonly kind: "ok" }
  | { readonly kind: "skip"; readonly code: SkipCode }
  /** `network` when the request itself failed, which counts against the work. */
  | { readonly kind: "retry"; readonly waitMs: number | null; readonly network?: true }
  | { readonly kind: "stop"; readonly code: StopCode; readonly waitMs: number | null };

const bytesText = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** Whether the bytes are an EPUB: a zip whose first entry is its `mimetype`. */
export function isEpub(bytes: Uint8Array): boolean {
  return bytes.length > 58 && bytesText(bytes, 0, 4) === "PK\x03\x04" &&
    bytesText(bytes, 30, 38) === "mimetype" && bytesText(bytes, 38, 58) === "application/epub+zip";
}

export function looksLikeFormat(format: CopyFormat, bytes: Uint8Array): boolean {
  if (format === "epub") return isEpub(bytes);
  if (format === "pdf") return bytesText(bytes, 0, 5) === "%PDF-";
  if (format === "html") {
    const head = new TextDecoder().decode(bytes.subarray(0, 8_192));
    return /<html\b/i.test(head) && /\bid\s*=\s*"preface"/i.test(head) && !isChallengePage(head);
  }
  // AZW3 and MOBI are both Mobipocket files.
  return bytesText(bytes, 60, 68) === "BOOKMOBI";
}

export function classifyAnswer(answer: Fetched, expect: CopyFormat | "page", now: number): Verdict {
  if (answer.kind === "failed") {
    if (answer.code === "too_large") return { kind: "skip", code: "too_large" };
    return answer.code === "busy" ? { kind: "retry", waitMs: NETWORK_RETRY_MS } : { kind: "retry", waitMs: NETWORK_RETRY_MS, network: true };
  }
  const waitMs = retryAfterMs(answer.retryAfter, now);
  const text = answer.text ?? (answer.bytes ? new TextDecoder().decode(answer.bytes.subarray(0, 8_192)) : "");
  const html = expect === "page" || /text\/html/i.test(answer.contentType ?? "");
  if (answer.cfMitigated?.toLowerCase() === "challenge" || (html && isChallengePage(text))) return { kind: "stop", code: "challenge", waitMs };
  // 429 (body "Retry later", with Retry-After), 445 ("heavy traffic") and the
  // front ends' 5xx: wait and try again.
  if ([429, 445, 502, 503, 504].includes(answer.status) || (answer.status >= 520 && answer.status <= 526)) return { kind: "retry", waitMs };
  if (answer.status === 403 || answer.status === 418) {
    return LOGIN_MARKERS.test(text) ? { kind: "skip", code: "needs_sign_in" } : { kind: "stop", code: "forbidden", waitMs };
  }
  if (answer.status === 404 || answer.status === 410) return { kind: "skip", code: "gone" };
  let landed: URL;
  try {
    landed = new URL(answer.url);
  } catch {
    return { kind: "stop", code: "wrong_host", waitMs: null };
  }
  if (landed.protocol !== "https:" || !/^(?:download\.)?archiveofourown\.org$/.test(landed.hostname)) return { kind: "stop", code: "wrong_host", waitMs: null };
  if (/^\/users\/login\b/i.test(landed.pathname) || (answer.status === 200 && expect === "page" && LOGIN_MARKERS.test(text) && !/\/downloads\//.test(text))) {
    return { kind: "skip", code: "needs_sign_in" };
  }
  if (answer.status !== 200) return { kind: "skip", code: "http_error" };
  if (expect === "page") return { kind: "ok" };
  // A download that lands on a work's page has no file to take.
  if (/^\/(?:collections\/[^/]+\/)?works\/[0-9]+/.test(landed.pathname)) return { kind: "skip", code: "no_download" };
  return answer.bytes && looksLikeFormat(expect, answer.bytes) ? { kind: "ok" } : { kind: "skip", code: "not_a_file" };
}

// --- File names -------------------------------------------------------------------

const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** A file name's UTF-8 bytes, at most; well under the 255 most file systems allow. */
export const MAX_NAME_BYTES = 200;
const MAX_FANDOM_BYTES = 100;
const utf8 = new TextEncoder();

/** The longest start of `text`, in whole characters, that fits in `max` UTF-8 bytes. */
function fitBytes(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    used += utf8.encode(char).length;
    if (used > max) break;
    out += char;
  }
  return out;
}

/** One part of a path, safe on Windows, macOS and Linux, and as Chrome checks it. */
export function safeSegment(text: string, maxBytes: number, fallback: string): string {
  let out = text.normalize("NFC")
    // Format characters (bidi marks, zero-width joiners), controls and private use Chrome refuses.
    .replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cs}]/gu, "")
    .replace(/[\\/:*?"<>|~]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  out = fitBytes(out, maxBytes).replace(/^[.\s-]+|[.\s]+$/g, "");
  if (!out) return fallback;
  // Windows refuses a reserved stem whatever follows it: `CON`, `con.txt`.
  return RESERVED_NAMES.test(out.split(".")[0] ?? "") ? `_${out}` : out;
}

/**
 * `AO3/<Fandom>/<Title> – <Author> (<work id>).<format>`, under Downloads.
 * The title and author give way to the length cap; ` (<work id>)`, any
 * `label` and the extension always stay.
 */
export function copyFilename(work: Pick<WorkPageRead, "workId" | "title" | "author" | "fandom">, format: CopyFormat, label?: string): string {
  const fandom = safeSegment(work.fandom, MAX_FANDOM_BYTES, "Unknown fandom");
  const tail = ` (${work.workId})${label ? ` (${safeSegment(label, 40, "")})` : ""}.${format}`;
  const room = MAX_NAME_BYTES - utf8.encode(tail).length;
  const author = safeSegment(work.author, Math.min(60, Math.floor(room / 3)), "Anonymous");
  const title = safeSegment(work.title, room - utf8.encode(` – ${author}`).length, "Untitled");
  return `AO3/${fandom}/${title} – ${author}${tail}`;
}

// --- The queue --------------------------------------------------------------------

export type Pace = "reader" | "check";

/** Tries of one request for one work before it is skipped; a background stopped mid-request counts. */
export const MAX_ATTEMPTS = 3;
/** A save the browser has not finished is looked at again after this long. */
export const SETTLE_RECHECK_MS = 2_000;
/** A save still unfinished after this long has failed. */
export const SETTLE_MAX_MS = 15 * 60_000;

export interface Copy {
  readonly downloadId: number;
  /** The name asked for, under Downloads. */
  readonly filename: string;
  /** Where the browser says it put the file. */
  readonly path: string | null;
  readonly bytes: number;
  readonly format: CopyFormat;
  readonly updatedAt: string;
  readonly savedAt: number;
}

export interface KeptWork {
  workId: string;
  title: string;
  author: string;
  fandom: string;
  complete: boolean;
  /** Archive users only; its link is never kept, only read from its page in the step that downloads it. */
  restricted: boolean;
  copy: Copy | null;
  /** Older, longer files left as they were when a much shorter version came. */
  setAside: string[];
  skipped: SkipCode | null;
}

export interface QueueItem {
  readonly workId: string;
  pace: Pace;
  /** Known from a page the reader has open: the file is fetched straight away. */
  link?: DownloadLink;
  /** Queued by a backup: the browser's download alerts stay hidden for it. */
  batch?: true;
  /** Requests made for the step this work is on. */
  attempts?: number;
  lastFailure?: "save" | "request";
}

/** A file the browser is still saving. The old copy is touched only once it is complete. */
export interface PendingSave {
  readonly workId: string;
  readonly downloadId: number;
  readonly filename: string;
  readonly bytes: number;
  readonly format: CopyFormat;
  readonly updatedAt: string;
  readonly setAside: boolean;
  readonly handle: string;
  readonly startedAt: number;
}

export interface ListRun {
  readonly purpose: "backup" | "check";
  readonly user: string;
  readonly lists: readonly ListName[];
  list: number;
  page: number;
  found: number;
  status: "running" | "finished";
}

export interface KeepState {
  v: 1;
  settings: Settings;
  user: string | null;
  works: Record<string, KeptWork>;
  queue: QueueItem[];
  run: ListRun | null;
  pending: PendingSave | null;
  pacer: {
    dueAt: number;
    window: { startedAt: number; reads: number };
    retries: number;
    misses: number;
    stopped: { code: StopCode; until: number } | null;
    lastCheckAt: number;
  };
}

export function newState(now: number): KeepState {
  return {
    v: 1, settings: structuredClone(DEFAULT_SETTINGS), user: null, works: {}, queue: [], run: null, pending: null,
    pacer: { dueAt: 0, window: { startedAt: now, reads: 0 }, retries: 0, misses: 0, stopped: null, lastCheckAt: now },
  };
}

export interface SaveRequest {
  readonly filename: string;
  readonly format: CopyFormat;
  /** The URL the file is saved from (`Fetched.handle`). */
  readonly handle: string;
  /** A dated name is never written over: the browser picks a free one. */
  readonly conflict: "overwrite" | "uniquify";
}

export type SaveState = { readonly state: "complete" | "interrupted" | "in_progress"; readonly filename: string | null };

export interface KeepPorts {
  readonly clock: { now(): number };
  readonly random: () => number;
  read(): Promise<unknown>;
  write(state: KeepState): Promise<void>;
  fetchPage(url: string): Promise<Fetched>;
  fetchFile(url: string): Promise<Fetched>;
  /** Starts saving under Downloads; resolves with the download's id. */
  save(request: SaveRequest): Promise<number>;
  /** Where a save stands, waiting a little for it to finish. */
  settle(downloadId: number): Promise<SaveState>;
  /** Lets a file's URL go once its save is over. */
  release?(handle: string): void;
  /** Gives up a save that never finished, and forgets it. */
  cancel?(downloadId: number): Promise<void>;
  /** Deletes a file, only if it is still this extension's file at that name. */
  remove(downloadId: number, filename: string): Promise<void>;
  /** Told when a backup starts and ends (Chrome hides its download bubble meanwhile). */
  quiet?(on: boolean): void;
}

export interface KeepView {
  readonly settings: Settings;
  readonly user: string | null;
  readonly kept: number;
  readonly withCopy: number;
  readonly waiting: number;
  readonly skipped: Partial<Record<SkipCode, number>>;
  readonly run: { purpose: ListRun["purpose"]; status: ListRun["status"]; list: ListName | null; page: number; found: number } | null;
  readonly stopped: { code: StopCode; until: number } | null;
}

function isState(value: unknown): value is KeepState {
  const state = value as Partial<KeepState> | null;
  return Boolean(state && state.v === 1 && state.settings && state.works && Array.isArray(state.queue) && state.pacer);
}

const backoff = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export class KeepACopy {
  #state: KeepState | null = null;
  #busy: Promise<unknown> = Promise.resolve();
  #quiet = false;

  constructor(private readonly ports: KeepPorts) {}

  async #load(): Promise<KeepState> {
    if (!this.#state) {
      const stored = await this.ports.read();
      this.#state ??= isState(stored) ? { ...stored, pending: stored.pending ?? null } : newState(this.ports.clock.now());
    }
    return this.#state;
  }

  /** One change at a time, each written before the next. */
  #serial<T>(task: (state: KeepState) => Promise<T> | T): Promise<T> {
    const next = this.#busy.then(async () => {
      const state = await this.#load();
      const result = await task(state);
      await this.ports.write(state);
      return result;
    });
    this.#busy = next.catch(() => undefined);
    return next;
  }

  /** Reads without waiting for a request under way, and writes nothing. */
  async view(): Promise<KeepView> {
    const state = await this.#load();
    const works = Object.values(state.works);
    const skipped: Partial<Record<SkipCode, number>> = {};
    for (const work of works) if (work.skipped) skipped[work.skipped] = (skipped[work.skipped] ?? 0) + 1;
    const run = state.run;
    const stopped = state.pacer.stopped;
    return {
      settings: structuredClone(state.settings),
      user: state.user,
      kept: works.length,
      withCopy: works.filter((w) => w.copy).length,
      waiting: state.queue.length,
      skipped,
      run: run ? { purpose: run.purpose, status: run.status, list: run.lists[run.list] ?? null, page: run.page, found: run.found } : null,
      stopped: stopped && stopped.until > this.ports.clock.now() ? { ...stopped } : null,
    };
  }

  updateSettings(patch: Partial<Settings>): Promise<void> {
    return this.#serial((state) => {
      const format = patch.format && COPY_FORMATS.includes(patch.format) ? patch.format : state.settings.format;
      state.settings = {
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : state.settings.enabled,
        triggers: { ...state.settings.triggers, ...(patch.triggers ?? {}) },
        weeklyCheck: typeof patch.weeklyCheck === "boolean" ? patch.weeklyCheck : state.settings.weeklyCheck,
        format,
      };
      this.#setQuiet(this.#batchRunning(state));
    });
  }

  /** The AO3 name the reader is signed in as, from the page they are on. */
  noteUser(user: string | null): Promise<void> {
    return this.#serial((state) => {
      if (user && AO3_USERNAME_PATTERN.test(user)) state.user = user;
    });
  }

  /** A work page the reader has open, with what they just did on it. */
  notePage(page: WorkPageRead, trigger: Trigger | "visit"): Promise<void> {
    return this.#serial((state) => {
      if (!this.#keeps(state, page.workId, trigger)) return;
      const work = this.#keep(state, page.workId, page);
      const link = page.downloads[state.settings.format];
      if (link && (!work.copy || work.copy.updatedAt !== link.updatedAt || work.copy.format !== state.settings.format)) {
        this.#enqueue(state, work.restricted ? { workId: work.workId, pace: "reader" } : { workId: work.workId, pace: "reader", link });
      }
    });
  }

  /** A work acted on from a page with no Download menu (its bookmark form): its page is read. */
  noteWork(workId: string, trigger: Trigger): Promise<void> {
    return this.#serial((state) => {
      if (!this.#keeps(state, workId, trigger)) return;
      if (!this.#keep(state, workId).copy) this.#enqueue(state, { workId, pace: "reader" });
    });
  }

  startBackup(): Promise<"started" | "running" | "no_user"> {
    return this.#serial((state) => {
      if (!state.user) return "no_user";
      if (state.run?.status === "running" && state.run.purpose === "backup") return "running";
      state.run = { purpose: "backup", user: state.user, lists: BACKUP_LISTS, list: 0, page: 1, found: 0, status: "running" };
      return "started";
    });
  }

  /**
   * Makes at most one request, if one is due. Returns how long until the
   * next one may be, or null with nothing to do.
   */
  tick(): Promise<number | null> {
    return this.#serial(async (state) => {
      try {
        return await this.#step(state);
      } finally {
        this.#setQuiet(this.#batchRunning(state));
      }
    });
  }

  #keeps(state: KeepState, workId: string, trigger: Trigger | "visit"): boolean {
    if (!state.settings.enabled || !ID_PATTERN.test(workId)) return false;
    return Boolean(state.works[workId]) || (trigger === "visit" ? state.settings.triggers.open : state.settings.triggers[trigger]);
  }

  #keep(state: KeepState, workId: string, page?: Partial<WorkPageRead>): KeptWork {
    const work = state.works[workId] ??= {
      workId, title: "Untitled", author: "Anonymous", fandom: "Unknown fandom", complete: false, restricted: false, copy: null, setAside: [], skipped: null,
    };
    if (page?.title) work.title = page.title;
    if (page?.author) work.author = page.author;
    if (page?.fandom) work.fandom = page.fandom;
    if (typeof page?.complete === "boolean") work.complete = page.complete;
    if (typeof page?.restricted === "boolean") work.restricted = page.restricted;
    return work;
  }

  #enqueue(state: KeepState, item: QueueItem): void {
    if (item.link && state.works[item.workId]?.restricted) {
      // A locked work's link is read in the step that downloads it, never kept.
      const { link: _dropped, ...rest } = item;
      item = rest;
    }
    const queued = state.queue.find((each) => each.workId === item.workId);
    if (!queued) {
      state.queue.push(item);
      return;
    }
    // A newer link, or the reader's own pace, wins over what was queued.
    if (item.link) queued.link = item.link;
    if (item.pace === "reader") queued.pace = "reader";
  }

  #drop(state: KeepState, workId: string): void {
    state.queue = state.queue.filter((queued) => queued.workId !== workId);
  }

  #batchRunning(state: KeepState): boolean {
    const now = this.ports.clock.now();
    if (!state.settings.enabled || (state.pacer.stopped && state.pacer.stopped.until > now)) return false;
    return (state.run?.purpose === "backup" && state.run.status === "running") || state.queue.some((queued) => queued.batch);
  }

  #setQuiet(on: boolean): void {
    if (this.#quiet === on) return;
    this.#quiet = on;
    this.ports.quiet?.(on);
  }

  async #step(state: KeepState): Promise<number | null> {
    const now = this.ports.clock.now();
    const pacer = state.pacer;
    if (!state.settings.enabled) return null;
    if (state.pending) return this.#settle(state, state.pending);
    if (pacer.stopped) {
      if (now < pacer.stopped.until) return pacer.stopped.until - now;
      pacer.stopped = null;
    }
    if (state.run?.status !== "running" && state.settings.weeklyCheck && state.user && now - pacer.lastCheckAt >= CHECK_EVERY_MS) {
      state.run = { purpose: "check", user: state.user, lists: CHECK_LISTS, list: 0, page: 1, found: 0, status: "running" };
    }
    const running = state.run?.status === "running" ? state.run : null;
    const item = state.queue.find((queued) => queued.pace === "reader") ?? (running ? null : state.queue[0] ?? null);
    const pace: Pace | null = item ? item.pace : running ? (running.purpose === "backup" ? "reader" : "check") : null;
    if (!pace) return null;
    if (now - pacer.window.startedAt >= WINDOW_MS) pacer.window = { startedAt: now, reads: 0 };
    if (pace === "check" && pacer.window.reads >= WINDOW_MAX_READS) return pacer.window.startedAt + WINDOW_MS - now;
    if (now < pacer.dueAt) return pacer.dueAt - now;

    if (item && (item.attempts ?? 0) >= MAX_ATTEMPTS) {
      this.#keep(state, item.workId).skipped = item.lastFailure === "save" ? "save_failed" : "failed";
      this.#drop(state, item.workId);
      return 0;
    }
    // Written before the request, so a background stopped part-way neither
    // asks again at once nor for ever.
    const gap = pace === "reader" ? PAGE_GAP_MS + Math.floor(this.ports.random() * PAGE_GAP_JITTER_MS) : REQUEST_GAP_MS;
    pacer.dueAt = now + gap;
    pacer.window.reads += 1;
    if (item) {
      item.attempts = (item.attempts ?? 0) + 1;
      item.lastFailure = "request";
    }
    await this.ports.write(state);

    const verdict = item ? await this.#workStep(state, item) : await this.#listStep(state, running!);
    const after = this.ports.clock.now();
    pacer.dueAt = Math.max(pacer.dueAt, after + gap);
    // AO3 refusing or slowing everyone down is not this work's fault.
    const siteWide = (verdict.kind === "stop" && verdict.code !== "unreadable" && verdict.code !== "save_failed") || (verdict.kind === "retry" && !verdict.network);
    if (item && siteWide) item.attempts = Math.max(0, (item.attempts ?? 1) - 1);
    if (verdict.kind === "retry") {
      pacer.retries += 1;
      if (pacer.retries >= MAX_CONSECUTIVE_RETRIES) {
        this.#stop(state, "slow_down", verdict.waitMs, after);
      } else {
        pacer.dueAt = after + Math.min(STOP_MAX_MS, Math.max(backoff(pacer.retries), verdict.waitMs ?? 0));
      }
    } else {
      pacer.retries = 0;
      if (verdict.kind === "stop") this.#stop(state, verdict.code, verdict.waitMs, after);
    }
    // (Read again: #stop may have set it since the check above.)
    const stopped = state.pacer.stopped as KeepState["pacer"]["stopped"];
    return Math.max(0, (stopped?.until ?? pacer.dueAt) - after);
  }

  #stop(state: KeepState, code: StopCode, waitMs: number | null, now: number): void {
    state.pacer.retries = 0;
    state.pacer.misses = 0;
    state.pacer.stopped = { code, until: now + Math.min(STOP_MAX_MS, Math.max(STOP_MS, waitMs ?? 0)) };
  }

  /**
   * A work's file that was not saved waits longer each time and is skipped
   * after MAX_ATTEMPTS; several in a row (a full disk) stop the queue.
   */
  #saveFailed(state: KeepState, workId: string, now: number): Verdict | null {
    const item = state.queue.find((queued) => queued.workId === workId);
    if (item) item.lastFailure = "save";
    state.pacer.dueAt = Math.max(state.pacer.dueAt, now + backoff(item?.attempts ?? 1));
    return this.#miss(state, "save_failed");
  }

  /** Per-work failures that are not the site's fault; several in a row are. Only a completed save clears them. */
  #miss(state: KeepState, code: StopCode = "unreadable"): Verdict | null {
    state.pacer.misses += 1;
    return state.pacer.misses >= MISSES_MAX ? { kind: "stop", code, waitMs: null } : null;
  }

  async #workStep(state: KeepState, item: QueueItem): Promise<Verdict> {
    const work = this.#keep(state, item.workId);
    const format = state.settings.format;
    // A link for another format was queued before the setting changed, or the work is locked: read the page.
    if (item.link && (work.restricted || readDownloadLink(item.link.url)?.format !== format)) delete item.link;
    const skip = (code: SkipCode): Verdict => {
      work.skipped = code;
      this.#drop(state, item.workId);
      return code === "gone" || code === "needs_sign_in" ? { kind: "skip", code } : this.#miss(state) ?? { kind: "skip", code };
    };
    if (!item.link) {
      const answer = await this.ports.fetchPage(`${AO3_ORIGIN}/works/${item.workId}?view_adult=true`);
      const verdict = classifyAnswer(answer, "page", this.ports.clock.now());
      if (verdict.kind === "skip") return skip(verdict.code);
      if (verdict.kind !== "ok") return verdict;
      const page = answer.kind === "response" ? readWorkPage(answer.text ?? "") : null;
      const link = page?.workId === item.workId ? page.downloads[format] : undefined;
      // A locked work is copied only from its page as the signed-in reader sees it, just now.
      const locked = work.restricted || (page ? page.restricted : isRestrictedPage(answer.kind === "response" ? answer.text ?? "" : ""));
      if (locked && (!page || page.signedIn !== true || !link)) {
        work.restricted = true;
        return skip("needs_sign_in");
      }
      if (!page || !link) return skip("no_download");
      this.#keep(state, item.workId, page);
      if (work.copy?.updatedAt === link.updatedAt && work.copy.format === format) {
        this.#drop(state, item.workId);
        return verdict;
      }
      if (locked) return this.#fileStep(state, item, work, link);
      item.link = link;
      item.attempts = 0;
      return verdict;
    }
    return this.#fileStep(state, item, work, item.link);
  }

  async #fileStep(state: KeepState, item: QueueItem, work: KeptWork, link: DownloadLink): Promise<Verdict> {
    const format = state.settings.format;
    const skip = (code: SkipCode): Verdict => {
      work.skipped = code;
      this.#drop(state, item.workId);
      return code === "gone" || code === "needs_sign_in" ? { kind: "skip", code } : this.#miss(state) ?? { kind: "skip", code };
    };
    const answer = await this.ports.fetchFile(link.url);
    const verdict = classifyAnswer(answer, format, this.ports.clock.now());
    const handle = answer.kind === "response" ? answer.handle : undefined;
    if (verdict.kind !== "ok" && handle) this.ports.release?.(handle);
    if (verdict.kind === "skip") return skip(verdict.code);
    if (verdict.kind !== "ok" || answer.kind !== "response") return verdict;
    if (!handle) return this.#saveFailed(state, item.workId, this.ports.clock.now()) ?? verdict;
    const size = answer.size ?? answer.bytes?.length ?? 0;
    const old = work.copy;
    const shrank = old !== null && old.format === format && size < old.bytes * SHRINK_KEEP_RATIO;
    let filename = copyFilename(work, format);
    const dated = shrank || work.setAside.includes(filename);
    if (dated) {
      const stamp = new Date(this.ports.clock.now()).toISOString();
      const label = `updated ${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)}`;
      const taken = new Set([...work.setAside, old?.filename]);
      filename = copyFilename(work, format, label);
      for (let n = 2; taken.has(filename); n += 1) filename = copyFilename(work, format, `${label}-${n}`);
    }
    try {
      const downloadId = await this.ports.save({ filename, format, handle, conflict: dated ? "uniquify" : "overwrite" });
      state.pending = { workId: item.workId, downloadId, filename, bytes: size, format, updatedAt: link.updatedAt, setAside: shrank, handle, startedAt: this.ports.clock.now() };
    } catch {
      this.ports.release?.(handle);
      return this.#saveFailed(state, item.workId, this.ports.clock.now()) ?? verdict;
    }
    return verdict;
  }

  async #settle(state: KeepState, pending: PendingSave): Promise<number> {
    const result = await this.ports.settle(pending.downloadId).catch((): SaveState => ({ state: "interrupted", filename: null }));
    const now = this.ports.clock.now();
    if (result.state === "in_progress" && now - pending.startedAt < SETTLE_MAX_MS) return SETTLE_RECHECK_MS;
    state.pending = null;
    // Never finished: stopped, so the browser does not go on reading a URL let go below.
    if (result.state === "in_progress") await this.ports.cancel?.(pending.downloadId).catch(() => undefined);
    this.ports.release?.(pending.handle);
    // Interrupted, or never finished: the old copy stays as it was.
    if (result.state !== "complete") {
      const stop = this.#saveFailed(state, pending.workId, now);
      if (stop?.kind === "stop") this.#stop(state, stop.code, null, now);
      return Math.max(0, (state.pacer.stopped?.until ?? state.pacer.dueAt) - now);
    }
    state.pacer.misses = 0;
    const work = this.#keep(state, pending.workId);
    const old = work.copy;
    if (old && pending.setAside) {
      work.setAside.push(old.filename);
    } else if (old && old.downloadId !== pending.downloadId && old.filename !== pending.filename) {
      await this.ports.remove(old.downloadId, old.path ?? old.filename).catch(() => undefined);
    }
    work.copy = {
      downloadId: pending.downloadId, filename: pending.filename, path: result.filename, bytes: pending.bytes,
      format: pending.format, updatedAt: pending.updatedAt, savedAt: now,
    };
    work.skipped = null;
    this.#drop(state, pending.workId);
    return Math.max(0, state.pacer.dueAt - now);
  }

  async #listStep(state: KeepState, run: ListRun): Promise<Verdict> {
    const list = run.lists[run.list];
    if (!list) {
      run.status = "finished";
      return { kind: "ok" };
    }
    const answer = await this.ports.fetchPage(listPageURL(run.user, list, run.page));
    const verdict = classifyAnswer(answer, "page", this.ports.clock.now());
    // A list that wants a sign-in is someone else's, or the reader signed out.
    if (verdict.kind === "skip") return { kind: "stop", code: "forbidden", waitMs: null };
    if (verdict.kind !== "ok" || answer.kind !== "response") return verdict;
    const read = readListPage(answer.text ?? "", list);
    for (const listed of read.works) {
      const known = state.works[listed.workId];
      const stale = (work: KeptWork) => !work.copy || (listed.updatedAt !== null && listed.updatedAt !== work.copy.updatedAt);
      if (run.purpose === "backup") {
        // Subscriptions show no chapter count, so they leave `complete` as it was.
        const work = this.#keep(state, listed.workId, list === "subscriptions" ? {} : { complete: listed.complete, restricted: listed.restricted });
        if (stale(work)) this.#enqueue(state, { workId: listed.workId, pace: "reader", batch: true });
      } else if (known?.copy && !listed.complete && stale(known)) {
        known.complete = listed.complete;
        known.restricted = listed.restricted;
        this.#enqueue(state, { workId: listed.workId, pace: "check" });
      }
    }
    run.found += read.works.length;
    if (read.next && run.page < MAX_LIST_PAGES) {
      run.page += 1;
    } else {
      run.list += 1;
      run.page = 1;
      if (run.list >= run.lists.length) {
        run.status = "finished";
        if (run.purpose === "check") state.pacer.lastCheckAt = this.ports.clock.now();
      }
    }
    if (run.status === "finished" && run.purpose === "check") state.run = null;
    return verdict;
  }
}
