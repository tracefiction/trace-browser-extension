/**
 * FanFiction.net summaries for stories saved from a page that shows none.
 *
 * FanFiction.net's mobile story page has no summary, so a story saved there
 * reaches the Library without one. The desktop story page carries it at the
 * top (`#profile_top`). This reads that one block from the reader's own
 * browser and sends only the summary, as a metadata contribution for a story
 * already in the reader's Library.
 *
 * - On save: a story newly saved from an FFN story page with no summary gets
 *   one read straight after the save.
 * - Backfill: the reader's other saved FFN stories that no one has a summary
 *   for (the server lists at most 50) are read one at a time, minutes apart,
 *   only while the reader is on FanFiction.net, never while a save or a page
 *   load is under way, and at most a few per browsing session.
 *
 * It stays small and leaves nothing behind: one request at a time, each with
 * a time limit; the page text is read only as far as the summary and then
 * dropped; no tab, frame or page is opened; nothing is cached. The only state
 * is the list of story ids still to fill and a few counters, kept in
 * session-only storage when the browser has it (memory otherwise), and
 * removed on sign-out or when the account changes. Any refusal, challenge
 * page, unexpected address, missing summary or error stops it for the rest of
 * the session; it never retries in a loop.
 */

export const FFN_SUMMARY_HOST_PATTERN = "https://www.fanfiction.net/*";
export const FFN_SUMMARY_STATE_KEY = "traceFfnSummaryFillV1";

/** Wait after the last FanFiction.net page signal before a backfill read. */
export const BACKFILL_SETTLE_MS = 20_000;
/** How stale the last FanFiction.net page signal may be when a step runs. */
const FFN_PRESENCE_GRACE_MS = 10_000;
/** Least time between two backfill network steps. */
export const BACKFILL_GAP_MS = 3 * 60_000;
/** Backfill reads per browsing session. */
export const BACKFILL_MAX_PER_SESSION = 10;
/** Reads straight after a save, per browsing session. */
export const ON_SAVE_MAX_PER_SESSION = 30;
/** Story ids kept to fill, at most. */
export const QUEUE_MAX = 50;
export const FETCH_TIMEOUT_MS = 10_000;
/** The page is read no further than this. */
export const MAX_READ_BYTES = 256 * 1_024;
const SUMMARY_WINDOW_CHARS = 16_384;
const SUMMARY_MAX_CHARS = 4_000;
const STORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ON_SAVE_PENDING_MAX = 5;
const RECENT_MAX = 50;

// --- Reading the summary from page text --------------------------------------

const PROFILE_TOP_PATTERN = /<div\b[^>]*\bid\s*=\s*["']?profile_top\b[^>]*>/i;
const SUMMARY_DIV_PATTERN =
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bxcontrast_txt\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi;

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
 * The summary on a FanFiction.net desktop story page: the first plain text
 * block (`div.xcontrast_txt`) at the top of the story (`#profile_top`) that
 * is not the rating line. A bounded string read: no DOM, no rendering, and
 * only a short stretch after `#profile_top` is looked at.
 */
export function ffnSummaryFromStoryHtml(html: string): string | null {
  if (typeof html !== "string") return null;
  const top = PROFILE_TOP_PATTERN.exec(html);
  if (top === null) return null;
  const start = top.index + top[0].length;
  const window = html.slice(start, start + SUMMARY_WINDOW_CHARS);
  SUMMARY_DIV_PATTERN.lastIndex = 0;
  for (let match = SUMMARY_DIV_PATTERN.exec(window); match !== null; match = SUMMARY_DIV_PATTERN.exec(window)) {
    const text = plainText(match[1] ?? "");
    if (!text || /^Rated:/i.test(text)) continue;
    return text.slice(0, SUMMARY_MAX_CHARS);
  }
  return null;
}

/** Whether the page text has reached the end of the summary block. */
function summaryBlockComplete(html: string): boolean {
  const top = PROFILE_TOP_PATTERN.exec(html);
  if (top === null) return false;
  const after = html.slice(top.index + top[0].length, top.index + top[0].length + SUMMARY_WINDOW_CHARS);
  return /class\s*=\s*["'][^"']*\bxcontrast_txt\b[^"']*["'][^>]*>[\s\S]*?<\/div\s*>/i.test(after) ||
    html.length - top.index >= SUMMARY_WINDOW_CHARS;
}

/** Whether a page is a Cloudflare (or similar) check instead of the story. */
export function isChallengePage(html: string, headers?: { get(name: string): string | null }): boolean {
  if (headers?.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  const head = html.slice(0, 8_192);
  return /<title>\s*(?:just a moment|attention required|please wait)/i.test(head) ||
    /\/cdn-cgi\/challenge-platform\//i.test(head) ||
    /\bcf[-_]chl[-_]/i.test(head) ||
    /\bchallenge-form\b/i.test(head);
}

// --- Reading one story page --------------------------------------------------

export type FfnSummaryRead =
  | { readonly kind: "found"; readonly summary: string }
  | {
      readonly kind: "stop";
      readonly reason:
        | "status"
        | "redirect"
        | "challenge"
        | "not_html"
        | "missing"
        | "error";
    };

export interface FillClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return (await response.text()).slice(0, MAX_READ_BYTES);
  }
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
      if (bytes >= MAX_READ_BYTES || summaryBlockComplete(text)) break;
    }
  } finally {
    // The rest of the page is never downloaded.
    void reader.cancel().catch(() => undefined);
  }
  return text;
}

function expectedStoryAddress(rawUrl: string, storyId: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.fanfiction.net" &&
      (url.pathname === `/s/${storyId}` || url.pathname.startsWith(`/s/${storyId}/`))
    );
  } catch {
    return false;
  }
}

/**
 * Reads one story's summary from its desktop page. The reader's own browser
 * makes the request, with its own FanFiction.net session, and nothing but the
 * summary leaves this function.
 */
export async function readFfnStorySummary(
  fetchImpl: typeof fetch,
  storyId: string,
  clock: FillClock,
): Promise<FfnSummaryRead> {
  if (!STORY_ID_PATTERN.test(storyId)) return { kind: "stop", reason: "error" };
  const abort = new AbortController();
  const timer = clock.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://www.fanfiction.net/s/${storyId}/1/`, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html" },
      signal: abort.signal,
    });
    if (!expectedStoryAddress(response.url, storyId)) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "stop", reason: "redirect" };
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "stop", reason: isChallengeHeader(response) ? "challenge" : "status" };
    }
    if (!/text\/html/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "stop", reason: "not_html" };
    }
    if (isChallengeHeader(response)) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "stop", reason: "challenge" };
    }
    const html = await readBounded(response);
    if (isChallengePage(html)) return { kind: "stop", reason: "challenge" };
    const summary = ffnSummaryFromStoryHtml(html);
    return summary === null
      ? { kind: "stop", reason: "missing" }
      : { kind: "found", summary };
  } catch {
    return { kind: "stop", reason: "error" };
  } finally {
    clock.clearTimeout(timer);
  }
}

function isChallengeHeader(response: Response): boolean {
  return response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
}

// --- Session state -----------------------------------------------------------

export interface FillState {
  readonly v: 1;
  /** The account the state belongs to (`accountId:epoch`). */
  readonly account: string;
  /** Story ids still to fill, at most `QUEUE_MAX`. */
  readonly queue: readonly string[];
  readonly listed: boolean;
  readonly stopped: boolean;
  readonly backfills: number;
  readonly saves: number;
  readonly lastStepAt: number;
}

export interface FillStatePort {
  read(): Promise<FillState | null>;
  write(state: FillState): Promise<void>;
  clear(): Promise<void>;
}

function validState(value: unknown): FillState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.account !== "string" ||
    !Array.isArray(record.queue) ||
    record.queue.length > QUEUE_MAX ||
    !record.queue.every((id) => typeof id === "string" && STORY_ID_PATTERN.test(id)) ||
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

export interface FfnSummaryFillPorts {
  readonly fetch: typeof fetch;
  readonly clock: FillClock;
  readonly state: FillStatePort;
  /** The signed-in account, or null when no one is signed in. */
  account(): string | null;
  /** The metadata-contribution preference (`prefMetadataImproveEnabled`). */
  contributionsEnabled(): Promise<boolean>;
  /** Whether the reader has allowed Trace on www.fanfiction.net. */
  hostAllowed(): Promise<boolean>;
  /** The reader's saved FFN story ids that no one has a summary for; null when unavailable. */
  listGaps(): Promise<readonly string[] | null>;
  /** Sends one summary for one saved story. */
  contribute(storyId: string, summary: string): Promise<ContributionOutcome>;
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
  #lastSaveAt = 0;
  #settleTimer: unknown | null = null;
  /** When a FanFiction.net page last spoke to Trace. */
  #lastFfnAt = Number.NEGATIVE_INFINITY;
  /** Stories read on save in this worker's lifetime, so a later chapter does not read again. */
  readonly #recent: string[] = [];

  constructor(ports: FfnSummaryFillPorts) {
    this.#ports = ports;
  }

  /** Whether a backfill read is waiting to run. */
  hasPendingTimer(): boolean {
    return this.#settleTimer !== null;
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
    this.#recent.push(storyId);
    if (this.#recent.length > RECENT_MAX) this.#recent.shift();
    this.#pendingSaves += 1;
    return this.#serial(async () => {
      try {
        await this.#readOnSave(storyId);
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
    if (this.#finished) return;
    if (this.#settleTimer !== null) this.#ports.clock.clearTimeout(this.#settleTimer);
    this.#settleTimer = this.#ports.clock.setTimeout(() => {
      this.#settleTimer = null;
      void this.#serial(() => this.#backfillStep());
    }, BACKFILL_SETTLE_MS);
  }

  /** Sign-out or another account: forget everything and stop. */
  async clear(): Promise<void> {
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
      try {
        await work();
      } catch {
        // A failed step stops nothing else; the state records any stop.
      }
    });
    this.#tail = run;
    return run;
  }

  /** The session's state for the signed-in account, or null when signed out. */
  async #state(): Promise<FillState | null> {
    const account = this.#ports.account();
    if (account === null) {
      await this.clear();
      return null;
    }
    const stored = await this.#ports.state.read();
    if (stored !== null && stored.account === account) return stored;
    // Another account (or none yet): nothing of the previous one is kept.
    this.#finished = false;
    const fresh = freshState(account);
    await this.#ports.state.write(fresh);
    return fresh;
  }

  async #stop(state: FillState): Promise<void> {
    // Stopped for the session: the ids still to fill are dropped too.
    this.#finished = true;
    await this.#ports.state.write(Object.freeze({ ...state, stopped: true, queue: Object.freeze([]) }));
  }

  /** Reads one story and sends its summary. Returns false when the session stops. */
  async #fill(state: FillState, storyId: string): Promise<boolean> {
    let enabled = false;
    try {
      enabled = await this.#ports.contributionsEnabled();
    } catch {
      enabled = false;
    }
    if (!enabled) {
      await this.#stop(state);
      return false;
    }
    let allowed = false;
    try {
      allowed = await this.#ports.hostAllowed();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      await this.#stop(state);
      return false;
    }
    const read = await readFfnStorySummary(this.#ports.fetch, storyId, this.#ports.clock);
    if (read.kind !== "found") {
      await this.#stop(state);
      return false;
    }
    if (this.#ports.account() !== state.account) return false;
    let outcome: ContributionOutcome = "failed";
    try {
      outcome = await this.#ports.contribute(storyId, read.summary);
    } catch {
      outcome = "failed";
    }
    if (outcome !== "accepted") {
      await this.#stop(state);
      return false;
    }
    return true;
  }

  async #readOnSave(storyId: string): Promise<void> {
    const state = await this.#state();
    if (state === null || state.stopped || state.saves >= ON_SAVE_MAX_PER_SESSION) return;
    const counted: FillState = Object.freeze({
      ...state,
      saves: state.saves + 1,
      lastStepAt: this.#ports.clock.now(),
      queue: Object.freeze(state.queue.filter((id) => id !== storyId)),
    });
    await this.#ports.state.write(counted);
    await this.#fill(counted, storyId);
  }

  async #backfillStep(): Promise<void> {
    const now = this.#ports.clock.now();
    if (this.#savesInFlight > 0 || now - this.#lastSaveAt < BACKFILL_SETTLE_MS) return;
    const state = await this.#state();
    if (state === null) return;
    if (
      state.stopped ||
      (state.listed && state.queue.length === 0) ||
      state.backfills >= BACKFILL_MAX_PER_SESSION
    ) {
      this.#finished = true;
      return;
    }
    if (now - state.lastStepAt < BACKFILL_GAP_MS) return;
    // Only while the reader is on FanFiction.net: its pages spoke to Trace
    // just before this step's quiet wait.
    if (now - this.#lastFfnAt > BACKFILL_SETTLE_MS + FFN_PRESENCE_GRACE_MS) return;

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
        .filter((id) => typeof id === "string" && STORY_ID_PATTERN.test(id))
        .filter((id, index, all) => all.indexOf(id) === index && !this.#recent.includes(id))
        .slice(0, QUEUE_MAX);
      // The list itself is this step's request; the first page read waits a gap.
      await this.#ports.state.write(Object.freeze({
        ...state,
        listed: true,
        queue: Object.freeze(queue),
        lastStepAt: now,
      }));
      return;
    }

    const [storyId, ...rest] = state.queue;
    if (storyId === undefined) return;
    const next: FillState = Object.freeze({
      ...state,
      queue: Object.freeze(rest),
      backfills: state.backfills + 1,
      lastStepAt: now,
    });
    await this.#ports.state.write(next);
    const carryOn = await this.#fill(next, storyId);
    if (!carryOn || rest.length === 0 || next.backfills >= BACKFILL_MAX_PER_SESSION) {
      this.#finished = true;
    }
  }
}
