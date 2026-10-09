import { sameAccountScope, type AccountScope } from "../extension-core/index.mjs";
import { archiveHostKindFromSender, isBlockedArchivePath } from "./archive-sender.mjs";
import { extensionCall, type BrowserTab, type ContentPort, type RuntimeMessageSender, type RuntimePort, type TabsPort } from "./browser-platform.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";

export const POPUP_PAGE_PORT = "trace-popup-page-v1";
export const POPUP_PAGE_RELAY = "TRACE_POPUP_PAGE_RELAY";
const FAILURE = Object.freeze({ ok: false, error: "page_unavailable" });
const COMMANDS = new Set(["TRACE_STORY_IDENTITY_GET", "TRACE_SAVED_NOTE_DISMISS", "TRACE_POPUP_QUICK_ADD", "TRACE_POPUP_SET_READER_STATUS", "TRACE_SCHEDULE_AUTO_TRACK"]);
// Import data is read only by the background's own Import controller; a
// popup relay message can never ask a page for it.
const COLLECT_COMMAND = Object.freeze({ type: "TRACE_COLLECT" });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function pageUrl(value: unknown): string | null {
  try { const url = new URL(String(value)); url.hash = ""; return url.href; } catch { return null; }
}
interface Page { port: ContentPort; sender: RuntimeMessageSender; url: string; pending: Map<number, Pending> }
interface Pending { command: Record<string, unknown>; scope: AccountScope | null; finish: (value: unknown) => void; executed: boolean }
interface Options {
  runtime: RuntimePort; tabs: TabsPort; mode: "promise" | "callback";
  scope: () => AccountScope | null;
  execute: (message: unknown, sender: RuntimeMessageSender, scope: AccountScope) => Promise<unknown>;
  timeoutMs?: number;
}

/** Ephemeral transport only. Browser-owned sender metadata is never supplied by the page. */
export class PopupPageRelay {
  readonly #pages = new Map<number, Page>();
  readonly #options: Options;
  #sequence = 0;
  constructor(options: Options) {
    this.#options = options;
    options.runtime.onConnect?.addListener((port) => this.#connect(port));
  }
  accepts(message: unknown, sender: RuntimeMessageSender | undefined): boolean {
    return record(message) && message.type === POPUP_PAGE_RELAY &&
      typeof this.#options.runtime.id === "string" &&
      sender?.tab == null && sender?.id === this.#options.runtime.id &&
      isPopupSender(sender, this.#options.runtime.id);
  }
  /** The active page's Import data, for the background's Import controller. */
  collect(tabId: unknown): Promise<unknown> {
    return this.#request(tabId, COLLECT_COMMAND);
  }
  async request(tabId: unknown, command: unknown): Promise<unknown> {
    if (!record(command) || !COMMANDS.has(String(command.type))) return FAILURE;
    return this.#request(tabId, command);
  }
  async #request(tabId: unknown, command: Record<string, unknown>): Promise<unknown> {
    if (!Number.isInteger(tabId)) return FAILURE;
    const tab = await this.#activeTab();
    const page = this.#pages.get(tabId as number);
    if (!page || tab?.id !== tabId || pageUrl(tab?.url) !== page.url || page.pending.size >= 8) return FAILURE;
    const id = ++this.#sequence;
    const scope = this.#options.scope();
    if ((command.type === "TRACE_POPUP_QUICK_ADD" || command.type === "TRACE_POPUP_SET_READER_STATUS") && scope === null) return FAILURE;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(FAILURE), this.#options.timeoutMs ?? (command.type === "TRACE_STORY_IDENTITY_GET" ? 1_000 : command === COLLECT_COMMAND ? 5_000 : 22_000));
      const finish = (value: unknown): void => { clearTimeout(timer); page.pending.delete(id); resolve(value); };
      page.pending.set(id, { command, scope, finish, executed: false });
      try { page.port.postMessage({ kind: "request", id, command }); } catch { finish(FAILURE); }
    });
  }
  #connect(port: ContentPort): void {
    const sender = port.sender;
    const tabId = sender?.tab?.id;
    const host = archiveHostKindFromSender(sender);
    const url = pageUrl(sender?.url);
    if (port.name !== POPUP_PAGE_PORT || typeof this.#options.runtime.id !== "string" || sender?.id !== this.#options.runtime.id ||
        sender?.frameId !== 0 || !Number.isInteger(tabId) || host === null || url === null ||
        pageUrl(sender?.tab?.url) !== url || isBlockedArchivePath(url, host)) return;
    const previous = this.#pages.get(tabId as number);
    if (previous) this.#remove(tabId as number, previous);
    const page: Page = { port, sender: sender!, url, pending: new Map() };
    this.#pages.set(tabId as number, page);
    port.onDisconnect.addListener(() => this.#remove(tabId as number, page));
    port.onMessage.addListener((message) => { void this.#receive(tabId as number, page, message).catch(() => this.#remove(tabId as number, page)); });
  }
  #remove(tabId: number, page: Page): void {
    if (this.#pages.get(tabId) === page) this.#pages.delete(tabId);
    for (const pending of page.pending.values()) pending.finish(FAILURE);
  }
  async #receive(tabId: number, page: Page, message: unknown): Promise<void> {
    if (!record(message) || typeof message.id !== "number") return;
    const pending = page.pending.get(message.id);
    if (!pending) return;
    const tab = await this.#activeTab();
    if (page.pending.get(message.id) !== pending) return;
    const scope = this.#options.scope();
    if (this.#pages.get(tabId) !== page || tab?.id !== tabId || pageUrl(tab?.url) !== page.url ||
        !(pending.scope === null && scope === null) && !sameAccountScope(pending.scope, scope)) {
      pending.finish(FAILURE); return;
    }
    if (message.kind === "command") {
      const expected = pending.command.type === "TRACE_POPUP_QUICK_ADD" ? "TRACE_QUICK_ADD" :
        pending.command.type === "TRACE_POPUP_SET_READER_STATUS" ? "TRACE_SET_READER_STATUS" : null;
      if (pending.executed || !expected || !record(message.command) || message.command.type !== expected || !pending.scope) {
        pending.finish(FAILURE); return;
      }
      pending.executed = true;
      const response = await this.#options.execute(message.command, page.sender, pending.scope);
      if (!page.pending.has(message.id)) return;
      if (!sameAccountScope(pending.scope, this.#options.scope())) { pending.finish(FAILURE); return; }
      page.port.postMessage({ kind: "commandResult", id: message.id, response: this.#publicResult(response) });
      return;
    }
    if (message.kind !== "response") return;
    const response = message.response;
    if (pending.command.type === "TRACE_STORY_IDENTITY_GET" && record(response)) {
      pending.finish(response.ok === true && typeof response.title === "string" &&
        ["AO3", "FanFiction.net"].includes(String(response.site))
        ? { ok: true, title: response.title.slice(0, 300), author: typeof response.author === "string" ? response.author.slice(0, 200) : null, site: response.site }
        : { ok: false, unavailable: response.unavailable === true });
    } else if (pending.command === COLLECT_COMMAND) {
      // The Import controller bounds and validates this payload itself.
      pending.finish(record(response) ? response : FAILURE);
    } else pending.finish(this.#publicResult(response));
  }
  #publicResult(response: unknown): unknown {
    if (!record(response)) return FAILURE;
    if (response.ok === true) return { ok: true };
    const allowed = ["not_authenticated", "auth_expired", "free_limit_reached", "rate_limited", "unavailable", "save_pending", "website_access_incomplete"];
    return { ok: false, error: allowed.includes(String(response.error)) ? response.error : "page_unavailable" };
  }
  async #activeTab(): Promise<BrowserTab | null> {
    try {
      return (await extensionCall<readonly BrowserTab[]>(this.#options.tabs as unknown as Record<string, (...args: unknown[]) => unknown>, "query", [{ active: true, currentWindow: true }], this.#options.runtime, this.#options.mode))[0] ?? null;
    } catch { return null; }
  }
}
