/**
 * The standalone Keep a Copy extension's background (Chrome and Firefox):
 * AO3 requests, the downloads API and storage around the queue in
 * keep-a-copy.mts.
 *
 * Requests go from the extension with the reader's own AO3 cookies, which
 * the browser sends because the extension may reach AO3. A file is held as a
 * blob and saved from its URL: Firefox's background makes it, and Chrome's
 * service worker, which cannot, has its offscreen document make it. Safari
 * is not served here: it has no downloads API.
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
  type Settings,
  type Trigger,
} from "./keep-a-copy.mjs";

const TRIGGERS: readonly (Trigger | "visit")[] = ["bookmark", "later", "subscribe", "kudos", "open", "visit"];
const FILE_TIMEOUT_MS = 120_000;
/** How long a save is waited on before the queue looks again. */
const SETTLE_WAIT_MS = 20_000;
const ALARM = "keep-a-copy";
/** The longest a timer is trusted to fire before the background may be stopped. */
const TIMER_MAX_MS = 25_000;

interface DownloadItem {
  id: number;
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  byExtensionId?: string;
}

type DownloadDelta = { id: number; state?: { current?: string } };

interface Extension {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    onConnect: { addListener(listener: (port: { name: string; onMessage: { addListener(listener: () => void): void } }) => void): void };
    onMessage: { addListener(listener: (message: unknown, sender: { id?: string; url?: string }, respond: (value: unknown) => void) => boolean | void): void };
  };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  alarms: { create(name: string, info: { periodInMinutes: number }): void; onAlarm: { addListener(listener: (alarm: { name: string }) => void): void } };
  downloads: {
    download(options: { url: string; filename: string; conflictAction: "overwrite" | "uniquify"; saveAs: false }): Promise<number>;
    search(query: { id: number }): Promise<DownloadItem[]>;
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
export function offscreenKeeper(api: OffscreenApi) {
  let creating: Promise<void> | null = null;
  const open = async () => (await api.hasDocument?.().catch(() => false)) ?? false;
  return {
    async ensure(): Promise<void> {
      if (await open()) return;
      creating ??= api.createDocument({
        url: "offscreen.html", reasons: ["BLOBS"], justification: "Holds a downloaded AO3 file while it is saved.",
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

export function installKeepACopy(extension: Extension): KeepACopy {
  const { downloads, runtime } = extension;
  const blobsHere = typeof URL.createObjectURL === "function";

  const offscreen = !blobsHere && extension.offscreen ? offscreenKeeper(extension.offscreen) : null;
  // The offscreen document's pings while it fetches keep this service worker up.
  runtime.onConnect.addListener((port) => {
    if (port.name === KEEP_ALIVE_PORT) port.onMessage.addListener(() => undefined);
  });

  const fetchFile = async (url: string): Promise<Fetched> => {
    if (!offscreen) return requestAO3(url, "file", FILE_TIMEOUT_MS, MAX_FILE_BYTES);
    try {
      await offscreen.ensure();
      const answer = await runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "fetch", url, timeoutMs: FILE_TIMEOUT_MS, limit: MAX_FILE_BYTES });
      if (!answer || typeof answer !== "object") return { kind: "failed", code: "network" };
      const fetched = fromOffscreenAnswer(answer as OffscreenAnswer);
      // Claimed at once, so the document keeps it until the save is over.
      if (fetched.kind === "response" && fetched.handle) void runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "claim", handle: fetched.handle }).catch(() => undefined);
      return fetched;
    } catch {
      return { kind: "failed", code: "network" };
    }
  };

  const settle = async (id: number): Promise<SaveState> => {
    const find = async () => (await downloads.search({ id }))[0];
    const item = await find();
    if (!item) return { state: "interrupted", filename: null };
    if (item.state !== "in_progress") return { state: item.state, filename: item.filename };
    await new Promise<void>((resolve) => {
      const listener = (delta: DownloadDelta) => {
        if (delta.id === id && delta.state?.current && delta.state.current !== "in_progress") done();
      };
      const done = () => {
        clearTimeout(timer);
        downloads.onChanged.removeListener(listener);
        resolve();
      };
      const timer = setTimeout(done, SETTLE_WAIT_MS);
      downloads.onChanged.addListener(listener);
    });
    const after = await find();
    return after ? { state: after.state, filename: after.filename } : { state: "interrupted", filename: null };
  };

  const setUi = (enabled: boolean) => void downloads.setUiOptions?.({ enabled }).catch(() => undefined);
  // Whatever an earlier background left: the bubble shows until a backup hides it.
  setUi(true);

  const engine = new KeepACopy({
    clock: Date,
    random: Math.random,
    read: async () => (await extension.storage.local.get(KEEP_A_COPY_KEY))[KEEP_A_COPY_KEY],
    write: (state: KeepState) => extension.storage.local.set({ [KEEP_A_COPY_KEY]: state }),
    fetchPage: (url) => requestAO3(url, "text", REQUEST_TIMEOUT_MS, MAX_PAGE_CHARS * 2),
    fetchFile,
    save: ({ filename, handle, conflict }) => downloads.download({ url: handle, filename, conflictAction: conflict, saveAs: false }),
    settle,
    release(handle) {
      if (!offscreen) URL.revokeObjectURL(handle);
      else void runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "release", handle }).catch(() => undefined);
    },
    async cancel(id) {
      await downloads.cancel(id).catch(() => undefined);
      await downloads.erase({ id }).catch(() => undefined);
    },
    async remove(id, filename) {
      // A file the reader moved, renamed or replaced is theirs: it is only forgotten.
      if (!isOurFile((await downloads.search({ id }))[0], runtime.id, filename)) return;
      await downloads.removeFile(id).catch(() => undefined);
      await downloads.erase({ id });
    },
    quiet: (on) => setUi(!on),
  });

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    if (running) return;
    running = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      const wait = await engine.tick();
      if (wait !== null) timer = setTimeout(() => void run(), Math.max(250, Math.min(wait, TIMER_MAX_MS)));
      else await offscreen?.close();
    } catch {
      // The alarm tries again within a minute.
    } finally {
      running = false;
    }
  };

  extension.alarms.create(ALARM, { periodInMinutes: 1 });
  extension.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void run();
  });

  runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== runtime.id || !message || typeof message !== "object") return;
    const { type } = message as { type?: unknown };
    const handle = async (): Promise<unknown> => {
      if (type === KEEP_A_COPY_MESSAGE.page) {
        const { trigger, user, html, workId } = message as { trigger?: unknown; user?: unknown; html?: unknown; workId?: unknown };
        const from = sender.url ? new URL(sender.url) : null;
        if (from?.protocol !== "https:" || from.hostname !== "archiveofourown.org" || !TRIGGERS.includes(trigger as Trigger)) return null;
        await engine.noteUser(typeof user === "string" ? user : null);
        const page = typeof html === "string" ? readWorkPage(html) : null;
        if (page && (typeof workId !== "string" || page.workId === workId)) await engine.notePage(page, trigger as Trigger | "visit");
        else if (!page && typeof workId === "string" && trigger !== "visit") await engine.noteWork(workId, trigger as Trigger);
      } else if (type === KEEP_A_COPY_MESSAGE.settings) {
        await engine.updateSettings((message as { patch?: Partial<Settings> }).patch ?? {});
      } else if (type === KEEP_A_COPY_MESSAGE.backup) {
        const started = await engine.startBackup();
        void run();
        return started;
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
  return engine;
}

const scope = globalThis as unknown as { browser?: Extension; chrome?: Extension };
const extension = scope.browser ?? scope.chrome;
if (extension?.downloads) installKeepACopy(extension);
