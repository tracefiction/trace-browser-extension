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
 * - Work and chapter pages are never read signed in: a public work's page
 *   and file go with `credentials: "omit"`. The reader's own lists, and a
 *   locked work's Chapter Index (`/works/<id>/navigate`) and file, go with
 *   their session and follow no redirect (`#lockedStep`).
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
  stopBackup: "KEEP_A_COPY_STOP_BACKUP",
  resumeBackup: "KEEP_A_COPY_RESUME_BACKUP",
  retrySkipped: "KEEP_A_COPY_RETRY_SKIPPED",
} as const;
export const AO3_ORIGIN = "https://archiveofourown.org";
declare const __KEEP_A_COPY_FOLDER__: string | undefined;
/**
 * The top folder of every copy, under Downloads: one per build. Each build
 * sets it (scripts/build-keep-a-copy.mjs); "NAME" is the standalone's
 * placeholder until its name is chosen.
 */
export const COPY_FOLDER: string = typeof __KEEP_A_COPY_FOLDER__ === "string" ? __KEEP_A_COPY_FOLDER__ : "NAME";
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
  /** Archive users only: AO3 shows it to signed-in readers only. */
  readonly restricted: boolean;
  readonly downloads: Partial<Record<CopyFormat, DownloadLink>>;
}

const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/** The lock beside a restricted work's title: lockblue.png, "(Restricted)". */
const RESTRICTED_LOCK = /<img\b[^>]*(?:\bsrc\s*=\s*"[^"]*\/lockblue\.png"|\balt\s*=\s*"\(Restricted\)")/i;

/** A character reference past the last code point reads as the replacement character, as a browser shows it. */
const codePoint = (value: number) => String.fromCodePoint(value <= 0x10ffff ? value : 0xfffd);

function decode(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, dec: string) => codePoint(Number(dec)))
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

/** Whether a page was served to a signed-in reader, when it says: `<body class="logged-in">` or `"logged-out"`. */
export function pageSignedIn(html: string): boolean | null {
  const bodyClass = /<body\b[^>]*\bclass\s*=\s*"([^"]*)"/i.exec(html.slice(0, MAX_PAGE_CHARS))?.[1] ?? "";
  return /\blogged-in\b/.test(bodyClass) ? true : /\blogged-out\b/.test(bodyClass) ? false : null;
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
  const author = decode(/<a\b[^>]*\brel\s*=\s*"author"[^>]*>([\s\S]*?)<\/a>/i.exec(head)?.[1] ?? "");
  const fandomBlock = /<dd\b[^>]*\bclass\s*=\s*"[^"]*\bfandom\b[^"]*"[^>]*>([\s\S]*?)<\/dd>/i.exec(head)?.[1] ?? "";
  const fandom = decode(/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(fandomBlock)?.[1] ?? "");
  return {
    workId, title: title || "Untitled", author: author || "Anonymous", fandom: fandom || "Unknown fandom",
    complete: isComplete(head), restricted: RESTRICTED_LOCK.test(titleBlock), downloads,
  };
}

function isComplete(html: string): boolean {
  const chapters = decode(/<dd\b[^>]*\bclass\s*=\s*"[^"]*\bchapters\b[^"]*"[^>]*>([\s\S]*?)<\/dd>/i.exec(html)?.[1] ?? "");
  const counts = /^([0-9,]+)\s*\/\s*([0-9,]+|\?)$/.exec(chapters);
  return Boolean(counts && counts[2] !== "?" && counts[1] === counts[2]);
}

export interface ChapterIndexRead {
  readonly workId: string;
  /** From the page's heading; empty when it does not say. */
  readonly title: string;
  readonly author: string;
  readonly chapters: number;
  /** The latest chapter's date, as seconds since 1970 (its day's start, UTC). */
  readonly latestAt: number;
  readonly signedIn: boolean | null;
}

/**
 * A work's Chapter Index (`/works/<id>/navigate`): every
 * chapter links to `/works/<id>/chapters/<id>` with its date beside it.
 * Null for any other page, or one whose chapters are not all one work's.
 */
export function readChapterIndex(html: string): ChapterIndexRead | null {
  const head = html.slice(0, MAX_PAGE_CHARS);
  const list = /<ol\b[^>]*\bclass\s*=\s*"[^"]*\bchapter\b[^"]*\bindex\b[^"]*"[^>]*>([\s\S]*?)<\/ol>/i.exec(head)?.[1];
  if (list === undefined) return null;
  let workId: string | null = null;
  let chapters = 0;
  let latestAt = 0;
  for (const item of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = /<a\b[^>]*\bhref\s*=\s*"\/works\/([1-9][0-9]{0,19})\/chapters\/[1-9][0-9]{0,19}"/i.exec(item[1] ?? "");
    if (!link?.[1]) continue;
    const date = /<span\b[^>]*\bclass\s*=\s*"[^"]*\bdatetime\b[^"]*"[^>]*>\s*\(([0-9]{4})-([0-9]{2})-([0-9]{2})\)/i.exec(item[1] ?? "");
    if (!date || (workId !== null && link[1] !== workId)) return null;
    workId = link[1];
    chapters += 1;
    latestAt = Math.max(latestAt, Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) / 1_000);
  }
  if (workId === null || !Number.isSafeInteger(latestAt) || latestAt <= 0) return null;
  // "Chapter Index for <a href="/works/<id>">Title</a> by <a rel="author">Author</a>"
  const heading = /<h2\b[^>]*\bclass\s*=\s*"[^"]*\bheading\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(head)?.[1] ?? "";
  const title = decode(new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*"/works/${workId}"[^>]*>([\\s\\S]*?)</a>`, "i").exec(heading)?.[1] ?? "");
  const author = decode(/<a\b[^>]*\brel\s*=\s*"author"[^>]*>([\s\S]*?)<\/a>/i.exec(heading)?.[1] ?? "");
  return { workId, title, author, chapters, latestAt, signedIn: pageSignedIn(head) };
}

/** Every locked version is at least this: twelve digits, above any `updated_at` of a Download link. */
export const LOCKED_VERSION_BASE = 100_000_000_000;

/**
 * A locked work's version, from its Chapter Index: its latest chapter's day
 * plus its chapter count, so it changes with every new chapter and every
 * later date. Digits, as a Download link's `updated_at` is, but from
 * LOCKED_VERSION_BASE up, so it is told apart from one and compared only
 * with another locked version.
 */
export function lockedVersion(index: Pick<ChapterIndexRead, "chapters" | "latestAt">): string {
  return String(LOCKED_VERSION_BASE + index.latestAt + index.chapters);
}

/** A locked work's download URL: the title's letters and digits (or the id) as its name, and the version. */
export function lockedFileURL(workId: string, title: string, format: CopyFormat, version: string): string {
  const name = title.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || workId;
  return `${AO3_ORIGIN}/downloads/${workId}/${name}.${format}?updated_at=${version}`;
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
  /**
   * A request with the reader's session follows no redirect: it was sent
   * somewhere else, and nothing more is asked (the browser keeps where).
   */
  | { readonly kind: "redirect"; readonly url: string }
  /** `busy`: another file is still being fetched (Chrome's offscreen document takes one at a time). */
  | { readonly kind: "failed"; readonly code: "network" | "timeout" | "too_large" | "busy" };

/** Why the whole queue stopped: AO3 itself is refusing, checking or struggling. */
export type StopCode = "challenge" | "forbidden" | "wrong_host" | "unreadable" | "slow_down" | "save_failed" | "signed_out";
/** Stops that are no failure of AO3's: it answered, or the trouble is on this side. */
const NOT_AO3_FAILING: readonly StopCode[] = ["unreadable", "save_failed", "signed_out"];
/** Why one work has no copy, while the rest go on. */
export type SkipCode = "gone" | "needs_sign_in" | "no_download" | "not_a_file" | "too_large" | "http_error" | "save_failed" | "failed";
/** Skips another try may cure. A locked work copies once the reader signs in; a hidden or deleted one has nothing to copy. */
export const RETRYABLE_SKIPS: readonly SkipCode[] = ["not_a_file", "too_large", "http_error", "save_failed", "failed"];

export type Verdict =
  | { readonly kind: "ok" }
  | { readonly kind: "skip"; readonly code: SkipCode }
  /** `network` when the request itself failed, which counts against the work. */
  /** `own`: the wait is this extension's, not a time AO3 gave. */
  /** `busy`: nothing was sent (the file fetcher was taken): it waits its turn, never a refusal. */
  | { readonly kind: "retry"; readonly waitMs: number | null; readonly network?: true; readonly own?: true; readonly busy?: true }
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

/**
 * `expect`: a file's format, a public work's "page" (read signed out), or a
 * page read with the reader's "session" (their lists, a locked work's
 * Chapter Index).
 */
export function classifyAnswer(answer: Fetched, expect: CopyFormat | "page" | "session", now: number): Verdict {
  // Not followed: a page read with the reader's session wants a sign-in; a file has none to take.
  if (answer.kind === "redirect") return expect === "session" ? { kind: "skip", code: "needs_sign_in" } : { kind: "skip", code: "no_download" };
  if (answer.kind === "failed") {
    if (answer.code === "too_large") return { kind: "skip", code: "too_large" };
    return answer.code === "busy" ? { kind: "retry", waitMs: NETWORK_RETRY_MS, busy: true, own: true } : { kind: "retry", waitMs: NETWORK_RETRY_MS, network: true, own: true };
  }
  const waitMs = retryAfterMs(answer.retryAfter, now);
  const text = answer.text ?? (answer.bytes ? new TextDecoder().decode(answer.bytes.subarray(0, 8_192)) : "");
  const html = expect === "page" || expect === "session" || /text\/html/i.test(answer.contentType ?? "");
  if (answer.cfMitigated?.toLowerCase() === "challenge" || (html && isChallengePage(text))) return { kind: "stop", code: "challenge", waitMs };
  // 429 (body "Retry later", with Retry-After), 445 ("heavy traffic") and the
  // front ends' 5xx: wait and try again.
  if ([429, 445, 502, 503, 504].includes(answer.status) || (answer.status >= 520 && answer.status <= 526)) return { kind: "retry", waitMs };
  if (answer.status === 403 || answer.status === 418) {
    // Every signed-out page has a sign-in form: only one read with the reader's session says they signed out.
    return expect === "session" && LOGIN_MARKERS.test(text) ? { kind: "skip", code: "needs_sign_in" } : { kind: "stop", code: "forbidden", waitMs };
  }
  if (answer.status === 404 || answer.status === 410) return { kind: "skip", code: "gone" };
  let landed: URL;
  try {
    landed = new URL(answer.url);
  } catch {
    return { kind: "stop", code: "wrong_host", waitMs: null };
  }
  if (landed.protocol !== "https:" || !/^(?:download\.)?archiveofourown\.org$/.test(landed.hostname)) return { kind: "stop", code: "wrong_host", waitMs: null };
  // The sign-in page. Read signed out, only one with `restricted=true` is a locked work's; any other has nothing to copy.
  if (/^\/users\/login\b/i.test(landed.pathname)) {
    return expect === "session" || landed.searchParams.get("restricted") === "true" ? { kind: "skip", code: "needs_sign_in" } : { kind: "skip", code: "no_download" };
  }
  if (answer.status === 200 && expect === "session" && LOGIN_MARKERS.test(text)) return { kind: "skip", code: "needs_sign_in" };
  if (answer.status !== 200) return { kind: "skip", code: "http_error" };
  if (expect === "page" || expect === "session") return { kind: "ok" };
  // A download that lands on a work's page has no file to take.
  if (/^\/(?:collections\/[^/]+\/)?works\/[0-9]+/.test(landed.pathname)) return { kind: "skip", code: "no_download" };
  return answer.bytes && looksLikeFormat(expect, answer.bytes) ? { kind: "ok" } : { kind: "skip", code: "not_a_file" };
}

// --- File names -------------------------------------------------------------------

const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|clock\$)$/i;
/** Whole names, and the endings, Chrome refuses in any part of a path (net::IsSafePortablePathComponent). */
const RESERVED_WHOLE_NAMES = /^(?:desktop\.ini|thumbs\.db)$/i;
const SHELL_ENDING = /\.(local|lnk|\{[^.]*\})$/i;
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
  out = fitBytes(out, maxBytes).replace(/^[.\s-]+|[.\s]+$/g, "").replace(SHELL_ENDING, "-$1");
  if (!out) return fallback;
  // Windows refuses a reserved stem whatever follows it: `CON`, `con.txt`.
  return RESERVED_NAMES.test(out.split(".")[0] ?? "") || RESERVED_WHOLE_NAMES.test(out) ? `_${out}` : out;
}

/**
 * `<COPY_FOLDER>/<Fandom>/<Title> – <Author> (<work id>).<format>`, under Downloads.
 * The title and author give way to the length cap; ` (<work id>)`, any
 * `label` and the extension always stay.
 */
export function copyFilename(work: Pick<WorkPageRead, "workId" | "title" | "author" | "fandom">, format: CopyFormat, label?: string): string {
  const fandom = safeSegment(work.fandom, MAX_FANDOM_BYTES, "Unknown fandom");
  const tail = ` (${work.workId})${label ? ` (${safeSegment(label, 40, "")})` : ""}.${format}`;
  const room = MAX_NAME_BYTES - utf8.encode(tail).length;
  const author = safeSegment(work.author, Math.min(60, Math.floor(room / 3)), "Anonymous");
  const title = safeSegment(work.title, room - utf8.encode(` – ${author}`).length, "Untitled");
  return `${COPY_FOLDER}/${fandom}/${title} – ${author}${tail}`;
}

// --- The queue --------------------------------------------------------------------

export type Pace = "reader" | "check";

/** Tries of one request for one work before it is skipped; a background stopped mid-request counts. */
export const MAX_ATTEMPTS = 3;
/** A save the browser has not finished is looked at again after this long. */
export const SETTLE_RECHECK_MS = 2_000;
/** A link from a page is used this long at most; after, the page is read again first. */
export const LINK_MAX_AGE_MS = 5 * 60_000;
/** A save still unfinished after this long has failed. */
export const SETTLE_MAX_MS = 15 * 60_000;
/** One work's page and file, 6 to 7 s apart: the pace assumed until the real one is measured. */
export const WORK_PACE_MS = 2 * (PAGE_GAP_MS + PAGE_GAP_JITTER_MS / 2);
/** Works finished before the real pace is believed. */
export const PACE_MIN_WORKS = 3;
/** A longer gap between steps (the browser closed, a stop, a Pause) starts the measure again. */
export const PACE_GAP_MS = 5 * 60_000;

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
  /** The URL the copy was saved from: its own download is the one with it. A copy saved before it was kept has none. */
  readonly url?: string;
}

export interface KeptWork {
  workId: string;
  title: string;
  author: string;
  fandom: string;
  complete: boolean;
  /** Archive users only, once seen so (never unset): copied only by `#lockedStep`, its link never kept. */
  restricted: boolean;
  /** A locked work's `updated_at` on the reader's list when last looked at: its copy's version is its Chapter Index's. */
  listed?: string;
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
  /** When `link` was read. */
  linkAt?: number;
  /** Queued by a backup: the browser's download alerts stay hidden for it. */
  batch?: true;
  /** Requests made for the step this work is on. */
  attempts?: number;
  lastFailure?: "save" | "request";
  /** Asked for again, with no link, while its file was saving: looked at again once that save is over. */
  again?: true;
  /** The `updated_at` a list or page showed when a locked work was asked for: kept once its Chapter Index is read. */
  listed?: string;
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
  /** A locked work's list or page `updated_at` it was asked for: the one last seen, once this save is complete. */
  readonly listed?: string;
}

export interface ListRun {
  readonly purpose: "backup" | "check";
  readonly user: string;
  readonly lists: readonly ListName[];
  list: number;
  page: number;
  /** Works on the lists so far, each once. */
  found: number;
  /** "finished": the lists are read. A backup's queued works may still be going. */
  status: "running" | "finished";
  /** The works already counted in `found`. */
  seen?: string[];
  /** The reader pressed Pause: nothing in the queue is asked for until Resume. */
  held?: true;
  /** Where the real pace is measured from: works left then, and the last step. */
  pace?: { at: number; left: number; lastAt: number };
  /** Answers in a row from this list page that were no page and no slow-down from AO3: three end the list. */
  errors?: number;
  /** A list sent elsewhere: Bookmarks page 1 is read once more first, to tell whether the reader signed out. */
  confirm?: true;
}

export interface StoppedState {
  code: StopCode;
  until: number;
  /** Several tries in a row failed and AO3 gave no time to come back. */
  unavailable?: true;
}

export interface KeepState {
  v: 1;
  settings: Settings;
  user: string | null;
  works: Record<string, KeptWork>;
  queue: QueueItem[];
  run: ListRun | null;
  pending: PendingSave | null;
  /** A page has shown the reader signed out since a locked work was last looked at. */
  signedOutSeen?: true;
  pacer: {
    dueAt: number;
    window: { startedAt: number; reads: number };
    retries: number;
    /** Works in a row AO3 gave no copy of (`unreadable`). */
    misses: number;
    /** Saves in a row that failed (`save_failed`), counted apart so a stop names its own cause. */
    failedSaves?: number;
    /** Tries in a row that failed with no time from AO3. Several make it "unavailable". */
    failures?: number;
    /** AO3 gave a time to come back, and the next try waits for it: the reader sees a pause. */
    slowedUntil?: number;
    stopped: StoppedState | null;
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

export type SaveState = {
  readonly state: "complete" | "interrupted" | "in_progress";
  readonly filename: string | null;
  /** The save's id now, when the browser gave it another (ids are handed out again after a restart). */
  readonly downloadId?: number;
};

export interface KeepPorts {
  readonly clock: { now(): number };
  readonly random: () => number;
  read(): Promise<unknown>;
  write(state: KeepState): Promise<void>;
  /** `include` only for the reader's own lists and a locked work's Chapter Index; a work page is read signed out. */
  fetchPage(url: string, credentials: "omit" | "include"): Promise<Fetched>;
  /** `include` only for a locked work's file (`#lockedStep`). */
  fetchFile(url: string, credentials: "omit" | "include"): Promise<Fetched>;
  /** Starts saving under Downloads; resolves with the download's id. */
  save(request: SaveRequest): Promise<number>;
  /**
   * Where a save stands, waiting a little for it to finish. The save is known by its own URL
   * (`handle`), not only its id, which the browser can give another download after a restart:
   * found by neither, it is lost (`interrupted`), and no one else's download is taken for it.
   */
  settle(downloadId: number, handle: string): Promise<SaveState>;
  /** Lets a file's URL go once its save is over. */
  release?(handle: string): void;
  /** Gives up a save that never finished, and forgets it, with any part-written file: only the save with this URL. */
  cancel?(downloadId: number, handle: string): Promise<void>;
  /** Deletes a file, only if it is still this extension's file at that name. */
  /**
   * Deletes a copy's file, only while its download is still the copy's own (the one with its URL)
   * and at its name. With no URL known, the copy is only forgotten: its file is never deleted.
   */
  remove(downloadId: number, filename: string, url?: string): Promise<void>;
  /** Told when a backup starts and ends (Chrome hides its download bubble meanwhile). */
  quiet?(on: boolean): void;
}

export interface BackupView {
  readonly state: "running" | "stopped";
  /** Works handled so far, of those found on the lists so far. */
  readonly done: number;
  readonly total: number;
  /** Still reading the lists: the total can grow, so no estimate yet. */
  readonly readingLists: boolean;
  /** Time left at the pace measured so far; null while it cannot be said (or AO3 has stopped the queue). */
  readonly estimateMs: number | null;
}

export interface KeepView {
  readonly settings: Settings;
  readonly user: string | null;
  readonly kept: number;
  readonly withCopy: number;
  readonly waiting: number;
  readonly skipped: Partial<Record<SkipCode, number>>;
  readonly run: { purpose: ListRun["purpose"]; status: ListRun["status"]; list: ListName | null; page: number; found: number } | null;
  readonly stopped: StoppedState | null;
  readonly backup: BackupView | null;
  /** When the last copy was saved. */
  readonly lastCopyAt: number | null;
}

function isState(value: unknown): value is KeepState {
  const state = value as Partial<KeepState> | null;
  return Boolean(state && state.v === 1 && state.settings && state.works && Array.isArray(state.queue) && state.pacer);
}

const backoff = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
const batchLeft = (state: KeepState) => state.queue.filter((queued) => queued.batch).length;
const backupOf = (state: KeepState) => (state.run?.purpose === "backup" ? state.run : null);
/** A backup still going, by reading its lists or copying what they found. */
function backupBusy(state: KeepState): boolean {
  const run = backupOf(state);
  return run !== null && (run.status === "running" || batchLeft(state) > 0);
}

export class KeepACopy {
  #state: KeepState | null = null;
  /** Requests sent by this background: a step that sent none is no read against the window, nor a try. */
  #sent = 0;
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
    const now = this.ports.clock.now();
    const pacer = state.pacer;
    // Between its tries, still unavailable: only an answer from AO3 ends it.
    const stopped: StoppedState | null = pacer.stopped && pacer.stopped.until > now ? { ...pacer.stopped }
      : (pacer.failures ?? 0) >= MAX_CONSECUTIVE_RETRIES ? { code: "slow_down", until: pacer.dueAt, unavailable: true }
      : (pacer.slowedUntil ?? 0) > now ? { code: "slow_down", until: pacer.slowedUntil as number }
      : null;
    return {
      settings: structuredClone(state.settings),
      user: state.user,
      kept: works.length,
      withCopy: works.filter((w) => w.copy).length,
      waiting: state.queue.length,
      skipped,
      run: run ? { purpose: run.purpose, status: run.status, list: run.lists[run.list] ?? null, page: run.page, found: run.found } : null,
      stopped,
      backup: this.#backupView(state, stopped !== null, now),
      lastCopyAt: works.reduce<number | null>((last, work) => (work.copy && work.copy.savedAt > (last ?? 0) ? work.copy.savedAt : last), null),
    };
  }

  #backupView(state: KeepState, siteStopped: boolean, now: number): BackupView | null {
    const run = backupOf(state);
    if (!run || !backupBusy(state)) return null;
    const left = batchLeft(state);
    const readingLists = run.status === "running";
    const measured = run.pace && run.pace.left - left >= PACE_MIN_WORKS ? (now - run.pace.at) / (run.pace.left - left) : null;
    return {
      state: run.held ? "stopped" : "running",
      done: Math.max(0, run.found - left),
      total: run.found,
      readingLists,
      estimateMs: readingLists || siteStopped || run.held ? null : left * (measured ?? WORK_PACE_MS),
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
      if (user && AO3_USERNAME_PATTERN.test(user)) {
        state.user = user;
        // Only the reader whose lists the run reads ends its sign-out stop.
        if (state.pacer.stopped?.code === "signed_out" && (!state.run || state.run.user === user)) state.pacer.stopped = null;
        // Signed in again: the locked works copy on their own, at the queue's pace.
        if (state.signedOutSeen && state.settings.enabled) {
          delete state.signedOutSeen;
          this.#requeue(state, ["needs_sign_in"]);
        }
      } else if (user === null) {
        state.signedOutSeen = true;
      }
    });
  }

  /** Try again: back in the queue, at its pace and under its stops. */
  retrySkipped(): Promise<void> {
    return this.#serial((state) => {
      if (state.settings.enabled) this.#requeue(state, RETRYABLE_SKIPS);
    });
  }

  #requeue(state: KeepState, codes: readonly SkipCode[]): void {
    for (const { workId, skipped } of Object.values(state.works)) {
      if (!skipped || !codes.includes(skipped)) continue;
      this.#keep(state, workId).skipped = null;
      this.#enqueue(state, { workId, pace: "reader" });
    }
  }

  /** A work page the reader has open, with what they just did on it. */
  notePage(page: WorkPageRead, trigger: Trigger | "visit"): Promise<void> {
    return this.#serial((state) => {
      if (!this.#keeps(state, page.workId, trigger)) return;
      const work = this.#keep(state, page.workId, page);
      const link = page.downloads[state.settings.format];
      if (work.restricted) {
        // A locked work's link is never taken, only its `updated_at` (the number alone): its
        // Chapter Index is read again only when that has moved since it was last read.
        const at = Object.values(page.downloads)[0]?.updatedAt ?? null;
        if (!work.copy || work.copy.format !== state.settings.format || (at !== null && at !== work.listed)) this.#enqueue(state, { workId: work.workId, pace: "reader", ...(at === null ? {} : { listed: at }) }, true);
      } else if (link && (!work.copy || work.copy.updatedAt !== link.updatedAt || work.copy.format !== state.settings.format)) {
        this.#enqueue(state, { workId: work.workId, pace: "reader", link });
      }
    });
  }

  /** A work acted on from a page with no Download menu (its bookmark form): its page is read. */
  noteWork(workId: string, trigger: Trigger): Promise<void> {
    return this.#serial((state) => {
      if (!this.#keeps(state, workId, trigger)) return;
      if (!this.#keep(state, workId).copy) this.#enqueue(state, { workId, pace: "reader" }, true);
    });
  }

  startBackup(): Promise<"started" | "running" | "no_user"> {
    return this.#serial((state) => {
      if (!state.user) return "no_user";
      if (backupBusy(state)) return "running";
      state.run = { purpose: "backup", user: state.user, lists: BACKUP_LISTS, list: 0, page: 1, found: 0, status: "running" };
      return "started";
    });
  }

  /** The reader's Pause: a save under way finishes, and nothing more is asked for. */
  stopBackup(): Promise<void> {
    return this.#serial((state) => {
      const run = backupOf(state);
      if (run && backupBusy(state)) run.held = true;
      this.#setQuiet(this.#batchRunning(state));
    });
  }

  /** Resume: picks up where it stopped, at the same pace and under the same stops. */
  resumeBackup(): Promise<void> {
    return this.#serial((state) => {
      const run = backupOf(state);
      if (run) delete run.held;
      this.#setQuiet(this.#batchRunning(state));
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
    // Locked stays locked.
    if (page?.restricted === true) work.restricted = true;
    return work;
  }

  /** `news`: the reader acted, or a list or the Library says the work changed (not a routine look). */
  #enqueue(state: KeepState, item: QueueItem, news = false): void {
    if (item.link && state.works[item.workId]?.restricted) {
      // No link of a locked work is ever kept or used.
      const { link: _dropped, ...rest } = item;
      item = rest;
    }
    if (item.link) item = { ...item, linkAt: this.ports.clock.now() };
    const queued = state.queue.find((each) => each.workId === item.workId);
    if (!queued) {
      state.queue.push(item);
      return;
    }
    // A newer link, or the reader's own pace, wins over what was queued.
    if (item.link) {
      queued.link = item.link;
      if (item.linkAt !== undefined) queued.linkAt = item.linkAt;
    } else if (news && state.pending?.workId === item.workId) {
      queued.again = true;
    }
    if (item.listed !== undefined) queued.listed = item.listed;
    if (item.pace === "reader") queued.pace = "reader";
    // On a backup's lists too: it counts, and waits, with the backup.
    if (item.batch) queued.batch = true;
  }

  #drop(state: KeepState, workId: string): void {
    state.queue = state.queue.filter((queued) => queued.workId !== workId);
  }

  #batchRunning(state: KeepState): boolean {
    const now = this.ports.clock.now();
    if (!state.settings.enabled || (state.pacer.stopped && state.pacer.stopped.until > now)) return false;
    if (backupOf(state)?.held) return false;
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
    const backup = backupOf(state);
    // Nothing of it left to hold: what was held with it goes on.
    if (backup?.held && !backupBusy(state)) delete backup.held;
    if (!backupBusy(state) && state.run?.status !== "running" && state.settings.weeklyCheck && state.user && now - pacer.lastCheckAt >= CHECK_EVERY_MS) {
      state.run = { purpose: "check", user: state.user, lists: CHECK_LISTS, list: 0, page: 1, found: 0, status: "running" };
    }
    const held = backupOf(state)?.held === true;
    const running = state.run?.status === "running" && !held ? state.run : null;
    // A backup reads its lists first, so its total is known before its works go.
    const listing = backupOf(state)?.status === "running";
    const waits = (queued: QueueItem) => held || (queued.batch === true && listing);
    const item = state.queue.find((queued) => queued.pace === "reader" && !waits(queued)) ?? (running ? null : state.queue.find((queued) => !waits(queued)) ?? null);
    const pace: Pace | null = item ? item.pace : running ? (running.purpose === "backup" ? "reader" : "check") : null;
    if (!pace) {
      pacer.failures = 0;
      return null;
    }
    if (now - pacer.window.startedAt >= WINDOW_MS) pacer.window = { startedAt: now, reads: 0 };
    if (pace === "check" && pacer.window.reads >= WINDOW_MAX_READS) return pacer.window.startedAt + WINDOW_MS - now;
    if (now < pacer.dueAt) return pacer.dueAt - now;

    if (item?.batch && backup) {
      const left = batchLeft(state);
      if (!backup.pace || now - backup.pace.lastAt > PACE_GAP_MS || left > backup.pace.left) backup.pace = { at: now, left, lastAt: now };
      else backup.pace.lastAt = now;
    }
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

    const sentBefore = this.#sent;
    const verdict = item ? await this.#workStep(state, item) : await this.#listStep(state, running!);
    const after = this.ports.clock.now();
    pacer.dueAt = Math.max(pacer.dueAt, after + gap);
    // Nothing was sent in this step: it takes nothing from the window's cap.
    const sentNothing = this.#sent === sentBefore;
    if (sentNothing) pacer.window.reads = Math.max(0, pacer.window.reads - 1);
    // AO3 refusing or slowing everyone down, or no answer at all, is not this work's fault; nor is a busy
    // fetcher, unless the step sent its page first.
    const siteWide = (verdict.kind === "stop" && verdict.code !== "unreadable" && verdict.code !== "save_failed")
      || (verdict.kind === "retry" && (!verdict.busy || sentNothing));
    if (item && siteWide) item.attempts = Math.max(0, (item.attempts ?? 1) - 1);
    // No answer: the next work goes first, so one file that never arrives holds up no other.
    if (item && verdict.kind === "retry" && verdict.network) {
      this.#drop(state, item.workId);
      state.queue.push(item);
    }
    const failed = (verdict.kind === "retry" && !verdict.busy) || (verdict.kind === "stop" && !NOT_AO3_FAILING.includes(verdict.code));
    const timeFromAO3 = failed && verdict.waitMs !== null && !(verdict.kind === "retry" && verdict.own);
    if (failed) pacer.failures = timeFromAO3 ? 0 : (pacer.failures ?? 0) + 1;
    else if (verdict.kind !== "retry" && !(verdict.kind === "stop" && verdict.code === "save_failed")) pacer.failures = 0;
    if (verdict.kind === "retry" && verdict.busy) {
      // AO3 refused nothing: no step toward a stop.
      pacer.dueAt = after + (verdict.waitMs ?? NETWORK_RETRY_MS);
    } else if (verdict.kind === "retry") {
      pacer.retries += 1;
      if (pacer.retries >= MAX_CONSECUTIVE_RETRIES) {
        this.#stop(state, "slow_down", timeFromAO3 ? verdict.waitMs : null, after);
      } else {
        pacer.dueAt = after + Math.min(STOP_MAX_MS, Math.max(backoff(pacer.retries), verdict.waitMs ?? 0));
        if (timeFromAO3) pacer.slowedUntil = pacer.dueAt;
      }
    } else {
      pacer.retries = 0;
      if (verdict.kind === "stop") this.#stop(state, verdict.code, verdict.waitMs, after);
    }
    // (Read again: #stop may have set it since the check above.)
    const stopped = state.pacer.stopped as KeepState["pacer"]["stopped"];
    return Math.max(0, (stopped?.until ?? pacer.dueAt) - after);
  }

  /** One request through the ports, counted unless nothing was sent (`busy`). */
  async #fetch(url: string, as: "page" | "file", credentials: "omit" | "include"): Promise<Fetched> {
    const answer = as === "page" ? await this.ports.fetchPage(url, credentials) : await this.ports.fetchFile(url, credentials);
    if (answer.kind !== "failed" || answer.code !== "busy") this.#sent += 1;
    return answer;
  }

  #stop(state: KeepState, code: StopCode, waitMs: number | null, now: number): void {
    state.pacer.retries = 0;
    state.pacer.misses = 0;
    state.pacer.failedSaves = 0;
    // Never on one failure: one check page or refusal with no time is a pause, at this queue's own hour.
    const unavailable = waitMs === null && !NOT_AO3_FAILING.includes(code) && (state.pacer.failures ?? 0) >= MAX_CONSECUTIVE_RETRIES;
    // Signed out: nothing to gain by asking soon. The next signed-in page ends it.
    const wait = code === "signed_out" ? STOP_MAX_MS : Math.min(STOP_MAX_MS, Math.max(STOP_MS, waitMs ?? 0));
    state.pacer.stopped = { code, until: now + wait, ...(unavailable ? { unavailable: true as const } : {}) };
  }

  /**
   * A work's file that was not saved waits longer each time and is skipped
   * after MAX_ATTEMPTS; several in a row (a full disk) stop the queue.
   */
  #saveFailed(state: KeepState, workId: string, now: number): Verdict | null {
    const item = state.queue.find((queued) => queued.workId === workId);
    if (item) item.lastFailure = "save";
    state.pacer.dueAt = Math.max(state.pacer.dueAt, now + backoff(item?.attempts ?? 1));
    state.pacer.failedSaves = (state.pacer.failedSaves ?? 0) + 1;
    return state.pacer.failedSaves >= MISSES_MAX ? { kind: "stop", code: "save_failed", waitMs: null } : null;
  }

  /** Per-work failures that are not the site's fault; several in a row are. Only a completed save clears them. */
  #miss(state: KeepState): Verdict | null {
    state.pacer.misses += 1;
    return state.pacer.misses >= MISSES_MAX ? { kind: "stop", code: "unreadable", waitMs: null } : null;
  }

  async #workStep(state: KeepState, item: QueueItem): Promise<Verdict> {
    const work = this.#keep(state, item.workId);
    const format = state.settings.format;
    const skip = this.#skipper(state, item, work);
    if (work.restricted) {
      delete item.link;
      return this.#lockedStep(state, item, work);
    }
    // A link for another format was queued before the setting changed, or one read a while ago: read the page.
    if (item.link && (readDownloadLink(item.link.url)?.format !== format || this.ports.clock.now() - (item.linkAt ?? 0) > LINK_MAX_AGE_MS)) {
      delete item.link;
      delete item.linkAt;
    }
    if (!item.link) {
      const answer = await this.#fetch(`${AO3_ORIGIN}/works/${item.workId}?view_adult=true`, "page", "omit");
      const verdict = classifyAnswer(answer, "page", this.ports.clock.now());
      const page = answer.kind === "response" && verdict.kind === "ok" ? readWorkPage(answer.text ?? "") : null;
      // AO3's sign-in page, or (never, read signed out) the lock: a locked work, copied in its own next step.
      if ((verdict.kind === "skip" && verdict.code === "needs_sign_in") || (verdict.kind === "ok" && (page ? page.restricted : isRestrictedPage(answer.kind === "response" ? answer.text ?? "" : "")))) {
        return this.#nowLocked(item, work, verdict);
      }
      if (verdict.kind === "skip") return skip(verdict.code);
      if (verdict.kind !== "ok") return verdict;
      const link = page?.workId === item.workId ? page.downloads[format] : undefined;
      if (!page || !link) return skip("no_download");
      this.#keep(state, item.workId, page);
      if (work.copy?.updatedAt === link.updatedAt && work.copy.format === format) {
        this.#drop(state, item.workId);
        return verdict;
      }
      item.link = link;
      item.linkAt = this.ports.clock.now();
      item.attempts = 0;
      return verdict;
    }
    return this.#fileStep(state, item, work, item.link, "omit");
  }

  /** Skips a work: gone or locked is no miss; anything else is one. */
  #skipper(state: KeepState, item: QueueItem, work: KeptWork): (code: SkipCode) => Verdict {
    return (code) => {
      work.skipped = code;
      this.#drop(state, item.workId);
      return code === "gone" || code === "needs_sign_in" ? { kind: "skip", code } : this.#miss(state) ?? { kind: "skip", code };
    };
  }

  /** A public work found locked: it stays queued, and its next step is `#lockedStep`. */
  #nowLocked(item: QueueItem, work: KeptWork, verdict: Verdict): Verdict {
    work.restricted = true;
    delete item.link;
    item.attempts = 0;
    return verdict;
  }

  /**
   * A locked work (AO3 shows it to signed-in readers only), and the one place
   * one is copied. Its work and chapter pages are never read signed in; its
   * Chapter Index is. A login page, or the index shown signed out, is
   * `needs_sign_in` (no miss, no stop, copied once a page shows the reader
   * signed in again); anything else is classified as any page is.
   */
  async #lockedStep(state: KeepState, item: QueueItem, work: KeptWork): Promise<Verdict> {
    const format = state.settings.format;
    const skip = this.#skipper(state, item, work);
    const answer = await this.#fetch(`${AO3_ORIGIN}/works/${work.workId}/navigate`, "page", "include");
    const verdict = classifyAnswer(answer, "session", this.ports.clock.now());
    if (verdict.kind === "skip") return skip(verdict.code);
    if (verdict.kind !== "ok" || answer.kind !== "response") return verdict;
    const index = readChapterIndex(answer.text ?? "");
    // Only this same work's Chapter Index, shown just now to the signed-in reader.
    if (index?.workId === work.workId && index.signedIn === false) return skip("needs_sign_in");
    if (index?.workId !== work.workId || index.signedIn !== true) return skip("no_download");
    this.#keep(state, work.workId, { title: index.title, author: index.author });
    const version = lockedVersion(index);
    if (work.copy?.updatedAt === version && work.copy.format === format) {
      // Unchanged: the list's or page's `updated_at` it was asked for is now the one last seen.
      if (item.listed !== undefined) work.listed = item.listed;
      this.#drop(state, item.workId);
      return verdict;
    }
    // A locked work's file is fetched only here, right after the signed-in
    // Chapter Index read for that work, and its URL is never kept.
    return this.#fileStep(state, item, work, { url: lockedFileURL(work.workId, index.title, format, version), updatedAt: version }, "include", item.listed);
  }

  /** `listed`: a locked work's list or page `updated_at`, kept with the save and as last seen only once it is complete. */
  async #fileStep(state: KeepState, item: QueueItem, work: KeptWork, link: DownloadLink, credentials: "omit" | "include", listed?: string): Promise<Verdict> {
    const format = state.settings.format;
    const skip = this.#skipper(state, item, work);
    const answer = await this.#fetch(link.url, "file", credentials);
    const verdict = classifyAnswer(answer, format, this.ports.clock.now());
    const handle = answer.kind === "response" ? answer.handle : undefined;
    if (verdict.kind !== "ok" && handle) this.ports.release?.(handle);
    // A public work's file sent to the sign-in page: it is locked now.
    if (verdict.kind === "skip" && verdict.code === "needs_sign_in" && credentials === "omit") return this.#nowLocked(item, work, verdict);
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
      state.pending = {
        workId: item.workId, downloadId, filename, bytes: size, format, updatedAt: link.updatedAt, setAside: shrank, handle, startedAt: this.ports.clock.now(),
        ...(listed !== undefined ? { listed } : {}),
      };
    } catch {
      this.ports.release?.(handle);
      return this.#saveFailed(state, item.workId, this.ports.clock.now()) ?? verdict;
    }
    return verdict;
  }

  async #settle(state: KeepState, pending: PendingSave): Promise<number> {
    const result = await this.ports.settle(pending.downloadId, pending.handle).catch((): SaveState => ({ state: "interrupted", filename: null }));
    const now = this.ports.clock.now();
    if (result.state === "in_progress" && now - pending.startedAt < SETTLE_MAX_MS) return SETTLE_RECHECK_MS;
    state.pending = null;
    // Never finished, or cut off (a browser quit mid-save): given up and forgotten, so the browser neither
    // goes on reading a URL let go below nor keeps a part-written file.
    if (result.state !== "complete") await this.ports.cancel?.(pending.downloadId, pending.handle).catch(() => undefined);
    this.ports.release?.(pending.handle);
    // Interrupted, or never finished: the old copy stays as it was.
    if (result.state !== "complete") {
      const stop = this.#saveFailed(state, pending.workId, now);
      if (stop?.kind === "stop") this.#stop(state, stop.code, null, now);
      return Math.max(0, (state.pacer.stopped?.until ?? state.pacer.dueAt) - now);
    }
    state.pacer.misses = 0;
    state.pacer.failedSaves = 0;
    const work = this.#keep(state, pending.workId);
    const old = work.copy;
    const downloadId = result.downloadId ?? pending.downloadId;
    if (old && pending.setAside) {
      work.setAside.push(old.filename);
    } else if (old && old.downloadId !== downloadId && old.filename !== pending.filename) {
      await this.ports.remove(old.downloadId, old.path ?? old.filename, old.url).catch(() => undefined);
    }
    work.copy = {
      downloadId, filename: pending.filename, path: result.filename, bytes: pending.bytes,
      format: pending.format, updatedAt: pending.updatedAt, savedAt: now, url: pending.handle,
    };
    if (pending.listed !== undefined) work.listed = pending.listed;
    work.skipped = null;
    // A newer link came while this one was saving, or the work was asked for
    // again: it is still to be fetched, or its page read again.
    const queued = state.queue.find((each) => each.workId === pending.workId);
    const newer = queued?.link !== undefined && queued.link.updatedAt !== pending.updatedAt;
    if (queued && (newer || queued.again)) {
      if (!newer) delete queued.link;
      queued.attempts = 0;
      delete queued.lastFailure;
      delete queued.again;
    } else {
      this.#drop(state, pending.workId);
    }
    return Math.max(0, state.pacer.dueAt - now);
  }

  async #listStep(state: KeepState, run: ListRun): Promise<Verdict> {
    const list = run.lists[run.list];
    if (!list) {
      run.status = "finished";
      return { kind: "ok" };
    }
    const signedOut: Verdict = { kind: "stop", code: "signed_out", waitMs: null };
    if (run.confirm) return this.#confirmList(state, run);
    // The reader's own lists, with their session: Marked for Later and Subscriptions are theirs alone.
    const answer = await this.#fetch(listPageURL(run.user, list, run.page), "page", "include");
    // Sent elsewhere (not followed): signed out, as far as is known, or else asked once more (#confirmList).
    if (answer.kind === "redirect") {
      // Another reader is signed in now: the run ends, with nothing more asked (a check, not done, comes again).
      if (state.user !== run.user) {
        this.#endRun(state, run, false);
        return { kind: "ok" };
      }
      if (state.signedOutSeen) return signedOut;
      run.confirm = true;
      return { kind: "ok" };
    }
    const verdict = classifyAnswer(answer, "session", this.ports.clock.now());
    if (verdict.kind === "skip") {
      // A list page shown signed out: the reader signed out.
      if (verdict.code === "needs_sign_in") return signedOut;
      // Gone: that list is over. Any other answer is tried again, three times in all, then that list is over too.
      run.errors = verdict.code === "gone" ? MAX_ATTEMPTS : (run.errors ?? 0) + 1;
      if (run.errors >= MAX_ATTEMPTS) this.#nextList(state, run);
      return verdict;
    }
    if (verdict.kind !== "ok" || answer.kind !== "response") return verdict;
    delete run.errors;
    const read = readListPage(answer.text ?? "", list);
    for (const listed of read.works) {
      const known = state.works[listed.workId];
      // A locked copy's version is not the list's: the list's own `updated_at` is compared with the one its Chapter Index was last read for.
      const stale = (work: KeptWork) => !work.copy || (listed.updatedAt !== null && listed.updatedAt !== (work.restricted ? work.listed : work.copy.updatedAt));
      const seen = listed.updatedAt === null ? {} : { listed: listed.updatedAt };
      if (run.purpose === "backup") {
        // Subscriptions show no chapter count, so they leave `complete` as it was.
        const work = this.#keep(state, listed.workId, list === "subscriptions" ? {} : { complete: listed.complete, restricted: listed.restricted });
        if (stale(work)) this.#enqueue(state, { workId: listed.workId, pace: "reader", batch: true, ...seen });
      } else if (known?.copy && !listed.complete) {
        if (listed.restricted) known.restricted = true;
        if (!stale(known)) continue;
        known.complete = listed.complete;
        this.#enqueue(state, { workId: listed.workId, pace: "check", ...seen }, true);
      }
    }
    if (run.purpose === "backup") {
      const seen = new Set(run.seen ?? []);
      for (const listed of read.works) seen.add(listed.workId);
      run.seen = [...seen];
      run.found = seen.size;
    } else {
      run.found += read.works.length;
    }
    if (read.next && run.page < MAX_LIST_PAGES) run.page += 1;
    else this.#nextList(state, run);
    return verdict;
  }

  /**
   * After a list sent elsewhere: Bookmarks page 1, read once more with the
   * reader's session, tells. Shown signed out, the reader signed out; shown
   * to them, only that list sent them elsewhere, and it is over.
   */
  async #confirmList(state: KeepState, run: ListRun): Promise<Verdict> {
    const answer = await this.#fetch(listPageURL(run.user, "bookmarks", 1), "page", "include");
    const verdict: Verdict = answer.kind === "redirect" ? { kind: "skip", code: "no_download" } : classifyAnswer(answer, "session", this.ports.clock.now());
    // AO3 slowing down or refusing: asked again after it.
    if (verdict.kind === "retry" || verdict.kind === "stop") return verdict;
    if (verdict.kind === "skip" && verdict.code === "needs_sign_in") {
      delete run.confirm;
      return { kind: "stop", code: "signed_out", waitMs: null };
    }
    if (verdict.kind === "ok" && answer.kind === "response" && pageSignedIn(answer.text ?? "") === true) {
      delete run.confirm;
      this.#nextList(state, run);
      return verdict;
    }
    // Anything else tells nothing: read again, three times in all, then that list is over.
    run.errors = (run.errors ?? 0) + 1;
    if (run.errors >= MAX_ATTEMPTS) {
      delete run.confirm;
      this.#nextList(state, run);
    }
    return verdict.kind === "skip" ? verdict : { kind: "skip", code: "http_error" };
  }

  /** The run goes on with its next list, or ends with its last. */
  #nextList(state: KeepState, run: ListRun): void {
    delete run.errors;
    run.list += 1;
    run.page = 1;
    if (run.list >= run.lists.length) this.#endRun(state, run, true);
  }

  /** `done`: every list was read; a check ended early is not done, and comes again. */
  #endRun(state: KeepState, run: ListRun, done: boolean): void {
    delete run.errors;
    delete run.confirm;
    run.status = "finished";
    if (run.purpose !== "check") return;
    if (done) state.pacer.lastCheckAt = this.ports.clock.now();
    state.run = null;
  }
}
