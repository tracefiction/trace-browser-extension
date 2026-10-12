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
 * The background owns the whole operation. There is one record for each
 * account and story, and everything shown comes from it: the popup draws it,
 * and the page shows its mark from it. Within one attempt a later answer for
 * the same account and story can only improve what the record says (nothing
 * known, then found, then found with a known origin); it never takes a
 * confirmation back. A different account has different records, and the old
 * account's are discarded as soon as the change is seen.
 */

export const FIRST_TAP_POPUP_PORT = "trace-first-tap-popup-v1";
/** Background to page: read this story's details. Changes nothing. */
export const FIRST_TAP_COLLECT_MESSAGE = "TRACE_FIRST_TAP_COLLECT";
/** Background to page: the save is confirmed and Trace's popup is closed. */
export const FIRST_TAP_MARK_MESSAGE = "TRACE_FIRST_TAP_MARK";
/** Background to page: the story sites are allowed; carry on as any page. */
export const FIRST_TAP_MANUAL_MODE_END_MESSAGE = "TRACE_PAGE_MANUAL_MODE_END";
export const FIRST_TAP_STORE_KEY = "traceFirstTapSaveV2";
/** How long a finished result is shown again to a popup reopened on the page. */
export const FIRST_TAP_RESULT_FRESH_MS = 10 * 60 * 1_000;
/** How long a settled record is kept, and how many records at most. */
export const FIRST_TAP_RECORD_TTL_MS = 24 * 60 * 60 * 1_000;
export const FIRST_TAP_RECORD_LIMIT = 20;

export type FirstTapAccount =
  | Readonly<{ state: "verified"; binding: string }>
  /** Known: Safari holds no account, or Trace refused the one it holds. */
  | Readonly<{ state: "missing" | "reconnect_required" }>
  /** Not known: the account could not be read just now. Never "signed out". */
  | Readonly<{ state: "unknown" }>;

export type FirstTapProvenance =
  /** This attempt's own write was confirmed. */
  | "saved_now"
  /** Found before this attempt could change anything, with nothing earlier in doubt. */
  | "already"
  /** In the Library now; whether this reader's tap put it there is not known. */
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
  /** The story sites are allowed: the page saves by itself. */
  | Readonly<{ state: "automatic" }>
  | Readonly<{ state: "account_missing" | "account_reconnect_required" | "account_unknown"; workKey: string }>
  /** The account changed under this popup. What it showed is gone; ask again. */
  | Readonly<{ state: "account_changed"; workKey: string }>
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

export type FirstTapTab = Readonly<{
  id?: number;
  url?: string;
  active?: boolean;
  incognito?: boolean;
}>;

type Settled =
  | Readonly<{ kind: "confirmed"; provenance: FirstTapProvenance; mode: StorySaveMode | null; entry: FirstTapEntry }>
  | Readonly<{ kind: "failed"; reason: FirstTapFailure; dispatch: "never_sent" | "refused" | "sent_unconfirmed" }>;
type Outcome = Settled | Readonly<{ kind: "saving"; startedAt: number }>;

/**
 * One account's knowledge of one story. `key` and `scope` are digests salted
 * for this install; the readable work key and account stay in memory only.
 */
type Record = {
  readonly key: string;
  readonly scope: string;
  readonly binding: string;
  readonly workKey: string;
  /** False for a private tab: nothing about it is written to storage. */
  persist: boolean;
  at: number;
  outcome: Outcome | null;
  /**
   * A write whose fate is not known may have added this story: this
   * extension's own, handed to the network and never answered, or a page's
   * own save admitted meanwhile. While set, a story found is never "already".
   */
  inDoubt: boolean;
  /** A page's own save for this story was admitted during this attempt. */
  pageSave: boolean;
  /** Whether what came before this attempt is known well enough to say "already". */
  priorKnown: boolean;
  running: boolean;
  story: FirstTapStory | null;
  /** Tabs that may show the mark for this attempt. */
  tabs: Set<number>;
  marked: Set<number>;
};

type StoredRecord = Readonly<{
  k: string;
  s: string;
  at: number;
  inDoubt: boolean;
  outcome: Settled | null;
}>;
type Stored = {
  salt: string;
  /** Accounts for which a record still in doubt had to be dropped. */
  forgot: string[];
  records: StoredRecord[];
};

export interface FirstTapPorts {
  /** The tab the popup says it was opened on, by id. Never a search. */
  tab(tappedTabId: number): Promise<FirstTapTab | null>;
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
  /** `beforeWrite` runs just before the write is handed to the network. */
  save(
    command: StoryTrackCommand,
    observer: { beforeWrite(): Promise<void> },
  ): Promise<StoryCommandEvidence>;
  presence(workKey: string): Promise<StoryPresence>;
  /** Asks the page to show its mark for a confirmed story. Best effort. */
  mark(tabId: number, workKey: string): Promise<void>;
  /** Tells a page it injected to leave manual mode. Best effort. */
  endManualMode(tabId: number): Promise<void>;
  readStore(): Promise<unknown>;
  writeStore(value: unknown): Promise<void>;
  /** A digest of `text` that cannot be read back. */
  digest(text: string): Promise<string>;
  randomSalt(): string;
  now(): number;
}

type Listener = (view: FirstTapView) => void;
type Sheet = { tabId: number; key: string | null; workKey: string | null };
type StoryPage = { tabId: number; workKey: string; url: string; hostKind: "ao3" | "ffn"; persist: boolean };

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

function storyFrom(collected: { [key: string]: unknown }, hostKind: "ao3" | "ffn"): FirstTapStory {
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

/** How much an outcome establishes. A record only ever moves up within an attempt. */
function weight(outcome: Outcome | null): number {
  if (outcome === null || outcome.kind === "saving") return 0;
  if (outcome.kind === "failed") return 1;
  return outcome.provenance === "found" ? 2 : 3;
}

function settledFrom(value: unknown): Settled | null {
  if (!isRecord(value)) return null;
  if (value.kind === "confirmed" && isRecord(value.entry) &&
      ["saved_now", "already", "found"].includes(String(value.provenance))) {
    return value as unknown as Settled;
  }
  if (value.kind === "failed" && typeof value.reason === "string" &&
      ["never_sent", "refused", "sent_unconfirmed"].includes(String(value.dispatch))) {
    return value as unknown as Settled;
  }
  return null;
}

function storedFrom(value: unknown): Stored | null {
  if (!isRecord(value) || typeof value.salt !== "string" || value.salt.length < 16) return null;
  const records: StoredRecord[] = [];
  for (const item of Array.isArray(value.records) ? value.records : []) {
    if (!isRecord(item) || typeof item.k !== "string" || typeof item.s !== "string" ||
        typeof item.at !== "number") continue;
    records.push({
      k: item.k, s: item.s, at: item.at,
      inDoubt: item.inDoubt === true,
      outcome: settledFrom(item.outcome),
    });
  }
  return {
    salt: value.salt,
    forgot: (Array.isArray(value.forgot) ? value.forgot : []).filter(
      (scope): scope is string => typeof scope === "string",
    ),
    records,
  };
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
  /** Records by key. Each belongs to one account and one story. */
  readonly #records = new Map<string, Record>();
  /** Open popups, and the record each is showing. */
  readonly #sheets = new Map<Listener, Sheet>();
  /** Tabs whose page script this background injected, and for which story. */
  readonly #injected = new Map<number, string>();
  /** The kept records; `readable` is false when storage could not be read. */
  #store: Promise<{ stored: Stored; readable: boolean }> | null = null;
  #writes: Promise<void> = Promise.resolve();

  constructor(ports: FirstTapPorts) {
    this.#ports = ports;
  }

  /** Whether the background injected this tab's page script for this story. */
  injectedFor(tabId: number, workKey: string): boolean {
    return this.#injected.get(tabId) === workKey;
  }

  /**
   * The reader opened Trace on `tappedTabId`. Returns what is known now; later
   * changes to the same record reach `listener` until `closed` is called.
   */
  async opened(
    listener: Listener,
    tappedTabId: number,
    options: { readonly requested?: boolean } = {},
  ): Promise<FirstTapView> {
    const page = this.#storyPage(await this.#ports.tab(tappedTabId).catch(() => null), tappedTabId);
    if (page === null) return Object.freeze({ state: "not_applicable" });
    const sheet: Sheet = this.#sheets.get(listener) ?? { tabId: page.tabId, key: null, workKey: null };
    sheet.tabId = page.tabId;
    sheet.key = null;
    sheet.workKey = page.workKey;
    this.#sheets.set(listener, sheet);

    const grant = await this.#ports.grantComplete().catch(() => null);
    if (grant === true) return Object.freeze({ state: "automatic" });

    const account = await this.#ports.account().catch(
      (): FirstTapAccount => Object.freeze({ state: "unknown" }),
    );
    if (account.state !== "verified") {
      return Object.freeze({
        state: account.state === "missing"
          ? "account_missing"
          : account.state === "reconnect_required"
            ? "account_reconnect_required"
            : "account_unknown",
        workKey: page.workKey,
      });
    }

    const record = await this.#recordFor(account.binding, page);
    // The popup may have closed while this was being worked out.
    if (this.#sheets.get(listener) === sheet) sheet.key = record.key;
    if (record.running) return this.#view(record);
    const age = this.#ports.now() - record.at;
    const fresh = age >= 0 && age < FIRST_TAP_RESULT_FRESH_MS;
    if (fresh && record.outcome?.kind === "confirmed") return this.#view(record);
    if (fresh && record.outcome?.kind === "failed" && options.requested !== true) {
      return this.#view(record);
    }

    // A write of unknown fate may already have added this story. Look before
    // offering or making another save, and never call what is found "already".
    if (record.inDoubt) {
      const found = await this.#look(record);
      if (found === "account_changed") return this.#accountChanged(record);
      if (found !== null) {
        this.#begin(record, page);
        // So that the page can show its mark for what was found.
        if (await this.#ports.inject(page.tabId).catch(() => false)) {
          this.#injected.set(page.tabId, page.workKey);
        }
        return this.#settle(record, { kind: "confirmed", provenance: "found", mode: null, entry: found });
      }
    }
    if (options.requested !== true) {
      const preference = await this.#ports.automaticSaving().catch((): "unknown" => "unknown");
      if (preference !== "on") {
        // With an earlier write in doubt, "save this story" is not offered:
        // it may have landed. The reader can look again, or choose to retry.
        return record.inDoubt
          ? Object.freeze({
              state: "failed", workKey: page.workKey, reason: "unavailable",
              dispatch: "sent_unconfirmed", story: record.story,
            })
          : Object.freeze({ state: "awaiting_request", workKey: page.workKey, preference });
      }
    }

    this.#begin(record, page);
    record.running = true;
    record.outcome = Object.freeze({ kind: "saving", startedAt: this.#ports.now() });
    void this.#run(record, page, grant);
    return this.#view(record);
  }

  /**
   * "Check again": looks, and can do nothing else. It has no path to a save.
   * A story it finds improves the record; anything else changes nothing.
   */
  async check(listener: Listener): Promise<FirstTapView> {
    const sheet = this.#sheets.get(listener);
    if (!sheet || sheet.workKey === null) return Object.freeze({ state: "not_applicable" });
    const unknown: FirstTapView = Object.freeze({ state: "presence_unknown", workKey: sheet.workKey });
    const record = sheet.key === null ? null : this.#records.get(sheet.key) ?? null;
    if (record === null || record.binding !== this.#ports.binding()) return unknown;
    const found = await this.#look(record);
    if (found === "account_changed") return this.#accountChanged(record);
    if (found === null) return unknown;
    return this.#settle(record, { kind: "confirmed", provenance: "found", mode: null, entry: found });
  }

  /** Trace's popup closed. The page it was over may now show its mark. */
  closed(listener: Listener): void {
    const sheet = this.#sheets.get(listener);
    if (!sheet) return;
    this.#sheets.delete(listener);
    const record = sheet.key === null ? null : this.#records.get(sheet.key);
    if (record) void this.#markIfDue(record);
  }

  /**
   * A page script's own save for this story was admitted for the current
   * account. It may add the story, so the record can no longer say "already",
   * and a failure it showed is no longer the last word.
   */
  pageSaveAdmitted(workKey: string): void {
    const binding = this.#ports.binding();
    for (const record of this.#records.values()) {
      if (record.workKey !== workKey || record.binding !== binding) continue;
      if (record.outcome?.kind === "confirmed") continue;
      record.inDoubt = true;
      record.pageSave = true;
      if (!record.running && record.outcome?.kind === "failed") record.outcome = null;
      void this.#persist(record);
    }
  }

  /**
   * The story sites are now allowed and the page scripts registered. Pages
   * this background put into manual mode are told to carry on as any page.
   */
  async leaveManualMode(): Promise<void> {
    await Promise.all([...this.#injected.keys()].map((tabId) =>
      this.#ports.endManualMode(tabId).catch(() => undefined)));
  }

  #storyPage(tab: FirstTapTab | null, tappedTabId: number): StoryPage | null {
    // The tab named must be the one on show in its window, and a story page.
    if (!tab || tab.id !== tappedTabId || tab.active === false || typeof tab.url !== "string") return null;
    const hostKind = archiveHostKindFromSender({ url: tab.url });
    if (hostKind === null || isBlockedArchivePath(tab.url, hostKind)) return null;
    const workKey = workKeyFromArchiveUrl(tab.url, hostKind);
    return workKey === null
      ? null
      : { tabId: tappedTabId, workKey, url: tab.url, hostKind, persist: tab.incognito !== true };
  }

  // --- Records ----------------------------------------------------------------

  #loadStore(): Promise<{ stored: Stored; readable: boolean }> {
    this.#store ??= this.#ports.readStore().then(
      (value) => ({
        stored: storedFrom(value) ?? { salt: this.#ports.randomSalt(), forgot: [], records: [] },
        readable: true,
      }),
      // Storage could not be read. A salt for this worker's life still keeps
      // records apart; nothing is kept, and nothing earlier is known.
      () => ({ stored: { salt: this.#ports.randomSalt(), forgot: [], records: [] }, readable: false }),
    );
    return this.#store;
  }

  /** The record for this account and story, from memory, storage, or new. */
  async #recordFor(binding: string, page: StoryPage): Promise<Record> {
    const { stored, readable } = await this.#loadStore();
    const scope = await this.#ports.digest(`${stored.salt}\u0000account\u0000${binding}`);
    const key = await this.#ports.digest(`${stored.salt}\u0000story\u0000${binding}\u0000${page.workKey}`);

    // Another account's records are discarded as soon as the change is seen.
    for (const [otherKey, other] of this.#records) {
      if (other.binding !== binding && !other.running) this.#records.delete(otherKey);
    }
    if (stored.records.some((item) => item.s !== scope) || stored.forgot.some((item) => item !== scope)) {
      stored.records = stored.records.filter((item) => item.s === scope);
      stored.forgot = stored.forgot.filter((item) => item === scope);
      if (readable) await this.#write(stored);
    }

    // "Already" needs the whole of what came before: records that are kept
    // (not a private tab), that could be read, and none dropped in doubt.
    const priorKnown = page.persist && readable && !stored.forgot.includes(scope);
    const existing = this.#records.get(key);
    if (existing) {
      existing.persist = existing.persist && page.persist;
      existing.priorKnown = existing.priorKnown && priorKnown;
      return existing;
    }
    const kept = page.persist ? stored.records.find((item) => item.k === key) : undefined;
    const record: Record = {
      key, scope, binding, workKey: page.workKey, persist: page.persist,
      at: kept?.at ?? this.#ports.now(),
      outcome: kept?.outcome ?? null,
      inDoubt: kept?.inDoubt === true,
      pageSave: false,
      priorKnown,
      running: false,
      story: null,
      tabs: new Set([page.tabId]),
      marked: new Set(),
    };
    this.#records.set(key, record);
    return record;
  }

  /** Starts a new attempt on a record. Only what is still in doubt carries over. */
  #begin(record: Record, page: StoryPage): void {
    record.outcome = null;
    record.at = this.#ports.now();
    record.pageSave = false;
    record.tabs = new Set([page.tabId]);
    record.marked = new Set();
  }

  #view(record: Record): FirstTapView {
    const outcome = record.outcome;
    if (outcome === null || outcome.kind === "saving") {
      return Object.freeze({
        state: "saving", workKey: record.workKey,
        startedAt: outcome?.kind === "saving" ? outcome.startedAt : record.at,
      });
    }
    return outcome.kind === "confirmed"
      ? Object.freeze({
          state: "confirmed", workKey: record.workKey, provenance: outcome.provenance,
          mode: outcome.mode, story: record.story, entry: outcome.entry,
        })
      : Object.freeze({
          state: "failed", workKey: record.workKey, reason: outcome.reason,
          dispatch: outcome.dispatch, story: record.story,
        });
  }

  /**
   * Records an answer. Within an attempt the record only moves up: a
   * confirmation is never replaced by a failure, and a known origin is never
   * replaced by an unknown one. Returns what the record now says.
   */
  async #settle(record: Record, answer: Settled): Promise<FirstTapView> {
    if (this.#ports.binding() !== record.binding) return this.#accountChanged(record);
    const before = weight(record.outcome);
    const after = weight(answer);
    if (after > before || (after === before && answer.kind === "failed")) {
      record.outcome = Object.freeze(answer);
      record.at = this.#ports.now();
    }
    if (record.outcome?.kind === "confirmed") {
      record.inDoubt = false;
      record.pageSave = false;
    }
    await this.#persist(record);
    const view = this.#view(record);
    for (const [listener, sheet] of this.#sheets) {
      if (sheet.key !== record.key) continue;
      try { listener(view); } catch { /* A closed popup is told nothing. */ }
    }
    await this.#markIfDue(record);
    return view;
  }

  /** A read-only look: the entry, nothing, or word that the account changed. */
  async #look(record: Record): Promise<FirstTapEntry | null | "account_changed"> {
    const presence = await this.#ports.presence(record.workKey).catch(
      (): StoryPresence => ({ kind: "unknown" }),
    );
    if (this.#ports.binding() !== record.binding) return "account_changed";
    return presence.kind === "found" ? entryFrom(presence.confirmation) : null;
  }

  /** The account changed: nothing held for the old one is shown or kept. */
  #accountChanged(record: Record): FirstTapView {
    const view: FirstTapView = Object.freeze({ state: "account_changed", workKey: record.workKey });
    this.#records.delete(record.key);
    for (const [listener, sheet] of this.#sheets) {
      if (sheet.key !== record.key) continue;
      sheet.key = null;
      try { listener(view); } catch { /* A closed popup is told nothing. */ }
    }
    void this.#drop(record);
    return view;
  }

  // --- Storage ----------------------------------------------------------------

  #write(stored: Stored): Promise<void> {
    this.#writes = this.#writes
      .then(() => this.#ports.writeStore({ salt: stored.salt, forgot: [...stored.forgot], records: [...stored.records] }))
      .catch(() => undefined);
    return this.#writes;
  }

  async #drop(record: Record): Promise<void> {
    const { stored, readable } = await this.#loadStore();
    if (!stored.records.some((item) => item.k === record.key)) return;
    stored.records = stored.records.filter((item) => item.k !== record.key);
    if (readable) await this.#write(stored);
  }

  /** Writes what a record now says. No work key, title, author or address. */
  async #persist(record: Record): Promise<void> {
    if (!record.persist) return;
    const { stored, readable } = await this.#loadStore();
    if (!readable) return;
    const now = this.#ports.now();
    const outcome = record.outcome === null || record.outcome.kind === "saving" ? null : record.outcome;
    let records = stored.records.filter((item) => item.k !== record.key);
    // Nothing settled and nothing in doubt is nothing worth keeping.
    if (outcome !== null || record.inDoubt) {
      records.push({ k: record.key, s: record.scope, at: record.at, inDoubt: record.inDoubt, outcome });
    }
    // A settled record ages out. One still in doubt is kept until the limit
    // forces it out, and then the account is marked: from there on a story
    // found with no record cannot be called "already".
    records = records.filter((item) =>
      item.inDoubt || (now - item.at >= 0 && now - item.at < FIRST_TAP_RECORD_TTL_MS));
    while (records.length > FIRST_TAP_RECORD_LIMIT) {
      const settled = records.findIndex((item) => !item.inDoubt);
      const [dropped] = records.splice(settled === -1 ? 0 : settled, 1);
      if (dropped?.inDoubt && !stored.forgot.includes(dropped.s)) stored.forgot.push(dropped.s);
    }
    stored.records = records;
    await this.#write(stored);
  }

  // --- One attempt ------------------------------------------------------------

  async #run(record: Record, page: StoryPage, grantAtStart: boolean | null): Promise<void> {
    const earlierInDoubt = record.inDoubt;
    const fail = async (
      reason: FirstTapFailure,
      dispatch: "never_sent" | "refused" | "sent_unconfirmed",
    ): Promise<void> => {
      record.running = false;
      // This attempt's own write is in doubt only if it went out unanswered.
      record.inDoubt = earlierInDoubt || record.pageSave || dispatch === "sent_unconfirmed";
      // A page's own save was admitted while this one was out. It may have
      // saved the story, so look before saying this attempt failed.
      if (record.pageSave) {
        const found = await this.#look(record);
        if (found === "account_changed") { this.#accountChanged(record); return; }
        if (found !== null) {
          await this.#settle(record, { kind: "confirmed", provenance: "found", mode: null, entry: found });
          return;
        }
      }
      await this.#settle(record, { kind: "failed", reason, dispatch });
    };
    try {
      if (!(await this.#ports.inject(page.tabId).catch(() => false))) {
        return await fail("page_unreachable", "never_sent");
      }
      this.#injected.set(page.tabId, page.workKey);
      const collected = await this.#ports.collect(page.tabId).catch(() => null);
      if (!isRecord(collected)) return await fail("page_unreachable", "never_sent");
      record.story = storyFrom(collected, page.hostKind);
      if (collected.ok !== true) {
        return await fail(
          collected.error === "story_unavailable" ? "story_unavailable" : "page_unreachable",
          "never_sent",
        );
      }
      // The page's reply is checked exactly as a save it had sent itself.
      const command = storyTrackCommandFromMessage(
        { type: "TRACE_CONNECT_AND_SAVE", workKey: record.workKey, payload: collected.payload },
        { tab: { url: page.url }, url: page.url, frameId: 0 },
      );
      if (command === null || command.workKey !== record.workKey) {
        return await fail("page_unreachable", "never_sent");
      }
      // The account changed while the page was read: nothing is sent for it.
      if (this.#ports.binding() !== record.binding) {
        record.running = false;
        this.#accountChanged(record);
        return;
      }

      const mode = storySaveModeAtAdmission({
        injectedForFirstTap: true,
        grantComplete: grantAtStart,
        registered: null,
      });
      const { result, dispatch } = await this.#ports.save(
        mode === null ? command : { ...command, mode },
        {
          // Written down before the write goes out, so that a background put
          // to sleep mid-save is known afterwards to have a write in doubt.
          beforeWrite: async () => {
            record.inDoubt = true;
            await this.#persist(record);
          },
        },
      );
      if (result.kind === "confirmed") {
        record.running = false;
        const provenance: FirstTapProvenance = result.source === "mutation"
          ? "saved_now"
          : result.source === "preflight" && record.priorKnown && !earlierInDoubt && !record.pageSave
            ? "already"
            : "found";
        await this.#settle(record, {
          kind: "confirmed", provenance, mode, entry: entryFrom(result.confirmation),
        });
        return;
      }
      const reason: FirstTapFailure =
        result.reason === "free_limit_reached" || result.reason === "rate_limited"
          ? result.reason
          : result.reason === "not_authenticated" || result.reason === "auth_expired"
            ? "not_authenticated"
            : "unavailable";
      await fail(reason, dispatch === "confirmed" ? "sent_unconfirmed" : dispatch);
    } catch {
      // What became of the write is not known here, so it is not called unsent.
      await fail("unavailable", "sent_unconfirmed").catch(() => undefined);
    }
  }

  // The page shows its mark only for a confirmed story, and only once no
  // popup is open over it. Both read the same record.
  async #markIfDue(record: Record): Promise<void> {
    if (record.outcome?.kind !== "confirmed" || this.#ports.binding() !== record.binding) return;
    for (const tabId of record.tabs) {
      if (record.marked.has(tabId)) continue;
      if ([...this.#sheets.values()].some((sheet) => sheet.tabId === tabId)) continue;
      record.marked.add(tabId);
      await this.#ports.mark(tabId, record.workKey).catch(() => undefined);
    }
  }
}
