import { BrowserArchivePermissionSnapshotPort } from "./browser-adapters.mjs";
import {
  extensionCall,
  type BrowserTab,
  type PermissionsPort,
  type RuntimeMessageSender,
  type RuntimePort,
  type TabsPort,
} from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";
import {
  classifyActiveTabUrl,
  isPopupSender,
  isTraceWebSender,
} from "./first-story-initiation.mjs";

/**
 * What Trace's own setup page, and the popup shown over it, may ask the
 * background. The page is an ordinary web page, so this is a boundary:
 *
 * - Only a top-level page on Trace's own origin, or this extension's popup,
 *   is answered. A story site, any other site and any frame get nothing.
 * - It can learn whether the story sites are allowed, and the titles of open
 *   story pages on those sites. Nothing about any other tab, and never an
 *   address.
 * - It can bring one of those story tabs to the front, and only one it was
 *   just given, re-checked at that moment. It cannot open, close, reload or
 *   navigate a tab, and it cannot raise a permission request.
 * - It is rate-limited per requester.
 */
export const SETUP_PAGE_MESSAGE = "TRACE_SETUP_PAGE_REQUEST";
/** Background to Trace pages: story-site access changed. */
export const SETUP_ACCESS_PUSH_MESSAGE = "TRACE_SETUP_ACCESS_PUSH";

export const SETUP_STORY_TAB_LIMIT = 5;
export const SETUP_TAB_TITLE_MAX_LENGTH = 120;
/** Requests one requester may make inside one window before it is refused. */
export const SETUP_REQUEST_LIMIT = 20;
export const SETUP_REQUEST_WINDOW_MS = 10_000;
const SETUP_REQUESTER_LIMIT = 32;

export const STORY_SITE_ORIGINS = Object.freeze([
  "https://*.archiveofourown.org/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
]);

// A grant Safari reports this way covers every site, the story sites included.
const EVERY_SITE_ORIGINS = new Set(["<all_urls>", "*://*/*", "https://*/*"]);

export type SetupAccess = Readonly<{
  storySitesAllowed: boolean;
  scope: "all" | "story-sites" | "this-site";
}>;

export type SetupStoryTab = Readonly<{
  tabId: number;
  title: string;
  site: "ao3" | "ffn";
}>;

export type SetupPageError =
  | "forbidden"
  | "invalid_request"
  | "unknown_request"
  | "rate_limited"
  | "unavailable"
  | "not_listed"
  | "not_allowed"
  | "not_a_story"
  | "switch_failed";

export type SetupPageResponse =
  | Readonly<{ ok: true; result?: SetupAccess | Readonly<{ tabs: readonly SetupStoryTab[] }> }>
  | Readonly<{ ok: false; error: SetupPageError }>;

interface SetupPageEnvironment {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly permissions?: PermissionsPort;
  readonly mode: "callback" | "promise";
  readonly webOrigin: string;
  /** The origins automatic saving needs. */
  readonly storyOrigins?: readonly string[];
  readonly clock?: { now(): number };
}

type SetupTab = BrowserTab & { readonly title?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refused(error: SetupPageError): SetupPageResponse {
  return Object.freeze({ ok: false as const, error });
}

/** The site of a story page's address, or null when it is not a story page. */
export function storyPageSite(rawUrl: unknown, webOrigin: string): "ao3" | "ffn" | null {
  if (typeof rawUrl !== "string") return null;
  const site = archiveHostKindFromSender({ url: rawUrl });
  if (site === null || isBlockedArchivePath(rawUrl, site)) return null;
  // The work key decides which tab may act for which work; the active-tab
  // classification decides what is called a story page. Both must agree.
  if (workKeyFromArchiveUrl(rawUrl, site) === null) return null;
  return classifyActiveTabUrl(rawUrl, webOrigin).kind === "supported_story" ? site : null;
}

// Control characters and the two Unicode line breaks, written as escapes.
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]+", "g");

/** A tab's title as the browser reports it: one line, capped, never an address. */
function tabTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, SETUP_TAB_TITLE_MAX_LENGTH).join("");
}

export class SetupPageController {
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #mode: "callback" | "promise";
  readonly #webOrigin: string;
  readonly #webTabPattern: string;
  readonly #storyOrigins: readonly string[];
  readonly #access: BrowserArchivePermissionSnapshotPort;
  readonly #now: () => number;
  /** Per requester: the story tabs it was last given, and from which page. */
  readonly #listed = new Map<string, { readonly ids: ReadonlySet<number>; readonly page: string }>();
  readonly #requests = new Map<string, number[]>();
  #push: Promise<void> | null = null;
  #pushAgain = false;

  constructor(environment: SetupPageEnvironment) {
    this.#runtime = environment.runtime;
    this.#tabs = environment.tabs;
    this.#mode = environment.mode;
    const webUrl = new URL(environment.webOrigin);
    this.#webOrigin = webUrl.origin;
    this.#webTabPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    this.#storyOrigins = Object.freeze([...(environment.storyOrigins ?? STORY_SITE_ORIGINS)]);
    this.#access = new BrowserArchivePermissionSnapshotPort(
      environment.permissions,
      environment.runtime,
      environment.mode,
    );
    this.#now = () => environment.clock?.now() ?? Date.now();
  }

  /** `null`: not this controller's message. */
  async handle(message: unknown, sender?: RuntimeMessageSender): Promise<SetupPageResponse | null> {
    if (!isRecord(message) || message.type !== SETUP_PAGE_MESSAGE) return null;
    const requester = this.#requester(sender);
    if (requester === null) return refused("forbidden");
    if (!this.#admit(requester.key)) return refused("rate_limited");

    const request = message.request;
    const keys = Object.keys(message).length;
    if (request === "access") {
      if (keys !== 2) return refused("invalid_request");
      const access = await this.#readAccess();
      return access === null ? refused("unavailable") : Object.freeze({ ok: true as const, result: access });
    }
    if (request === "story-tabs") {
      if (keys !== 2) return refused("invalid_request");
      const tabs = await this.#storyTabs(requester);
      return tabs === null
        ? refused("unavailable")
        : Object.freeze({ ok: true as const, result: Object.freeze({ tabs }) });
    }
    if (request === "switch-to-tab") {
      const tabId = message.tabId;
      if (keys !== 3 || typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
        return refused("invalid_request");
      }
      return this.#switchToTab(requester, tabId);
    }
    return refused(typeof request === "string" ? "unknown_request" : "invalid_request");
  }

  /** Story-site access changed: tell every open Trace page. */
  accessChanged(): Promise<void> {
    if (this.#push !== null) {
      this.#pushAgain = true;
      return this.#push;
    }
    const push = (async () => {
      do {
        this.#pushAgain = false;
        await this.#pushAccess();
      } while (this.#pushAgain);
    })().finally(() => {
      this.#push = null;
    });
    this.#push = push;
    return push;
  }

  /** Who is asking: a top-level Trace page (by tab) or this extension's popup. */
  #requester(sender: RuntimeMessageSender | undefined): { key: string; page: string } | null {
    if (isPopupSender(sender, this.#runtime.id)) return { key: "popup", page: "popup" };
    if (!isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) return null;
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId)) return null;
    // Every address the sender carries must be Trace's own: the frame that
    // sent the message and the tab it sits in.
    const frame = sender?.url === undefined ? undefined : this.#tracePage(sender.url);
    const tab = sender?.tab?.url === undefined ? undefined : this.#tracePage(sender.tab.url);
    if (frame === null || tab === null) return null;
    const page = frame ?? tab;
    return page === undefined ? null : { key: `page:${tabId}`, page };
  }

  #tracePage(rawUrl: unknown): string | null {
    if (typeof rawUrl !== "string") return null;
    try {
      const url = new URL(rawUrl);
      return url.origin === this.#webOrigin ? url.origin + url.pathname : null;
    } catch {
      return null;
    }
  }

  #admit(requester: string): boolean {
    const now = this.#now();
    const recent = (this.#requests.get(requester) ?? []).filter(
      (at) => at <= now && now - at < SETUP_REQUEST_WINDOW_MS,
    );
    if (recent.length >= SETUP_REQUEST_LIMIT) {
      this.#requests.set(requester, recent);
      return false;
    }
    recent.push(now);
    this.#requests.delete(requester);
    this.#requests.set(requester, recent);
    while (this.#requests.size > SETUP_REQUESTER_LIMIT) {
      const oldest = this.#requests.keys().next().value as string;
      this.#requests.delete(oldest);
      this.#listed.delete(oldest);
    }
    return true;
  }

  async #readAccess(): Promise<SetupAccess | null> {
    const [allowed, listed] = await Promise.all([
      this.#access.containsOrigins(this.#storyOrigins).catch(() => null),
      this.#access.readGrantedOrigins().catch(() => null),
    ]);
    if (typeof allowed !== "boolean") return null;
    if (!allowed) return Object.freeze({ storySitesAllowed: false, scope: "this-site" as const });
    const everySite = (listed ?? []).some((origin) => EVERY_SITE_ORIGINS.has(origin));
    return Object.freeze({
      storySitesAllowed: true,
      scope: everySite ? "all" as const : "story-sites" as const,
    });
  }

  async #storyTabs(requester: { key: string; page: string }): Promise<readonly SetupStoryTab[] | null> {
    // Whatever happens next, an earlier list is no longer the most recent.
    this.#listed.delete(requester.key);
    const access = await this.#readAccess();
    if (access === null) return null;
    if (!access.storySitesAllowed) return Object.freeze([]);
    let tabs: readonly SetupTab[];
    try {
      tabs = await this.#call<readonly SetupTab[]>("query", [{}]);
    } catch {
      return null;
    }
    const stories: { tab: SetupTab; site: "ao3" | "ffn"; order: number }[] = [];
    (Array.isArray(tabs) ? tabs : []).forEach((tab, order) => {
      if (!isRecord(tab) || typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 0) return;
      const site = storyPageSite(tab.url, this.#webOrigin);
      if (site !== null) stories.push({ tab, site, order });
    });
    const used = (tab: SetupTab): number =>
      typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
    stories.sort((left, right) =>
      used(right.tab) - used(left.tab) ||
      Number(right.tab.active === true) - Number(left.tab.active === true) ||
      left.order - right.order,
    );
    const answer = stories.slice(0, SETUP_STORY_TAB_LIMIT).map(({ tab, site }) =>
      Object.freeze({ tabId: tab.id as number, title: tabTitle(tab.title), site }),
    );
    this.#listed.set(requester.key, {
      ids: new Set(answer.map(({ tabId }) => tabId)),
      page: requester.page,
    });
    return Object.freeze(answer);
  }

  async #switchToTab(
    requester: { key: string; page: string },
    tabId: number,
  ): Promise<SetupPageResponse> {
    // Only a tab this same page was just given. A page that has moved on, or
    // another page in the same tab, starts again with a new list.
    const listed = this.#listed.get(requester.key);
    if (listed === undefined || listed.page !== requester.page || !listed.ids.has(tabId)) {
      return refused("not_listed");
    }
    if (typeof this.#tabs.get !== "function" || typeof this.#tabs.update !== "function") {
      return refused("unavailable");
    }
    const access = await this.#readAccess();
    if (access === null) return refused("unavailable");
    if (!access.storySitesAllowed) return refused("not_allowed");
    // The tab may have gone elsewhere since it was listed. Look again now.
    let tab: SetupTab | null;
    try {
      tab = await this.#call<SetupTab | null>("get", [tabId]);
    } catch {
      tab = null;
    }
    if (!isRecord(tab) || tab.id !== tabId || storyPageSite(tab.url, this.#webOrigin) === null) {
      return refused("not_a_story");
    }
    try {
      await this.#call<unknown>("update", [tabId, { active: true }]);
    } catch {
      return refused("switch_failed");
    }
    return Object.freeze({ ok: true as const });
  }

  async #pushAccess(): Promise<void> {
    const access = await this.#readAccess();
    if (access === null) return;
    let tabs: readonly BrowserTab[];
    try {
      tabs = await this.#call<readonly BrowserTab[]>("query", [{ url: [this.#webTabPattern] }]);
    } catch {
      return;
    }
    const message = Object.freeze({ type: SETUP_ACCESS_PUSH_MESSAGE, ...access });
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (typeof tab?.id !== "number" || this.#tracePage(tab.url) === null) continue;
      try {
        await this.#call<unknown>("sendMessage", [tab.id, message]);
      } catch {
        // A Trace tab without the page script simply does not hear it.
      }
    }
  }

  #call<T>(method: "query" | "get" | "update" | "sendMessage", args: readonly unknown[]): Promise<T> {
    return extensionCall<T>(
      this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
      method,
      args,
      this.#runtime,
      this.#mode,
    );
  }
}

export function installSetupPageRuntime(environment: SetupPageEnvironment): SetupPageController {
  const controller = new SetupPageController(environment);
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || message.type !== SETUP_PAGE_MESSAGE) return false;
    void controller.handle(message, sender).then(
      (response) => sendResponse(response ?? refused("unavailable")),
      () => sendResponse(refused("unavailable")),
    );
    return true;
  });
  const changed = (): void => {
    void controller.accessChanged().catch(() => undefined);
  };
  environment.permissions?.onAdded?.addListener(changed);
  environment.permissions?.onRemoved?.addListener(changed);
  return controller;
}
