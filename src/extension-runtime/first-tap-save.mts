import type {
  ConfirmedStorySave,
  StoryCommandEvidence,
  StoryPresence,
  StorySaveMode,
  StoryTrackCommand,
} from "../extension-core/index.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";
import { storyTrackCommandFromMessage } from "./story-command-sender.mjs";

/**
 * The first save, made when the reader opens Trace on a story before Safari
 * has been asked for lasting access to the story sites.
 *
 * The background owns the whole operation. The popup only asks for it and
 * shows what the background publishes; the page only supplies the story's
 * details and, later, shows its mark. Both read the one result held here.
 */

export const FIRST_TAP_POPUP_PORT = "trace-first-tap-popup-v1";
/** Background to page: read this story's details. Changes nothing. */
export const FIRST_TAP_COLLECT_MESSAGE = "TRACE_FIRST_TAP_COLLECT";
/** Background to page: the save is confirmed and Trace's sheet is closed. */
export const FIRST_TAP_MARK_MESSAGE = "TRACE_FIRST_TAP_MARK";
export const FIRST_TAP_RECORD_KEY = "traceFirstTapSaveV1";
/** How long a finished result is shown again to a popup reopened on the page. */
export const FIRST_TAP_RECORD_TTL_MS = 10 * 60 * 1_000;

export type FirstTapAccount =
  | Readonly<{ state: "verified"; binding: string }>
  /** Known: Safari holds no account, or Trace refused the one it holds. */
  | Readonly<{ state: "missing" | "reconnect_required" }>
  /** Not known: the account could not be read just now. Never "signed out". */
  | Readonly<{ state: "unknown" }>;

export type FirstTapProvenance =
  /** This attempt's own write was confirmed. */
  | "saved_now"
  /** Found before this attempt could change anything. */
  | "already"
  /** In the Library now; whether this tap put it there is not known. */
  | "found";

export type FirstTapFailure =
  | "story_unavailable"
  | "page_unreachable"
  | "free_limit_reached"
  | "rate_limited"
  | "not_authenticated"
  | "unavailable";

export type FirstTapStory = Readonly<{
  title: string | null;
  author: string | null;
  site: "AO3" | "FanFiction.net";
}>;

/** The Library entry's own status and place, as the popup's record line reads them. */
export type FirstTapEntry = Readonly<{
  status: string | null;
  readerStatus: string | null;
  canonicalReaderStatus: string | null;
  chapters: Readonly<{ current: number; total: number | null }> | null;
}>;

/** What the popup is given. Machine values only; wording belongs to the popup. */
export type FirstTapView =
  /** Not a readable story page, or first-tap saving does not apply. */
  | Readonly<{ state: "not_applicable" }>
  /** The five story sites are allowed: the page saves by itself. */
  | Readonly<{ state: "automatic" }>
  | Readonly<{ state: "account_missing" | "account_reconnect_required" | "account_unknown"; workKey: string }>
  /** Automatic saving is off or unreadable: nothing is saved until asked. */
  | Readonly<{ state: "awaiting_request"; workKey: string; preference: "off" | "unknown" }>
  | Readonly<{ state: "saving"; workKey: string; startedAt: number }>
  | Readonly<{
      state: "confirmed";
      workKey: string;
      provenance: FirstTapProvenance;
      mode: StorySaveMode | null;
      story: FirstTapStory | null;
      entry: FirstTapEntry;
    }>
  | Readonly<{
      state: "failed";
      workKey: string;
      reason: FirstTapFailure;
      /** `never_sent` is the only value that supports "nothing was sent". */
      dispatch: "never_sent" | "refused" | "sent_unconfirmed";
      story: FirstTapStory | null;
    }>
  /** A read-only look found nothing it could rely on. Never "not saved". */
  | Readonly<{ state: "presence_unknown"; workKey: string }>;

type Tab = Readonly<{ id?: number; url?: string }>;

type StoredRecord = Readonly<{
  tabId: number;
  workKey: string;
  binding: string;
  at: number;
  /** `started`: an attempt began and its end was never recorded. */
  phase: "started" | "confirmed" | "failed";
  view?: FirstTapView;
}>;

export interface FirstTapPorts {
  /** The tab the reader opened Trace on. Only ever asked for after that tap. */
  activeTab(): Promise<Tab | null>;
  /** Whether all the story sites are allowed; null when it could not be read. */
  grantComplete(): Promise<boolean | null>;
  /** Read for this open, never from a kept snapshot. */
  account(): Promise<FirstTapAccount>;
  /** The account a result belongs to right now, or null for none. */
  binding(): string | null;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
  /** Puts the page script into the tab, in manual mode. */
  inject(tabId: number): Promise<boolean>;
  collect(tabId: number): Promise<unknown>;
  save(command: StoryTrackCommand): Promise<StoryCommandEvidence>;
  presence(workKey: string): Promise<StoryPresence>;
  /** Asks the page to show its mark for a confirmed story. Best effort. */
  mark(tabId: number, workKey: string): Promise<void>;
  readRecord(): Promise<unknown>;
  writeRecord(record: StoredRecord | null): Promise<void>;
  now(): number;
}

type Operation = {
  readonly tabId: number;
  readonly workKey: string;
  readonly binding: string;
  view: FirstTapView;
  /** Whether the page has been asked to show its mark. */
  marked: boolean;
};

type Listener = (view: FirstTapView) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

function storyFrom(collected: Record<string, unknown>, hostKind: "ao3" | "ffn"): FirstTapStory {
  return Object.freeze({
    title: text(collected.title, 300),
    author: text(collected.author, 200),
    site: hostKind === "ffn" ? "FanFiction.net" : "AO3",
  });
}

function entryFrom(confirmation: ConfirmedStorySave): FirstTapEntry {
  const entry = confirmation.entry;
  return Object.freeze({
    status: text(entry.status, 40),
    readerStatus: text(entry.readerStatus, 40),
    canonicalReaderStatus: text(entry.canonicalReaderStatus, 40),
    chapters: entry.chapters === undefined
      ? null
      : Object.freeze({ current: entry.chapters.current, total: entry.chapters.total }),
  });
}

function storedRecord(value: unknown): StoredRecord | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.tabId) ||
    typeof value.workKey !== "string" ||
    typeof value.binding !== "string" ||
    typeof value.at !== "number" ||
    !["started", "confirmed", "failed"].includes(String(value.phase))
  ) {
    return null;
  }
  return value as unknown as StoredRecord;
}

/**
 * The mode the background stamps on a save when it admits it. A page's own
 * claim is never read. `null` means neither can be established.
 */
export function storySaveModeAtAdmission(evidence: Readonly<{
  /** The background itself put the page script into this document. */
  injectedForFirstTap: boolean;
  /** Whether all the story sites are allowed right now; null when unread. */
  grantComplete: boolean | null;
  /** Whether the page scripts are registered right now; null when unread. */
  registered: boolean | null;
}>): StorySaveMode | null {
  if (evidence.grantComplete === true && evidence.registered === true) {
    return "normal_automatic";
  }
  if (evidence.injectedForFirstTap && evidence.grantComplete === false) {
    return "bounded_manual";
  }
  return null;
}

export class FirstTapSave {
  readonly #ports: FirstTapPorts;
  readonly #operations = new Map<number, Operation>();
  readonly #listeners = new Map<number, Set<Listener>>();
  readonly #listenerTabs = new Map<Listener, number>();
  /** Tabs whose page script this background injected for a first tap. */
  readonly #injected = new Map<number, string>();

  constructor(ports: FirstTapPorts) {
    this.#ports = ports;
  }

  /** Whether the background injected this tab's page script for this story. */
  injectedFor(tabId: number, workKey: string): boolean {
    return this.#injected.get(tabId) === workKey;
  }

  /**
   * The reader opened Trace. Returns what is known now; later changes reach
   * `listener` until `closed` is called for it.
   */
  async opened(listener: Listener, options: { readonly requested?: boolean } = {}): Promise<FirstTapView> {
    const tab = await this.#ports.activeTab().catch(() => null);
    const page = this.#storyPage(tab);
    if (page === null) return Object.freeze({ state: "not_applicable" });
    this.#listen(page.tabId, listener);

    const grant = await this.#ports.grantComplete().catch(() => null);
    if (grant === true) return Object.freeze({ state: "automatic" });

    const account = await this.#ports.account().catch(
      (): FirstTapAccount => Object.freeze({ state: "unknown" }),
    );
    if (account.state !== "verified") {
      // Whatever was shown for another account, or for none, is not this
      // reader's result any more.
      this.#discard(page.tabId);
      return Object.freeze({
        state: account.state === "missing"
          ? "account_missing"
          : account.state === "reconnect_required"
            ? "account_reconnect_required"
            : "account_unknown",
        workKey: page.workKey,
      });
    }

    const current = this.#operations.get(page.tabId);
    if (current && current.workKey === page.workKey && current.binding === account.binding) {
      const retry = options.requested === true && current.view.state !== "saving" &&
        current.view.state !== "confirmed";
      if (!retry) return current.view;
    } else if (current) {
      this.#discard(page.tabId);
    }

    let stored = storedRecord(await this.#ports.readRecord().catch(() => null));
    if (stored !== null && !(this.#ports.now() - stored.at >= 0 &&
        this.#ports.now() - stored.at < FIRST_TAP_RECORD_TTL_MS)) {
      // Too old to describe anything: it is removed, not kept around.
      await this.#ports.writeRecord(null).catch(() => undefined);
      stored = null;
    }
    const sameAttempt = stored !== null && stored.workKey === page.workKey &&
      stored.binding === account.binding;
    if (
      options.requested !== true &&
      sameAttempt && stored !== null && stored.tabId === page.tabId &&
      stored.view !== undefined && stored.phase !== "started"
    ) {
      // A popup reopened after the background slept gets the same answer.
      const operation: Operation = {
        tabId: page.tabId, workKey: page.workKey, binding: account.binding,
        view: stored.view, marked: false,
      };
      this.#operations.set(page.tabId, operation);
      return operation.view;
    }

    if (options.requested !== true) {
      const preference = await this.#ports.automaticSaving().catch((): "unknown" => "unknown");
      if (preference !== "on") {
        return Object.freeze({ state: "awaiting_request", workKey: page.workKey, preference });
      }
    }

    // An earlier attempt for this story and account that never recorded its
    // end, or ended without knowing whether its write landed, may be what put
    // the story in the Library. A story then found is "found", not "already".
    const earlierAttemptOpen = sameAttempt && stored !== null && (
      stored.phase === "started" ||
      (stored.view?.state === "failed" && stored.view.dispatch === "sent_unconfirmed")
    );
    const operation: Operation = {
      tabId: page.tabId, workKey: page.workKey, binding: account.binding,
      view: Object.freeze({ state: "saving", workKey: page.workKey, startedAt: this.#ports.now() }),
      marked: false,
    };
    this.#operations.set(page.tabId, operation);
    void this.#run(operation, page.url, grant, earlierAttemptOpen);
    return operation.view;
  }

  /**
   * "Check again": looks, and can do nothing else. It has no path to a save.
   * Only a story it finds changes what is shown.
   */
  async check(): Promise<FirstTapView> {
    const tab = await this.#ports.activeTab().catch(() => null);
    const page = this.#storyPage(tab);
    if (page === null) return Object.freeze({ state: "not_applicable" });
    const binding = this.#ports.binding();
    const unknown: FirstTapView = Object.freeze({ state: "presence_unknown", workKey: page.workKey });
    if (binding === null) return unknown;
    const presence = await this.#ports.presence(page.workKey).catch(
      (): StoryPresence => ({ kind: "unknown" }),
    );
    if (presence.kind !== "found" || this.#ports.binding() !== binding) return unknown;
    const before = this.#operations.get(page.tabId);
    const story = before && before.workKey === page.workKey &&
      (before.view.state === "confirmed" || before.view.state === "failed")
      ? before.view.story
      : null;
    const operation: Operation = {
      tabId: page.tabId, workKey: page.workKey, binding,
      view: Object.freeze({
        state: "confirmed", workKey: page.workKey, provenance: "found", mode: null,
        story, entry: entryFrom(presence.confirmation),
      }),
      marked: false,
    };
    this.#operations.set(page.tabId, operation);
    await this.#settle(operation);
    return operation.view;
  }

  /** Trace's sheet closed. The page it was over may now show its mark. */
  closed(listener: Listener): void {
    const tabId = this.#listenerTabs.get(listener);
    if (tabId === undefined) return;
    this.#listenerTabs.delete(listener);
    const listeners = this.#listeners.get(tabId);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.#listeners.delete(tabId);
    const operation = this.#operations.get(tabId);
    if (operation) void this.#markIfDue(operation);
  }

  /**
   * A page script's own save for this tab and story was admitted. Whatever a
   * first tap said that was not a confirmation no longer describes the story:
   * a save the sheet called unsent may be paid by the page a moment later.
   */
  pageSaveAdmitted(tabId: number, workKey: string): void {
    const operation = this.#operations.get(tabId);
    if (!operation || operation.workKey !== workKey || operation.view.state === "confirmed") return;
    this.#discard(tabId);
    void this.#ports.writeRecord(null).catch(() => undefined);
  }

  #storyPage(tab: Tab | null): { tabId: number; workKey: string; url: string; hostKind: "ao3" | "ffn" } | null {
    if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") return null;
    const hostKind = archiveHostKindFromSender({ url: tab.url });
    if (hostKind === null || isBlockedArchivePath(tab.url, hostKind)) return null;
    const workKey = workKeyFromArchiveUrl(tab.url, hostKind);
    return workKey === null ? null : { tabId: tab.id as number, workKey, url: tab.url, hostKind };
  }

  #listen(tabId: number, listener: Listener): void {
    const listeners = this.#listeners.get(tabId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(tabId, listeners);
    this.#listenerTabs.set(listener, tabId);
  }

  #discard(tabId: number): void {
    this.#operations.delete(tabId);
  }

  #current(operation: Operation): boolean {
    return this.#operations.get(operation.tabId) === operation &&
      this.#ports.binding() === operation.binding;
  }

  async #run(
    operation: Operation,
    url: string,
    grantAtStart: boolean | null,
    earlierAttemptOpen: boolean,
  ): Promise<void> {
    const fail = (
      reason: FirstTapFailure,
      dispatch: "never_sent" | "refused" | "sent_unconfirmed",
      story: FirstTapStory | null,
    ): Promise<void> => {
      operation.view = Object.freeze({ state: "failed", workKey: operation.workKey, reason, dispatch, story });
      return this.#settle(operation);
    };
    try {
      await this.#ports.writeRecord({
        tabId: operation.tabId, workKey: operation.workKey, binding: operation.binding,
        at: this.#ports.now(), phase: "started",
      }).catch(() => undefined);

      if (!(await this.#ports.inject(operation.tabId).catch(() => false))) {
        return await fail("page_unreachable", "never_sent", null);
      }
      this.#injected.set(operation.tabId, operation.workKey);
      const collected = await this.#ports.collect(operation.tabId).catch(() => null);
      const hostKind = archiveHostKindFromSender({ url });
      if (!isRecord(collected) || hostKind === null) {
        return await fail("page_unreachable", "never_sent", null);
      }
      const story = storyFrom(collected, hostKind);
      if (collected.ok !== true) {
        return await fail(
          collected.error === "story_unavailable" ? "story_unavailable" : "page_unreachable",
          "never_sent",
          story,
        );
      }
      // The page's reply is checked exactly as a save it had sent itself.
      const command = storyTrackCommandFromMessage(
        { type: "TRACE_CONNECT_AND_SAVE", workKey: operation.workKey, payload: collected.payload },
        { tab: { url }, url, frameId: 0 },
      );
      if (command === null || command.workKey !== operation.workKey) {
        return await fail("page_unreachable", "never_sent", story);
      }
      // The account changed while the page was read: nothing is sent for it.
      if (!this.#current(operation)) return this.#superseded(operation);

      const mode = storySaveModeAtAdmission({
        injectedForFirstTap: true,
        grantComplete: grantAtStart,
        registered: null,
      });
      const { result, dispatch } = await this.#ports.save(
        mode === null ? command : { ...command, mode },
      );
      if (!this.#current(operation)) return this.#superseded(operation);

      if (result.kind === "confirmed") {
        const provenance: FirstTapProvenance = result.source === "mutation"
          ? "saved_now"
          : result.source === "preflight" && !earlierAttemptOpen
            ? "already"
            : "found";
        operation.view = Object.freeze({
          state: "confirmed", workKey: operation.workKey, provenance, mode,
          story, entry: entryFrom(result.confirmation),
        });
        return await this.#settle(operation);
      }
      const reason: FirstTapFailure =
        result.reason === "free_limit_reached" || result.reason === "rate_limited"
          ? result.reason
          : result.reason === "not_authenticated" || result.reason === "auth_expired"
            ? "not_authenticated"
            : "unavailable";
      return await fail(reason, dispatch === "confirmed" ? "sent_unconfirmed" : dispatch, story);
    } catch {
      // What became of the write is not known here, so it is not called unsent.
      if (this.#current(operation)) await fail("unavailable", "sent_unconfirmed", null);
    }
  }

  /** The result is no longer this reader's: say only that the page should be opened again. */
  #superseded(operation: Operation): void {
    if (this.#operations.get(operation.tabId) === operation) this.#discard(operation.tabId);
    this.#publish(operation.tabId, Object.freeze({ state: "account_unknown", workKey: operation.workKey }));
  }

  async #settle(operation: Operation): Promise<void> {
    if (!this.#current(operation)) return this.#superseded(operation);
    await this.#ports.writeRecord({
      tabId: operation.tabId, workKey: operation.workKey, binding: operation.binding,
      at: this.#ports.now(),
      phase: operation.view.state === "confirmed" ? "confirmed" : "failed",
      // The story's title and author are shown, never kept.
      view: "story" in operation.view ? Object.freeze({ ...operation.view, story: null }) : operation.view,
    }).catch(() => undefined);
    this.#publish(operation.tabId, operation.view);
    await this.#markIfDue(operation);
  }

  #publish(tabId: number, view: FirstTapView): void {
    for (const listener of this.#listeners.get(tabId) ?? []) {
      try { listener(view); } catch { /* A closed popup is told nothing. */ }
    }
  }

  // The page shows its mark only for a confirmed story, and only once Trace's
  // sheet is no longer over it. Both read the same held result.
  async #markIfDue(operation: Operation): Promise<void> {
    if (
      operation.marked ||
      operation.view.state !== "confirmed" ||
      (this.#listeners.get(operation.tabId)?.size ?? 0) > 0 ||
      !this.#current(operation)
    ) {
      return;
    }
    operation.marked = true;
    await this.#ports.mark(operation.tabId, operation.workKey).catch(() => undefined);
  }
}
