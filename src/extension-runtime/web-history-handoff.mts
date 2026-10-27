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
 * One handoff at a time, kept in memory for its lifetime. A part is given
 * only to a Trace page, only while the account that started it is still the
 * one signed in, and only before it expires; the page then keeps its own copy.
 */

import type { HistoryParts } from "./native-history-handoff.mjs";

export const WEB_HISTORY_LIFETIME_MS = 1_800_000;
/** The page's request for the declaration or one part (sync.js forwards it). */
export const WEB_HISTORY_REQUEST = "TRACE_WEB_HISTORY_REQUEST";
/** The page saying it has every part: the handoff is spent. */
export const WEB_HISTORY_RECEIVED = "TRACE_WEB_HISTORY_RECEIVED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      "history_handoff_account_changed" | "history_handoff_bad_request" };

type Offered = {
  readonly handoffID: string;
  readonly accountId: string;
  readonly expiresAtMs: number;
  readonly history: HistoryParts;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class WebHistoryHandoff {
  readonly #webOrigin: string;
  readonly #randomID: () => string;
  readonly #now: () => number;
  #offered: Offered | null = null;

  constructor(options: { webOrigin: string; randomID: () => string; now?: () => number }) {
    this.#webOrigin = new URL(options.webOrigin).origin;
    this.#randomID = options.randomID;
    this.#now = options.now ?? Date.now;
  }

  /** The review page for a handoff. The id rides in the fragment, never to a server. */
  reviewUrl(handoffID: string): string {
    return `${this.#webOrigin}/import/history#handoff=${handoffID}`;
  }

  /** Makes `history` the one History on offer, for `accountId`, replacing any earlier one. */
  offer(accountId: string, history: HistoryParts): WebHistoryOffer {
    const handoffID = this.#randomID();
    const now = this.#now();
    if (!accountId || !UUID.test(handoffID) || !Number.isSafeInteger(now) || history.parts.length === 0) {
      return Object.freeze({ ok: false, error: "history_handoff_unavailable" });
    }
    const expiresAtMs = now + WEB_HISTORY_LIFETIME_MS;
    this.#offered = { handoffID, accountId, expiresAtMs, history };
    return Object.freeze({ ok: true, state: "opened_on_web", handoffID, expiresAtMs, url: this.reviewUrl(handoffID) });
  }

  /** Forgets the History on offer (its account left, or the reader deleted it). */
  discard(): void {
    this.#offered = null;
  }

  /**
   * Answers a Trace page's request. `currentAccountId` is the account signed
   * in to the extension now; a History started by another is never given out.
   */
  answer(message: unknown, currentAccountId: string | null): WebHistoryAnswer {
    if (!record(message) || typeof message.handoffID !== "string" || !UUID.test(message.handoffID)) {
      return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
    }
    const offered = this.#offered;
    if (offered === null || offered.handoffID !== message.handoffID) {
      return Object.freeze({ ok: false, error: "history_handoff_unknown" });
    }
    if (this.#now() >= offered.expiresAtMs) {
      this.#offered = null;
      return Object.freeze({ ok: false, error: "history_handoff_expired" });
    }
    if (currentAccountId !== offered.accountId) {
      return Object.freeze({ ok: false, error: "history_handoff_account_changed" });
    }
    if (message.type === WEB_HISTORY_RECEIVED) {
      this.#offered = null;
      return Object.freeze({ ok: true, kind: "received" });
    }
    if (message.type !== WEB_HISTORY_REQUEST) return Object.freeze({ ok: false, error: "history_handoff_bad_request" });
    const { history } = offered;
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
}
