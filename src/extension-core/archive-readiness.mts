export type ArchiveHostKind = "ao3" | "ffn";

export interface ArchiveRunReceipt {
  readonly hostKind: ArchiveHostKind;
  readonly at: number;
  readonly handoffId?: string;
}

export interface ArchivePermissionSnapshot {
  readonly hostKind: ArchiveHostKind;
  readonly at: number;
  readonly grantedOrigins: readonly string[];
}

export interface ArchiveReadinessReceiptPort {
  publishRunReceipt(receipt: ArchiveRunReceipt): Promise<boolean>;
  publishPermissionSnapshot(snapshot: ArchivePermissionSnapshot): Promise<boolean>;
}

export interface ArchivePermissionSnapshotPort {
  readGrantedOrigins(): Promise<readonly string[] | null>;
}

export interface ArchiveReadinessClock {
  now(): number;
}

export type ArchiveRunResult =
  | { readonly kind: "published" }
  | { readonly kind: "throttled" }
  | { readonly kind: "unavailable" };

export const ARCHIVE_RUN_THROTTLE_MS = 5 * 60 * 1_000;

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

  constructor(options: {
    receipts: ArchiveReadinessReceiptPort;
    permissions: ArchivePermissionSnapshotPort;
    clock?: ArchiveReadinessClock;
  }) {
    this.#receipts = options.receipts;
    this.#permissions = options.permissions;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
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
