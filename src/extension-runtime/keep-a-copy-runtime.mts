/**
 * Keep a Copy's background in Chrome and Firefox, for the standalone
 * extension (keep-a-copy-standalone.mts) and Trace's own (index.mts): AO3
 * requests, the downloads API and storage around the queue in
 * keep-a-copy.mts.
 *
 * A public work's page and file are requested signed out; the reader's own
 * lists, and a locked work's Chapter Index and file, go with their AO3
 * cookies, which the browser sends because the extension may reach AO3. A
 * file is held as a blob and saved from its URL: Firefox's background makes
 * it, and Chrome's service worker, which cannot, has its offscreen document
 * make it. Safari is not served here: it has no downloads API.
 */

import { REQUEST_TIMEOUT_MS } from "./ao3-history-import.mjs";
import { KEEP_ALIVE_PORT, OFFSCREEN_TARGET, fromOffscreenAnswer, requestAO3, type OffscreenAnswer } from "./keep-a-copy-fetch.mjs";
import {
  KEEP_A_COPY_KEY,
  KEEP_A_COPY_MESSAGE,
  KeepACopy,
  MAX_FILE_BYTES,
  MAX_PAGE_CHARS,
  readWorkPage,
  type Fetched,
  type KeepState,
  type SaveState,
  type Scope,
  type Settings,
  type Trigger,
} from "./keep-a-copy.mjs";
import { IndexedDbKeepStore, PACER_KEY, withDevicePacer } from "./keep-a-copy-store.mjs";

type KeepMessage = (typeof KEEP_A_COPY_MESSAGE)[keyof typeof KEEP_A_COPY_MESSAGE];
const MESSAGES: readonly string[] = /* @__PURE__ */ Object.values(KEEP_A_COPY_MESSAGE);

const TRIGGERS: readonly (Trigger | "visit")[] = ["bookmark", "later", "subscribe", "kudos", "open", "visit"];
const FILE_TIMEOUT_MS = 120_000;
/** How long a save is waited on before the queue looks again. */
const SETTLE_WAIT_MS = 20_000;
const ALARM = "keep-a-copy";
/** The longest a timer is trusted to fire before the background may be stopped. */
const TIMER_MAX_MS = 25_000;

interface DownloadItem {
  id: number;
  /** The URL the save was made from: a save's own blob URL, which no other download has. */
  url: string;
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  byExtensionId?: string;
}

type DownloadDelta = { id: number; state?: { current?: string } };

export interface Extension {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    onConnect: { addListener(listener: (port: { name: string; onMessage: { addListener(listener: () => void): void } }) => void): void };
    onStartup?: { addListener(listener: () => void): void };
    onMessage: { addListener(listener: (message: unknown, sender: { id?: string; url?: string }, respond: (value: unknown) => void) => boolean | void): void };
  };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    get?(name: string): Promise<unknown>;
    clear?(name: string): unknown;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  downloads: {
    download(options: { url: string; filename: string; conflictAction: "overwrite" | "uniquify"; saveAs: false }): Promise<number>;
    search(query: { id: number } | { url: string }): Promise<DownloadItem[]>;
    removeFile(id: number): Promise<void>;
    cancel(id: number): Promise<void>;
    erase(query: { id: number }): Promise<unknown>;
    setUiOptions?(options: { enabled: boolean }): Promise<void>;
    onChanged: { addListener(listener: (delta: DownloadDelta) => void): void; removeListener(listener: (delta: DownloadDelta) => void): void };
  };
  offscreen?: OffscreenApi;
}

interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?(): Promise<boolean>;
}

/** Chrome's offscreen document, opened again whenever Chrome has closed it, and closed when the queue is idle. */
export function offscreenKeeper(api: OffscreenApi, url = "offscreen.html") {
  let creating: Promise<void> | null = null;
  const open = async () => (await api.hasDocument?.().catch(() => false)) ?? false;
  return {
    async ensure(): Promise<void> {
      if (await open()) return;
      creating ??= api.createDocument({
        url, reasons: ["BLOBS"], justification: "Holds a downloaded AO3 file while it is saved.",
      }).catch((error: unknown) => {
        // Already open, from before this service worker started.
        if (!/single offscreen/i.test(String(error))) throw error;
      }).finally(() => {
        creating = null;
      });
      await creating;
    },
    async close(): Promise<void> {
      if (!creating && (await open())) await api.closeDocument().catch(() => undefined);
    },
  };
}

/**
 * Whether a page's message was handled already: a page sends what it could
 * not get answered again (keep-a-copy-page.mts), and the background may
 * have handled it all the same. Each message's id is remembered a while.
 */
export function repeatedMessage(max = 100): (id: unknown) => boolean {
  const seen: string[] = [];
  return (id) => {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
    if (seen.includes(id)) return true;
    seen.push(id);
    if (seen.length > max) seen.shift();
    return false;
  };
}

const normalPath = (path: string) => path.replace(/\\/g, "/");

/** Whether a download is this extension's own, still at the name recorded for it. */
export function isOurFile(item: DownloadItem | undefined, extensionId: string, filename: string): boolean {
  if (!item || (item.byExtensionId !== undefined && item.byExtensionId !== extensionId)) return false;
  let path = normalPath(item.filename);
  let expected = normalPath(filename);
  // Windows paths (a drive or a share) match whatever their case.
  if (/^(?:[A-Za-z]:\/|\/\/)/.test(path)) {
    path = path.toLowerCase();
    expected = expected.toLowerCase();
  }
  return path === expected || path.endsWith(`/${expected}`);
}

type DownloadsApi = Pick<Extension["downloads"], "search" | "cancel" | "erase" | "removeFile" | "onChanged">;

/**
 * A save's own download: the one at its id while that still has the save's URL, or else the one
 * with that URL (a browser can hand an id to another download after a restart, and Firefox does).
 * Never another extension's, where the browser says whose a download is.
 */
export async function ownDownload(downloads: Pick<DownloadsApi, "search">, extensionId: string, id: number, handle: string): Promise<DownloadItem | undefined> {
  const ours = (item: DownloadItem | undefined): item is DownloadItem =>
    item !== undefined && item.url === handle && (item.byExtensionId === undefined || item.byExtensionId === extensionId);
  const atId = (await downloads.search({ id }).catch((): DownloadItem[] => []))[0];
  if (ours(atId)) return atId;
  return (await downloads.search({ url: handle }).catch((): DownloadItem[] => [])).find(ours);
}

/** Where saves stand, and giving them up, each known by its own URL (`ownDownload`): no one else's download is touched. */
export function downloadPorts(downloads: DownloadsApi, extensionId: string) {
  const own = (id: number, handle: string) => ownDownload(downloads, extensionId, id, handle);
  const state = (item: DownloadItem, id: number): SaveState => ({ state: item.state, filename: item.filename, ...(item.id !== id ? { downloadId: item.id } : {}) });
  return {
    async settle(id: number, handle: string): Promise<SaveState> {
      const item = await own(id, handle);
      // Found by neither its id nor its URL: lost.
      if (!item) return { state: "interrupted", filename: null };
      if (item.state !== "in_progress") return state(item, id);
      await new Promise<void>((resolve) => {
        const listener = (delta: DownloadDelta) => {
          if (delta.id === item.id && delta.state?.current && delta.state.current !== "in_progress") done();
        };
        const done = () => {
          clearTimeout(timer);
          downloads.onChanged.removeListener(listener);
          resolve();
        };
        const timer = setTimeout(done, SETTLE_WAIT_MS);
        downloads.onChanged.addListener(listener);
      });
      const after = await own(item.id, handle);
      return after ? state(after, id) : { state: "interrupted", filename: null };
    },
    async cancel(id: number, handle: string): Promise<void> {
      const item = await own(id, handle);
      if (!item) return;
      await downloads.cancel(item.id).catch(() => undefined);
      await downloads.erase({ id: item.id }).catch(() => undefined);
    },
    async remove(id: number, filename: string, url?: string): Promise<void> {
      // Only the copy's own download, found by its URL, still at the copy's name: a file the reader moved,
      // renamed, replaced, or saved there by hand under the copy's old id, is theirs, and is only forgotten.
      // So is a copy saved before its URL was kept.
      if (url === undefined) return;
      const item = await own(id, url);
      if (!item || !isOurFile(item, extensionId, filename)) return;
      await downloads.removeFile(item.id).catch(() => undefined);
      await downloads.erase({ id: item.id });
    },
  };
}

/**
 * Starts a repeating alarm unless it is already set: creating it again would
 * push its next run back, for ever if the background restarts more often.
 */
export async function ensureAlarm(alarms: Extension["alarms"], name: string, periodInMinutes: number): Promise<void> {
  const existing = await alarms.get?.(name).catch(() => undefined);
  if (!existing) alarms.create(name, { periodInMinutes });
}

export interface KeepACopyOptions {
  /** The settings a new store starts with. */
  readonly defaults?: Settings;
  /** The messages answered (all, by default): Trace's build has no AO3 list backup. */
  readonly answers?: readonly KeepMessage[];
  /**
   * Whether the minute alarm runs while there is nothing to do (the default,
   * for the weekly check). Off, it runs only while the queue is busy, so the
   * background is not woken every minute for a switch that is off.
   */
  readonly idleAlarm?: boolean;
  /** Whose works are in use at first: "" for the standalone's own, null until an account is known. */
  readonly scope?: Scope;
  /** Where the works are kept; IndexedDB by default. */
  readonly store?: Pick<IndexedDbKeepStore, "read" | "write">;
  /** Chrome's offscreen document, in the package. */
  readonly offscreenDocument?: string;
}

export interface KeepACopyInstall {
  readonly engine: KeepACopy;
  /** Looks at the queue now, after something was added to it. */
  wake(): void;
}

export function installKeepACopy(extension: Extension, options: KeepACopyOptions = {}): KeepACopyInstall {
  const { downloads, runtime } = extension;
  const answers: readonly string[] = options.answers ?? MESSAGES;
  const idleAlarm = options.idleAlarm ?? true;
  const blobsHere = typeof URL.createObjectURL === "function";

  const offscreen = !blobsHere && extension.offscreen ? offscreenKeeper(extension.offscreen, options.offscreenDocument) : null;
  // The offscreen document's pings while it fetches keep this service worker up.
  runtime.onConnect.addListener((port) => {
    if (port.name === KEEP_ALIVE_PORT) port.onMessage.addListener(() => undefined);
  });

  const fetchFile = async (url: string, credentials: "omit" | "include"): Promise<Fetched> => {
    if (!offscreen) return requestAO3(url, "file", FILE_TIMEOUT_MS, MAX_FILE_BYTES, credentials);
    try {
      await offscreen.ensure();
      const answer = await runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "fetch", url, timeoutMs: FILE_TIMEOUT_MS, limit: MAX_FILE_BYTES, credentials });
      if (!answer || typeof answer !== "object") return { kind: "failed", code: "network" };
      const fetched = fromOffscreenAnswer(answer as OffscreenAnswer);
      // Claimed at once, so the document keeps it until the save is over.
      if (fetched.kind === "response" && fetched.handle) void runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "claim", handle: fetched.handle }).catch(() => undefined);
      return fetched;
    } catch {
      return { kind: "failed", code: "network" };
    }
  };

  const { settle, cancel, remove } = downloadPorts(downloads, runtime.id);

  const setUi = (enabled: boolean) => void downloads.setUiOptions?.({ enabled }).catch(() => undefined);
  // Whatever an earlier background left: the bubble shows until a backup hides it.
  setUi(true);

  const indexedDB = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const store: Pick<IndexedDbKeepStore, "read" | "write"> = options.store ?? (indexedDB
    ? new IndexedDbKeepStore(indexedDB)
    // Without IndexedDB (never in a supported browser): an account's whole state in one key, the device's pacer in another.
    : {
        read: async (scope) => withDevicePacer(
          (await extension.storage.local.get(`${KEEP_A_COPY_KEY}:${scope}`))[`${KEEP_A_COPY_KEY}:${scope}`],
          (await extension.storage.local.get(`${KEEP_A_COPY_KEY}.${PACER_KEY}`))[`${KEEP_A_COPY_KEY}.${PACER_KEY}`],
        ),
        write: ({ pacer, ...state }: KeepState, _changed, scope) =>
          extension.storage.local.set({ [`${KEEP_A_COPY_KEY}:${scope}`]: state, [`${KEEP_A_COPY_KEY}.${PACER_KEY}`]: pacer }),
      });
  const engine = new KeepACopy({
    clock: Date,
    random: Math.random,
    read: (scope) => store.read(scope),
    write: (state, changed, scope) => store.write(state, changed, scope),
    fetchPage: (url, credentials) => requestAO3(url, "text", REQUEST_TIMEOUT_MS, MAX_PAGE_CHARS * 2, credentials),
    fetchFile,
    save: ({ filename, handle, conflict }) => downloads.download({ url: handle, filename, conflictAction: conflict, saveAs: false }),
    settle,
    release(handle) {
      if (!offscreen) URL.revokeObjectURL(handle);
      else void runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "release", handle }).catch(() => undefined);
    },
    cancel,
    remove,
    quiet: (on) => setUi(!on),
  // Trace's null (no account's works until its Library is read) stays null: only no scope given is the standalone's own.
  }, options.defaults, options.scope === undefined ? "" : options.scope);

  const repeated = repeatedMessage();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alarmOn = false;
  const alarm = (on: boolean) => {
    if (alarmOn === on) return;
    alarmOn = on;
    if (on) void ensureAlarm(extension.alarms, ALARM, 1).catch(() => undefined);
    else void Promise.resolve(extension.alarms.clear?.(ALARM)).catch(() => undefined);
  };
  const run = async () => {
    if (running) return;
    running = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      // Set before the tick, so a background stopped part-way is woken
      // again; never for a switch that is off.
      if (await engine.enabled()) alarm(true);
      const wait = await engine.tick();
      if (wait !== null) timer = setTimeout(() => void run(), Math.max(250, Math.min(wait, TIMER_MAX_MS)));
      else {
        if (!idleAlarm) alarm(false);
        await offscreen?.close();
      }
    } catch {
      // The alarm tries again within a minute.
    } finally {
      running = false;
    }
  };

  extension.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void run();
  });
  // The browser opening starts the background: a queue goes on with no page open, and Firefox keeps no alarm across sessions.
  runtime.onStartup?.addListener(() => void run());

  runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== runtime.id || !message || typeof message !== "object") return;
    const { type } = message as { type?: unknown };
    // Other messages are another part of the background's to answer.
    if (typeof type !== "string" || !answers.includes(type)) return;
    const handle = async (): Promise<unknown> => {
      if (type === KEEP_A_COPY_MESSAGE.page) {
        const { trigger, user, html, workId, id } = message as { trigger?: unknown; user?: unknown; html?: unknown; workId?: unknown; id?: unknown };
        const from = sender.url ? new URL(sender.url) : null;
        if (from?.protocol !== "https:" || from.hostname !== "archiveofourown.org" || !TRIGGERS.includes(trigger as Trigger)) return null;
        // Null only when the page shows the reader signed out; absent when it does not say.
        if (typeof user === "string" || user === null) await engine.noteUser(user);
        const page = typeof html === "string" ? readWorkPage(html) : null;
        // Sent again but handled already: a work just skipped is not read again.
        if (!repeated(id)) {
          if (page && (typeof workId !== "string" || page.workId === workId)) await engine.notePage(page, trigger as Trigger | "visit");
          else if (!page && typeof workId === "string" && trigger !== "visit") await engine.noteWork(workId, trigger as Trigger);
        }
      } else if (type === KEEP_A_COPY_MESSAGE.settings) {
        await engine.updateSettings((message as { patch?: Partial<Settings> }).patch ?? {});
      } else if (type === KEEP_A_COPY_MESSAGE.backup) {
        const started = await engine.startBackup();
        void run();
        return started;
      } else if (type === KEEP_A_COPY_MESSAGE.stopBackup) {
        await engine.stopBackup();
      } else if (type === KEEP_A_COPY_MESSAGE.resumeBackup) {
        await engine.resumeBackup();
      } else if (type === KEEP_A_COPY_MESSAGE.retrySkipped) {
        await engine.retrySkipped();
      } else if (type !== KEEP_A_COPY_MESSAGE.view) {
        return null;
      }
      void run();
      return { ...(await engine.view()), canHideDownloads: typeof downloads.setUiOptions === "function" };
    };
    handle().then(respond, () => respond(null));
    return true;
  });

  void run();
  return { engine, wake: () => void run() };
}
