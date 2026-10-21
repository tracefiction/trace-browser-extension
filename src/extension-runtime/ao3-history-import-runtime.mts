/**
 * The History import in the browser: the page loop it puts into the reader's
 * AO3 tab, the messages the sheet and that loop send, and its alarm.
 * ao3-history-import.mts decides; this file only carries messages and runs
 * the loop.
 */

import { extensionCall, type AlarmsPort, type PermissionsPort, type RuntimePort, type ScriptingPort, type TabsPort } from "./browser-platform.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";
import {
  AO3_HISTORY_IMPORT_MESSAGE,
  Ao3HistoryImport,
  REQUEST_TIMEOUT_MS,
  type HistoryRunView,
} from "./ao3-history-import.mjs";
import {
  AO3_USERNAME_PATTERN,
  MAX_HISTORY_PAGE_CHARS,
  type LoadFailCode,
  type LoadedPage,
} from "./ao3-history-page.mjs";
import { IndexedDbHistoryStore, MemoryHistoryStore, type HistoryStore } from "./ao3-history-store.mjs";

export const AO3_HISTORY_IMPORT_ALARM = "trace-ao3-history-import";
const AO3_SITE_PATTERN = "https://*.archiveofourown.org/*";

/**
 * The page loop, put into the reader's AO3 tab. Runs in the page, so it must
 * use nothing from outside this function. While the tab is visible it asks
 * the background what to do, makes a same-site request when told (with the
 * tab's own sign-in and Safari's own headers), hands the answer back, and
 * waits as long as it is told; the timer lives in the page, so it outlasts
 * the background. Hidden, it waits for the tab to be shown again.
 *
 * It also draws the reading bar at the foot of the page from the run's view
 * that comes with each reply: how far the run has got, with Pause, and what
 * happened when it stops. The bar lives in its own shadow root, so AO3's
 * styles and Trace's never meet. It shows only counts, never a work.
 */
export function ao3HistoryLoopInTab(message: string, maxChars: number, timeoutMs: number): unknown {
  const scope = globalThis as unknown as Record<string, unknown>;
  const key = "__traceAo3HistoryImportLoopV1";
  const existing = scope[key] as { poke(): void } | undefined;
  if (existing) {
    existing.poke();
    return "running";
  }
  const api = (scope.browser ?? scope.chrome) as { runtime: { sendMessage(message: unknown): unknown } } | undefined;
  if (!api?.runtime) return "no_runtime";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let stopped = false;
  const send = (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      return Promise.resolve(api.runtime.sendMessage({ type: message, ...body }))
        .then((reply) => (reply && typeof reply === "object" ? reply as Record<string, unknown> : null), () => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  };

  // --- The reading bar ---
  const barKey = "__traceAo3HistoryImportBarV1";
  let bar: { host: HTMLElement; title: HTMLElement; line: HTMLElement; button: HTMLButtonElement; fill: HTMLElement } | null = null;
  let hidden = false;
  let buttonAction: "pause" | "hide" = "pause";
  const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
  const removeBar = () => {
    bar?.host.remove();
    bar = null;
  };
  const makeBar = () => {
    const old = document.getElementById(barKey);
    if (old) old.remove();
    const host = document.createElement("div");
    host.id = barKey;
    // Open, so assistive tech and tests can read it; it holds only counts.
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      ".bar{--surface:#ffffff;--text:#18232d;--text-2:#5f6b76;--track:#d8e0e7;--action:#c24c22;" +
        "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483646;" +
        "max-width:560px;margin:0 auto;box-sizing:border-box;padding:12px 14px 14px;border-radius:14px;" +
        "background:var(--surface);color:var(--text);box-shadow:0 1px 0 rgba(24,35,45,.04),0 12px 28px -12px rgba(24,35,45,.42);" +
        "font:15px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:center}",
      "@media (prefers-color-scheme:dark){.bar{--surface:#121418;--text:#f2f5f8;--text-2:#b4bcc6;--track:#2b2f35;--action:#ff8458}}",
      ".title{font-weight:600;margin:0}",
      ".line{grid-column:1;color:var(--text-2);font-size:13px;margin:0}",
      "button{grid-row:1/3;grid-column:2;min-height:44px;padding:0 14px;border:0;border-radius:10px;" +
        "font:600 15px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--text);background:var(--track);cursor:pointer}",
      ".track{grid-column:1/3;height:3px;margin-top:8px;border-radius:2px;background:var(--track);overflow:hidden}",
      ".fill{height:100%;width:0;background:var(--action);border-radius:2px;transition:width .3s}",
      "@media (prefers-reduced-motion:reduce){.fill{transition:none}}",
    ].join("");
    const box = document.createElement("div");
    box.className = "bar";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    const title = document.createElement("p");
    title.className = "title";
    const line = document.createElement("p");
    line.className = "line";
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => {
      if (buttonAction === "hide") {
        hidden = true;
        removeBar();
        return;
      }
      button.disabled = true;
      void send({ action: "tab_pause" }).then((reply) => {
        stop();
        if (reply && reply.view) render(reply.view);
        button.disabled = false;
      });
    });
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    track.appendChild(fill);
    box.append(title, line, button, track);
    root.append(style, box);
    (document.body ?? document.documentElement).appendChild(host);
    return { host, title, line, button, fill };
  };
  function render(view: unknown): void {
    if (hidden || !view || typeof view !== "object") return;
    const v = view as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const works = number(v.works) ?? 0;
    const read = number(v.pagesRead) ?? 0;
    const total = number(v.totalPages);
    if (v.status !== "running" && v.status !== "paused" && v.status !== "finished") {
      removeBar();
      return;
    }
    bar ??= makeBar();
    let title = "Reading your History";
    let line = "";
    if (v.status === "running") {
      const page = total === null ? read + 1 : Math.min(read + 1, total);
      const waiting = v.waitingFor;
      line = waiting === "slow_down"
        ? "AO3 asked Trace to slow down. Trying again soon."
        : waiting === "ao3_unwell"
          ? "AO3 isn't answering. Trace will try again shortly."
          : waiting === "network"
            ? "No connection. Trace will try again shortly."
            : `Page ${page}${total === null ? "" : ` of ${total}`} · ${plural(works, "story", "stories")}`;
      buttonAction = "pause";
    } else if (v.status === "paused") {
      title = "Paused";
      line = `${plural(works, "story", "stories")} kept. Open Trace to carry on.`;
      buttonAction = "hide";
    } else {
      title = "Your History is ready";
      line = `${plural(works, "story", "stories")}. Open Trace to review them.`;
      buttonAction = "hide";
    }
    bar.title.textContent = title;
    bar.line.textContent = line;
    bar.button.textContent = buttonAction === "pause" ? "Pause" : "Hide";
    const share = v.status === "finished" ? 1 : total === null || total === 0 ? 0 : Math.min(1, read / total);
    bar.fill.style.width = `${Math.round(share * 1_000) / 10}%`;
  }

  const read = async (url: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const limit = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "follow", signal: controller.signal });
      const text = await response.text();
      return {
        kind: "response",
        status: response.status,
        url: response.url,
        html: text.length > maxChars ? text.slice(0, maxChars) : text,
        chars: text.length,
        retryAfter: response.headers.get("retry-after"),
        cfMitigated: response.headers.get("cf-mitigated"),
        contentType: response.headers.get("content-type"),
      };
    } catch (_) {
      return { kind: "failed", code: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(limit);
    }
  };
  const schedule = (ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  function stop(): void {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", shown);
    delete scope[key];
  }
  async function run(): Promise<void> {
    timer = null;
    if (stopped || busy || document.visibilityState !== "visible") return;
    busy = true;
    let next: Record<string, unknown> | null = null;
    try {
      next = await send({ action: "tab_tick" });
      if (next?.view) render(next.view);
      // One request per tick: the background says when the next is due.
      if (next && typeof next.fetch === "string" && typeof next.token === "string") {
        const answer = await read(next.fetch);
        next = await send({ action: "tab_answer", token: next.token, answer });
        if (next?.view) render(next.view);
      }
    } finally {
      busy = false;
    }
    if (stopped) return;
    if (next === null) {
      // The background did not answer: try again shortly.
      schedule(10_000);
      return;
    }
    if (next.stop === true) {
      stop();
      return;
    }
    const wait = typeof next.wait === "number" && Number.isFinite(next.wait) ? next.wait : 10_000;
    schedule(Math.min(Math.max(wait, 500), 16 * 60_000));
  }
  function shown(): void {
    if (document.visibilityState === "visible" && !busy) schedule(500);
  }
  document.addEventListener("visibilitychange", shown);
  scope[key] = { poke: () => { if (!busy) schedule(500); } };
  schedule(0);
  return "started";
}

/** The signed-in AO3 name a page shows: its own "My History" link. Runs in the page. */
export function signedInNamesInTab(): unknown {
  const names = new Set<string>();
  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    const match = /^\/users\/([A-Za-z0-9_]{1,40})\/readings\/?$/.exec(link.getAttribute("href") ?? "");
    if (match?.[1]) names.add(match[1]);
  }
  const toggle = document.querySelector("#greeting a.dropdown-toggle[href^='/users/']");
  const own = /^\/users\/([A-Za-z0-9_]{1,40})\/?$/.exec(toggle?.getAttribute("href") ?? "");
  if (own?.[1]) names.add(own[1]);
  return Array.from(names);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 200) : null;
}

/** An answer handed over by the page loop, checked field by field. */
export function loadedPageFromTab(value: unknown): LoadedPage {
  if (!isRecord(value)) return { kind: "failed", code: "tab_no_result" };
  if (value.kind === "failed") return { kind: "failed", code: value.code === "timeout" ? "timeout" : "network" };
  if (
    value.kind !== "response" ||
    typeof value.status !== "number" ||
    typeof value.url !== "string" ||
    typeof value.html !== "string"
  ) {
    return { kind: "failed", code: "tab_no_result" };
  }
  const html = value.html.length > MAX_HISTORY_PAGE_CHARS ? value.html.slice(0, MAX_HISTORY_PAGE_CHARS) : value.html;
  return {
    kind: "response",
    status: value.status,
    url: value.url,
    html,
    chars: typeof value.chars === "number" && Number.isSafeInteger(value.chars) ? value.chars : html.length,
    retryAfter: stringOrNull(value.retryAfter),
    cfMitigated: stringOrNull(value.cfMitigated),
    contentType: stringOrNull(value.contentType),
  };
}

/** Whether a message came from a page on AO3 itself, in a tab: that tab's id. */
export function ao3TabSender(sender: unknown, extensionId: string | undefined): number | null {
  if (!isRecord(sender) || !isRecord(sender.tab) || typeof sender.tab.id !== "number") return null;
  if (typeof extensionId === "string" && sender.id !== extensionId) return null;
  const raw = typeof sender.url === "string" ? sender.url : sender.tab.url;
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? sender.tab.id : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface HistoryImportEnvironment {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly scripting?: ScriptingPort;
  readonly permissions?: PermissionsPort;
  readonly alarms: AlarmsPort;
  readonly storageMode: "callback" | "promise";
  /** IndexedDB; without it a run lives only as long as this background. */
  readonly databaseFactory: IDBFactory | null;
  /** The signed-in Trace account's id, or null. */
  readonly account: () => Promise<string | null>;
  /** Called when that account signs out or another takes its place. */
  readonly whenAccountLeaves: (cleanup: () => Promise<void>) => void;
  readonly saveActivity: () => { readonly inFlight: number; readonly lastEndedAt: number };
  /** For tests: the store to keep the run in. */
  readonly store?: HistoryStore;
}

export type SheetError =
  | "no_site_access"
  | "open_ao3_first"
  | "signed_out"
  | "username_unclear"
  | "not_connected"
  | "already_started"
  | "storage_full"
  | "storage_write_failed"
  | "unknown_action";

export type SheetReply =
  | { readonly ok: true; readonly view: HistoryRunView; readonly startable?: boolean }
  | { readonly ok: false; readonly error: SheetError; readonly view?: HistoryRunView };

export function installAo3HistoryImport(environment: HistoryImportEnvironment): Ao3HistoryImport {
  const { runtime, tabs, scripting, permissions, alarms, storageMode } = environment;
  const call = <T,>(target: unknown, method: string, args: readonly unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, storageMode);

  /** One tab, by the id a message handed over; never a search. */
  async function ao3Tab(sourceTabId: number | null): Promise<{ readonly id: number; readonly url: URL } | LoadFailCode> {
    if (sourceTabId === null || tabs.get === undefined) return "tab_gone";
    let tab: unknown;
    try {
      tab = await call(tabs, "get", [sourceTabId]);
    } catch {
      return "tab_gone";
    }
    if (!isRecord(tab) || typeof tab.url !== "string") return "no_site_access";
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      return "tab_not_ao3";
    }
    return url.protocol === "https:" && url.hostname === "archiveofourown.org" ? { id: sourceTabId, url } : "tab_not_ao3";
  }

  async function inTab<T>(tabId: number, func: (...args: never[]) => unknown, args: readonly unknown[]): Promise<T | LoadFailCode> {
    if (scripting?.executeScript === undefined) return "tab_no_result";
    try {
      const results = await withTimeout(
        call<unknown>(scripting, "executeScript", [{ target: { tabId, frameIds: [0] }, func, args }]),
        REQUEST_TIMEOUT_MS + 5_000,
      );
      if (results === "timeout") return "timeout";
      const first: unknown = Array.isArray(results) ? results[0] : undefined;
      return isRecord(first) && "result" in first ? first.result as T : "tab_no_result";
    } catch {
      return "tab_no_result";
    }
  }

  const store = environment.store ??
    (environment.databaseFactory === null ? new MemoryHistoryStore() : new IndexedDbHistoryStore(environment.databaseFactory));

  const history = new Ao3HistoryImport({
    store,
    clock: { now: () => Date.now() },
    random: () => Math.random(),
    newId: randomToken,
    account: environment.account,
    saveActivity: environment.saveActivity,
    async ensureLoop(sourceTabId) {
      const tab = await ao3Tab(sourceTabId);
      if (typeof tab === "string") return "failed";
      const result = await inTab<unknown>(
        tab.id,
        ao3HistoryLoopInTab as (...args: never[]) => unknown,
        [AO3_HISTORY_IMPORT_MESSAGE, MAX_HISTORY_PAGE_CHARS, REQUEST_TIMEOUT_MS],
      );
      return result === "started" || result === "running" ? result : "failed";
    },
    ...(alarms.create === undefined
      ? {}
      : {
          alarm: {
            start: () => call<void>(alarms, "create", [AO3_HISTORY_IMPORT_ALARM, { periodInMinutes: 1 }]),
            stop: () => call<void>(alarms, "clear", [AO3_HISTORY_IMPORT_ALARM]).then(() => undefined),
          },
        }),
  });
  environment.whenAccountLeaves(() => history.accountLeft());

  /** The reader's AO3 name, from the tab the sheet was opened on. */
  async function signedInUser(tabId: number | null): Promise<string | { readonly error: SheetError }> {
    if (permissions?.contains !== undefined) {
      const allowed = await call<boolean>(permissions, "contains", [{ origins: [AO3_SITE_PATTERN] }]).catch(() => false);
      if (allowed !== true) return { error: "no_site_access" };
    }
    const tab = await ao3Tab(tabId);
    if (tab === "no_site_access") return { error: "no_site_access" };
    if (typeof tab === "string") return { error: "open_ao3_first" };
    const names = await inTab<unknown>(tab.id, signedInNamesInTab as (...args: never[]) => unknown, []);
    if (!Array.isArray(names)) return { error: names === "timeout" ? "open_ao3_first" : "no_site_access" };
    const valid = names.filter((name): name is string => typeof name === "string" && AO3_USERNAME_PATTERN.test(name));
    const unique = [...new Set(valid.map((name) => name.toLowerCase()))];
    if (unique.length === 0) return { error: "signed_out" };
    if (unique.length > 1) return { error: "username_unclear" };
    return valid[0]!;
  }

  async function handle(message: Record<string, unknown>): Promise<SheetReply> {
    const tabId = typeof message.tabId === "number" && Number.isSafeInteger(message.tabId) ? message.tabId : null;
    switch (message.action) {
      case "status": {
        void history.wake(tabId);
        // Whether this sheet can start a run: a connected Trace account, on AO3.
        const [account, tab] = await Promise.all([environment.account().catch(() => null), ao3Tab(tabId)]);
        return { ok: true, view: await history.view(), startable: account !== null && typeof tab !== "string" };
      }
      case "start": {
        const user = await signedInUser(tabId);
        if (typeof user !== "string") return { ok: false, error: user.error, view: await history.view() };
        const started = await history.start(user, tabId);
        return "error" in started
          ? { ok: false, error: started.error, view: await history.view() }
          : { ok: true, view: started };
      }
      case "pause":
        return { ok: true, view: await history.pause() };
      case "resume":
        return { ok: true, view: await history.resume(tabId) };
      case "delete":
        return { ok: true, view: await history.delete() };
      default:
        return { ok: false, error: "unknown_action" };
    }
  }

  /** The last time each AO3 tab was given the page loop, so a busy page is not asked again and again. */
  const loopOffered = new Map<number, number>();

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message)) return false;
    const pageTab = ao3TabSender(sender, runtime.id);
    if (message.type === AO3_HISTORY_IMPORT_MESSAGE && pageTab !== null) {
      // The page loop, from the AO3 tab it runs in.
      // Each reply carries the run's view, for the reading bar on the page.
      const withView = (instruction: unknown) => history.view()
        .then((view) => ({ ...(instruction as object), view }), () => instruction);
      if (message.action === "tab_tick") {
        void history.tick(pageTab).then(withView).then(sendResponse, () => sendResponse({ wait: 10_000 }));
        return true;
      }
      if (message.action === "tab_answer" && typeof message.token === "string") {
        void history.answer(message.token, loadedPageFromTab(message.answer))
          .then(withView).then(sendResponse, () => sendResponse({ wait: 10_000 }));
        return true;
      }
      if (message.action === "tab_pause") {
        // The reading bar's Pause, in the reader's own AO3 tab.
        void history.pause().then((view) => sendResponse({ stop: true, view }), () => sendResponse({ stop: true }));
        return true;
      }
      return false;
    }
    if (pageTab !== null) {
      // Any other AO3 page speaking to Trace: the reader is on AO3, so a
      // running run's loop is put into that tab. Never answered here.
      const now = Date.now();
      if (now - (loopOffered.get(pageTab) ?? 0) >= 5_000) {
        loopOffered.set(pageTab, now);
        void history.wake(pageTab);
      }
      return false;
    }
    if (message.type !== AO3_HISTORY_IMPORT_MESSAGE) return false;
    if (!isPopupSender(sender, runtime.id)) return false;
    void handle(message).then(sendResponse, () => sendResponse({ ok: false, error: "unknown_action" }));
    return true;
  });
  alarms.onAlarm?.addListener((alarm) => {
    if (alarm.name === AO3_HISTORY_IMPORT_ALARM) void history.wake();
  });
  // A background started for any reason puts a running run's loop back.
  globalThis.setTimeout(() => void history.wake(), 1_500);
  return history;
}
