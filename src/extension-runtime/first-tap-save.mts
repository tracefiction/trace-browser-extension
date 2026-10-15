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
import type { StoryMembership } from "./story-membership.mjs";

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
/** Page to background, from a page in manual mode: are the story sites allowed yet? */
export const FIRST_TAP_MANUAL_MODE_QUERY_MESSAGE = "TRACE_PAGE_MANUAL_MODE_QUERY";
export const FIRST_TAP_STORE_KEY = "traceFirstTapSaveV2";
/** How long a finished result is shown again to a popup reopened on the page. */
export const FIRST_TAP_RESULT_FRESH_MS = 10 * 60 * 1_000;
/** How long a settled record is kept, and how many records at most. */
export const FIRST_TAP_RECORD_TTL_MS = 24 * 60 * 60 * 1_000;
export const FIRST_TAP_RECORD_LIMIT = 20;
/**
 * How long a doubt that can no longer be placed on a story or an account
 * holds. While it does, no story found on this install is "already there".
 * It is not kept for good: one save cut off in a private tab would otherwise
 * cost every account on the install that word for ever.
 */
export const FIRST_TAP_UNPLACED_DOUBT_TTL_MS = 2_592_000_000; // thirty days
/**
 * How long an open that saves nothing waits on reading the page and asking
 * Trace whether the story is in the Library, before it offers the save
 * without them.
 */
export const FIRST_TAP_OPEN_READ_MS = 2_500;

/** What `work` comes to, or `fallback` if it fails or takes longer than `ms`. */
function within<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

export type FirstTapAccount =
  /**
   * `binding` is the account's session and changes when it signs in again.
   * `owner` is the account itself, the same across its sessions. It is used
   * only inside a digest salted for this install, and is never kept or shown.
   */
  | Readonly<{ state: "verified"; binding: string; owner: string }>
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

/**
 * What is known of a failed save's write. `never_sent` is the only value that
 * supports "nothing was sent". `not_in_library` is a write that was handed
 * over and never answered, followed by Trace's own word, asked for by the
 * reader, that the story is not in the Library.
 */
export type FirstTapDispatch = "never_sent" | "refused" | "sent_unconfirmed" | "not_in_library";

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
  /**
   * Nothing is saved until the reader asks: automatic saving is off or
   * unreadable, or it is on and this build saves only when asked. `story` is
   * what the page said of itself when read for the sheet to name it.
   */
  | Readonly<{
      state: "awaiting_request";
      workKey: string;
      preference: "on" | "off" | "unknown";
      story: FirstTapStory | null;
    }>
  /** `story` is what the page said of itself, once this attempt has read it. */
  | Readonly<{ state: "saving"; workKey: string; startedAt: number; story: FirstTapStory | null }>
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
      dispatch: FirstTapDispatch;
      story: FirstTapStory | null;
    }>
  /** A read-only look found nothing it could rely on. Never "not saved". */
  | Readonly<{ state: "presence_unknown"; workKey: string }>;

/**
 * The tab the reader opened Trace on, as the popup read it in that tap. The
 * background looks no tab up for itself: the page it then reaches under the
 * tap's own access has to name the same story, or nothing is sent.
 */
export type FirstTapTapped = Readonly<{
  tabId: number;
  url: string;
  /** Whether the tab is a private one; null when the browser did not say. */
  private: boolean | null;
}>;

type Settled =
  | Readonly<{ kind: "confirmed"; provenance: FirstTapProvenance; mode: StorySaveMode | null; entry: FirstTapEntry }>
  | Readonly<{ kind: "failed"; reason: FirstTapFailure; dispatch: FirstTapDispatch }>;
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
  /**
   * A digest of the account itself and the story, salted for this install.
   * Unlike `key`, it is the same when the account signs in again.
   */
  readonly work: string;
  /** False for a private tab: nothing about it is written to storage. */
  persist: boolean;
  /** Counted in the store as a write out for which no record is kept. */
  unkept: boolean;
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
  /**
   * The opens of this record that are still being worked out, one after
   * another: whether a save is under way is read and set with nothing let in
   * between, so two opens that arrive together start one save.
   */
  deciding: Promise<void>;
  /** The look now asking Trace about this story, if one is: a second joins it. */
  checking: Promise<FirstTapView> | null;
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
  /** While in doubt only: a digest of the account itself and the story. */
  w?: string;
}>;
type Stored = {
  salt: string;
  /** Account sessions for which a record still in doubt had to be dropped. */
  forgot: string[];
  records: StoredRecord[];
  /**
   * Writes still in doubt, made under an account session that has since
   * ended: one digest each, of the account itself and the story. The same
   * account may sign in again, and then that story found in its Library is
   * never "already". Only that account confirming the story clears one;
   * another account's save of the same story has a different digest.
   */
  doubts: string[];
  /**
   * Writes handed to the network for which no record is kept (a private tab)
   * and whose answer has not come, and when the last went out. It names
   * nothing. One left over by a background that has gone is a write of unknown
   * fate that nothing here can place any more.
   */
  unkept: number;
  unkeptAt: number | null;
  /**
   * When a doubt was last lost that can no longer be placed on a story or an
   * account. It holds for `FIRST_TAP_UNPLACED_DOUBT_TTL_MS`.
   */
  unplacedAt: number | null;
};

export interface FirstTapPorts {
  /**
   * Whether opening Trace on a story saves it without a further tap. When
   * false, an open only offers the save and the reader's own tap makes it.
   */
  readonly saveOnOpen: boolean;
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
  /**
   * Asks Trace whether this one story is in the account's Library. Made once
   * for each time the reader asks, and never answered from a kept copy.
   */
  membership(workKey: string): Promise<StoryMembership>;
  /** Asks the page to show its mark for a confirmed story. Best effort. */
  mark(tabId: number, workKey: string): Promise<void>;
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

const isTapped = (value: unknown): value is FirstTapTapped =>
  isRecord(value) && Number.isInteger(value.tabId) && typeof value.url === "string" &&
  (value.private === null || typeof value.private === "boolean");

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
      ["never_sent", "refused", "sent_unconfirmed", "not_in_library"].includes(String(value.dispatch))) {
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
      ...(typeof item.w === "string" ? { w: item.w } : {}),
    });
  }
  const strings = (list: unknown): string[] =>
    (Array.isArray(list) ? list : []).filter((item): item is string => typeof item === "string");
  return {
    salt: value.salt,
    forgot: strings(value.forgot),
    records,
    doubts: strings(value.doubts),
    unkept: Number.isInteger(value.unkept) && (value.unkept as number) > 0 ? value.unkept as number : 0,
    unkeptAt: typeof value.unkeptAt === "number" ? value.unkeptAt : null,
    unplacedAt: typeof value.unplacedAt === "number" ? value.unplacedAt : null,
  };
}

function emptyStore(salt: string): Stored {
  return { salt, forgot: [], records: [], doubts: [], unkept: 0, unkeptAt: null, unplacedAt: null };
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

  /** Tabs whose page script this background injected, while it has been awake. */
  injectedTabs(): readonly number[] {
    return [...this.#injected.keys()];
  }

  /**
   * The reader opened Trace on `tapped`. Returns what is known now; later
   * changes to the same record reach `listener` until `closed` is called.
   */
  async opened(
    listener: Listener,
    tapped: FirstTapTapped,
    options: { readonly requested?: boolean } = {},
  ): Promise<FirstTapView> {
    const page = this.#storyPage(tapped);
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

    const record = await this.#recordFor(account, page);
    // The popup may have closed while this was being worked out.
    if (this.#sheets.get(listener) === sheet) sheet.key = record.key;
    // One open at a time for an account and story. What follows reads
    // whether a save is under way, waits on the Library and the preference,
    // and only then starts one; a second open let in between those would
    // start a second save.
    const decided = record.deciding.then(() => this.#decide(record, page, grant, options));
    record.deciding = decided.then(() => undefined, () => undefined);
    return decided;
  }

  /** What an open comes to, worked out with no other open of the record under way. */
  async #decide(
    record: Record,
    page: StoryPage,
    grant: boolean | null,
    options: { readonly requested?: boolean },
  ): Promise<FirstTapView> {
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
      if (preference !== "on" || this.#ports.saveOnOpen !== true) {
        // With an earlier write in doubt, "save this story" is not offered:
        // it may have landed. The reader can look again, or choose to retry.
        if (record.inDoubt) {
          return Object.freeze({
            state: "failed", workKey: page.workKey, reason: "unavailable",
            dispatch: "sent_unconfirmed", story: record.story,
          });
        }
        // Nothing is saved on this open. The page is read so that the sheet
        // can name its story, and, unless automatic saving is off, Trace is
        // asked, read only, whether the story is in the Library already: a
        // story that is is shown as it is, never offered to be saved again.
        const [found] = await Promise.all([
          preference === "off" ? Promise.resolve(null) : within(this.#look(record), FIRST_TAP_OPEN_READ_MS, null),
          within(this.#readForSheet(record, page), FIRST_TAP_OPEN_READ_MS, undefined),
        ]);
        if (found === "account_changed") return this.#accountChanged(record);
        if (found !== null) {
          this.#begin(record, page);
          // Found before anything was sent: there before this open, where
          // what came before is known well enough to say so.
          return this.#settle(record, {
            kind: "confirmed", provenance: record.priorKnown && !record.pageSave ? "already" : "found",
            mode: null, entry: found,
          });
        }
        return Object.freeze({ state: "awaiting_request", workKey: page.workKey, preference, story: record.story });
      }
    }

    this.#begin(record, page);
    record.running = true;
    record.outcome = Object.freeze({ kind: "saving", startedAt: this.#ports.now() });
    void this.#run(record, page, grant);
    return this.#view(record);
  }

  /**
   * "Check again": asks Trace, once, whether this one story is in the
   * account's Library. It has no path to a save. A story Trace has improves
   * the record. One Trace says it does not have is said to be absent only
   * when no save of it is still out. A request that could not be made or
   * read, or that Trace turned away, leaves the story's place not known.
   * A look asked for while one is still out joins it: one request, one answer.
   */
  async check(listener: Listener): Promise<FirstTapView> {
    const sheet = this.#sheets.get(listener);
    if (!sheet || sheet.workKey === null) return Object.freeze({ state: "not_applicable" });
    const unknown: FirstTapView = Object.freeze({ state: "presence_unknown", workKey: sheet.workKey });
    const record = sheet.key === null ? null : this.#records.get(sheet.key) ?? null;
    if (record === null || record.binding !== this.#ports.binding()) return unknown;
    // A confirmation is never taken back by a later look.
    if (record.outcome?.kind === "confirmed") return this.#view(record);
    if (record.checking !== null) return record.checking;
    const asking = this.#askTrace(record, unknown);
    record.checking = asking;
    const done = (): void => {
      if (record.checking === asking) record.checking = null;
    };
    void asking.then(done, done);
    return asking;
  }

  async #askTrace(record: Record, unknown: FirstTapView): Promise<FirstTapView> {
    // The same key the save itself was made under.
    const membership = await this.#ports.membership(record.workKey).catch(
      (): StoryMembership => ({ kind: "unknown" }),
    );
    if (membership.kind === "account_refused") {
      return Object.freeze({ state: "account_reconnect_required", workKey: record.workKey });
    }
    if (this.#ports.binding() !== record.binding) return this.#accountChanged(record);
    if (membership.kind === "present") {
      return this.#settle(record, {
        kind: "confirmed", provenance: "found", mode: null,
        entry: Object.freeze({ ...membership.entry, chapters: null }),
      });
    }
    if (membership.kind !== "absent") return unknown;
    // Not in the Library, on Trace's own word. A save still out may yet put
    // it there, so that wait goes on as it was.
    if (record.running) return this.#view(record);
    // The write that went unanswered stays in doubt all the same: an answer
    // that is on its way could still land after this one, and a story found
    // later must not then be called "already there".
    return this.#settle(record, { kind: "failed", reason: "unavailable", dispatch: "not_in_library" });
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

  #storyPage(tapped: FirstTapTapped): StoryPage | null {
    if (!isTapped(tapped)) return null;
    const hostKind = archiveHostKindFromSender({ url: tapped.url });
    if (hostKind === null || isBlockedArchivePath(tapped.url, hostKind)) return null;
    const workKey = workKeyFromArchiveUrl(tapped.url, hostKind);
    // Kept only for a tab known to be an ordinary one. Where the browser did
    // not say, the tab is treated as private and nothing about it is written.
    return workKey === null
      ? null
      : { tabId: tapped.tabId, workKey, url: tapped.url, hostKind, persist: tapped.private === false };
  }

  // --- Records ----------------------------------------------------------------

  #loadStore(): Promise<{ stored: Stored; readable: boolean }> {
    this.#store ??= this.#ports.readStore().then(
      async (value) => {
        const stored = storedFrom(value) ?? emptyStore(this.#ports.randomSalt());
        // A write counted by a background that has gone: it went out from a
        // tab nothing is kept for, and its answer was never recorded. Which
        // story and which account it was for cannot be recovered, so for a
        // while from when it went out nothing found is "already" here.
        if (stored.unkept > 0) {
          this.#unplaced(stored, stored.unkeptAt ?? this.#ports.now());
          stored.unkept = 0;
          stored.unkeptAt = null;
          await this.#write(stored);
        }
        return { stored, readable: true };
      },
      // Storage could not be read. A salt for this worker's life still keeps
      // records apart; nothing is kept, and nothing earlier is known.
      () => ({ stored: emptyStore(this.#ports.randomSalt()), readable: false }),
    );
    return this.#store;
  }

  /** The record for this account and story, from memory, storage, or new. */
  async #recordFor(
    { binding, owner }: Readonly<{ binding: string; owner: string }>,
    page: StoryPage,
  ): Promise<Record> {
    const { stored, readable } = await this.#loadStore();
    const scope = await this.#ports.digest(`${stored.salt}\u0000account\u0000${binding}`);
    const key = await this.#ports.digest(`${stored.salt}\u0000story\u0000${binding}\u0000${page.workKey}`);
    const work = await this.#ports.digest(`${stored.salt}\u0000work\u0000${owner}\u0000${page.workKey}`);

    // Another account's records are discarded as soon as the change is seen.
    // What they could say of a story is discarded with them; a doubt is not.
    // "Another account" here is another session, and the same reader may have
    // signed out and in again: a write of theirs whose fate is not known may
    // be why a story is in the Library now. So a record in doubt leaves a
    // digest of its account and story behind, which no other account's save
    // can match or clear, and a doubt that cannot be placed that way is
    // carried, for a while, as one about every story.
    let changed = false;
    for (const [otherKey, other] of this.#records) {
      if (other.binding === binding) continue;
      if (other.inDoubt && this.#carryDoubt(stored, other)) changed = true;
      if (!other.running) this.#records.delete(otherKey);
    }
    for (const item of stored.records) {
      if (item.s === scope) continue;
      changed = true;
      if (item.inDoubt) this.#carryDoubt(stored, { persist: true, work: item.w });
    }
    if (stored.forgot.some((item) => item !== scope)) {
      changed = true;
      this.#carryDoubt(stored, { persist: false, work: undefined });
    }
    if (changed) {
      stored.records = stored.records.filter((item) => item.s === scope);
      stored.forgot = stored.forgot.filter((item) => item === scope);
      if (readable) await this.#write(stored);
    }

    // "Already" needs the whole of what came before: records that are kept
    // (not a private tab), that could be read, none dropped in doubt, and no
    // write in doubt for this story left by a session that has ended.
    const priorKnown = page.persist && readable &&
      !stored.forgot.includes(scope) && !this.#unplacedHolds(stored) &&
      !stored.doubts.includes(work);
    const existing = this.#records.get(key);
    if (existing) {
      existing.persist = existing.persist && page.persist;
      existing.priorKnown = existing.priorKnown && priorKnown;
      return existing;
    }
    const kept = page.persist ? stored.records.find((item) => item.k === key) : undefined;
    const record: Record = {
      key, scope, binding, workKey: page.workKey, work, persist: page.persist, unkept: false,
      at: kept?.at ?? this.#ports.now(),
      outcome: kept?.outcome ?? null,
      inDoubt: kept?.inDoubt === true,
      pageSave: false,
      priorKnown,
      running: false,
      deciding: Promise.resolve(),
      checking: null,
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
        story: record.story,
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
      await this.#doubtSettled(record);
    }
    await this.#persist(record);
    const view = this.#show(record);
    await this.#markIfDue(record);
    return view;
  }

  /** Tells every popup open on a record what it now says. */
  #show(record: Record): FirstTapView {
    const view = this.#view(record);
    for (const [listener, sheet] of this.#sheets) {
      if (sheet.key !== record.key) continue;
      try { listener(view); } catch { /* A closed popup is told nothing. */ }
    }
    return view;
  }

  /**
   * Reads the story's page for the sheet to name it, under the access the
   * reader's tap gave the tab. Nothing is sent to Trace and nothing is kept:
   * the page's own word is believed only for the story the popup named.
   */
  async #readForSheet(record: Record, page: StoryPage): Promise<void> {
    if (!(await this.#ports.inject(page.tabId).catch(() => false))) return;
    this.#injected.set(page.tabId, page.workKey);
    const collected = await this.#ports.collect(page.tabId).catch(() => null);
    if (!isRecord(collected) || collected.ok !== true || collected.workKey !== record.workKey) return;
    if (collected.private === true && record.persist) {
      record.persist = false;
      record.priorKnown = false;
    }
    record.story = storyFrom(collected, page.hostKind);
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
      .then(() => this.#ports.writeStore({
        salt: stored.salt, forgot: [...stored.forgot], records: [...stored.records],
        doubts: [...stored.doubts], unkept: stored.unkept, unkeptAt: stored.unkeptAt,
        unplacedAt: stored.unplacedAt,
      }))
      .catch(() => undefined);
    return this.#writes;
  }

  /**
   * This story is confirmed in the Library for the account now signed in. A
   * doubt an ended session of this same account left about it has nothing
   * more to say. A doubt another account left about the same story has a
   * different digest and is not touched.
   */
  async #doubtSettled(record: Record): Promise<void> {
    const { stored, readable } = await this.#loadStore();
    if (!stored.doubts.includes(record.work)) return;
    stored.doubts = stored.doubts.filter((item) => item !== record.work);
    if (readable) await this.#write(stored);
  }

  /**
   * A record that is not kept still counts its write while that write is out
   * and unanswered. The count says nothing of the story, the tab or the
   * account; it is what lets a later background know something went missing.
   */
  async #countUnkept(record: Record): Promise<void> {
    if (record.unkept === record.inDoubt) return;
    const { stored, readable } = await this.#loadStore();
    if (!readable) return;
    record.unkept = record.inDoubt;
    stored.unkept = Math.max(0, stored.unkept + (record.inDoubt ? 1 : -1));
    if (record.inDoubt) stored.unkeptAt = this.#ports.now();
    await this.#write(stored);
  }

  /** Notes a doubt that can no longer be placed, as of `at` or later. */
  #unplaced(stored: Stored, at: number): void {
    stored.unplacedAt = Math.max(stored.unplacedAt ?? at, at);
  }

  /** Whether such a doubt still holds. A clock set back does not end it early. */
  #unplacedHolds(stored: Stored): boolean {
    return stored.unplacedAt !== null &&
      this.#ports.now() - stored.unplacedAt < FIRST_TAP_UNPLACED_DOUBT_TTL_MS;
  }

  async #drop(record: Record): Promise<void> {
    const { stored, readable } = await this.#loadStore();
    let changed = stored.records.some((item) => item.k === record.key);
    stored.records = stored.records.filter((item) => item.k !== record.key);
    // The write this record had out may still have landed.
    if (record.inDoubt && this.#carryDoubt(stored, record)) changed = true;
    if (changed && readable) await this.#write(stored);
  }

  /**
   * Keeps a doubt past the account session it arose under: by the digest of
   * its account and story where one may be kept, and otherwise, or past the
   * limit, as a doubt about every story that holds for a while.
   */
  #carryDoubt(stored: Stored, from: { readonly persist: boolean; readonly work: string | undefined }): boolean {
    // Nothing of a private tab's story is written, not even its digest.
    if (from.persist && from.work !== undefined) {
      if (stored.doubts.includes(from.work)) return false;
      stored.doubts.push(from.work);
      if (stored.doubts.length <= FIRST_TAP_RECORD_LIMIT) return true;
      stored.doubts = stored.doubts.slice(-FIRST_TAP_RECORD_LIMIT);
    }
    this.#unplaced(stored, this.#ports.now());
    return true;
  }

  /** Writes what a record now says. No work key, title, author or address. */
  async #persist(record: Record): Promise<void> {
    if (!record.persist) return this.#countUnkept(record);
    const { stored, readable } = await this.#loadStore();
    if (!readable) return;
    const now = this.#ports.now();
    const outcome = record.outcome === null || record.outcome.kind === "saving" ? null : record.outcome;
    let records = stored.records.filter((item) => item.k !== record.key);
    // Nothing settled and nothing in doubt is nothing worth keeping.
    if (outcome !== null || record.inDoubt) {
      records.push({
        k: record.key, s: record.scope, at: record.at, inDoubt: record.inDoubt, outcome,
        ...(record.inDoubt ? { w: record.work } : {}),
      });
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
      // The page reached under this tap names its own story. The address the
      // popup gave is believed only when the page agrees with it.
      if (collected.workKey !== record.workKey) return await fail("page_unreachable", "never_sent");
      // The page has named its story: a popup waiting on this save can show
      // the title instead of a stand-in for it.
      if (record.story.title !== null && record.outcome?.kind === "saving") this.#show(record);
      // The page's own word that it is private outranks a popup that said
      // otherwise or nothing: from here nothing about this story is kept.
      if (collected.private === true && record.persist) {
        record.persist = false;
        record.priorKnown = false;
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
