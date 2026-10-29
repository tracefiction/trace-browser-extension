/**
 * Keep a Copy in Safari (iPhone, iPad and Mac): the extension side of the
 * hand-off to the Trace app. Safari has no downloads API, so the app
 * downloads public works itself and keeps every file and the queue. This
 * extension fetches only what the app asks it to (locked works, and works
 * AO3 refused the app), in the reader's own AO3 tab, and hands each file to
 * the app a part at a time over `sendNativeMessage`.
 *
 * The queue, its pace
 * and its rules are keep-a-copy.mts's, unchanged: one request at a time, a
 * locked work only from its page as the signed-in reader sees it, read in
 * the same step, and only a real file is handed over.
 *
 * No file is ever held here whole, nor as base64: it stays a Blob in the
 * reader's tab (keep-a-copy-tab.mts), and one part of at most 256 KiB is
 * read, encoded and sent at a time.
 */

import { REQUEST_TIMEOUT_MS } from "./ao3-history-import.mjs";
import {
  COPY_FORMATS,
  KEEP_A_COPY_KEY,
  KeepACopy,
  MAX_FILE_BYTES,
  MAX_PAGE_CHARS,
  type CopyFormat,
  type Fetched,
  type Pace,
  type SaveState,
  type Settings,
  type WantedWork,
} from "./keep-a-copy.mjs";
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
export const TRANSFER_KEY = "keepACopyNativeTransferV1";
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

export interface TabPort {
  /** The reader's AO3 tab to work in, or null when none is open. */
  find(): Promise<number | null>;
  /** Runs `func` in the tab and gives back its result, or null. */
  run<T>(tabId: number, func: (...args: never[]) => unknown, args: readonly unknown[], timeoutMs: number): Promise<T | null>;
}

export interface NativeHandoffDeps {
  readonly native: NativePort;
  readonly tabs: TabPort;
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
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

/** The queue with Safari's ports: requests in the reader's tab, files to the app. */
export class NativeCopyHandoff {
  readonly engine: KeepACopy;
  /** What the tab said of each file it holds: its size and digest. */
  readonly #files = new Map<string, { size: number; sha256: string }>();
  #pumping: Promise<void> | null = null;
  #lastQueueAt = -Infinity;

  constructor(private readonly deps: NativeHandoffDeps) {
    this.engine = new KeepACopy({
      clock: deps.clock,
      random: deps.random,
      read: () => deps.storage.get(KEEP_A_COPY_KEY),
      write: (state) => deps.storage.set(KEEP_A_COPY_KEY, state),
      fetchPage: async (url) => {
        const tabId = await deps.tabs.find();
        if (tabId === null) return { kind: "failed", code: "busy" };
        return fromTab(await deps.tabs.run<TabAnswer>(tabId, keepCopyFetchInTab, [url, "text", REQUEST_TIMEOUT_MS, MAX_PAGE_CHARS * 2, ""], REQUEST_TIMEOUT_MS + 5_000));
      },
      fetchFile: async (url) => {
        const tabId = await deps.tabs.find();
        if (tabId === null) return { kind: "failed", code: "busy" };
        const handle = `keep-copy:${tabId}:${deps.newId()}`;
        const answer = await deps.tabs.run<TabAnswer>(tabId, keepCopyFetchInTab, [url, "file", FILE_TIMEOUT_MS, MAX_FILE_BYTES, handle], FILE_TIMEOUT_MS + 5_000);
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
   * whether there is anything to do.
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
    await this.engine.updateSettings({ enabled: answer.enabled, format: answer.format });
    await this.engine.want(answer.works);
    return answer.works.length > 0;
  }

  async #record(): Promise<TransferRecord | null> {
    const stored = await this.deps.storage.get(TRANSFER_KEY).catch(() => null);
    return isRecord(stored) && typeof stored.transferId === "string" ? stored as unknown as TransferRecord : null;
  }

  #write(record: TransferRecord): Promise<void> {
    return this.deps.storage.set(TRANSFER_KEY, { ...record });
  }

  #send(message: Record<string, unknown>): Promise<unknown> {
    return this.deps.native.send({ ...message, protocolVersion: KEEP_COPY_PROTOCOL_VERSION }).catch(() => null);
  }

  async #fail(record: TransferRecord, reason: string): Promise<void> {
    record.state = "failed";
    await this.#write(record);
    await this.#send({ type: KEEP_COPY_NATIVE.abort, transferId: record.transferId, reason });
  }

  /** The app gave no answer: tried again on the next look, and given up after a few. */
  async #missed(record: TransferRecord, answer: unknown): Promise<void> {
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
    const record: TransferRecord = {
      transferId, downloadId: this.deps.clock.now(), workId: request.workId, updatedAt: request.updatedAt, format: request.format,
      fileName: request.filename, byteLength: file.size, sha256: file.sha256, handle: request.handle, nextIndex: 0, failures: 0, state: "open",
    };
    await this.#write(record);
    this.#pump(record);
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
    let next = ackedIndex(begin, transferId, parts);
    if (next === null) return this.#missed(record, begin);
    const tabId = tabOf(record.handle);
    while (next < parts) {
      const base64 = Number.isSafeInteger(tabId)
        ? await this.deps.tabs.run<string | null>(tabId, keepCopyPartInTab, [record.handle, next, PART_BYTES], REQUEST_TIMEOUT_MS)
        : null;
      // The tab was closed or reloaded: the file is gone with it.
      if (typeof base64 !== "string") return this.#fail(record, "file_gone");
      const ack = await this.#send({ type: KEEP_COPY_NATIVE.part, transferId, index: next, base64 });
      const after = ackedIndex(ack, transferId, parts);
      if (after === null) return this.#missed(record, ack);
      next = after;
      record.nextIndex = next;
      record.failures = 0;
      await this.#write(record);
    }
    const end = await this.#send({ type: KEEP_COPY_NATIVE.end, transferId });
    if (!isRecord(end) || end.ok !== true || end.transferId !== transferId || end.saved !== true) return this.#missed(record, end);
    record.state = "saved";
    await this.#write(record);
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
    return record?.state === "open" ? { state: "in_progress", filename: null } : { state: "interrupted", filename: null };
  }
}

// --- Safari's background ------------------------------------------------------------

interface SafariTab {
  readonly id?: number;
  readonly url?: string;
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
  readonly storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  /** Sends one message to the app (`sendNativeMessageWithFallback`). */
  sendNative(message: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown>;
  newId(): string;
}

const NATIVE_ALARM = "trace-keep-a-copy-native";
const TIMER_MAX_MS = 25_000;
const isAo3 = (url: string | undefined) => typeof url === "string" && /^https:\/\/archiveofourown\.org\//.test(url);

/** The reader's AO3 tab among those found: the one they are on, or the last they used. */
export function readerTab(tabs: readonly SafariTab[]): number | null {
  const open = tabs.filter((tab) => typeof tab.id === "number" && isAo3(tab.url) && !tab.discarded);
  open.sort((a, b) => Number(b.active === true) - Number(a.active === true) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return open[0]?.id ?? null;
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
    storage: {
      get: async (key) => (await env.storage.get(key))[key],
      set: (key, value) => env.storage.set({ [key]: value }),
    },
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
  void run(true);
  return handoff;
}
