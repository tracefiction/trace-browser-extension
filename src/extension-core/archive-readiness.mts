export type ArchiveHostKind = "ao3" | "ffn";

export interface ArchiveRunReceipt {
  readonly hostKind: ArchiveHostKind;
  readonly at: number;
  readonly handoffId?: string;
}

export interface ArchivePermissionSnapshot {
  /** The archive whose run this snapshot follows; absent for a reading taken on its own. */
  readonly hostKind?: ArchiveHostKind;
  readonly at: number;
  readonly grantedOrigins: readonly string[];
}

export interface ArchiveReadinessReceiptPort {
  publishRunReceipt(receipt: ArchiveRunReceipt): Promise<boolean>;
  publishPermissionSnapshot(snapshot: ArchivePermissionSnapshot): Promise<boolean>;
}

export interface ArchivePermissionSnapshotPort {
  readGrantedOrigins(): Promise<readonly string[] | null>;
  /**
   * Whether every listed origin is granted, however the grant is spelled.
   * `null` means there was no answer.
   */
  containsOrigins?(origins: readonly string[]): Promise<boolean | null>;
}

export interface ArchiveReadinessClock {
  now(): number;
}

export type ArchiveRunResult =
  | { readonly kind: "published" }
  | { readonly kind: "throttled" }
  | { readonly kind: "unavailable" };

export type ArchiveAccessReportResult =
  | { readonly kind: "published"; readonly complete: boolean }
  /** The current access could not be read; nothing was sent. */
  | { readonly kind: "unknown" }
  /** Access is incomplete, but this install has never held it; nothing was sent. */
  | { readonly kind: "withheld" }
  /** The same reading was delivered moments ago; nothing was sent. */
  | { readonly kind: "current" }
  /** An earlier delivery failed and it is too soon to try again. */
  | { readonly kind: "deferred" }
  | { readonly kind: "unavailable" };

/** What an install remembers about its access readings. No origins, no account. */
export interface ArchiveAccessLedger {
  /** A reading has found every required origin granted at least once. */
  readonly grantSeen: boolean;
  readonly deliveredAt?: number;
  /** A fingerprint of the reading delivered at `deliveredAt`. */
  readonly delivered?: string;
  /** Deliveries that have failed in a row. */
  readonly failures?: number;
  /** No delivery is attempted before this time. */
  readonly retryAt?: number;
}

export interface ArchiveAccessLedgerPort {
  read(): Promise<ArchiveAccessLedger>;
  write(ledger: ArchiveAccessLedger): Promise<void>;
}

export const ARCHIVE_RUN_THROTTLE_MS = 5 * 60 * 1_000;
/** A reading that access is missing is taken twice, this far apart. */
export const ARCHIVE_ACCESS_CONFIRM_DELAY_MS = 2_000;
/** A reading equal to the last one delivered is not sent again this soon. */
export const ARCHIVE_ACCESS_REPEAT_AFTER_MS = 5 * 60 * 1_000;
/** How long to leave a failed delivery alone: longer after each failure in a row. */
export const ARCHIVE_ACCESS_RETRY_DELAYS_MS = Object.freeze([
  60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000,
]);
const ARCHIVE_ACCESS_REPORT_MAX_PASSES = 3;

/**
 * Tells two readings apart without keeping what they listed: whether access
 * was complete, how many origins were granted, and a hash of them.
 */
function accessFingerprint(complete: boolean, origins: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of [...origins].sort().join(" ")) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${complete ? "complete" : "incomplete"}:${origins.length}:${hash.toString(16)}`;
}

const SYSTEM_CLOCK: ArchiveReadinessClock = Object.freeze({
  now: () => Date.now(),
});

/**
 * Owns only positive evidence that a supported archive content script ran.
 *
 * Session state, account identity, story metadata, and save completion do not
 * belong here. The runtime adapter validates the transport-provided sender
 * before calling this service.
 */
export class ArchiveReadinessService {
  readonly #receipts: ArchiveReadinessReceiptPort;
  readonly #permissions: ArchivePermissionSnapshotPort;
  readonly #clock: ArchiveReadinessClock;
  readonly #lastRunAttemptByHost = new Map<ArchiveHostKind, number>();
  readonly #requiredOrigins: readonly string[];
  readonly #wait: (ms: number) => Promise<void>;
  readonly #ledger: ArchiveAccessLedgerPort;
  #accessReport: Promise<ArchiveAccessReportResult> | null = null;
  #accessReportRequestedAgain = false;

  constructor(options: {
    receipts: ArchiveReadinessReceiptPort;
    permissions: ArchivePermissionSnapshotPort;
    clock?: ArchiveReadinessClock;
    /** The origins automatic saving needs; without them no access reading is taken. */
    requiredOrigins?: readonly string[];
    wait?: (ms: number) => Promise<void>;
    /** Where the access ledger is kept; in memory when absent. */
    accessLedger?: ArchiveAccessLedgerPort;
  }) {
    this.#receipts = options.receipts;
    this.#permissions = options.permissions;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#requiredOrigins = Object.freeze([...(options.requiredOrigins ?? [])]);
    this.#wait = options.wait ??
      ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    let remembered: ArchiveAccessLedger = Object.freeze({ grantSeen: false });
    this.#ledger = options.accessLedger ?? {
      read: async () => remembered,
      write: async (ledger) => { remembered = ledger; },
    };
  }

  async recordRun(input: {
    hostKind: ArchiveHostKind;
    handoffId?: string;
  }): Promise<ArchiveRunResult> {
    const at = this.#clock.now();
    const lastAttempt = this.#lastRunAttemptByHost.get(input.hostKind);
    if (
      input.handoffId === undefined &&
      lastAttempt !== undefined &&
      at - lastAttempt < ARCHIVE_RUN_THROTTLE_MS
    ) {
      return { kind: "throttled" };
    }

    // Reserve the throttle slot before crossing the async native boundary so
    // concurrent page signals cannot create a receipt storm.
    this.#lastRunAttemptByHost.set(input.hostKind, at);
    const receipt = Object.freeze({
      hostKind: input.hostKind,
      at,
      ...(input.handoffId === undefined ? {} : { handoffId: input.handoffId }),
    });

    let published = false;
    try {
      published = await this.#receipts.publishRunReceipt(receipt);
    } catch {
      published = false;
    }

    if (!published) {
      // Native messaging may be temporarily unavailable during app/extension
      // startup. Permit the next real navigation to retry instead of hiding
      // the failure behind the normal five-minute receipt throttle.
      if (this.#lastRunAttemptByHost.get(input.hostKind) === at) {
        this.#lastRunAttemptByHost.delete(input.hostKind);
      }
      return { kind: "unavailable" };
    }

    // Diagnostic permission metadata is intentionally sequenced after the
    // positive run receipt and never delays the caller's receipt result.
    void this.#publishPermissionSnapshot(input.hostKind);
    return { kind: "published" };
  }

  /**
   * Publishes what access is granted right now, on its own rather than
   * after a run. A run can only ever prove access; this is the reading that
   * can show access has ended (for example, a one-day grant running out),
   * because no page script runs to say so.
   *
   * It must not raise a false alarm. Access is reported missing only when
   * this install has held the grant before, two readings in a row say it is
   * gone, and the list of what is granted came with them. An install that
   * has never held the grant has nothing to lose, so it sends nothing. When
   * the required origins are confirmed they are listed by name, since a
   * broader grant need not spell them out.
   *
   * It is also quiet: a reading equal to the last one delivered is not sent
   * again within a few minutes, and a failed delivery is left alone for
   * longer after each failure in a row.
   */
  reportAccess(): Promise<ArchiveAccessReportResult> {
    if (this.#accessReport !== null) {
      // Access may have changed since the running report read it.
      this.#accessReportRequestedAgain = true;
      return this.#accessReport;
    }
    const report = (async () => {
      let result: ArchiveAccessReportResult = { kind: "unknown" };
      for (let pass = 0; pass < ARCHIVE_ACCESS_REPORT_MAX_PASSES; pass += 1) {
        this.#accessReportRequestedAgain = false;
        result = await this.#reportAccessOnce();
        if (!this.#accessReportRequestedAgain) break;
      }
      return result;
    })().finally(() => {
      this.#accessReport = null;
    });
    this.#accessReport = report;
    return report;
  }

  async #reportAccessOnce(): Promise<ArchiveAccessReportResult> {
    const ledger = await this.#readLedger();
    const startedAt = this.#clock.now();
    const longestWait = ARCHIVE_ACCESS_RETRY_DELAYS_MS.at(-1)!;
    if (
      typeof ledger.retryAt === "number" &&
      startedAt < ledger.retryAt &&
      // A clock that moved backwards must not silence readings for good.
      ledger.retryAt - startedAt <= longestWait
    ) {
      return { kind: "deferred" };
    }
    let reading = await this.#readAccess();
    if (reading === null) return { kind: "unknown" };
    if (!reading.complete) {
      // This reading exists to catch access that ended. Before the grant has
      // ever been seen, "incomplete" is only setup not being finished yet.
      if (!ledger.grantSeen) return { kind: "withheld" };
      await this.#wait(ARCHIVE_ACCESS_CONFIRM_DELAY_MS);
      reading = await this.#readAccess();
      if (reading === null) return { kind: "unknown" };
    }
    // Past this point the grant has been seen: either this reading found it
    // complete, or the ledger already said so.
    const grantSeen = true;
    const fingerprint = accessFingerprint(reading.complete, reading.grantedOrigins);
    const now = this.#clock.now();
    if (
      ledger.delivered === fingerprint &&
      typeof ledger.deliveredAt === "number" &&
      now >= ledger.deliveredAt &&
      now - ledger.deliveredAt < ARCHIVE_ACCESS_REPEAT_AFTER_MS
    ) {
      if (!ledger.grantSeen) await this.#writeLedger({ ...ledger, grantSeen });
      return { kind: "current" };
    }
    let published = false;
    try {
      published = await this.#receipts.publishPermissionSnapshot(Object.freeze({
        at: now,
        grantedOrigins: reading.grantedOrigins,
      }));
    } catch {
      published = false;
    }
    if (published) {
      await this.#writeLedger({ grantSeen, deliveredAt: now, delivered: fingerprint });
      return { kind: "published", complete: reading.complete };
    }
    const failures = (ledger.failures ?? 0) + 1;
    const retryAfter = ARCHIVE_ACCESS_RETRY_DELAYS_MS[
      Math.min(failures, ARCHIVE_ACCESS_RETRY_DELAYS_MS.length) - 1
    ]!;
    await this.#writeLedger({ ...ledger, grantSeen, failures, retryAt: now + retryAfter });
    return { kind: "unavailable" };
  }

  async #readLedger(): Promise<ArchiveAccessLedger> {
    try {
      return await this.#ledger.read();
    } catch {
      // An unreadable ledger is treated as an install that never held the grant.
      return { grantSeen: false };
    }
  }

  async #writeLedger(ledger: ArchiveAccessLedger): Promise<void> {
    try {
      await this.#ledger.write(Object.freeze(ledger));
    } catch {
      // The next reading works from whatever was last stored.
    }
  }

  async #readAccess(): Promise<{
    readonly complete: boolean;
    readonly grantedOrigins: readonly string[];
  } | null> {
    const contains = this.#permissions.containsOrigins;
    if (this.#requiredOrigins.length === 0 || contains === undefined) return null;
    const [listed, complete] = await Promise.all([
      this.#permissions.readGrantedOrigins().catch(() => null),
      contains.call(this.#permissions, this.#requiredOrigins).catch(() => null),
    ]);
    if (typeof complete !== "boolean") return null;
    if (complete) {
      return {
        complete: true,
        grantedOrigins: Object.freeze(
          Array.from(new Set([...this.#requiredOrigins, ...(listed ?? [])])),
        ),
      };
    }
    // Missing access is only reported together with what is granted.
    if (listed === null) return null;
    return { complete: false, grantedOrigins: Object.freeze([...listed]) };
  }

  async #publishPermissionSnapshot(hostKind: ArchiveHostKind): Promise<void> {
    let grantedOrigins: readonly string[] | null = null;
    try {
      grantedOrigins = await this.#permissions.readGrantedOrigins();
    } catch {
      return;
    }
    if (grantedOrigins === null) return;
    try {
      await this.#receipts.publishPermissionSnapshot(Object.freeze({
        hostKind,
        at: this.#clock.now(),
        grantedOrigins: Object.freeze([...grantedOrigins]),
      }));
    } catch {
      // Permission snapshots are diagnostic only. A failure cannot weaken or
      // retract the already-published archive-run receipt.
    }
  }
}
