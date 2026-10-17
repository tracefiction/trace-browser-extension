/**
 * Tabs that only opened the Trace app.
 *
 * The sheet opens the Trace app with `tabs.create({ url: "traceauth://…" })`,
 * the one way Safari on iPhone is known to hand an app link from the sheet to
 * the app. That leaves a tab behind whose address is the app link. Left open,
 * Safari can load it again later (a restored tab, a reload) and ask "Open in
 * Trace?" with no tap from the reader. This closes such tabs once they have
 * done their job.
 *
 * Without the `tabs` permission a tab's address cannot be read, so the tab is
 * known by when it was made: the sheet notes the moment just before it asks
 * for the tab, and the tab created within moments of that is the app's.
 *
 * A tab is closed when the reader is on another tab, or, if it is still the
 * tab in front, once Safari's question has long been answered. A tab the
 * reader has gone on to use for a page of their own is never closed.
 */
import { extensionCall, type RuntimePort, type StorageArea } from "./browser-platform.mjs";

/** Set by the sheet (popup.js) just before it creates an app-link tab. */
export const APP_LINK_PENDING_KEY = "traceAppLinkPendingAt" as const;
/** The app-link tabs not closed yet: `{ id, at }`, ids only. */
export const APP_LINK_TABS_KEY = "traceAppLinkTabs" as const;
/** A tab created this soon after the sheet's note is the app link's. */
export const APP_LINK_PENDING_WINDOW_MS = 10_000;
/** A tab still in front is left this long, so Safari's question is never cut short. */
export const APP_LINK_FRONT_GRACE_MS = 60_000;
/** A load in the tab after this long is the reader using it: the tab is theirs. */
export const APP_LINK_SETTLE_MS = 5_000;
const MAX_TRACKED = 20;

type TrackedTab = { readonly id: number; readonly at: number };

interface TabEvent<Listener> {
  addListener(listener: Listener): void;
}

export interface AppLinkTabsPort {
  readonly get?: (...args: unknown[]) => unknown;
  readonly remove?: (...args: unknown[]) => unknown;
  readonly onCreated?: TabEvent<(tab: { readonly id?: number }) => void>;
  readonly onActivated?: TabEvent<(info: { readonly tabId?: number }) => void>;
  readonly onUpdated?: TabEvent<(tabId: number, change: { readonly status?: string; readonly url?: string }) => void>;
  readonly onRemoved?: TabEvent<(tabId: number) => void>;
}

function tracked(value: unknown): TrackedTab[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TrackedTab =>
    typeof item === "object" && item !== null &&
    Number.isSafeInteger((item as TrackedTab).id) &&
    Number.isFinite((item as TrackedTab).at)
  ).slice(-MAX_TRACKED);
}

export function installAppLinkTabCleanup(environment: {
  readonly runtime: RuntimePort;
  readonly tabs: AppLinkTabsPort;
  readonly storage: StorageArea;
  readonly mode: "promise" | "callback";
  readonly now?: () => number;
}): { sweep(): Promise<void> } {
  const { runtime, tabs, storage, mode } = environment;
  const now = environment.now ?? (() => Date.now());
  const call = <T,>(target: object, method: string, args: unknown[]) =>
    extensionCall<T>(target as Record<string, (...args: unknown[]) => unknown>, method, args, runtime, mode);
  let tail: Promise<void> = Promise.resolve();
  // One change to the list at a time, in the order the events came.
  const serial = (work: () => Promise<void>): Promise<void> => {
    tail = tail.then(work).catch(() => undefined);
    return tail;
  };
  const read = async (): Promise<{ list: TrackedTab[]; pendingAt: number | null }> => {
    const values = await call<Record<string, unknown> | undefined>(storage, "get", [[APP_LINK_TABS_KEY, APP_LINK_PENDING_KEY]]);
    const pending = values?.[APP_LINK_PENDING_KEY];
    return {
      list: tracked(values?.[APP_LINK_TABS_KEY]),
      pendingAt: typeof pending === "number" && Number.isFinite(pending) ? pending : null,
    };
  };
  const write = async (list: readonly TrackedTab[]): Promise<void> => {
    if (list.length) await call(storage, "set", [{ [APP_LINK_TABS_KEY]: list }]);
    else await call(storage, "remove", [APP_LINK_TABS_KEY]);
  };

  /** Closes every app-link tab that is done. `front` is the tab now in front, when known. */
  const sweep = (front?: number): Promise<void> => serial(async () => {
    const { list } = await read();
    if (!list.length || typeof tabs.remove !== "function") return;
    const keep: TrackedTab[] = [];
    for (const item of list) {
      let active: boolean;
      try {
        if (front !== undefined) active = item.id === front;
        else if (typeof tabs.get === "function") {
          // Only a tab the browser reported creating for the sheet's app link.
          const createdTabId = item.id;
          active = (await call<{ active?: boolean }>(tabs, "get", [createdTabId]))?.active === true;
        }
        else active = false;
      } catch {
        continue; // Already gone.
      }
      if (active && now() - item.at < APP_LINK_FRONT_GRACE_MS) {
        keep.push(item);
        continue;
      }
      try {
        await call(tabs, "remove", [item.id]);
      } catch {
        // Already closed by the reader.
      }
    }
    await write(keep);
  });

  tabs.onCreated?.addListener((tab) => {
    const id = tab?.id;
    if (!Number.isSafeInteger(id)) return;
    void serial(async () => {
      const { list, pendingAt } = await read();
      const at = now();
      if (pendingAt === null || at - pendingAt < 0 || at - pendingAt > APP_LINK_PENDING_WINDOW_MS) return;
      // One note, one tab.
      await call(storage, "remove", [APP_LINK_PENDING_KEY]);
      await write([...list.filter((item) => item.id !== id), { id: id as number, at }].slice(-MAX_TRACKED));
    });
  });
  tabs.onActivated?.addListener((info) => {
    void sweep(Number.isSafeInteger(info?.tabId) ? info.tabId : undefined);
  });
  tabs.onUpdated?.addListener((tabId, change) => {
    if (change?.status !== "loading" && change?.url === undefined) return;
    // The reader loading a page of their own in the tab: it is theirs now.
    void serial(async () => {
      const { list } = await read();
      const item = list.find((entry) => entry.id === tabId);
      if (item === undefined || now() - item.at < APP_LINK_SETTLE_MS) return;
      await write(list.filter((entry) => entry.id !== tabId));
    });
  });
  tabs.onRemoved?.addListener((tabId) => {
    void serial(async () => {
      const { list } = await read();
      if (list.some((entry) => entry.id === tabId)) await write(list.filter((entry) => entry.id !== tabId));
    });
  });
  // A background that starts (Safari reopened, or woken for anything else)
  // closes what an earlier one could not.
  void sweep();
  return { sweep: () => sweep() };
}
