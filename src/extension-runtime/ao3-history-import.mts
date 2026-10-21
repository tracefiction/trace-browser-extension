/**
 * A History import's run: reads the signed-in reader's whole AO3 History,
 * page by page, from their own AO3 tab, and keeps every work found on this
 * device until they review it. Nothing is sent to Trace and nothing enters
 * the Library here; the review does that, with the reader's choices.
 *
 * Courtesy to AO3, and the reader's trust, come first:
 * - Only `/users/<name>/readings` pages, one request at a time, 8 to 10
 *   seconds apart, from the reader's tab with Safari's own headers.
 * - A 429 or 503 waits at least a minute, or as long as AO3 says, and doubles
 *   the gap; three in a row pause the run. A wait over 15 minutes is the
 *   reader's to resume.
 * - A challenge, a sign-out, an unexpected page or address stops at once.
 *   Nothing is retried past a challenge, and a page not understood is never
 *   taken for the end of the History.
 * - No request while a story save to Trace is under way, or just after one.
 *
 * The reading happens in the tab because AO3 does not see the reader's sign-in
 * from the extension's background, and because Safari on iPhone unloads the
 * background within about a minute, with its timers. A small loop in the
 * visible AO3 tab asks the run, on its own timer, whether a page is due,
 * makes the request when told, and hands the answer back; the run checks the
 * answer and keeps it. A hidden tab waits until it is shown again.
 *
 * A run is kept in the History store: each page's works and the next page are
 * written together, so it carries on after the background is unloaded,
 * Safari restarts or the reader comes back days later.
 */

import {
  AO3_USERNAME_PATTERN,
  classifyHistoryAnswer,
  historyPageURL,
  type ClassifiedAnswer,
  type HistoryPageRead,
  type HistoryStopCode,
  type LoadFailCode,
  type LoadedPage,
  type RetryCode,
} from "./ao3-history-page.mjs";
import { HistoryStoreFull, type HistoryStore } from "./ao3-history-store.mjs";

export const AO3_HISTORY_IMPORT_MESSAGE = "TRACE_AO3_HISTORY_IMPORT";

/** Least time between two History pages, before the jitter. */
export const PAGE_GAP_MS = 8_000;
/** Up to this much is added to each gap, so pages are 8 to 10 s apart. */
export const PAGE_GAP_JITTER_MS = 2_000;
/** The gap after backing off never grows past this. */
export const MAX_PAGE_GAP_MS = 60_000;
/** Least wait after a 429 or 503; doubles for each one in a row. */
export const RETRY_BASE_MS = 60_000;
/** 15 minutes. (Literals here, so a build without the import drops them.) */
export const RETRY_MAX_MS = 900_000;
/** Least wait after a request that failed on the network or timed out. */
export const NETWORK_RETRY_MS = 30_000;
/** A run pauses after this many retried answers in a row. */
export const MAX_CONSECUTIVE_RETRIES = 3;
/** No request while a save is under way, nor this soon after one ends. */
export const SAVE_SETTLE_MS = 10_000;
export const SAVE_RECHECK_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 20_000;
/** An unanswered request counts as lost this long after it was made: the time limit and 10 s. */
export const LOST_AFTER_MS = 30_000;
/** Far past any History seen; a run this long is paused, never ended. */
export const MAX_PAGES = 5_000;

export type HistoryRunStatus = "running" | "paused" | "finished";

/** Why a run is paused or finished. */
export type HistoryRunReason =
  | "reached_last_page"
  | "paused_by_you"
  | HistoryStopCode
  | Exclude<LoadFailCode, "timeout" | "network">
  /** Three retries in a row of this kind. */
  | Exclude<RetryCode, "timeout" | "empty_page">
  /** AO3 asked for a wait longer than the run waits by itself. */
  | "retry_later"
  /** Page 1 listed no works, three times: the History is empty or turned off. */
  | "history_empty"
  /** A later page listed no works, three times. */
  | "empty_page"
  /** AO3 sent the same page twice for two page numbers. */
  | "pagination_repeat"
  | "page_limit"
  /** The device would not keep more. */
  | "storage_full"
  | "storage_write_failed";

/** What a waiting run waits for. */
export type HistoryRunWait = "slow_down" | "ao3_unwell" | "network" | "save" | null;

export interface HistoryRun {
  v: 1;
  runId: string;
  /** The Trace account the run belongs to; another account never sees it. */
  account: string;
  /** The AO3 name whose History is read. */
  user: string;
  status: HistoryRunStatus;
  reason: HistoryRunReason | null;
  /** The AO3 tab whose loop carries the run. */
  tabId: number | null;
  nextPage: number;
  /** The highest page number AO3's page links have shown. */
  totalPages: number | null;
  lastPageDigest: string | null;
  /** The request made and not yet answered. */
  inFlight: { token: string; at: number; page: number } | null;
  counts: {
    /** Pages read and kept. */
    pages: number;
    /** Different works kept. */
    works: number;
    /** Rows marked for later, as seen. */
    later: number;
    deleted: number;
    unreadable: number;
    /** Works seen again on a later page. */
    repeats: number;
  };
  timing: {
    startedAt: number;
    finishedAt: number | null;
    pausedAt: number | null;
    pausedMs: number;
    /** When the next request may be made. */
    dueAt: number;
    gapMs: number;
    /** When the last page was kept, while running; for the estimate. */
    lastKeptAt: number | null;
    keptGapMsTotal: number;
    keptGapCount: number;
  };
  retry: { consecutive: number; code: RetryCode | null };
}

/** What the sheet and the AO3 page show. Never the AO3 name or a work. */
export interface HistoryRunView {
  readonly status: HistoryRunStatus | "idle";
  readonly reason: HistoryRunReason | null;
  readonly pagesRead: number;
  readonly totalPages: number | null;
  readonly works: number;
  readonly later: number;
  readonly deleted: number;
  readonly unreadable: number;
  readonly waitingFor: HistoryRunWait;
  readonly waitingUntil: number | null;
  /** About how long the rest takes, or null before it can be told. */
  readonly remainingMs: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/** What the page loop does next. */
export type LoopInstruction =
  | { readonly wait: number }
  | { readonly fetch: string; readonly token: string }
  | { readonly stop: true };

export type StartError = "username_unclear" | "not_connected" | "already_started" | "storage_full" | "storage_write_failed";

export interface HistoryImportPorts {
  readonly store: HistoryStore;
  readonly clock: { now(): number };
  readonly random: () => number;
  readonly newId: () => string;
  /**
   * The signed-in Trace account, or null when there is none or it is not
   * known yet. A run of another account is deleted on sight.
   */
  readonly account: () => Promise<string | null>;
  /** Story saves to Trace under way, and when the last one ended. */
  readonly saveActivity: () => { readonly inFlight: number; readonly lastEndedAt: number };
  /** Puts the page loop into an AO3 tab (it runs only while the tab is visible). */
  readonly ensureLoop?: (tabId: number) => Promise<"started" | "running" | "failed">;
  readonly alarm?: { start(): Promise<void> | void; stop(): Promise<void> | void };
}

const clone = <T,>(value: T): T => structuredClone(value);

function isRun(value: unknown): value is HistoryRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<HistoryRun>;
  return run.v === 1 && typeof run.runId === "string" && typeof run.account === "string" &&
    typeof run.user === "string" && AO3_USERNAME_PATTERN.test(run.user) &&
    ["running", "paused", "finished"].includes(run.status as string) &&
    Number.isSafeInteger(run.nextPage) && typeof run.counts === "object" && run.counts !== null &&
    typeof run.timing === "object" && run.timing !== null && typeof run.retry === "object" && run.retry !== null;
}

function newRun(runId: string, account: string, user: string, tabId: number | null, now: number): HistoryRun {
  return {
    v: 1, runId, account, user, status: "running", reason: null, tabId,
    nextPage: 1, totalPages: null, lastPageDigest: null, inFlight: null,
    counts: { pages: 0, works: 0, later: 0, deleted: 0, unreadable: 0, repeats: 0 },
    timing: {
      startedAt: now, finishedAt: null, pausedAt: null, pausedMs: 0, dueAt: now, gapMs: PAGE_GAP_MS,
      lastKeptAt: null, keptGapMsTotal: 0, keptGapCount: 0,
    },
    retry: { consecutive: 0, code: null },
  };
}

const WAIT_OF: Readonly<Record<RetryCode, Exclude<HistoryRunWait, null>>> = {
  rate_limited: "slow_down",
  unavailable: "slow_down",
  server_error: "ao3_unwell",
  empty_page: "ao3_unwell",
  incomplete_page: "ao3_unwell",
  network: "network",
  timeout: "network",
};

export function describeRun(run: HistoryRun | null, now: number, saving = false): HistoryRunView {
  if (run === null) {
    return {
      status: "idle", reason: null, pagesRead: 0, totalPages: null, works: 0, later: 0, deleted: 0,
      unreadable: 0, waitingFor: null, waitingUntil: null, remainingMs: null, startedAt: null, finishedAt: null,
    };
  }
  const running = run.status === "running";
  const waitingUntil = running && run.inFlight === null && run.timing.dueAt > now ? run.timing.dueAt : null;
  const waitingFor: HistoryRunWait = !running
    ? null
    : saving
      ? "save"
      : run.retry.code !== null && waitingUntil !== null ? WAIT_OF[run.retry.code] : null;
  let remainingMs: number | null = null;
  if (run.status !== "finished" && run.totalPages !== null) {
    const left = Math.max(0, run.totalPages - run.counts.pages);
    // From the pace pages have been kept at, or the planned one at first.
    const perPage = run.timing.keptGapCount >= 2
      ? run.timing.keptGapMsTotal / run.timing.keptGapCount
      : run.timing.gapMs + PAGE_GAP_JITTER_MS / 2 + 1_500;
    remainingMs = Math.round(left * perPage);
  }
  return {
    status: run.status,
    reason: run.reason,
    pagesRead: run.counts.pages,
    totalPages: run.totalPages,
    works: run.counts.works,
    later: run.counts.later,
    deleted: run.counts.deleted,
    unreadable: run.counts.unreadable,
    waitingFor,
    waitingUntil,
    remainingMs,
    startedAt: run.timing.startedAt,
    finishedAt: run.timing.finishedAt,
  };
}

export class Ao3HistoryImport {
  readonly #ports: HistoryImportPorts;
  #run: HistoryRun | null = null;
  #loaded = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(ports: HistoryImportPorts) {
    this.#ports = ports;
  }

  /** Runs changes to the run one after another. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** The stored run, if it is the signed-in account's. Another account's is deleted. */
  async #load(): Promise<HistoryRun | null> {
    if (!this.#loaded) {
      const value = await this.#ports.store.readRun().catch(() => null);
      this.#run = isRun(value) ? clone(value) : null;
      this.#loaded = true;
    }
    if (this.#run !== null) {
      const account = await this.#ports.account().catch(() => null);
      if (account !== null && account !== this.#run.account) await this.#forget();
    }
    return this.#run;
  }

  async #forget(): Promise<void> {
    await this.#ports.store.clear().catch(() => undefined);
    this.#run = null;
    this.#loaded = true;
  }

  /** Writes `next`; on failure the stored run stays as it was. */
  async #write(next: HistoryRun): Promise<boolean> {
    return (await this.#writeFailure(next)) === null;
  }

  /** Writes `next`, and says why it could not be kept, if it could not. */
  async #writeFailure(next: HistoryRun): Promise<"storage_full" | "storage_write_failed" | null> {
    try {
      await this.#ports.store.writeRun(next);
      this.#run = next;
      return null;
    } catch (error) {
      return error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed";
    }
  }

  async #alarm(on: boolean): Promise<void> {
    try {
      await (on ? this.#ports.alarm?.start() : this.#ports.alarm?.stop());
    } catch {
      // The page loop and the sheet still carry the run.
    }
  }

  async #ensureLoop(tabId: number | null): Promise<void> {
    if (tabId === null || this.#ports.ensureLoop === undefined) return;
    try {
      await this.#ports.ensureLoop(tabId);
    } catch {
      // The alarm, the sheet or the next AO3 page tries again.
    }
  }

  #saving(now: number): boolean {
    const saves = this.#ports.saveActivity();
    return saves.inFlight > 0 || now - saves.lastEndedAt < SAVE_SETTLE_MS;
  }

  #instruction(run: HistoryRun | null): LoopInstruction {
    if (run === null || run.status !== "running") return { stop: true };
    return { wait: Math.max(0, run.timing.dueAt - this.#ports.clock.now()) };
  }

  #gap(run: HistoryRun): number {
    return run.timing.gapMs + Math.floor(Math.max(0, Math.min(1, this.#ports.random())) * PAGE_GAP_JITTER_MS);
  }

  async view(): Promise<HistoryRunView> {
    const run = await this.#serial(() => this.#load());
    const now = this.#ports.clock.now();
    return describeRun(run, now, run?.status === "running" && this.#saving(now));
  }

  /** Every work the run has kept, for the review. Another account gets none. */
  async works() {
    const run = await this.#serial(() => this.#load());
    return run === null ? [] : this.#ports.store.readWorks();
  }

  /** Starts a run for `user`; the page loop in `tabId` carries it. */
  async start(user: string, tabId: number | null): Promise<HistoryRunView | { readonly error: StartError }> {
    if (!AO3_USERNAME_PATTERN.test(user)) return { error: "username_unclear" };
    const started = await this.#serial(async (): Promise<true | StartError> => {
      const account = await this.#ports.account().catch(() => null);
      if (account === null) return "not_connected";
      const current = await this.#load();
      // A finished run is replaced only after the reader deleted or imported it.
      if (current !== null) return "already_started";
      const run = newRun(this.#ports.newId(), account, user, tabId, this.#ports.clock.now());
      try {
        // A new run starts on an empty store.
        await this.#ports.store.clear();
        await this.#ports.store.writeRun(run);
      } catch (error) {
        return error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed";
      }
      this.#run = run;
      return true;
    });
    if (started !== true) return { error: started };
    await this.#alarm(true);
    await this.#ensureLoop(tabId);
    return this.view();
  }

  async pause(): Promise<HistoryRunView> {
    await this.#serial(async () => {
      const run = await this.#load();
      if (run === null || run.status !== "running") return;
      const next = clone(run);
      next.status = "paused";
      next.reason = "paused_by_you";
      next.timing.pausedAt = this.#ports.clock.now();
      await this.#write(next);
    });
    await this.#alarm(false);
    return this.view();
  }

  async resume(tabId: number | null): Promise<HistoryRunView> {
    const resumed = await this.#serial(async () => {
      const run = await this.#load();
      if (run === null || run.status !== "paused") return false;
      const next = clone(run);
      const now = this.#ports.clock.now();
      next.status = "running";
      next.reason = null;
      if (next.timing.pausedAt !== null) next.timing.pausedMs += Math.max(0, now - next.timing.pausedAt);
      next.timing.pausedAt = null;
      // The pause is not part of the pace the estimate reads.
      next.timing.lastKeptAt = null;
      // A saved retry deadline still holds.
      next.timing.dueAt = Math.max(next.timing.dueAt, now);
      next.retry.consecutive = 0;
      if (tabId !== null) next.tabId = tabId;
      return await this.#write(next);
    });
    if (resumed) {
      await this.#alarm(true);
      await this.#ensureLoop(this.#run?.tabId ?? null);
    }
    return this.view();
  }

  /** Stop and delete: the run and everything it found are gone. */
  async delete(): Promise<HistoryRunView> {
    await this.#serial(() => this.#forget());
    await this.#alarm(false);
    return this.view();
  }

  /** The signed-in account left: whatever was kept for it goes too. */
  async accountLeft(): Promise<void> {
    await this.#serial(() => this.#forget());
    await this.#alarm(false);
  }

  /**
   * Something other than the page loop woke the background: the alarm, the
   * sheet, an AO3 page, the background starting. A running run's page loop
   * is put (back) into the AO3 tab. It never reads.
   */
  async wake(tabId: number | null = null): Promise<void> {
    const loopTab = await this.#serial(async () => {
      const run = await this.#load();
      if (run === null || run.status !== "running") return null;
      if (tabId !== null && tabId !== run.tabId) {
        const next = clone(run);
        next.tabId = tabId;
        await this.#write(next);
      }
      return tabId ?? run.tabId;
    });
    if (loopTab === null) {
      if (this.#run?.status !== "running") await this.#alarm(false);
      return;
    }
    await this.#ensureLoop(loopTab);
  }

  /** The page loop's tick from the visible AO3 tab `tabId`. */
  async tick(tabId: number | null): Promise<LoopInstruction> {
    const instruction = await this.#serial(async (): Promise<LoopInstruction> => {
      const run = await this.#load();
      if (run === null || run.status !== "running") return { stop: true };
      const now = this.#ports.clock.now();
      const next = clone(run);
      if (tabId !== null) next.tabId = tabId;
      if (next.inFlight !== null) {
        if (now - next.inFlight.at <= LOST_AFTER_MS) {
          return { wait: Math.max(1_000, next.inFlight.at + LOST_AFTER_MS - now) };
        }
        // Its answer never came: the tab moved on, or Safari dropped it.
        next.inFlight = null;
      }
      if (next.nextPage > MAX_PAGES) return this.#pauseWith(next, "page_limit", now);
      if (this.#saving(now)) {
        if (tabId !== null && tabId !== run.tabId) await this.#write(next);
        return { wait: SAVE_RECHECK_MS };
      }
      if (now < next.timing.dueAt) {
        if (tabId !== null && tabId !== run.tabId) await this.#write(next);
        return { wait: next.timing.dueAt - now };
      }
      // The request is on record before it is made, so a restarted
      // background keeps the pace and knows it was lost.
      const token = this.#ports.newId();
      next.inFlight = { token, at: now, page: next.nextPage };
      next.timing.dueAt = now + LOST_AFTER_MS;
      const failure = await this.#writeFailure(next);
      if (failure !== null) return this.#pauseWith(next, failure, now);
      return { fetch: historyPageURL(next.user, next.nextPage), token };
    });
    if ("stop" in instruction) await this.#alarm(false);
    return instruction;
  }

  /** The answer to the request `token`, from the page loop. */
  async answer(token: string, answer: LoadedPage): Promise<LoopInstruction> {
    const instruction = await this.#serial(async (): Promise<LoopInstruction> => {
      const current = await this.#load();
      // Deleted, paused or given up as lost meanwhile: nothing is kept.
      if (current === null || current.inFlight === null || current.inFlight.token !== token) {
        return this.#instruction(current);
      }
      const next = clone(current);
      const { page } = current.inFlight;
      next.inFlight = null;
      const now = this.#ports.clock.now();
      if (next.status !== "running") {
        await this.#write(next);
        return this.#instruction(next);
      }
      const result = classifyHistoryAnswer(answer, next.user, page, now);
      if (result.kind === "page") return this.#keep(next, page, result.read, now);
      if (result.kind === "retry") return this.#retry(next, page, result, now);
      return this.#pauseWith(next, result.code, now);
    });
    if ("stop" in instruction) await this.#alarm(false);
    return instruction;
  }

  async #pauseWith(next: HistoryRun, reason: HistoryRunReason, now: number): Promise<LoopInstruction> {
    next.status = "paused";
    next.reason = reason;
    next.inFlight = null;
    next.timing.pausedAt ??= now;
    if (!(await this.#write(next))) {
      // Not even the pause could be kept; this background stops anyway.
      this.#run = next;
    }
    return { stop: true };
  }

  async #retry(
    next: HistoryRun,
    page: number,
    result: Extract<ClassifiedAnswer, { kind: "retry" }>,
    now: number,
  ): Promise<LoopInstruction> {
    next.retry.consecutive += 1;
    next.retry.code = result.code;
    const network = result.code === "network" || result.code === "timeout";
    const base = network ? NETWORK_RETRY_MS : RETRY_BASE_MS * 2 ** (next.retry.consecutive - 1);
    const retryAfter = result.retryAfterMs ?? 0;
    // Never before AO3's own time, even after a pause and Resume.
    next.timing.dueAt = now + Math.max(Math.min(RETRY_MAX_MS, base), retryAfter);
    if (next.retry.consecutive >= MAX_CONSECUTIVE_RETRIES) {
      const reason: HistoryRunReason = result.code === "timeout"
        ? "network"
        : result.code === "empty_page" && page === 1 ? "history_empty" : result.code;
      return this.#pauseWith(next, reason, now);
    }
    if (retryAfter > RETRY_MAX_MS) return this.#pauseWith(next, "retry_later", now);
    if (result.code === "rate_limited" || result.code === "unavailable" || result.code === "server_error") {
      // AO3 asked for less: every later page waits longer too.
      next.timing.gapMs = Math.min(MAX_PAGE_GAP_MS, next.timing.gapMs * 2);
    }
    const failure = await this.#writeFailure(next);
    if (failure !== null) return this.#pauseWith(next, failure, now);
    return this.#instruction(next);
  }

  async #keep(
    next: HistoryRun,
    page: number,
    read: Extract<HistoryPageRead, { kind: "page" }>,
    now: number,
  ): Promise<LoopInstruction> {
    const digest = read.works.length ? `${read.works[0]!.id}|${read.works.at(-1)!.id}|${read.works.length}` : null;
    if (digest !== null && digest === next.lastPageDigest) return this.#pauseWith(next, "pagination_repeat", now);
    next.lastPageDigest = digest;
    next.counts.pages += 1;
    next.counts.later += read.works.filter((work) => work.later).length;
    next.counts.deleted += read.deleted;
    next.counts.unreadable += read.unreadable;
    next.totalPages = Math.max(next.totalPages ?? 0, read.totalPages);
    next.retry = { consecutive: 0, code: null };
    if (next.timing.lastKeptAt !== null) {
      next.timing.keptGapMsTotal += now - next.timing.lastKeptAt;
      next.timing.keptGapCount += 1;
    }
    next.timing.lastKeptAt = now;
    if (read.nextPage === null) {
      next.status = "finished";
      next.reason = "reached_last_page";
      next.timing.finishedAt = now;
      next.totalPages = page;
    } else {
      next.nextPage = read.nextPage;
      next.timing.dueAt = now + this.#gap(next);
    }
    // The works and the run, with the counts the store worked out, are kept
    // together, or neither is. `runFor` may be called again when a lost
    // connection is retried, so it makes a new run and never changes `next`.
    let kept: HistoryRun = next;
    try {
      await this.#ports.store.admit(read.works, ({ fresh, repeats }) => {
        kept = {
          ...next,
          counts: { ...next.counts, works: next.counts.works + fresh, repeats: next.counts.repeats + repeats },
        };
        return kept;
      });
    } catch (error) {
      const failed = clone(this.#run ?? next);
      failed.inFlight = null;
      return this.#pauseWith(failed, error instanceof HistoryStoreFull ? "storage_full" : "storage_write_failed", now);
    }
    this.#run = clone(kept);
    return this.#instruction(this.#run);
  }
}
