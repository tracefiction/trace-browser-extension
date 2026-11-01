/**
 * Keep a Copy in Trace's own extension, in Chrome and Firefox: the reader's
 * Trace Library says which AO3 works are kept, through the same queue, pace
 * and files as the standalone extension (keep-a-copy.mts).
 *
 * Kept: every AO3 story in the Library that is Saved, Reading, Caught up,
 * Paused or Finished. Moving a story to Dropped stops its updates and never
 * deletes its file. The Library is the one the extension already reads for
 * its page marks (GET /api/extension/library-overlay): nothing new is asked
 * of Trace, and nothing about the copies is sent to it.
 *
 * A copy is refreshed when the reader opens the work (its page's Download
 * link has a new `updated_at`), or when Trace's count of the work's
 * published chapters rises; the work's page is then read once, and the file
 * fetched only if AO3 says it changed.
 *
 * Off until the reader turns it on (`prefKeepACopyEnabled`), and only in a
 * package built with TRACE_KEEP_A_COPY=1.
 */

import type { AccountOverlay, LibraryOverlayEntry } from "../extension-core/index.mjs";
import { ACCOUNT_PROJECTION_REVISION_KEY } from "./runtime-messages.mjs";
import { KEEP_A_COPY_MESSAGE, type KeepACopy, type LibraryList, type Settings } from "./keep-a-copy.mjs";
import { ensureAlarm, installKeepACopy, type Extension } from "./keep-a-copy-runtime.mjs";

export const KEEP_A_COPY_PREF_KEY = "prefKeepACopyEnabled";
export const LIBRARY_SYNC_ALARM = "trace-keep-a-copy-library";
/** How often the Library is read again while the switch is on. */
export const LIBRARY_SYNC_MINUTES = 15;
/** The most entries Trace sends. */
export const LIBRARY_MAX_ENTRIES = 10_000;
/**
 * Trace leaves out entries it cannot show before it counts what it sends, so
 * the list is taken as the whole Library only when the account's own count
 * of stories, and the list, are well under its limit. Otherwise a work
 * missing from it is never let go: only Dropped stops a work's updates.
 */
export const LIBRARY_WHOLE_BELOW = 9_500;
/** Chrome's offscreen document in Trace's package. */
export const KEEP_A_COPY_OFFSCREEN_DOCUMENT = "keep-a-copy-offscreen.html";

/** Nothing is kept by what the reader does on AO3: the Library alone says. */
export const LIBRARY_DEFAULTS: Settings = {
  enabled: false,
  triggers: { bookmark: false, later: false, subscribe: false, kudos: false, open: false },
  weeklyCheck: false,
  format: "epub",
};

type ReaderStatus = NonNullable<LibraryOverlayEntry["canonicalReaderStatus"]>;

export const KEPT_STATUSES: readonly ReaderStatus[] = ["SAVED", "READING", "CAUGHT_UP", "PAUSED", "FINISHED"];

const FROM_LEGACY: Readonly<Record<LibraryOverlayEntry["status"], ReaderStatus>> = {
  PLANNING: "SAVED",
  READING: "READING",
  PAUSED: "PAUSED",
  COMPLETED: "FINISHED",
  DROPPED: "DROPPED",
};

export function readerStatus(entry: LibraryOverlayEntry): ReaderStatus {
  return entry.canonicalReaderStatus ?? FROM_LEGACY[entry.status];
}

/**
 * Trace's count of a work's published chapters: the reader's chapter plus
 * the new ones after it, when Trace knows both. Reading moves one into the
 * other, so only a new chapter makes the sum rise.
 */
export function publishedChapters(entry: LibraryOverlayEntry): number | null {
  if (!entry.chapters || (entry.catchupState !== "UP" && entry.catchupState !== "BEHIND")) return null;
  return entry.chapters.current + (entry.newChapterCount ?? 0);
}

/** The Library of the account connected now, as Keep a Copy reads it. */
export interface LibrarySnapshot {
  readonly accountId: string;
  readonly overlay: AccountOverlay;
  /** The account's own count of its Library's stories, when Trace reported one. */
  readonly libraryCount: number | null;
}

/** The Library's AO3 works, as the queue keeps them. */
export function libraryList(overlay: AccountOverlay, libraryCount: number | null): LibraryList {
  const keep: { workId: string; chapters: number | null }[] = [];
  const drop: string[] = [];
  for (const [key, entry] of Object.entries(overlay.entries)) {
    const workId = /^ao3:([1-9][0-9]{0,19})$/.exec(key)?.[1];
    if (!workId) continue;
    if (KEPT_STATUSES.includes(readerStatus(entry))) keep.push({ workId, chapters: publishedChapters(entry) });
    else drop.push(workId);
  }
  const whole = libraryCount !== null && libraryCount < LIBRARY_WHOLE_BELOW && Object.keys(overlay.entries).length < LIBRARY_WHOLE_BELOW;
  return { keep, drop, whole };
}

export interface LibraryCopiesDeps {
  readonly engine: Pick<KeepACopy, "updateSettings" | "syncLibrary" | "useScope" | "switchOff">;
  /** The accounts with works kept here. */
  scopes(): Promise<readonly string[]>;
  /** Looks at the queue now. */
  wake(): void;
  /** The Library of the account connected now; null when none is, or it cannot be read. */
  library(refresh: boolean): Promise<LibrarySnapshot | null>;
  readPref(): Promise<boolean>;
  /** Starts or stops the Library's own alarm. */
  alarm(on: boolean): void;
}

/** The switch, the Library and the queue, kept in step. */
export class TraceLibraryCopies {
  #on = false;
  #tail: Promise<void> = Promise.resolve();
  /** Changes of the switch the reader made: a read of it begun before one is older. */
  #changes = 0;

  constructor(private readonly deps: LibraryCopiesDeps) {}

  /** A background starting: the Library kept here is used, and Trace is asked again on the alarm. */
  async start(): Promise<void> {
    const changes = this.#changes;
    // The switch cannot be read: off for this wake, with what is stored left as it is.
    const on = await this.deps.readPref().catch(() => null);
    // The reader changed the switch while it was read: their change stands.
    if (on === null || changes !== this.#changes) return;
    await this.#apply(on, false);
  }

  /** The reader turned the switch on or off. */
  prefChanged(on: boolean): Promise<void> {
    this.#changes += 1;
    return this.#apply(on, true);
  }

  async #apply(on: boolean, refresh: boolean): Promise<void> {
    this.#on = on;
    // An off goes on even if the works in use cannot be written: the alarm stops, and the other accounts are reached.
    await this.deps.engine.updateSettings({ enabled: on }).catch((error: unknown) => {
      if (on) throw error;
    });
    this.deps.alarm(on);
    if (on) await this.sync(refresh);
    // Off: every account's works kept here are switched off, not only those in use, so not even an AO3 name stays.
    else for (const scope of await this.deps.scopes().catch(() => [])) await this.deps.engine.switchOff(scope).catch(() => undefined);
  }

  /** Reads the Library and keeps its works, one read at a time. */
  sync(refresh: boolean): Promise<void> {
    return this.#queue(async () => {
      if (!this.#on) return;
      const library = await this.deps.library(refresh).catch(() => null);
      // Unknown is not empty: nothing is let go without a Library read.
      if (library === null) return;
      // That account's own works: another account's are left as they are.
      await this.deps.engine.useScope(library.accountId);
      // Turned off while the Library was read: that account's works are switched off too.
      await this.deps.engine.updateSettings({ enabled: this.#on });
      if (!this.#on) return;
      await this.deps.engine.syncLibrary(libraryList(library.overlay, library.libraryCount));
      this.deps.wake();
    });
  }

  /**
   * The account signed out, or another took its place: its works are left
   * as they are, files and all, and nothing runs until an account is read
   * again. The same account back carries on without checking them again.
   */
  accountLeft(): Promise<void> {
    return this.#queue(() => this.deps.engine.useScope(null));
  }

  /** One change of works in use at a time. */
  #queue(task: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

interface TraceExtension extends Extension {
  readonly storage: Extension["storage"] & {
    readonly onChanged: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
  };
}

export interface TraceLibrarySource {
  librarySnapshot(refresh: boolean): Promise<LibrarySnapshot | null>;
  whenAccountLeaves(cleanup: () => Promise<void>): void;
}

/** Installs Keep a Copy in Trace's background, where the downloads API is. */
export function installTraceKeepACopy(extension: TraceExtension, source: TraceLibrarySource): TraceLibraryCopies {
  const { engine, scopes, wake } = installKeepACopy(extension, {
    defaults: LIBRARY_DEFAULTS,
    answers: [KEEP_A_COPY_MESSAGE.page, KEEP_A_COPY_MESSAGE.view],
    idleAlarm: false,
    offscreenDocument: KEEP_A_COPY_OFFSCREEN_DOCUMENT,
    // No account's works are in use until the Library is read.
    scope: null,
  });
  const copies = new TraceLibraryCopies({
    engine,
    scopes,
    wake,
    library: (refresh) => source.librarySnapshot(refresh),
    readPref: async () => (await extension.storage.local.get(KEEP_A_COPY_PREF_KEY))[KEEP_A_COPY_PREF_KEY] === true,
    alarm(on) {
      if (on) void ensureAlarm(extension.alarms, LIBRARY_SYNC_ALARM, LIBRARY_SYNC_MINUTES).catch(() => undefined);
      else void Promise.resolve(extension.alarms.clear?.(LIBRARY_SYNC_ALARM)).catch(() => undefined);
    },
  });
  source.whenAccountLeaves(() => copies.accountLeft());
  extension.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LIBRARY_SYNC_ALARM) void copies.sync(true).catch(() => undefined);
  });
  extension.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (KEEP_A_COPY_PREF_KEY in changes) void copies.prefChanged(changes[KEEP_A_COPY_PREF_KEY]?.newValue === true).catch(() => undefined);
    // A save, a status change or another account: the Library kept here has changed.
    // (Trace is asked again at most every 30 s: the account view's own limit.)
    else if (ACCOUNT_PROJECTION_REVISION_KEY in changes) void copies.sync(true).catch(() => undefined);
  });
  void copies.start().catch(() => undefined);
  return copies;
}
