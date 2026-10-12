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
  FIRST_TAP_MARK_MESSAGE,
  FIRST_TAP_POPUP_PORT,
  FIRST_TAP_RECORD_KEY,
  FirstTapSave,
  storySaveModeAtAdmission,
  type FirstTapAccount,
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
  tappedTab(): Promise<{ readonly id?: number; readonly url?: string } | null>;
  accountForThisOpen(): Promise<FirstTapAccount>;
  pageBinding(): string | null;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
  saveStoryWithEvidence(command: StoryTrackCommand): Promise<StoryCommandEvidence>;
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
}>;

/**
 * Installs the first-tap save: the popup's port, the page messages, and the
 * stamp put on every page save as it is admitted. Only a build that turns the
 * first-tap save on calls this.
 */
export function installFirstTapSave(environment: Environment): FirstTapSave {
  const { runtime, tabs, permissions, scripting, storage, mode, origins, session } = environment;
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
    activeTab: () => session.tappedTab(),
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
    save: (command) => session.saveStoryWithEvidence(command),
    presence: (workKey) => session.storyPresence(workKey),
    async mark(tabId, workKey) {
      await call(tabs, "sendMessage", [tabId, { type: FIRST_TAP_MARK_MESSAGE, workKey }, { frameId: 0 }]);
    },
    async readRecord() {
      return (await storage.get(FIRST_TAP_RECORD_KEY))[FIRST_TAP_RECORD_KEY];
    },
    async writeRecord(record) {
      if (record === null) await storage.remove(FIRST_TAP_RECORD_KEY);
      else await storage.set({ [FIRST_TAP_RECORD_KEY]: record });
    },
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
    pageSaveAdmitted: (tabId, workKey) => firstTap.pageSaveAdmitted(tabId, workKey),
  });

  runtime.onConnect?.addListener((port: ContentPort) => {
    // Only Trace's own sheet, opened by the reader's tap, may start a save.
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
    const show = (view: FirstTapView): void => {
      if (!open) return;
      try { port.postMessage({ view }); } catch { /* The sheet has gone. */ }
    };
    port.onDisconnect.addListener(() => {
      open = false;
      firstTap.closed(show);
    });
    port.onMessage.addListener((message) => {
      const command = typeof message === "object" && message !== null
        ? (message as { readonly command?: unknown }).command
        : undefined;
      const work = command === "open"
        ? firstTap.opened(show)
        : command === "save"
          ? firstTap.opened(show, { requested: true })
          : command === "check"
            ? firstTap.check()
            : null;
      if (work === null) return;
      void work.then(show, () => show(Object.freeze({ state: "not_applicable" }))).then(() => {
        // A sheet that closed while this was being worked out is closed for
        // the result too, so the page is not left waiting on it.
        if (!open) firstTap.closed(show);
      });
    });
  });
  return firstTap;
}
