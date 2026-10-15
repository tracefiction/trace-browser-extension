/**
 * FanFiction.net summaries for stories saved from a page that shows none.
 *
 * On iPhone, FanFiction.net serves its mobile layout for a story, and that
 * layout has no summary, so a story saved there reaches the Library without
 * one. The author's story list (`https://m.fanfiction.net/u/<author>/?a=s`)
 * shows every story of theirs with its summary. This reads that list from the
 * reader's own browser and sends only the summaries, as a metadata
 * contribution for stories already in the reader's Library.
 *
 * - On save: a story newly saved from an FFN story page with no summary is
 *   read straight after the save. The page names its author, so that is one
 *   request; when it did not (a save made another way), the story's own page
 *   is read first for the author, then the list.
 * - Backfill: the reader's other saved FFN stories that no one has a summary
 *   for (the server lists at most 50) are read one request at a time, minutes
 *   apart, only while the reader is on FanFiction.net, never while a save or
 *   a page load is under way, and a few requests per browsing session. One
 *   author's list fills every waiting story of theirs on it.
 *
 * It stays small and leaves nothing behind: one request at a time, each with
 * a time limit; page text is read only as far as needed and then dropped; no
 * tab, frame or page is opened; nothing is cached. The only state is the
 * story (and author) ids still to fill and a few counters, kept in
 * session-only storage when the browser has it (memory otherwise), and
 * removed on sign-out or when the account changes. Any refusal, challenge
 * page, unexpected address, unreadable page or error stops it for the rest of
 * the session; it never retries in a loop. A story missing from its author's
 * first page of stories is dropped; no further pages are read.
 */

export const FFN_SUMMARY_HOST_PATTERN = "https://m.fanfiction.net/*";
export const FFN_SUMMARY_STATE_KEY = "traceFfnSummaryFillV1";

/** Wait after the last FanFiction.net page signal before a backfill request. */
export const BACKFILL_SETTLE_MS = 20_000;
/** How stale the last FanFiction.net page signal may be when a step runs. */
const FFN_PRESENCE_GRACE_MS = 10_000;
/** Least time between two backfill requests. */
export const BACKFILL_GAP_MS = 3 * 60_000;
/** Backfill requests per browsing session. */
export const BACKFILL_MAX_PER_SESSION = 10;
/** Saves read straight away, per browsing session. */
export const ON_SAVE_MAX_PER_SESSION = 30;
/** Stories kept to fill, at most. */
export const QUEUE_MAX = 50;
export const FETCH_TIMEOUT_MS = 10_000;
/** No page is read further than this. */
export const MAX_READ_BYTES = 256 * 1_024;
/** The author link sits near the top of a story page. */
const STORY_PAGE_MAX_READ_BYTES = 64 * 1_024;
const ROW_MAX_CHARS = 8_192;
const SUMMARY_MAX_CHARS = 4_000;
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ON_SAVE_PENDING_MAX = 5;
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

const STORY_CONTENT_PATTERN = /<div\b[^>]*\bid\s*=\s*["']?(?:content|profile_top)\b[^>]*>/i;
const AUTHOR_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/u\/([1-9][0-9]{0,19})(?:[/?#"'])/i;

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

const ROW_START_PATTERN = /<div\b[^>]*\bclass\s*=\s*["'](?:[^"']*\s)?bs(?:\s[^"']*)?["'][^>]*>/gi;
const ROW_STORY_LINK_PATTERN = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/s\/([1-9][0-9]{0,19})\/[^>]*>/i;
const ROW_GRAY_PATTERN = /<div\b[^>]*\bclass\s*=\s*["'](?:[^"']*\s)?gray(?:\s[^"']*)?["'][^>]*>/i;

/**
 * The stories on a FanFiction.net mobile story list (an author's stories, or
 * any list in the same rows): each row (`div.bs`) links its story first, and
 * the summary is the text after the row's last link and before its gray
 * details line. A bounded string read: no DOM and no rendering. Returns the
 * rows it could read, by story id, and how many story rows the page had.
 */
export function ffnSummariesFromStoryListHtml(html: string): {
  readonly rows: number;
  readonly summaries: ReadonlyMap<string, string>;
} {
  const summaries = new Map<string, string>();
  if (typeof html !== "string") return { rows: 0, summaries };
  const starts: number[] = [];
  ROW_START_PATTERN.lastIndex = 0;
  for (let match = ROW_START_PATTERN.exec(html); match !== null; match = ROW_START_PATTERN.exec(html)) {
    starts.push(match.index);
  }
  let rows = 0;
  starts.forEach((start, index) => {
    const end = Math.min(starts[index + 1] ?? html.length, start + ROW_MAX_CHARS);
    const row = html.slice(start, end);
    const story = ROW_STORY_LINK_PATTERN.exec(row);
    const gray = ROW_GRAY_PATTERN.exec(row);
    if (story === null || gray === null) return;
    rows += 1;
    const beforeGray = row.slice(0, gray.index);
    const lastLinkEnd = beforeGray.toLowerCase().lastIndexOf("</a>");
    if (lastLinkEnd === -1) return;
    const summary = plainText(beforeGray.slice(lastLinkEnd + 4)).slice(0, SUMMARY_MAX_CHARS);
    const storyId = story[1]!;
    if (summary && !summaries.has(storyId)) summaries.set(storyId, summary);
  });
  return { rows, summaries };
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

// --- Reading one page ------------------------------------------------------------

export type StopReason =
  | "status"
  | "redirect"
  | "challenge"
  | "not_html"
  | "missing"
  | "error";

export interface FillClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  enough: (text: string) => boolean,
): Promise<string> {
  const body = response.body;
  // Without a stream the page cannot be read in bounds, so it is not read.
  if (!body || typeof body.getReader !== "function") return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes || enough(text)) break;
    }
  } finally {
    // The rest of the page is never downloaded.
    void reader.cancel().catch(() => undefined);
  }
  return text;
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * One GET to m.fanfiction.net in the reader's own browser, with its own
 * FanFiction.net session and no cache. The page must end at the address
 * asked for; its text is read only until `enough` says so.
 */
async function readFfnPage(
  fetchImpl: typeof fetch,
  clock: FillClock,
  request: {
    readonly url: string;
    readonly expectedPath: (pathname: string) => boolean;
    readonly maxBytes: number;
    readonly enough: (text: string) => boolean;
  },
): Promise<{ readonly kind: "page"; readonly html: string } | { readonly kind: "stop"; readonly reason: StopReason }> {
  const abort = new AbortController();
  const timer = clock.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html" },
      signal: abort.signal,
    });
    let landed: URL | null = null;
    try {
      landed = new URL(response.url);
    } catch {
      landed = null;
    }
    if (
      landed === null ||
      landed.protocol !== "https:" ||
      landed.hostname !== "m.fanfiction.net" ||
      !request.expectedPath(landed.pathname)
    ) {
      discard(response);
      return { kind: "stop", reason: "redirect" };
    }
    const challenged = response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
    if (response.status !== 200 || challenged) {
      discard(response);
      return { kind: "stop", reason: challenged ? "challenge" : "status" };
    }
    if (!/text\/html/i.test(response.headers.get("content-type") ?? "")) {
      discard(response);
      return { kind: "stop", reason: "not_html" };
    }
    const html = await readBounded(response, request.maxBytes, request.enough);
    if (isChallengePage(html)) return { kind: "stop", reason: "challenge" };
    return { kind: "page", html };
  } catch {
    return { kind: "stop", reason: "error" };
  } finally {
    clock.clearTimeout(timer);
  }
}

export type AuthorLookup =
  | { readonly kind: "found"; readonly authorId: string }
  | { readonly kind: "stop"; readonly reason: StopReason };

/** The author of one story, from the top of its own page. */
export async function lookUpFfnAuthorId(
  fetchImpl: typeof fetch,
  storyId: string,
  clock: FillClock,
): Promise<AuthorLookup> {
  if (!ID_PATTERN.test(storyId)) return { kind: "stop", reason: "error" };
  const page = await readFfnPage(fetchImpl, clock, {
    url: `https://m.fanfiction.net/s/${storyId}/1/`,
    expectedPath: (pathname) => pathname === `/s/${storyId}` || pathname.startsWith(`/s/${storyId}/`),
    maxBytes: STORY_PAGE_MAX_READ_BYTES,
    enough: (text) => ffnAuthorIdFromStoryHtml(text) !== null,
  });
  if (page.kind === "stop") return page;
  const authorId = ffnAuthorIdFromStoryHtml(page.html);
  return authorId === null
    ? { kind: "stop", reason: "missing" }
    : { kind: "found", authorId };
}

export type AuthorStoriesRead =
  | { readonly kind: "found"; readonly summaries: ReadonlyMap<string, string> }
  | { readonly kind: "stop"; readonly reason: StopReason };

/**
 * The summaries of the wanted stories on the first page of an author's
 * story list. A page with no story rows at all is unreadable (stop); a page
 * that has rows but not a wanted story simply leaves it out.
 */
export async function readFfnAuthorSummaries(
  fetchImpl: typeof fetch,
  authorId: string,
  wanted: readonly string[],
  clock: FillClock,
): Promise<AuthorStoriesRead> {
  if (!ID_PATTERN.test(authorId)) return { kind: "stop", reason: "error" };
  const page = await readFfnPage(fetchImpl, clock, {
    url: `https://m.fanfiction.net/u/${authorId}/?a=s`,
    expectedPath: (pathname) => pathname === `/u/${authorId}` || pathname.startsWith(`/u/${authorId}/`),
    maxBytes: MAX_READ_BYTES,
    enough: (text) => {
      const { summaries } = ffnSummariesFromStoryListHtml(text);
      return wanted.every((id) => summaries.has(id));
    },
  });
  if (page.kind === "stop") return page;
  const { rows, summaries } = ffnSummariesFromStoryListHtml(page.html);
  if (rows === 0) return { kind: "stop", reason: "missing" };
  const found = new Map<string, string>();
  for (const id of wanted) {
    const summary = summaries.get(id);
    if (summary !== undefined) found.set(id, summary);
  }
  return { kind: "found", summaries: found };
}

// --- Session state -----------------------------------------------------------

export interface QueuedStory {
  /** The story's FanFiction.net id. */
  readonly s: string;
  /** Its author's id, once known. */
  readonly a?: string;
}

export interface FillState {
  readonly v: 2;
  /** The account the state belongs to (`accountId:epoch`). */
  readonly account: string;
  /** Stories still to fill, at most `QUEUE_MAX`. */
  readonly queue: readonly QueuedStory[];
  readonly listed: boolean;
  readonly stopped: boolean;
  readonly backfills: number;
  readonly saves: number;
  readonly lastStepAt: number;
}

export interface FillStatePort {
  /** Whether the state outlives this worker (session storage), so the caps hold. */
  readonly sessionBacked: boolean;
  read(): Promise<FillState | null>;
  write(state: FillState): Promise<void>;
  clear(): Promise<void>;
}

function validQueuedStory(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "s" || key === "a") &&
    typeof record.s === "string" &&
    ID_PATTERN.test(record.s) &&
    (record.a === undefined || (typeof record.a === "string" && ID_PATTERN.test(record.a)))
  );
}

function validState(value: unknown): FillState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 2 ||
    typeof record.account !== "string" ||
    !Array.isArray(record.queue) ||
    record.queue.length > QUEUE_MAX ||
    !record.queue.every(validQueuedStory) ||
    typeof record.listed !== "boolean" ||
    typeof record.stopped !== "boolean" ||
    !Number.isSafeInteger(record.backfills) ||
    !Number.isSafeInteger(record.saves) ||
    typeof record.lastStepAt !== "number" ||
    !Number.isFinite(record.lastStepAt)
  ) {
    return null;
  }
  return record as unknown as FillState;
}

interface SessionArea {
  get(keys: string): Promise<Record<string, unknown>> | unknown;
  set(items: Record<string, unknown>): Promise<void> | unknown;
  remove(keys: string): Promise<void> | unknown;
}

/**
 * Session-only storage (`storage.session`): kept in memory by the browser
 * and gone when it quits. Without it the state lives in this worker's memory.
 */
export class SessionFillState implements FillStatePort {
  readonly #area: SessionArea | null;
  #memory: FillState | null = null;

  constructor(area: SessionArea | null | undefined) {
    this.#area = area && typeof area.get === "function" ? area : null;
  }

  get sessionBacked(): boolean {
    return this.#area !== null;
  }

  async read(): Promise<FillState | null> {
    if (this.#area === null) return this.#memory;
    try {
      const values = await this.#area.get(FFN_SUMMARY_STATE_KEY) as Record<string, unknown> | undefined;
      return validState(values?.[FFN_SUMMARY_STATE_KEY]);
    } catch {
      return this.#memory;
    }
  }

  async write(state: FillState): Promise<void> {
    this.#memory = state;
    if (this.#area === null) return;
    try {
      await this.#area.set({ [FFN_SUMMARY_STATE_KEY]: state });
    } catch {
      // Memory keeps the session's pacing when session storage is unavailable.
    }
  }

  async clear(): Promise<void> {
    this.#memory = null;
    if (this.#area === null) return;
    try {
      await this.#area.remove(FFN_SUMMARY_STATE_KEY);
    } catch {
      // Nothing else to remove.
    }
  }
}

// --- The filler --------------------------------------------------------------

export type ContributionOutcome = "accepted" | "skipped" | "failed";

export interface FilledSummary {
  readonly storyId: string;
  readonly summary: string;
}

export interface FfnSummaryFillPorts {
  readonly fetch: typeof fetch;
  readonly clock: FillClock;
  readonly state: FillStatePort;
  /** The signed-in account, or null when no one is signed in. */
  account(): string | null;
  /** The metadata-contribution preference (`prefMetadataImproveEnabled`). */
  contributionsEnabled(): Promise<boolean>;
  /** Whether the reader has allowed Trace on m.fanfiction.net. */
  hostAllowed(): Promise<boolean>;
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
    v: 2,
    account,
    queue: Object.freeze([]),
    listed: false,
    stopped: false,
    backfills: 0,
    saves: 0,
    lastStepAt: 0,
  });
}

function storyIdFromWorkKey(workKey: string): string | null {
  const match = /^ffn:([1-9][0-9]{0,19})$/.exec(workKey);
  return match?.[1] ?? null;
}

export class FfnSummaryFill {
  readonly #ports: FfnSummaryFillPorts;
  #tail: Promise<void> = Promise.resolve();
  /** The backfill has nothing more to do this session (stopped, done or capped). */
  #finished = false;
  #pendingSaves = 0;
  #savesInFlight = 0;
  #lastSaveAt = Number.NEGATIVE_INFINITY;
  #settleTimer: unknown | null = null;
  /** When a FanFiction.net page last spoke to Trace. */
  #lastFfnAt = Number.NEGATIVE_INFINITY;
  /** When a page on another site last spoke to Trace. */
  #lastElsewhereAt = Number.NEGATIVE_INFINITY;
  /** Raised by every sign-out or account change; a step from before writes nothing. */
  #generation = 0;
  /** The generation the running step started in. */
  #runGeneration = 0;
  /** Stories read on save in this worker's lifetime, so a later chapter does not read again. */
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
   * story page that showed no summary, the summary is read now.
   */
  storySaved(story: SavedStory, alreadyInLibrary: boolean): Promise<void> {
    if (story.hostKind !== "ffn" || alreadyInLibrary) return Promise.resolve();
    const item = story.payload.item as Record<string, unknown> | undefined;
    if (item === undefined || item === null || typeof item !== "object" || item.ctx !== "story") {
      return Promise.resolve();
    }
    if (typeof item.sm === "string" && item.sm.trim().length > 0) return Promise.resolve();
    const storyId = storyIdFromWorkKey(story.workKey);
    if (storyId === null || this.#recent.includes(storyId)) return Promise.resolve();
    if (this.#pendingSaves >= ON_SAVE_PENDING_MAX) return Promise.resolve();
    const authorId = typeof story.ffnAuthorId === "string" && ID_PATTERN.test(story.ffnAuthorId)
      ? story.ffnAuthorId
      : undefined;
    this.#recent.push(storyId);
    if (this.#recent.length > RECENT_MAX) this.#recent.shift();
    this.#pendingSaves += 1;
    return this.#serial(async () => {
      try {
        await this.#readOnSave(storyId, authorId);
      } finally {
        this.#pendingSaves -= 1;
      }
    });
  }

  /**
   * A FanFiction.net page spoke to Trace (it loaded, or the reader moved on
   * it). The backfill waits until the pages have been quiet for a while.
   */
  ffnPageActivity(): void {
    this.#lastFfnAt = this.#ports.clock.now();
    // Without session storage the session's caps would reset with every
    // worker start, so the backfill does not run at all.
    if (this.#finished || !this.#ports.state.sessionBacked) return;
    if (this.#settleTimer !== null) this.#ports.clock.clearTimeout(this.#settleTimer);
    this.#settleTimer = this.#ports.clock.setTimeout(() => {
      this.#settleTimer = null;
      void this.#serial(() => this.#backfillStep());
    }, BACKFILL_SETTLE_MS);
  }

  /**
   * A page on another site (AO3, Trace) spoke to Trace: the reader has moved
   * on, so no backfill runs until a FanFiction.net page speaks again.
   */
  elsewherePageActivity(): void {
    this.#lastElsewhereAt = this.#ports.clock.now();
    if (this.#settleTimer !== null) {
      this.#ports.clock.clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
  }

  /** Sign-out or another account: forget everything and stop. */
  async clear(): Promise<void> {
    this.#generation += 1;
    if (this.#settleTimer !== null) {
      this.#ports.clock.clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
    this.#recent.length = 0;
    this.#finished = false;
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

  #finish(): void {
    if (this.#current()) this.#finished = true;
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
    this.#finished = false;
    const fresh = freshState(account);
    return await this.#write(fresh) ? fresh : null;
  }

  async #stop(state: FillState): Promise<void> {
    // Stopped for the session: the stories still to fill are dropped too.
    this.#finish();
    await this.#write(Object.freeze({ ...state, stopped: true, queue: Object.freeze([]) }));
  }

  /** Whether a request may be made now; stops the session when it may not. */
  async #mayRequest(state: FillState): Promise<boolean> {
    let allowed = false;
    try {
      allowed = await this.#ports.contributionsEnabled() && await this.#ports.hostAllowed();
    } catch {
      allowed = false;
    }
    if (!allowed) await this.#stop(state);
    return allowed;
  }

  /**
   * Reads one author's story list and sends the summaries of every waiting
   * story on it. Returns the state after it, or null when the session stopped.
   */
  async #readAuthor(state: FillState, authorId: string, storyIds: readonly string[]): Promise<FillState | null> {
    const read = await readFfnAuthorSummaries(this.#ports.fetch, authorId, storyIds, this.#ports.clock);
    if (read.kind !== "found") {
      await this.#stop(state);
      return null;
    }
    // Every story asked for is done with: filled, or not on the first page.
    const done = new Set(storyIds);
    const next: FillState = Object.freeze({
      ...state,
      queue: Object.freeze(state.queue.filter(({ s }) => !done.has(s))),
    });
    if (!(await this.#write(next))) return null;
    if (read.summaries.size === 0) return next;
    if (this.#ports.account() !== state.account || !this.#current()) return null;
    let outcome: ContributionOutcome = "failed";
    try {
      outcome = await this.#ports.contribute(
        [...read.summaries].map(([storyId, summary]) => Object.freeze({ storyId, summary })),
      );
    } catch {
      outcome = "failed";
    }
    if (outcome !== "accepted") {
      await this.#stop(next);
      return null;
    }
    return next;
  }

  /** The waiting stories by one author, this one first. */
  #byAuthor(state: FillState, storyId: string, authorId: string): string[] {
    return [storyId, ...state.queue.filter(({ s, a }) => a === authorId && s !== storyId).map(({ s }) => s)];
  }

  async #readOnSave(storyId: string, knownAuthorId: string | undefined): Promise<void> {
    let state = await this.#state();
    if (state === null || state.stopped || state.saves >= ON_SAVE_MAX_PER_SESSION) return;
    state = Object.freeze({ ...state, saves: state.saves + 1, lastStepAt: this.#ports.clock.now() });
    if (!(await this.#write(state))) return;
    if (!(await this.#mayRequest(state))) return;
    let authorId = knownAuthorId;
    if (authorId === undefined) {
      // A save that did not name the author: its own page names it.
      const lookup = await lookUpFfnAuthorId(this.#ports.fetch, storyId, this.#ports.clock);
      if (lookup.kind !== "found") {
        await this.#stop(state);
        return;
      }
      authorId = lookup.authorId;
      if (!this.#current()) return;
    }
    await this.#readAuthor(state, authorId, this.#byAuthor(state, storyId, authorId));
  }

  async #backfillStep(): Promise<void> {
    if (!this.#ports.state.sessionBacked) return;
    const now = this.#ports.clock.now();
    if (this.#savesInFlight > 0 || now - this.#lastSaveAt < BACKFILL_SETTLE_MS) return;
    const state = await this.#state();
    if (state === null) return;
    if (
      state.stopped ||
      (state.listed && state.queue.length === 0) ||
      state.backfills >= BACKFILL_MAX_PER_SESSION
    ) {
      this.#finish();
      return;
    }
    if (now - state.lastStepAt < BACKFILL_GAP_MS) return;
    // Only while the reader is on FanFiction.net: its pages spoke to Trace
    // just before this step's quiet wait, and no other site's page has since.
    if (now - this.#lastFfnAt > BACKFILL_SETTLE_MS + FFN_PRESENCE_GRACE_MS) return;
    if (this.#lastElsewhereAt >= this.#lastFfnAt) return;

    if (!state.listed) {
      let enabled = false;
      try {
        enabled = await this.#ports.contributionsEnabled();
      } catch {
        enabled = false;
      }
      if (!enabled) {
        await this.#stop(state);
        return;
      }
      const gaps = await this.#ports.listGaps().catch(() => null);
      if (gaps === null) {
        await this.#stop(state);
        return;
      }
      const queue = gaps
        .filter((id) => typeof id === "string" && ID_PATTERN.test(id))
        .filter((id, index, all) => all.indexOf(id) === index && !this.#recent.includes(id))
        .slice(0, QUEUE_MAX)
        .map((s) => Object.freeze({ s }));
      // The list itself is this step's request; the first page read waits a gap.
      await this.#write(Object.freeze({
        ...state,
        listed: true,
        queue: Object.freeze(queue),
        lastStepAt: now,
      }));
      return;
    }

    const head = state.queue[0];
    if (head === undefined) return;
    const counted: FillState = Object.freeze({
      ...state,
      backfills: state.backfills + 1,
      lastStepAt: now,
    });
    if (!(await this.#write(counted))) return;
    if (!(await this.#mayRequest(counted))) return;

    if (head.a === undefined) {
      // This step's one request: the story's own page, for its author.
      const lookup = await lookUpFfnAuthorId(this.#ports.fetch, head.s, this.#ports.clock);
      if (lookup.kind !== "found") {
        await this.#stop(counted);
        return;
      }
      await this.#write(Object.freeze({
        ...counted,
        queue: Object.freeze([Object.freeze({ s: head.s, a: lookup.authorId }), ...counted.queue.slice(1)]),
      }));
    } else {
      const next = await this.#readAuthor(counted, head.a, this.#byAuthor(counted, head.s, head.a));
      if (next !== null && next.queue.length === 0) this.#finish();
    }
    if (counted.backfills >= BACKFILL_MAX_PER_SESSION) this.#finish();
  }
}
