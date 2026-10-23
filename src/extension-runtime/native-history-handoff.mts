/**
 * Hands a whole AO3 History to the Trace app for review, through the paired
 * native History inbox (Shared (Extension)/TraceSafariHistoryInbox.swift).
 *
 * The import handoff (native-import.mts) carries one page, 250 works at most.
 * A History can hold thousands, so it goes in parts: PREPARE declares the
 * part count, bytes, works and SHA-256 of the whole; each STAGE carries one
 * part, a bounded JSON document of its own; the inbox is ready to open only
 * when every part is in and they add up to the declaration. A failed or stale
 * run cancels its own reservation. Nothing here reads a credential: the
 * controller supplies the account scope and its currency check, as it does
 * for the import handoff.
 */

import type { RuntimePort } from "./browser-platform.mjs";
import { sendNativeMessageWithFallback } from "./browser-adapters.mjs";
import type { HistoryWork } from "./ao3-history-page.mjs";

export const HISTORY_SOURCE = "ao3-history";
/** What the inbox accepts, as its PREPARE acknowledgement declares. */
export const HISTORY_MAXIMUM_PART_BYTES = 393_216;
export const HISTORY_MAXIMUM_PARTS = 128;
export const HISTORY_MAXIMUM_ITEMS = 25_000;
export const HISTORY_MAXIMUM_PART_ITEMS = 1_000;
const HISTORY_LIFETIME_MS = 1_800_000;
const REQUEST_ADMISSION_MS = 600_000;
const MESSAGE_ATTEMPT_MS = 2_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One History work as an Import item: a listing row with its History fields. */
export function historyImportItem(work: HistoryWork): Record<string, unknown> {
  const item: Record<string, unknown> = {
    src: "ao3",
    ctx: "listing",
    u: `https://archiveofourown.org/works/${work.id}`,
    t: work.title,
  };
  if (work.authors[0]) item.a = work.authors[0];
  if (work.fandoms.length) item.fms = [...work.fandoms];
  if (work.tags.length) item.tags = [...work.tags];
  if (work.summary) item.sm = work.summary;
  if (work.words !== null) item.w = work.words;
  const chapters = /^(\d+)\/(\d+|\?)$/.exec(work.chapters ?? "");
  if (chapters) {
    const published = Number(chapters[1]);
    item.chPub = published;
    item.cht = chapters[2] === "?" ? "?" : Number(chapters[2]);
    item.s = chapters[2] !== "?" && Number(chapters[2]) === published ? "complete" : "wip";
  }
  if (work.later) item.ml = true;
  else {
    if (work.lastVisited !== null) item.lv = work.lastVisited;
    if (work.visits !== null) item.vc = work.visits;
  }
  return item;
}

export interface HistoryParts {
  readonly parts: readonly Uint8Array[];
  readonly byteCount: number;
  readonly itemCount: number;
  readonly sha256: string;
}

/**
 * The History as parts, newest visit first, each `{s,at,items}` of at most
 * `HISTORY_MAXIMUM_PART_BYTES` and `HISTORY_MAXIMUM_PART_ITEMS`. Null when
 * there is nothing to hand over or it is past what the inbox takes.
 */
export async function historyParts(
  works: readonly HistoryWork[],
  capturedAt: string,
  digest: (bytes: Uint8Array) => Promise<string> = sha256Hex,
): Promise<HistoryParts | null> {
  if (works.length === 0 || works.length > HISTORY_MAXIMUM_ITEMS) return null;
  const ordered = [...works].sort((a, b) =>
    (b.lastVisited ?? "").localeCompare(a.lastVisited ?? "") || Number(b.id) - Number(a.id));
  const encoder = new TextEncoder();
  const encode = (items: readonly string[]) =>
    encoder.encode(`{"s":${JSON.stringify(HISTORY_SOURCE)},"at":${JSON.stringify(capturedAt)},"items":[${items.join(",")}]}`);
  // A part's size is its envelope and its items with the commas between, so
  // each work is encoded once.
  const envelope = encode([]).byteLength;
  const parts: Uint8Array[] = [];
  let current: string[] = [];
  let currentBytes = envelope;
  for (const work of ordered) {
    const item = JSON.stringify(historyImportItem(work));
    const itemBytes = encoder.encode(item).byteLength;
    // A single work too large for a part on its own is past any real History.
    if (envelope + itemBytes > HISTORY_MAXIMUM_PART_BYTES) return null;
    const withItem = currentBytes + itemBytes + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (withItem > HISTORY_MAXIMUM_PART_BYTES || current.length >= HISTORY_MAXIMUM_PART_ITEMS)) {
      parts.push(encode(current));
      current = [item];
      currentBytes = envelope + itemBytes;
    } else {
      current.push(item);
      currentBytes = withItem;
    }
  }
  if (current.length > 0) parts.push(encode(current));
  if (parts.length > HISTORY_MAXIMUM_PARTS) return null;
  const byteCount = parts.reduce((total, part) => total + part.byteLength, 0);
  const whole = new Uint8Array(byteCount);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return { parts, byteCount, itemCount: ordered.length, sha256: await digest(whole) };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export type HistoryHandoffResult =
  | { readonly ok: true; readonly state: "ready_to_open"; readonly handoffID: string; readonly expiresAtMs: number }
  | { readonly ok: false; readonly error: "history_handoff_unavailable" };

const failure = (): HistoryHandoffResult => Object.freeze({ ok: false, error: "history_handoff_unavailable" });

type Reservation = {
  readonly requestID: string;
  readonly issued: number;
  handoffID: string | null;
  expiresAtMs: number;
};

/** Only the controller constructs this producer, for the admitted sheet. */
export class NativeHistoryHandoffProducer {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";
  readonly #apiOrigin: string;
  readonly #randomID: () => string;
  readonly #now: () => number;
  #active = false;
  /** The last History staged, until another run or its discard. */
  #staged: Reservation | null = null;

  constructor(options: { runtime: RuntimePort; mode: "callback" | "promise";
    apiOrigin: string; randomID: () => string; now?: () => number }) {
    this.#runtime = options.runtime;
    this.#mode = options.mode;
    this.#apiOrigin = new URL(options.apiOrigin).origin;
    this.#randomID = options.randomID;
    this.#now = options.now ?? Date.now;
  }

  /** Cancels the History last staged, when its account left before it was published. */
  async discardUnpublished(): Promise<void> {
    const staged = this.#staged;
    this.#staged = null;
    if (staged?.handoffID) {
      await this.#send({ type: "TRACE_IOS_HISTORY_CANCEL", protocolVersion: 1,
        requestID: staged.requestID, handoffID: staged.handoffID }).catch(() => null);
    }
  }

  async run(
    scope: Readonly<{ accountId: string; epoch: number }>,
    isCurrent: () => Promise<boolean>,
    history: HistoryParts,
  ): Promise<HistoryHandoffResult> {
    if (this.#active) return failure();
    this.#active = true;
    let reservation: Reservation | null = null;
    let staged = false;
    try {
      if (!scope.accountId || new TextEncoder().encode(scope.accountId).length > 256 ||
          !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || !(await isCurrent())) return failure();
      const requestID = this.#randomID();
      const issued = this.#now();
      if (!UUID.test(requestID) || !Number.isSafeInteger(issued)) return failure();
      const pending: Reservation = { requestID, issued, handoffID: null, expiresAtMs: issued + REQUEST_ADMISSION_MS + HISTORY_LIFETIME_MS };
      reservation = pending;
      const prepared = await this.#send({
        type: "TRACE_IOS_HISTORY_PREPARE", protocolVersion: 1, requestID, requestIssuedAtMs: issued,
        accountID: scope.accountId, accountEpoch: scope.epoch, apiOrigin: this.#apiOrigin,
        partCount: history.parts.length, byteCount: history.byteCount, itemCount: history.itemCount,
        sha256: history.sha256,
      }, async () => await isCurrent() && this.#now() < issued + REQUEST_ADMISSION_MS);
      if (!record(prepared) || prepared.type !== "TRACE_IOS_HISTORY_PREPARE" || prepared.protocolVersion !== 1 ||
          prepared.ok !== true || prepared.state !== "prepared" ||
          typeof prepared.handoffID !== "string" || !UUID.test(prepared.handoffID) ||
          typeof prepared.expiresAtMs !== "number" || !Number.isSafeInteger(prepared.expiresAtMs) ||
          prepared.expiresAtMs > pending.expiresAtMs ||
          prepared.maximumPartBytes !== HISTORY_MAXIMUM_PART_BYTES || prepared.maximumParts !== HISTORY_MAXIMUM_PARTS ||
          prepared.maximumItems !== HISTORY_MAXIMUM_ITEMS) return failure();
      pending.handoffID = prepared.handoffID;
      pending.expiresAtMs = prepared.expiresAtMs;
      const handoffID = prepared.handoffID;
      const current = async () => await isCurrent() && this.#now() < pending.expiresAtMs;
      let ready: unknown = null;
      for (const [partIndex, part] of history.parts.entries()) {
        if (!(await current())) return failure();
        ready = await this.#send({ type: "TRACE_IOS_HISTORY_STAGE", protocolVersion: 1, requestID, handoffID,
          partIndex, partBase64: base64(part) }, current);
        const last = partIndex === history.parts.length - 1;
        if (!record(ready) || ready.type !== "TRACE_IOS_HISTORY_STAGE" || ready.protocolVersion !== 1 ||
            ready.ok !== true || ready.handoffID !== handoffID || ready.expiresAtMs !== pending.expiresAtMs ||
            ready.state !== (last ? "ready_to_open" : "staging")) return failure();
      }
      if (!(await current())) return failure();
      staged = true;
      this.#staged = pending;
      return Object.freeze({ ok: true, state: "ready_to_open", handoffID, expiresAtMs: pending.expiresAtMs });
    } catch {
      return failure();
    } finally {
      if (!staged && reservation?.handoffID) {
        await this.#send({ type: "TRACE_IOS_HISTORY_CANCEL", protocolVersion: 1,
          requestID: reservation.requestID, handoffID: reservation.handoffID }).catch(() => null);
      }
      this.#active = false;
    }
  }

  async #send(message: Readonly<Record<string, unknown>>,
    isCurrent: () => Promise<boolean> = async () => true): Promise<unknown | null> {
    // Two bounded attempts with the same identity and bytes; a part sent
    // twice is accepted once by the inbox.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await isCurrent())) return null;
      const response = await sendNativeMessageWithFallback(this.#runtime, this.#mode, message, MESSAGE_ATTEMPT_MS,
        { mayFallback: isCurrent });
      if (response !== null) return response;
    }
    return null;
  }
}
