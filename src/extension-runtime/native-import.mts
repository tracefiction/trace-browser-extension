import type { RuntimePort } from "./browser-platform.mjs";
import { sendNativeMessageWithFallback } from "./browser-adapters.mjs";
import type { FirstStoryInitiationResult } from "./first-story-initiation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE_ATTEMPT_MS = 2_500;
const REQUEST_LIFETIME_MS = 600_000;
const failure = (): FirstStoryInitiationResult => Object.freeze({ ok: false, error: "native_import_unavailable" });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Reservation = {
  readonly prepare: Readonly<Record<string, unknown>>;
  readonly requestID: string;
  readonly issued: number;
  readonly isCurrent: () => Promise<boolean>;
  handoffID: string | null;
  expiresAtMs: number;
  abandoned: boolean;
  cancellation: Promise<void> | null;
};

/** Only the admitted private popup controller constructs this producer. No
 * content-supplied account, URL, provider or credential enters its messages. */
export class NativeLibraryImportProducer {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";
  readonly #apiOrigin: string;
  readonly #randomID: () => string;
  readonly #now: () => number;
  #active = false;
  #reservation: Reservation | null = null;
  constructor(options: { runtime: RuntimePort; mode: "callback" | "promise";
    apiOrigin: string; randomID: () => string; now?: () => number }) {
    this.#runtime = options.runtime;
    this.#mode = options.mode;
    this.#apiOrigin = new URL(options.apiOrigin).origin;
    this.#randomID = options.randomID;
    this.#now = options.now ?? Date.now;
  }

  async run(scope: Readonly<{ accountId: string; epoch: number }>,
    isCurrent: () => Promise<boolean>,
    collect: (stage: (payload: string) => Promise<FirstStoryInitiationResult>) => Promise<FirstStoryInitiationResult>,
  ): Promise<FirstStoryInitiationResult> {
    if (this.#active) return failure();
    this.#active = true;
    let reservation: Reservation | null = null;
    let staged = false;
    try {
      // Retain ambiguous PREPARE ownership across clicks. Recover only with its
      // original capability, then cancel before allocating another request ID.
      const previous = this.#reservation;
      if (previous !== null) {
        previous.abandoned = true;
        if (previous.handoffID === null) await this.#prepare(previous);
        await this.#cancel(previous);
        if (this.#reservation !== null) return failure();
      }
      if (!scope.accountId || new TextEncoder().encode(scope.accountId).length > 256 ||
          !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || !(await isCurrent())) return failure();
      const requestID = this.#randomID();
      const issued = this.#now();
      if (!UUID.test(requestID) || !Number.isSafeInteger(issued)) return failure();
      reservation = { requestID, issued, isCurrent, handoffID: null,
        // A request can first reach native just before its ten-minute admission
        // deadline; that reservation then has its own ten-minute lifetime.
        expiresAtMs: issued + 2 * REQUEST_LIFETIME_MS, abandoned: false, cancellation: null,
        prepare: Object.freeze({ type: "TRACE_IOS_IMPORT_PREPARE", protocolVersion: 1,
          requestID, requestIssuedAtMs: issued, accountID: scope.accountId,
          accountEpoch: scope.epoch, apiOrigin: this.#apiOrigin }) };
      this.#reservation = reservation;
      await this.#prepare(reservation);
      const { handoffID, expiresAtMs } = reservation;
      if (handoffID === null || !(await isCurrent()) || this.#now() >= expiresAtMs) return failure();
      const result = await collect(async (payloadBase64) => {
        const current = async () => await isCurrent() && this.#now() < expiresAtMs;
        if (payloadBase64.length > 699_052 || !(await current())) return failure();
        const ready = await this.#send({ type: "TRACE_IOS_IMPORT_STAGE", protocolVersion: 1,
          requestID, handoffID, payloadBase64 }, current);
        if (!record(ready) || ready.type !== "TRACE_IOS_IMPORT_STAGE" || ready.protocolVersion !== 1 ||
            ready.ok !== true || ready.state !== "ready_to_open" || ready.handoffID !== handoffID ||
            ready.expiresAtMs !== expiresAtMs || !(await current())) return failure();
        staged = true;
        return Object.freeze({ ok: true, state: "ready_to_open", handoffID, expiresAtMs });
      });
      // Preserve the collector's existing permission and unsupported-page outcomes.
      return result;
    } catch { return failure(); }
    finally {
      if (!staged && reservation !== null) {
        reservation.abandoned = true;
        await this.#cancel(reservation).catch(() => undefined);
      }
      this.#active = false;
    }
  }

  async discardUnpublished(handoffID: string): Promise<void> {
    const reservation = this.#reservation;
    if (reservation?.handoffID !== handoffID) return;
    reservation.abandoned = true;
    await this.#cancel(reservation);
  }

  async #prepare(reservation: Reservation): Promise<void> {
    await this.#send(reservation.prepare,
      async () => await reservation.isCurrent() && this.#now() < reservation.issued + REQUEST_LIFETIME_MS,
      (prepared) => {
        if (!record(prepared) || prepared.type !== "TRACE_IOS_IMPORT_PREPARE" || prepared.protocolVersion !== 1 ||
            prepared.ok !== true || prepared.state !== "prepared" ||
            typeof prepared.handoffID !== "string" || !UUID.test(prepared.handoffID) ||
            typeof prepared.expiresAtMs !== "number" || !Number.isSafeInteger(prepared.expiresAtMs) ||
            prepared.expiresAtMs > reservation.issued + 2 * REQUEST_LIFETIME_MS ||
            prepared.maximumPayloadBytes !== 524_288 || prepared.maximumItems !== 250 ||
            (reservation.handoffID !== null && (reservation.handoffID !== prepared.handoffID ||
              reservation.expiresAtMs !== prepared.expiresAtMs))) return;
        reservation.handoffID = prepared.handoffID;
        reservation.expiresAtMs = prepared.expiresAtMs;
        // The adapter observes even an acknowledgement arriving after timeout.
        // A failed/stale run may clean up its own ID, never publish it later.
        if (reservation.abandoned) void this.#cancel(reservation).catch(() => undefined);
      });
  }

  #cancel(reservation: Reservation): Promise<void> {
    if (this.#reservation !== reservation) return Promise.resolve();
    if (reservation.cancellation !== null) return reservation.cancellation;
    const operation = (async () => {
      if (this.#now() >= reservation.expiresAtMs) {
        if (this.#reservation === reservation) this.#reservation = null;
        return;
      }
      if (reservation.handoffID === null) return;
      const cancelled = await this.#send({ type: "TRACE_IOS_IMPORT_CANCEL", protocolVersion: 1,
        requestID: reservation.requestID, handoffID: reservation.handoffID });
      if (record(cancelled) && cancelled.type === "TRACE_IOS_IMPORT_CANCEL" && cancelled.protocolVersion === 1 &&
          ((cancelled.ok === true && cancelled.state === "cancelled") ||
            (cancelled.ok === false && (cancelled.error === "expired" || cancelled.error === "replayed")))) {
        if (this.#reservation === reservation) this.#reservation = null;
      }
    })();
    reservation.cancellation = operation;
    void operation.finally(() => { reservation.cancellation = null; }).catch(() => undefined);
    return operation;
  }

  async #send(message: Readonly<Record<string, unknown>>,
    isCurrent: () => Promise<boolean> = async () => true,
    observeResponse?: (response: unknown) => void,
  ): Promise<unknown | null> {
    // Two bounded transport attempts share the frozen identity/body. Recheck
    // authority before each attempt; retries never recollect page metadata.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await isCurrent())) return null;
      const response = await sendNativeMessageWithFallback(
        this.#runtime, this.#mode, message, MESSAGE_ATTEMPT_MS, {
          mayFallback: isCurrent, ...(observeResponse === undefined ? {} : { observeResponse }),
        });
      if (response !== null) return response;
    }
    return null;
  }
}
