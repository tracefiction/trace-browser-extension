import { runsBesideTraceApp } from "./archive-readiness.mjs";
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
 * - Only the setup page itself (a top-level page at `/safari-setup` on
 *   Trace's own origin), or this extension's popup, is answered. Every other
 *   Trace page, a story site, any other site and any frame get nothing.
 * - Only on iPhone and iPad, where that page exists to be used.
 * - It can learn whether the story sites are allowed, and the titles of open
 *   story pages on those sites in its own window. Nothing about any other
 *   tab, nothing in Private Browsing or another window, and never an address.
 * - It can bring one of those story tabs to the front, and only one that same
 *   tab was just given, re-checked at that moment. It cannot open, close,
 *   reload or navigate a tab, and it cannot raise a permission request.
 *
 * The path check keeps every other Trace page from using this by accident. It
 * is not a defence against script already running on Trace's own origin,
 * which can move its page to the setup path without loading; what is written
 * above is therefore the most such script could learn or do.
 * - It is rate-limited per requester.
 */
export const SETUP_PAGE_MESSAGE = "TRACE_SETUP_PAGE_REQUEST";
/** Background to Trace pages: story-site access changed. */
export const SETUP_ACCESS_PUSH_MESSAGE = "TRACE_SETUP_ACCESS_PUSH";

export const SETUP_STORY_TAB_LIMIT = 5;
export const SETUP_TAB_TITLE_MAX_LENGTH = 120;
/** How long a list of story tabs may be acted on. */
export const SETUP_STORY_LIST_LIFE_MS = 120_000;
/** Requests one requester may make inside one window before it is refused. */
export const SETUP_REQUEST_LIMIT = 20;
export const SETUP_REQUEST_WINDOW_MS = 10_000;
const SETUP_REQUESTER_LIMIT = 32;

export const STORY_SITE_ORIGINS = /* @__PURE__ */ Object.freeze([
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
  /** Defaults to this context's `navigator`. */
  readonly platform?: { readonly userAgent?: string };
}

type SetupTab = BrowserTab & { readonly title?: unknown };

/** Who is asking. `tab` is the setup page's own tab; the popup has none. */
type Requester = Readonly<{ key: string; tab: SetupTab | null }>;

type ListedTabs = Readonly<{ ids: ReadonlySet<number>; windowId: number; at: number }>;

/** The window a tab is in, or null when it is in Private Browsing or does not say. */
function ownWindow(tab: unknown): number | null {
  if (!isRecord(tab) || tab.incognito === true) return null;
  return typeof tab.windowId === "number" && Number.isSafeInteger(tab.windowId) ? tab.windowId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refused(error: SetupPageError): SetupPageResponse {
  return Object.freeze({ ok: false as const, error });
}

/** The setup page's path: exactly `/safari-setup`, with or without a trailing slash. */
export function isSetupPagePath(pathname: string): boolean {
  return /^\/safari-setup\/?$/.test(pathname);
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

// Written as escapes. Control characters and line breaks become a space.
const CONTROL_CHARACTERS = /* @__PURE__ */ new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");
// Characters that reorder or hide text are dropped: the directional marks,
// embeddings, overrides and isolates, and the zero-width space and marks. The
// zero-width joiner (200d) and non-joiner (200c) stay: emoji are built with
// the first, and Persian and Indic spelling needs both. Neither reorders text.
const HIDDEN_CHARACTERS = /* @__PURE__ */ new RegExp(
  "[\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]",
  "g",
);

/**
 * A tab that has no title yet is commonly given its address as one. An
 * address is never passed on, so such a title counts as none.
 */
function isAddressLike(line: string): boolean {
  // Anything that opens like an address with an authority.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) return true;
  if (line === "" || /\s/.test(line)) return false;
  // One word with a scheme, when it parses as an address.
  if (/^[a-z][a-z0-9+.-]*:/i.test(line)) {
    try {
      return Boolean(new URL(line));
    } catch {
      return false;
    }
  }
  // A bare host, or host and path, of a story site: every listed tab is on one.
  try {
    const host = new URL(`https://${line}`).hostname;
    return archiveHostKindFromSender({ url: `https://${host}/` }) !== null;
  } catch {
    return false;
  }
}

/**
 * The tab's own host and path as a title would show them: lower case, without
 * a leading `www.` or `m.`, without a trailing slash.
 */
function ownAddress(tabUrl: unknown): string | null {
  if (typeof tabUrl !== "string") return null;
  try {
    const url = new URL(tabUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return path === "" ? null : (url.hostname.replace(/^(?:www|m)\./, "") + path).toLowerCase();
  } catch {
    return null;
  }
}

/** A tab's title as the browser reports it: one line, capped, never an address. */
function tabTitle(value: unknown, tabUrl: unknown): string {
  if (typeof value !== "string") return "";
  const line = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(HIDDEN_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (isAddressLike(line)) return "";
  // Nor a longer title that has the tab's own address in it, such as a
  // loading title. The site's name in a title's usual ending is not that.
  const own = ownAddress(tabUrl);
  if (own !== null && line.toLowerCase().includes(own)) return "";
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
  /** Per requester: the story tabs it was last given, in which window, and when. */
  readonly #listed = new Map<string, ListedTabs>();
  readonly #requests = new Map<string, number[]>();
  #push: Promise<void> | null = null;
  #pushAgain = false;

  constructor(environment: SetupPageEnvironment) {
    this.#runtime = environment.runtime;
    this.#tabs = environment.tabs;
    this.#mode = environment.mode;
    const webUrl = new URL(environment.webOrigin);
    this.#webOrigin = webUrl.origin;
    this.#webTabPattern = `${webUrl.protocol}//${webUrl.hostname}/safari-setup*`;
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
    if (requester === null) {
      // A tab seen anywhere but the setup page keeps no list.
      const tabId = sender?.tab?.id;
      if (typeof tabId === "number") this.#listed.delete(`page:${tabId}`);
      return refused("forbidden");
    }
    if (!this.#admit(requester.key)) return refused("rate_limited");

    const request = message.request;
    const keys = Object.keys(message).length;
    if (request === "access") {
      if (keys !== 2) return refused("invalid_request");
      const access = await this.#readAccess();
      return access === null ? refused("unavailable") : Object.freeze({ ok: true as const, result: access });
    }
    if (request === "story-tabs") {
      // The popup has no tab of its own; it names the tab it is open over.
      const overTab = message.overTab;
      if (requester.tab === null) {
        if (keys !== 3 || typeof overTab !== "number" || !Number.isSafeInteger(overTab) || overTab < 0) {
          return refused("invalid_request");
        }
      } else if (keys !== 2) {
        return refused("invalid_request");
      }
      const tabs = await this.#storyTabs(requester, requester.tab === null ? (overTab as number) : null);
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

  /** Story-site access changed: tell every open setup page. */
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

  /** Who is asking: the setup page (by tab) or this extension's popup. */
  #requester(sender: RuntimeMessageSender | undefined): Requester | null {
    if (isPopupSender(sender, this.#runtime.id)) {
      // A popup's address alone is not enough: it must be this extension's.
      return this.#runtime.id !== undefined && sender?.id === this.#runtime.id
        ? { key: "popup", tab: null }
        : null;
    }
    if (!isTraceWebSender(sender, this.#runtime.id, this.#webOrigin)) return null;
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId)) return null;
    // Every address the sender carries must be the setup page's: the frame
    // that sent the message and the tab it sits in.
    const addresses = [sender?.url, sender?.tab?.url].filter((address) => address !== undefined);
    if (addresses.length === 0) return null;
    if (!addresses.every((address) => this.#isSetupPage(address))) return null;
    return { key: `page:${tabId}`, tab: sender?.tab ?? null };
  }

  #isSetupPage(rawUrl: unknown): boolean {
    if (typeof rawUrl !== "string") return false;
    try {
      const url = new URL(rawUrl);
      return url.origin === this.#webOrigin && isSetupPagePath(url.pathname);
    } catch {
      return false;
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

  /** The tab the popup says it is open over, when that tab is the setup page. */
  async #setupTab(tabId: number): Promise<SetupTab | null> {
    if (typeof this.#tabs.get !== "function") return null;
    try {
      const tab = await this.#call<SetupTab | null>("get", [tabId]);
      return isRecord(tab) && tab.id === tabId && this.#isSetupPage(tab.url) ? tab : null;
    } catch {
      return null;
    }
  }

  async #storyTabs(requester: Requester, overTab: number | null): Promise<readonly SetupStoryTab[] | null> {
    // Whatever happens next, an earlier list is no longer the most recent.
    this.#listed.delete(requester.key);
    const access = await this.#readAccess();
    if (access === null) return null;
    if (!access.storySitesAllowed) return Object.freeze([]);
    // Only the asking tab's own window, and never Private Browsing: a setup
    // page in a private tab, or one whose window is not known, is given nothing.
    const windowId = ownWindow(requester.tab ?? (overTab === null ? null : await this.#setupTab(overTab)));
    if (windowId === null) return Object.freeze([]);
    let tabs: readonly SetupTab[];
    try {
      tabs = await this.#call<readonly SetupTab[]>("query", [{ windowId }]);
    } catch {
      return null;
    }
    const stories: { tab: SetupTab; site: "ao3" | "ffn"; order: number }[] = [];
    (Array.isArray(tabs) ? tabs : []).forEach((tab, order) => {
      if (!isRecord(tab) || typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 0) return;
      if (ownWindow(tab) !== windowId) return;
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
      Object.freeze({ tabId: tab.id as number, title: tabTitle(tab.title, tab.url), site }),
    );
    this.#listed.set(requester.key, {
      ids: new Set(answer.map(({ tabId }) => tabId)),
      windowId,
      at: this.#now(),
    });
    return Object.freeze(answer);
  }

  async #switchToTab(requester: Requester, tabId: number): Promise<SetupPageResponse> {
    // Only a tab this same requester was just given. A tab that has left the
    // setup page is no longer a requester at all, and its list is dropped.
    const listed = this.#listed.get(requester.key);
    if (listed === undefined || !listed.ids.has(tabId)) return refused("not_listed");
    // A list is good for a short while, and for the window it was made in.
    const age = this.#now() - listed.at;
    const moved = requester.tab !== null && ownWindow(requester.tab) !== listed.windowId;
    if (age < 0 || age > SETUP_STORY_LIST_LIFE_MS || moved) {
      this.#listed.delete(requester.key);
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
    if (
      !isRecord(tab) ||
      tab.id !== tabId ||
      ownWindow(tab) !== listed.windowId ||
      storyPageSite(tab.url, this.#webOrigin) === null
    ) {
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
      if (typeof tab?.id !== "number" || !this.#isSetupPage(tab.url)) continue;
      try {
        await this.#call<unknown>("sendMessage", [tab.id, message]);
      } catch {
        // A setup page without the page script simply does not hear it.
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

/**
 * iPhone and iPad only, by the same decision the access report makes. Where
 * the platform is known not to be one, nothing is installed. Where it is not
 * known yet (an iPad can call itself a Mac), the listeners are registered at
 * once, so an event that woke the background is not missed, and each decides
 * when it runs: a Mac then answers "unavailable" without looking at access or
 * at any tab, and pushes nothing.
 */
export function installSetupPageRuntime(environment: SetupPageEnvironment): SetupPageController | null {
  const beside = runsBesideTraceApp(
    environment.runtime,
    environment.mode,
    environment.platform?.userAgent ?? globalThis.navigator?.userAgent ?? "",
  );
  if (beside === false) return null;
  const supported = Promise.resolve(beside);
  const controller = new SetupPageController(environment);
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || message.type !== SETUP_PAGE_MESSAGE) return false;
    void supported
      .then((yes) => (yes ? controller.handle(message, sender) : refused("unavailable")))
      .then(
        (response) => sendResponse(response ?? refused("unavailable")),
        () => sendResponse(refused("unavailable")),
      );
    return true;
  });
  const changed = (): void => {
    void supported
      .then((yes) => (yes ? controller.accessChanged() : undefined))
      .catch(() => undefined);
  };
  environment.permissions?.onAdded?.addListener(changed);
  environment.permissions?.onRemoved?.addListener(changed);
  return controller;
}
