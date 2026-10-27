/**
 * Hands a whole AO3 History to Trace on the web for review, on a computer.
 *
 * The iPhone hands it to the app through a paired inbox
 * (native-history-handoff.mts). A computer has no app: Review in Trace opens
 * Trace's History review in a new tab, and that page asks for the History a
 * part at a time through the bridge the extension already runs on Trace's
 * own pages (sync.js). The parts are the iPhone's (`historyParts`), so both
 * reviews read the same items. The History stays in this browser: nothing
 * is sent to Trace's server until the reader imports.
 *
 * One handoff at a time. A background can stop at any moment (an idle
 * service worker), so the offer itself (its id, account, expiry, when it was
 * read and the digest of the whole) is kept in session storage, and the parts
 * are made again from the History store when they are next asked for; parts
 * made again from other works than were offered are never given out. A part
 * is given only to a Trace page, only while the account that started it is
 * still the one signed in, and only before it expires or is received.
 */

import type { HistoryParts } from "./native-history-handoff.mjs";

export const WEB_HISTORY_LIFETIME_MS = 1_800_000;
/** The page's request for the declaration or one part (sync.js forwards it). */
export const WEB_HISTORY_REQUEST = "TRACE_WEB_HISTORY_REQUEST";
/** The page saying it has kept every part: the handoff is spent. */
export const WEB_HISTORY_RECEIVED = "TRACE_WEB_HISTORY_RECEIVED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEEP_KEY = "traceWebHistoryOfferV1";

export type WebHistoryOffer =
  | { readonly ok: true; readonly state: "opened_on_web"; readonly handoffID: string;
      readonly expiresAtMs: number; readonly url: string }
  | { readonly ok: false; readonly error: "history_handoff_unavailable" };

/** What the page is told. A part is its JSON text: `{s, at, items}`. */
export type WebHistoryAnswer =
  | { readonly ok: true; readonly kind: "declaration"; readonly handoffID: string; readonly accountId: string;
      readonly partCount: number; readonly byteCount: number; readonly itemCount: number;
      readonly sha256: string; readonly expiresAtMs: number }
  | { readonly ok: true; readonly kind: "part"; readonly handoffID: string; readonly partIndex: number;
      readonly text: string }
  | { readonly ok: true; readonly kind: "received" }
  | { readonly ok: false; readonly error: "history_handoff_unknown" | "history_handoff_expired" |
      "history_handoff_account_changed" | "history_handoff_not_connected" | "history_handoff_bad_request" };

/** Where the offer is kept across a background restart (storage.session). */
export interface WebHistoryKeep {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

type OfferRecord = {
  readonly v: 1;
  readonly handoffID: string;
  readonly accountId: string;
  readonly expiresAtMs: number;
  readonly capturedAt: string;
  readonly sha256: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function offerRecord(value: unknown): OfferRecord | null {
  if (!record(value) || value.v !== 1 || typeof value.handoffID !== "string" || !UUID.test(value.handoffID) ||
      typeof value.accountId !== "string" || !value.accountId || typeof value.capturedAt !== "string" ||
      typeof value.sha256 !== "string" || typeof value.expiresAtMs !== "number" ||
      !Number.isSafeInteger(value.expiresAtMs)) return null;
  return value as unknown as OfferRecord;
}

/** When the parts were read: the `at` every part carries. */
function capturedAtOf(history: HistoryParts): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(history.parts[0]));
    return record(parsed) && typeof parsed.at === "string" ? parsed.at : null;
  } catch {
    return null;
  }
}

export class WebHistoryHandoff {
  readonly #webOrigin: string;
  readonly #randomID: () => string;
  readonly #now: () => number;
  readonly #keep: WebHistoryKeep | null;
  /** Makes the parts again from the History store, for when they were read. */
  #source: ((capturedAt: string) => Promise<HistoryParts | null>) | null = null;
  #offered: OfferRecord | null = null;
  #parts: HistoryParts | null = null;
  #loaded = false;

  constructor(options: { webOrigin: string; randomID: () => string; now?: () => number; keep?: WebHistoryKeep }) {
    this.#webOrigin = new URL(options.webOrigin).origin;
    this.#randomID = options.randomID;
    this.#now = options.now ?? Date.now;
    this.#keep = options.keep ?? null;
  }

  /** The History store the parts are made from, after a restart. */
  useSource(source: (capturedAt: string) => Promise<HistoryParts | null>): void {
    this.#source = source;
  }

  /** The review page for a handoff. The id rides in the fragment, never to a server. */
  reviewUrl(handoffID: string): string {
    return `${this.#webOrigin}/import/history#handoff=${handoffID}`;
  }

  /** Makes `history` the one History on offer, for `accountId`, replacing any earlier one. */
  async offer(accountId: string, history: HistoryParts): Promise<WebHistoryOffer> {
    const handoffID = this.#randomID();
    const now = this.#now();
    const capturedAt = history.parts.length ? capturedAtOf(history) : null;
    if (!accountId || !UUID.test(handoffID) || !Number.isSafeInteger(now) || capturedAt === null) {
      return Object.freeze({ ok: false, error: "history_handoff_unavailable" });
    }
    const offered: OfferRecord = { v: 1, handoffID, accountId, expiresAtMs: now + WEB_HISTORY_LIFETIME_MS,
      capturedAt, sha256: history.sha256 };
    this.#offered = offered;
    this.#parts = history;
    this.#loaded = true;
    await this.#keep?.save(offered).catch(() => undefined);
    return Object.freeze({ ok: true, state: "opened_on_web", handoffID, expiresAtMs: offered.expiresAtMs,
      url: this.reviewUrl(handoffID) });
  }

  /** Forgets the History on offer (its account left, or the reader deleted it). */
  async discard(): Promise<void> {
    this.#offered = null;
    this.#parts = null;
    this.#loaded = true;
    await this.#keep?.clear().catch(() => undefined);
  }

  /**
   * Answers a Trace page's request. `currentAccountId` is the account signed
   * in to the extension now, or null while it isn't connected; a History
   * started by another account is never given out.
   */
  async answer(message: unknown, currentAccountId: string | null): Promise<WebHistoryAnswer> {
    if (!record(message) || typeof message.handoffID !== "string" || !UUID.test(message.handoffID)) {
      return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
    }
    if (!this.#loaded) {
      this.#loaded = true;
      this.#offered = offerRecord(await this.#keep?.load().catch(() => null));
    }
    const offered = this.#offered;
    if (offered === null || offered.handoffID !== message.handoffID) {
      return Object.freeze({ ok: false, error: "history_handoff_unknown" });
    }
    if (this.#now() >= offered.expiresAtMs) {
      await this.discard();
      return Object.freeze({ ok: false, error: "history_handoff_expired" });
    }
    if (currentAccountId === null) return Object.freeze({ ok: false, error: "history_handoff_not_connected" });
    if (currentAccountId !== offered.accountId) {
      return Object.freeze({ ok: false, error: "history_handoff_account_changed" });
    }
    if (message.type === WEB_HISTORY_RECEIVED) {
      await this.discard();
      return Object.freeze({ ok: true, kind: "received" });
    }
    if (message.type !== WEB_HISTORY_REQUEST) return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
    const history = await this.#history(offered);
    if (history === null) return Object.freeze({ ok: false, error: "history_handoff_unknown" });
    if (message.part === "declaration") {
      return Object.freeze({
        ok: true, kind: "declaration", handoffID: offered.handoffID, accountId: offered.accountId,
        partCount: history.parts.length, byteCount: history.byteCount, itemCount: history.itemCount,
        sha256: history.sha256, expiresAtMs: offered.expiresAtMs,
      });
    }
    const partIndex = message.part;
    if (typeof partIndex !== "number" || !Number.isSafeInteger(partIndex) || partIndex < 0 ||
        partIndex >= history.parts.length) {
      return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
    }
    return Object.freeze({
      ok: true, kind: "part", handoffID: offered.handoffID, partIndex,
      text: new TextDecoder().decode(history.parts[partIndex]),
    });
  }

  /** The parts on offer, made again after a restart; null when the works have changed since. */
  async #history(offered: OfferRecord): Promise<HistoryParts | null> {
    if (this.#parts !== null) return this.#parts;
    const rebuilt = await this.#source?.(offered.capturedAt).catch(() => null) ?? null;
    if (rebuilt === null || rebuilt.sha256 !== offered.sha256) return null;
    this.#parts = rebuilt;
    return rebuilt;
  }
}

/** Keeps the offer in `storage.session` (memory the browser clears when it quits). */
export function sessionKeep(area: { get(key: string): Promise<Record<string, unknown>>;
  set(patch: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> }): WebHistoryKeep {
  return {
    load: async () => (await area.get(KEEP_KEY))[KEEP_KEY] ?? null,
    save: (value) => area.set({ [KEEP_KEY]: value }),
    clear: () => area.remove(KEEP_KEY),
  };
}
