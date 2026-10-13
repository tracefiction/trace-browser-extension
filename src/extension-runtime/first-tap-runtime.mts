import type {
  StoryCommandEvidence,
  StoryPresence,
  StorySaveMode,
  StoryTrackCommand,
} from "../extension-core/index.mjs";
import { isStorySitePattern } from "./archive-sender.mjs";
import {
  extensionCall,
  type BrowserStorage,
  type BrowserTab,
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
  FIRST_TAP_MANUAL_MODE_QUERY_MESSAGE,
  FIRST_TAP_MARK_MESSAGE,
  FIRST_TAP_POPUP_PORT,
  FIRST_TAP_STORE_KEY,
  FirstTapSave,
  storySaveModeAtAdmission,
  type FirstTapAccount,
  type FirstTapTapped,
  type FirstTapView,
} from "./first-tap-save.mjs";
import {
  HAND_OVER_BY_RELOADING_THE_PAGE,
  StorySiteAccess,
  type StorySiteAccessReading,
  type StorySiteAccessView,
  type StorySiteAsk,
} from "./story-site-access.mjs";

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
  accountForThisOpen(): Promise<
    | { readonly state: "verified"; readonly binding: string }
    | { readonly state: "missing" | "reconnect_required" | "unknown" }
  >;
  snapshot(): { readonly accountId: string | null };
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
 * Installs the first-tap save: the popup's port, the page messages, the ask
 * for lasting access, and the stamp put on every page save as it is admitted.
 * Only a build that turns the first-tap save on calls this. The returned
 * function is to be called when the page scripts have been registered under
 * the complete grant; it hands the pages saved on a first tap over to
 * automatic saving.
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

  /** A fresh look at the story sites: what is allowed, and how much of it. */
  const access = async (): Promise<StorySiteAccessReading | null> => {
    const [complete, listed] = await Promise.all([
      grantComplete(),
      typeof permissions.getAll !== "function"
        ? Promise.resolve(null)
        : call<{ readonly origins?: unknown }>(permissions, "getAll", []).then(
            (all) => Array.isArray(all?.origins) ? new Set<unknown>(all.origins) : null,
            () => null,
          ),
    ]);
    if (complete === null && listed === null) return null;
    const granted = listed === null ? 0 : origins.filter((origin) => listed.has(origin)).length;
    return Object.freeze({
      complete: origins.length > 0 && (complete ?? granted === origins.length),
      granted,
      total: origins.length,
    });
  };

  /**
   * The account for this open, with the account itself beside its session, so
   * that a doubt about one account's write is never matched or cleared by
   * another's. An account that changed while it was read is not known.
   */
  const account = async (): Promise<FirstTapAccount> => {
    const read = await session.accountForThisOpen();
    if (read.state !== "verified") return read;
    const owner = session.snapshot().accountId;
    return typeof owner === "string" && owner.length > 0 && session.pageBinding() === read.binding
      ? Object.freeze({ state: "verified", binding: read.binding, owner })
      : Object.freeze({ state: "unknown" });
  };

  const firstTap = new FirstTapSave({
    grantComplete,
    account,
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

  // --- From the first manual save to automatic saving ---------------------------

  /** Whether the story sites are allowed and the page scripts registered, read now. */
  const savesByItself = async (): Promise<boolean> => {
    const [grant, scripts] = await Promise.all([grantComplete(), registered()]);
    return grant === true && scripts === true;
  };
  /**
   * Tells every page that may be in manual mode that the story sites are
   * allowed. Which pages those are is not taken from this background's memory:
   * it may have been asleep since it injected them, or the reader may have
   * allowed the sites in the browser's settings with no popup open. So every
   * open story page is told, and one that is not in manual mode refuses.
   * Checked here, not taken on trust from the caller.
   */
  const handOver = async (): Promise<void> => {
    if (!(await savesByItself())) return;
    const ids = new Set<number>(firstTap.injectedTabs());
    // Only story-site tabs are asked for, and only now that the reader has
    // allowed those sites: a query with no address filter reads as a wish to
    // see every open tab.
    const storySites = origins.filter(isStorySitePattern);
    if (storySites.length > 0) {
      const open = await call<readonly BrowserTab[]>(tabs, "query", [{ url: storySites }]).catch(
        (): readonly BrowserTab[] => [],
      );
      for (const tab of open) {
        if (typeof tab.id === "number" && Number.isInteger(tab.id)) ids.add(tab.id);
      }
    }
    await Promise.all([...ids].map((tabId) =>
      call(tabs, "sendMessage", [
        tabId,
        { type: FIRST_TAP_MANUAL_MODE_END_MESSAGE, reload: HAND_OVER_BY_RELOADING_THE_PAGE },
        { frameId: 0 },
      ]).catch(() => undefined)));
  };
  // A page in manual mode asks for itself when the reader comes back to it.
  // That reaches a background that was asleep when the sites were allowed.
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if ((message as { readonly type?: unknown } | null)?.type !== FIRST_TAP_MANUAL_MODE_QUERY_MESSAGE) return false;
    if (
      sender?.id !== runtime.id || !Number.isInteger(sender.tab?.id) ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    ) {
      sendResponse({ ok: false });
      return false;
    }
    void savesByItself().then(
      (ready) => sendResponse({ ok: true, manual: !ready, reload: ready && HAND_OVER_BY_RELOADING_THE_PAGE }),
      () => sendResponse({ ok: true, manual: true, reload: false }),
    );
    return true;
  });

  const siteAccess = new StorySiteAccess({
    access,
    registered,
    account,
    automaticSaving: () => session.automaticSaving(),
    handOver,
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
    // The popup names the tab it was opened on, once: its id, its address
    // and whether it is private, all as the popup read them in the reader's
    // tap. Every later command on this port is about that tab and no other.
    // The background looks no tab up for itself.
    let tapped: FirstTapTapped | null = null;
    const post = (message: { view?: FirstTapView; access?: StorySiteAccessView }): void => {
      if (!open) return;
      try { port.postMessage(message); } catch { /* The popup has gone. */ }
    };
    const show = (view: FirstTapView): void => post({ view });
    const showAccess = (view: StorySiteAccessView): void => post({ access: view });
    port.onDisconnect.addListener(() => {
      open = false;
      siteAccess.closed(show);
      firstTap.closed(show);
    });
    port.onMessage.addListener((message) => {
      const request = typeof message === "object" && message !== null
        ? message as {
            readonly command?: unknown; readonly tabId?: unknown; readonly url?: unknown;
            readonly private?: unknown; readonly returned?: unknown; readonly threw?: unknown;
          }
        : {};
      if (tapped === null && Number.isInteger(request.tabId) && typeof request.url === "string") {
        tapped = Object.freeze({
          tabId: request.tabId as number,
          url: request.url,
          private: typeof request.private === "boolean" ? request.private : null,
        });
      }
      if (tapped === null) return;

      // The ask. The popup made the request in the reader's tap and says so;
      // what came of it is read here.
      if (request.command === "access_asking") {
        const waiting = siteAccess.asking(show);
        if (waiting !== null) showAccess(waiting);
        return;
      }
      const ask: StorySiteAsk | null =
        // A look with no request made, for a popup that shows a state of the ask.
        request.command === "access_check" ? { kind: "none" }
        // A look while the request is out, and the popup's word that it has
        // stopped waiting on it.
        : request.command === "access_waiting" ? { kind: "waiting" }
        : request.command === "access_unanswered" ? { kind: "unanswered" }
        : request.command !== "access_answered" ? null
        : request.threw === true ? { kind: "threw" }
        : { kind: "returned", value: request.returned };
      if (ask !== null) {
        void siteAccess.answered(show, ask).then(showAccess, () => showAccess(Object.freeze({ state: "not_known" })));
        return;
      }

      const work = request.command === "open"
        ? firstTap.opened(show, tapped)
        : request.command === "save"
          ? firstTap.opened(show, tapped, { requested: true })
          : request.command === "check"
            ? firstTap.check(show)
            : null;
      if (work === null) return;
      void work.then(
        async (view) => {
          // Opened with the story sites already allowed: nothing is saved
          // from here, and the popup is told what holds, read now.
          if (view.state !== "automatic") return show(view);
          const allowed = await siteAccess.observe().catch(
            (): StorySiteAccessView => Object.freeze({ state: "not_known" }),
          );
          post({ view, access: allowed });
        },
        () => show(Object.freeze({ state: "not_applicable" })),
      ).then(() => {
        // A popup that closed while this was being worked out is closed for
        // the result too, so the page is not left waiting on it.
        if (!open) firstTap.closed(show);
      });
    });
  });

  // A background that starts with the story sites already allowed and the
  // scripts registered has no one to tell it so. A page left in manual mode
  // by the background before it is handed over now.
  void handOver().catch(() => undefined);
  return handOver;
}
