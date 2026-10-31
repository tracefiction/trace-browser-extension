/**
 * Keep a Copy in Safari (iPhone, iPad and Mac): the extension side of the
 * hand-off to the Trace app. Safari has no downloads API, so the app
 * downloads public works itself and keeps every file and the queue. This
 * extension reads only what the app asks it to (works AO3 refused the app,
 * and locked works), in the reader's own AO3 tab, and hands each file to the
 * app a part at a time over `sendNativeMessage`. A public work is read signed
 * out; a locked one from its Chapter Index and file, signed in.
 *
 * The queue, its pace
 * and its rules are keep-a-copy.mts's, unchanged: one request at a time,
 * each work's page (or a locked work's Chapter Index) and its file in the
 * same step, and only a real file handed over.
 *
 * No file is ever held here whole, nor as base64: it stays a Blob in the
 * reader's tab (keep-a-copy-tab.mts), and one part of at most 256 KiB is
 * read, encoded and sent at a time.
 */

import { REQUEST_TIMEOUT_MS } from "./ao3-history-import.mjs";
import {
  COPY_FORMATS,
  KeepACopy,
  MAX_FILE_BYTES,
  MAX_PAGE_CHARS,
  type CopyFormat,
  type Fetched,
  type KeepState,
  type Pace,
  type SaveState,
  type Settings,
  type WantedWork,
} from "./keep-a-copy.mjs";
import { IndexedDbKeepStore } from "./keep-a-copy-store.mjs";
import { keepCopyFetchInTab, keepCopyPartInTab, keepCopyReleaseInTab, type TabAnswer } from "./keep-a-copy-tab.mjs";

export const KEEP_COPY_PROTOCOL_VERSION = 1;
export const KEEP_COPY_NATIVE = {
  queue: "KEEP_COPY_QUEUE_GET",
  begin: "KEEP_COPY_BEGIN",
  part: "KEEP_COPY_PART",
  end: "KEEP_COPY_END",
  abort: "KEEP_COPY_ABORT",
  skipped: "KEEP_COPY_SKIPPED",
} as const;
/** One part's bytes: as base64, with the message around it, well under the app's 512 KiB inbox. */
export const PART_BYTES = 256 * 1_024;
/** The most works one queue answer may name. */
export const MAX_QUEUE_WORKS = 100;
/** How long the app is waited on for each message. */
export const NATIVE_TIMEOUT_MS = 5_000;
/** Messages of one transfer the app may leave unanswered before it is given up. */
export const MAX_TRANSFER_FAILURES = 3;
/** The app is asked for its queue at most this often. */
export const QUEUE_EVERY_MS = 5 * 60_000;
/** The open transfer's record, in the store's own small records. */
export const TRANSFER_KEY = "nativeTransferV1";
const FILE_TIMEOUT_MS = 120_000;
/** How long a transfer is waited on before the queue looks again. */
const SETTLE_WAIT_MS = 20_000;

/** The app decides; nothing is kept by what the reader does on AO3. */
export const NATIVE_DEFAULTS: Settings = {
  enabled: false,
  triggers: { bookmark: false, later: false, subscribe: false, kudos: false, open: false },
  weeklyCheck: false,
  format: "epub",
};

const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const UPDATED_AT_PATTERN = /^[0-9]{1,12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface QueueAnswer {
  readonly enabled: boolean;
  readonly format: CopyFormat;
  readonly works: readonly (WantedWork & { readonly reason: "locked" | "refused" })[];
}

/** The app's queue, or null for anything that is not one: nothing is fetched on a malformed answer. */
export function readQueueAnswer(answer: unknown): QueueAnswer | null {
  if (!isRecord(answer) || answer.ok !== true || typeof answer.enabled !== "boolean") return null;
  const format = answer.format === undefined ? "epub" : answer.format;
  if (!COPY_FORMATS.includes(format as CopyFormat)) return null;
  const raw = answer.works ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_QUEUE_WORKS) return null;
  const works: (WantedWork & { reason: "locked" | "refused" })[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.workId !== "string" || !ID_PATTERN.test(item.workId)) return null;
    if (item.reason !== "locked" && item.reason !== "refused") return null;
    const have = item.have ?? null;
    if (have !== null && (typeof have !== "string" || !UPDATED_AT_PATTERN.test(have))) return null;
    const pace = item.pace ?? "check";
    if (pace !== "reader" && pace !== "check") return null;
    works.push({ workId: item.workId, have, pace: pace as Pace, reason: item.reason });
  }
  return { enabled: answer.enabled, format: format as CopyFormat, works: answer.enabled ? works : [] };
}

/** One file on its way to the app, kept in storage so a restarted background resumes it or gives it up. */
export interface TransferRecord {
  readonly transferId: string;
  readonly downloadId: number;
  readonly workId: string;
  readonly updatedAt: string;
  readonly format: CopyFormat;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  /** The file in the reader's tab: `keep-copy:<tab id>:<id>`. */
  readonly handle: string;
  nextIndex: number;
  failures: number;
  /** When the app last newly acknowledged a part: a transfer is given up only when this stops moving. */
  progressAt: number;
  state: "open" | "saved" | "failed";
}

export const partCount = (byteLength: number) => Math.max(1, Math.ceil(byteLength / PART_BYTES));
const tabOf = (handle: string) => Number(/^keep-copy:([0-9]{1,15}):/.exec(handle)?.[1] ?? NaN);

/** The next part the app asks for, from its acknowledgement of this transfer; null for anything else. */
export function ackedIndex(answer: unknown, transferId: string, parts: number): number | null {
  if (!isRecord(answer) || answer.ok !== true || answer.transferId !== transferId) return null;
  const next = answer.nextIndex;
  return typeof next === "number" && Number.isSafeInteger(next) && next >= 0 && next <= parts ? next : null;
}

export interface NativePort {
  /** Sends one message to the app; null when it does not answer in time. */
  send(message: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** The tab a step, or a transfer, is pinned to. */
export interface ReaderTab {
  readonly id: number;
  readonly windowId: number | null;
  readonly incognito: boolean;
  /** The AO3 work the tab is on, if it is on one. */
  readonly workId: string | null;
}

const samePlace = (a: ReaderTab, b: ReaderTab) => a.id === b.id && a.windowId === b.windowId && a.incognito === b.incognito;

export interface TabPort {
  /** The reader's AO3 tab, the one they are on, or null when they are not on AO3. */
  find(): Promise<ReaderTab | null>;
  /** Runs `func` in the tab and gives back its result, or null. */
  run<T>(tabId: number, func: (...args: never[]) => unknown, args: readonly unknown[], timeoutMs: number): Promise<T | null>;
}

/** Where the works and the open transfer are kept (IndexedDbKeepStore). */
export interface NativeStore {
  read(scope: string): Promise<unknown>;
  write(state: KeepState, changed: ReadonlySet<string>, scope: string): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export interface NativeHandoffDeps {
  readonly native: NativePort;
  readonly tabs: TabPort;
  readonly store: NativeStore;
  readonly clock: { now(): number };
  readonly random: () => number;
  newId(): string;
  /** Waits; a test moves its own clock. */
  sleep(ms: number): Promise<void>;
}

function fromTab(answer: TabAnswer | null): Fetched {
  if (!isRecord(answer)) return { kind: "failed", code: "network" };
  if (answer.kind !== "response") return answer;
  const { head, sha256: _sha256, ...rest } = answer;
  return { ...rest, ...(head ? { bytes: Uint8Array.from(head) } : {}) };
}

/** The app's word that it holds this transfer's file already: a repeat of a message it completed. */
const savedAnswer = (answer: unknown, transferId: string) =>
  isRecord(answer) && answer.ok === true && answer.transferId === transferId && answer.saved === true;

/** The queue with Safari's ports: requests in the reader's tab, files to the app. */
export class NativeCopyHandoff {
  readonly engine: KeepACopy;
  /** What the tab said of each file it holds: its size and digest. */
  readonly #files = new Map<string, { size: number; sha256: string }>();
  /** Transfers given up in this background: a loop still sending stops, and never writes them open again. */
  readonly #ended = new Set<string>();
  #pumping: Promise<void> | null = null;
  #lastQueueAt = -Infinity;
  /** The tab this step's page was read in: its file comes from there, or not at all. */
  #stepTab: ReaderTab | null = null;

  constructor(private readonly deps: NativeHandoffDeps) {
    this.engine = new KeepACopy({
      clock: deps.clock,
      random: deps.random,
      read: (scope) => deps.store.read(scope),
      write: (state, changed, scope) => deps.store.write(state, changed, scope),
      // Page and file in one step, from one tab.
      fileWithPage: true,
      // Each request goes with the credentials the queue gives it, in the tab.
      fetchPage: async (url, credentials) => {
        const tab = await deps.tabs.find();
        this.#stepTab = tab;
        if (tab === null) return { kind: "failed", code: "busy" };
        return fromTab(await deps.tabs.run<TabAnswer>(tab.id, keepCopyFetchInTab, [url, "text", REQUEST_TIMEOUT_MS, MAX_PAGE_CHARS * 2, "", credentials], REQUEST_TIMEOUT_MS + 5_000));
      },
      fetchFile: async (url, credentials) => {
        const pinned = this.#stepTab;
        this.#stepTab = null;
        const tab = await deps.tabs.find();
        // The reader left that tab, closed it, or left AO3 in it: the step
        // ends here, and no other tab is used in its place.
        if (pinned === null || tab === null || !samePlace(pinned, tab)) return { kind: "failed", code: "network" };
        const handle = `keep-copy:${tab.id}:${deps.newId()}`;
        const answer = await deps.tabs.run<TabAnswer>(tab.id, keepCopyFetchInTab, [url, "file", FILE_TIMEOUT_MS, MAX_FILE_BYTES, handle, credentials], FILE_TIMEOUT_MS + 5_000);
        if (answer?.kind === "response" && answer.handle === handle && typeof answer.sha256 === "string" && /^[0-9a-f]{64}$/.test(answer.sha256) && typeof answer.size === "number") {
          this.#files.set(handle, { size: answer.size, sha256: answer.sha256 });
        }
        return fromTab(answer);
      },
      save: (request) => this.#begin(request),
      settle: (downloadId) => this.#settle(downloadId),
      release: (handle) => {
        this.#files.delete(handle);
        const tabId = tabOf(handle);
        if (Number.isSafeInteger(tabId)) void deps.tabs.run(tabId, keepCopyReleaseInTab, [handle], 5_000).catch(() => undefined);
      },
      cancel: async (downloadId) => {
        const record = await this.#record();
        if (record?.downloadId === downloadId && record.state === "open") await this.#fail(record, "gave_up");
      },
      // The app owns every file and replaces a copy when the new one is complete.
      remove: async () => undefined,
      skipped: (workId, code) => void deps.native.send({ type: KEEP_COPY_NATIVE.skipped, protocolVersion: KEEP_COPY_PROTOCOL_VERSION, workId, code }).catch(() => undefined),
    }, NATIVE_DEFAULTS);
  }

  /**
   * Asks the app which works it wants fetched here, at most every five
   * minutes unless `force`, and tells it where the queue stands. Returns
   * whether there is anything to do. Only the work the reader has open now
   * goes at the reader's pace; every other one at the slow pace, under its
   * cap of reads.
   */
  async askQueue(force = false): Promise<boolean> {
    const now = this.deps.clock.now();
    if (!force && now - this.#lastQueueAt < QUEUE_EVERY_MS) return (await this.engine.view()).waiting > 0;
    this.#lastQueueAt = now;
    const view = await this.engine.view();
    const answer = readQueueAnswer(await this.deps.native.send({
      type: KEEP_COPY_NATIVE.queue,
      protocolVersion: KEEP_COPY_PROTOCOL_VERSION,
      waiting: view.waiting,
      stopped: view.stopped,
    }).catch(() => null));
    // No answer, or not one: the queue stays as it was.
    if (answer === null) return view.waiting > 0;
    const open = await this.deps.tabs.find().catch(() => null);
    await this.engine.updateSettings({ enabled: answer.enabled, format: answer.format });
    await this.engine.want(answer.works.map((work) => ({
      ...work, pace: work.pace === "reader" && open?.workId === work.workId ? "reader" : "check",
    })));
    return answer.works.length > 0;
  }

  async #record(): Promise<TransferRecord | null> {
    const stored = await this.deps.store.getMeta(TRANSFER_KEY).catch(() => null);
    return isRecord(stored) && typeof stored.transferId === "string" ? stored as unknown as TransferRecord : null;
  }

  #write(record: TransferRecord): Promise<void> {
    return this.deps.store.setMeta(TRANSFER_KEY, { ...record });
  }

  /** Whether this transfer is still the open one: not given up here, nor replaced or ended in storage. */
  async #open(record: TransferRecord): Promise<boolean> {
    if (this.#ended.has(record.transferId)) return false;
    const stored = await this.#record();
    return stored?.transferId === record.transferId && stored.state === "open" && !this.#ended.has(record.transferId);
  }

  /** Writes the loop's progress, only while the transfer is still open. */
  async #progress(record: TransferRecord): Promise<boolean> {
    if (!(await this.#open(record))) return false;
    await this.#write(record);
    return true;
  }

  #send(message: Record<string, unknown>): Promise<unknown> {
    return this.deps.native.send({ ...message, protocolVersion: KEEP_COPY_PROTOCOL_VERSION }).catch(() => null);
  }

  async #fail(record: TransferRecord, reason: string): Promise<void> {
    this.#ended.add(record.transferId);
    record.state = "failed";
    await this.#write(record);
    await this.#send({ type: KEEP_COPY_NATIVE.abort, transferId: record.transferId, reason });
  }

  async #saved(record: TransferRecord): Promise<void> {
    if (!(await this.#open(record))) return;
    record.state = "saved";
    await this.#write(record);
  }

  /** The app gave no answer: tried again on the next look, and given up after a few. */
  async #missed(record: TransferRecord, answer: unknown): Promise<void> {
    if (!(await this.#open(record))) return;
    if (isRecord(answer) && answer.ok === false) return this.#fail(record, typeof answer.error === "string" ? answer.error.slice(0, 40) : "refused");
    record.failures += 1;
    if (record.failures >= MAX_TRANSFER_FAILURES) return this.#fail(record, "no_answer");
    await this.#write(record);
  }

  async #begin(request: { workId: string; updatedAt: string; filename: string; format: CopyFormat; handle: string }): Promise<number> {
    const file = this.#files.get(request.handle);
    if (!file || file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error("file_unknown");
    // A transfer a stopped background left open is given up first.
    const old = await this.#record();
    if (old?.state === "open") await this.#fail(old, "replaced");
    const transferId = this.deps.newId();
    if (!UUID_PATTERN.test(transferId)) throw new Error("bad_id");
    const now = this.deps.clock.now();
    const record: TransferRecord = {
      transferId, downloadId: now, workId: request.workId, updatedAt: request.updatedAt, format: request.format,
      fileName: request.filename, byteLength: file.size, sha256: file.sha256, handle: request.handle, nextIndex: 0, failures: 0,
      progressAt: now, state: "open",
    };
    await this.#write(record);
    void this.#pump(record);
    return record.downloadId;
  }

  /** Sends the transfer from where the app says it stands; one at a time. */
  #pump(record: TransferRecord): Promise<void> {
    this.#pumping ??= this.#sendParts(record).catch(() => undefined).finally(() => {
      this.#pumping = null;
    });
    return this.#pumping;
  }

  async #sendParts(record: TransferRecord): Promise<void> {
    const parts = partCount(record.byteLength);
    const { transferId } = record;
    const begin = await this.#send({
      type: KEEP_COPY_NATIVE.begin, transferId, workId: record.workId, updatedAt: record.updatedAt, format: record.format,
      byteLength: record.byteLength, sha256: record.sha256, fileName: record.fileName, partBytes: PART_BYTES, partCount: parts,
    });
    // A repeated BEGIN for a transfer the app already completed.
    if (savedAnswer(begin, transferId)) return this.#saved(record);
    let next = ackedIndex(begin, transferId, parts);
    if (next === null) return this.#missed(record, begin);
    record.progressAt = this.deps.clock.now();
    if (!(await this.#progress(record))) return;
    const tabId = tabOf(record.handle);
    while (next < parts) {
      // Given up meanwhile (it took too long, or a newer one replaced it): stop.
      if (!(await this.#open(record))) return;
      const base64 = Number.isSafeInteger(tabId)
        ? await this.deps.tabs.run<string | null>(tabId, keepCopyPartInTab, [record.handle, next, PART_BYTES], REQUEST_TIMEOUT_MS)
        : null;
      // The tab was closed, reloaded or left: the file is gone with it.
      if (typeof base64 !== "string") return (await this.#open(record)) ? this.#fail(record, "file_gone") : undefined;
      const ack = await this.#send({ type: KEEP_COPY_NATIVE.part, transferId, index: next, base64 });
      if (savedAnswer(ack, transferId)) return this.#saved(record);
      const after = ackedIndex(ack, transferId, parts);
      if (after === null) return this.#missed(record, ack);
      // Progress is a part the app newly holds; a repeat answered again is not.
      if (after > record.nextIndex) record.progressAt = this.deps.clock.now();
      next = after;
      record.nextIndex = next;
      record.failures = 0;
      if (!(await this.#progress(record))) return;
    }
    if (!(await this.#open(record))) return;
    const end = await this.#send({ type: KEEP_COPY_NATIVE.end, transferId });
    if (!savedAnswer(end, transferId)) return this.#missed(record, end);
    await this.#saved(record);
  }

  async #settle(downloadId: number): Promise<SaveState> {
    let record = await this.#record();
    if (!record || record.downloadId !== downloadId) return { state: "interrupted", filename: null };
    if (record.state === "open") {
      // In a restarted background this picks the transfer up where the app has it.
      const pumping = this.#pump(record);
      await Promise.race([pumping, this.deps.sleep(SETTLE_WAIT_MS)]);
      record = await this.#record();
    }
    if (record?.state === "saved") return { state: "complete", filename: record.fileName };
    return record?.state === "open"
      ? { state: "in_progress", filename: null, progressAt: record.progressAt }
      : { state: "interrupted", filename: null };
  }
}

// --- Safari's background ------------------------------------------------------------

interface SafariTab {
  readonly id?: number;
  readonly url?: string;
  readonly windowId?: number;
  readonly incognito?: boolean;
  readonly active?: boolean;
  readonly lastAccessed?: number;
  readonly discarded?: boolean;
}

export interface NativeKeepEnvironment {
  readonly tabs: Record<string, unknown> & {
    onUpdated?: { addListener(listener: (tabId: number, change: { status?: string; url?: string }, tab: SafariTab) => void): void };
    onActivated?: { addListener(listener: () => void): void };
  };
  readonly scripting: { executeScript(details: Record<string, unknown>): Promise<unknown> };
  readonly alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    get?(name: string): Promise<unknown>;
    clear?(name: string): unknown;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  readonly indexedDB: IDBFactory;
  /** Sends one message to the app (`sendNativeMessageWithFallback`). */
  sendNative(message: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown>;
  newId(): string;
}

const NATIVE_ALARM = "trace-keep-a-copy-native";
const TIMER_MAX_MS = 25_000;
const isAo3 = (url: string | undefined) => typeof url === "string" && /^https:\/\/archiveofourown\.org\//.test(url);

/** The reader's AO3 tab among those found: the one they are on, or the last they used. */
export function readerTab(tabs: readonly SafariTab[]): ReaderTab | null {
  const open = tabs.filter((tab) => typeof tab.id === "number" && isAo3(tab.url) && !tab.discarded);
  open.sort((a, b) => Number(b.active === true) - Number(a.active === true) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const tab = open[0];
  if (!tab || typeof tab.id !== "number") return null;
  return {
    id: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    incognito: tab.incognito === true,
    workId: /^https:\/\/archiveofourown\.org\/(?:collections\/[^/]+\/)?works\/([1-9][0-9]{0,19})(?:[/?#]|$)/.exec(tab.url ?? "")?.[1] ?? null,
  };
}

const call = <T,>(target: Record<string, unknown>, method: string, args: readonly unknown[]): Promise<T> =>
  Promise.resolve().then(() => (target[method] as (...args: unknown[]) => T | Promise<T>)(...args));

/**
 * Installs the hand-off in Safari's background. It runs only while the
 * reader is on an AO3 page: the tab they are on is the one asked, and no
 * other tab is looked up.
 */
export function installNativeKeepACopy(env: NativeKeepEnvironment): NativeCopyHandoff {
  const tabs: TabPort = {
    find: async () => readerTab(await call<SafariTab[]>(env.tabs, "query", [{ active: true, currentWindow: true }]).catch(() => [])),
    async run<T>(tabId: number, func: (...args: never[]) => unknown, args: readonly unknown[], timeoutMs: number): Promise<T | null> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          env.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args }),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        const first: unknown = Array.isArray(results) ? results[0] : undefined;
        return isRecord(first) && "result" in first ? first.result as T : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  const handoff = new NativeCopyHandoff({
    native: { send: (message) => env.sendNative(message, NATIVE_TIMEOUT_MS) },
    tabs,
    store: new IndexedDbKeepStore(env.indexedDB),
    clock: Date,
    random: Math.random,
    newId: () => env.newId(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const alarm = async (on: boolean) => {
    if (!on) return void Promise.resolve(env.alarms.clear?.(NATIVE_ALARM)).catch(() => undefined);
    if (!(await env.alarms.get?.(NATIVE_ALARM).catch(() => undefined))) env.alarms.create(NATIVE_ALARM, { periodInMinutes: 1 });
  };
  const run = async (force = false) => {
    if (running) return;
    running = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      // Nothing is asked of the app, or of AO3, without the reader's AO3 tab.
      if ((await tabs.find()) === null) return void (await alarm(false));
      await handoff.askQueue(force);
      const wait = await handoff.engine.tick();
      if (wait === null) return void (await alarm(false));
      await alarm(true);
      timer = setTimeout(() => void run(), Math.max(250, Math.min(wait, TIMER_MAX_MS)));
    } catch {
      // The alarm, or the reader's next AO3 page, tries again.
    } finally {
      running = false;
    }
  };

  env.alarms.onAlarm.addListener((fired) => {
    if (fired.name === NATIVE_ALARM) void run();
  });
  env.tabs.onUpdated?.addListener((_tabId, change, tab) => {
    if (change.status === "complete" && isAo3(tab.url ?? change.url)) void run();
  });
  // The reader back on an AO3 tab: the queue carries on.
  env.tabs.onActivated?.addListener(() => void run());
  void run(true);
  return handoff;
}
