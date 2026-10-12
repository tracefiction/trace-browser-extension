import type {
  StoryCommandEvidence,
  StoryPresence,
  StorySaveMode,
  StoryTrackCommand,
} from "../extension-core/index.mjs";
import {
  extensionCall,
  type BrowserStorage,
  type ContentPort,
  type PermissionsPort,
  type RuntimePort,
  type ScriptingPort,
  type TabsPort,
} from "./browser-platform.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";
import {
  FIRST_TAP_COLLECT_MESSAGE,
  FIRST_TAP_MANUAL_MODE_END_MESSAGE,
  FIRST_TAP_MARK_MESSAGE,
  FIRST_TAP_POPUP_PORT,
  FIRST_TAP_STORE_KEY,
  FirstTapSave,
  storySaveModeAtAdmission,
  type FirstTapAccount,
  type FirstTapTab,
  type FirstTapView,
} from "./first-tap-save.mjs";

/**
 * Sets the page script's manual mode, then the page script itself. Nothing
 * that lists or decorates stories is injected for a first tap.
 */
export const FIRST_TAP_PAGE_FILES: readonly string[] = Object.freeze([
  "page-manual-mode.js",
  "content-config.js",
  "trace-finish-qualify.js",
  "collector.js",
]);

/** What the first-tap save asks of the session that owns the account. */
export interface FirstTapSession {
  accountForThisOpen(): Promise<FirstTapAccount>;
  pageBinding(): string | null;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
  saveStoryWithEvidence(
    command: StoryTrackCommand,
    observer?: { beforeWrite?(): Promise<void> | void },
  ): Promise<StoryCommandEvidence>;
  storyPresence(workKey: string): Promise<StoryPresence>;
  attachStoryAdmission(hooks: {
    modeFor(tabId: number, workKey: string): Promise<StorySaveMode | null>;
    pageSaveAdmitted(tabId: number, workKey: string): void;
  }): void;
}

type Environment = Readonly<{
  runtime: RuntimePort;
  tabs: TabsPort;
  permissions: PermissionsPort;
  scripting: ScriptingPort;
  storage: BrowserStorage;
  mode: "callback" | "promise";
  /** The story-site patterns whose complete grant makes saving automatic. */
  origins: readonly string[];
  /** The ids of the page scripts registered under that grant. */
  registrationIds: readonly string[];
  session: FirstTapSession;
  now?: () => number;
  /** Random bytes for this install's salt, and a one-way digest. */
  crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}>;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Installs the first-tap save: the popup's port, the page messages, and the
 * stamp put on every page save as it is admitted. Only a build that turns the
 * first-tap save on calls this. The returned function is to be called when
 * the page scripts have been registered under the complete grant.
 */
export function installFirstTapSave(environment: Environment): () => Promise<void> {
  const { runtime, tabs, permissions, scripting, storage, mode, origins, session } = environment;
  const cryptography = environment.crypto ?? globalThis.crypto;
  const call = <T,>(target: object, method: string, args: unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  const grantComplete = async (): Promise<boolean | null> => {
    if (origins.length === 0 || typeof permissions.contains !== "function") return null;
    try {
      const answer = await call<unknown>(permissions, "contains", [{ origins: [...origins] }]);
      return typeof answer === "boolean" ? answer : null;
    } catch {
      return null;
    }
  };
  const registered = async (): Promise<boolean | null> => {
    try {
      const current = await call<readonly { readonly id?: string }[]>(scripting, "getRegisteredContentScripts", []);
      const ids = new Set(current.map(({ id }) => id));
      return environment.registrationIds.every((id) => ids.has(id));
    } catch {
      return null;
    }
  };

  const firstTap = new FirstTapSave({
    // One tab, by the id the popup gave. Without `tabs`, its address is only
    // visible for the tab the reader opened Trace on.
    async tab(tappedTabId) {
      if (typeof tabs.get !== "function") return null;
      return call<FirstTapTab | null>(tabs, "get", [tappedTabId]);
    },
    grantComplete,
    account: () => session.accountForThisOpen(),
    binding: () => session.pageBinding(),
    automaticSaving: () => session.automaticSaving(),
    async inject(tabId) {
      if (typeof scripting.executeScript !== "function") return false;
      await call(scripting, "executeScript", [{
        target: { tabId, frameIds: [0] },
        files: [...FIRST_TAP_PAGE_FILES],
      }]);
      return true;
    },
    collect: (tabId) => call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_COLLECT_MESSAGE }, { frameId: 0 }]),
    save: (command, observer) => session.saveStoryWithEvidence(command, observer),
    presence: (workKey) => session.storyPresence(workKey),
    async mark(tabId, workKey) {
      await call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_MARK_MESSAGE, workKey }, { frameId: 0 }]);
    },
    async endManualMode(tabId) {
      await call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_MANUAL_MODE_END_MESSAGE }, { frameId: 0 }]);
    },
    async readStore() {
      return (await storage.get(FIRST_TAP_STORE_KEY))[FIRST_TAP_STORE_KEY];
    },
    async writeStore(value) {
      await storage.set({ [FIRST_TAP_STORE_KEY]: value });
    },
    async digest(text) {
      const bytes = await cryptography.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return hex(new Uint8Array(bytes)).slice(0, 32);
    },
    randomSalt: () => hex(cryptography.getRandomValues(new Uint8Array(16))),
    now: environment.now ?? (() => Date.now()),
  });

  session.attachStoryAdmission({
    async modeFor(tabId, workKey) {
      const [grant, scripts] = await Promise.all([grantComplete(), registered()]);
      return storySaveModeAtAdmission({
        injectedForFirstTap: firstTap.injectedFor(tabId, workKey),
        grantComplete: grant,
        registered: scripts,
      });
    },
    pageSaveAdmitted: (_tabId, workKey) => firstTap.pageSaveAdmitted(workKey),
  });

  runtime.onConnect?.addListener((port: ContentPort) => {
    // Only Trace's own popup, opened by the reader's tap, may start a save.
    if (
      port.name !== FIRST_TAP_POPUP_PORT ||
      !port.sender ||
      port.sender.id !== runtime.id ||
      (port.sender.tab !== undefined && port.sender.tab !== null) ||
      !isPopupSender(port.sender, runtime.id) ||
      (port.sender.frameId !== undefined && port.sender.frameId !== 0)
    ) {
      return;
    }
    let open = true;
    // The popup names the tab it was opened on, once. Every later command on
    // this port is about that tab and no other.
    let tappedTabId: number | null = null;
    const show = (view: FirstTapView): void => {
      if (!open) return;
      try { port.postMessage({ view }); } catch { /* The popup has gone. */ }
    };
    port.onDisconnect.addListener(() => {
      open = false;
      firstTap.closed(show);
    });
    port.onMessage.addListener((message) => {
      const request = typeof message === "object" && message !== null
        ? message as { readonly command?: unknown; readonly tabId?: unknown }
        : {};
      if (tappedTabId === null && Number.isInteger(request.tabId)) tappedTabId = request.tabId as number;
      if (tappedTabId === null) return;
      const work = request.command === "open"
        ? firstTap.opened(show, tappedTabId)
        : request.command === "save"
          ? firstTap.opened(show, tappedTabId, { requested: true })
          : request.command === "check"
            ? firstTap.check(show)
            : null;
      if (work === null) return;
      void work.then(show, () => show(Object.freeze({ state: "not_applicable" }))).then(() => {
        // A popup that closed while this was being worked out is closed for
        // the result too, so the page is not left waiting on it.
        if (!open) firstTap.closed(show);
      });
    });
  });

  // The story sites are allowed and the page scripts registered: pages put
  // into manual mode for a first tap carry on as any page. Checked here, not
  // taken on trust from the caller.
  return async () => {
    const [grant, scripts] = await Promise.all([grantComplete(), registered()]);
    if (grant === true && scripts === true) await firstTap.leaveManualMode();
  };
}
