import {
  copyAccountOverlay,
  copyAccountSummary,
  copyLibraryOverlayEntry,
  createEmptyAccountData,
  parseAccountData,
  sameAccountScope,
  type AccountDataV1,
  type AccountScope,
  type ConfirmedStorySave,
} from "../extension-core/index.mjs";
import {
  PRIVATE_RECORD_KEYS,
  type PrivateRecordDatabase,
} from "./private-database.mjs";

export interface AccountScopeSource {
  displayScope(): AccountScope | null;
  publicationScope(): AccountScope | null;
}

export type AccountDataWriteResult =
  | { readonly kind: "published"; readonly value: AccountDataV1 }
  | { readonly kind: "rejected_scope" | "invalid_model" | "stale_write" };

export type CapacityRecoveryAcknowledgement = "shown" | "dismissed";

const CAPACITY_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const CAPACITY_DISMISSAL_MS = 7 * 24 * 60 * 60 * 1_000;

export class AccountDataRepository {
  readonly #database: PrivateRecordDatabase;
  readonly #scopes: AccountScopeSource;
  #tail: Promise<void> = Promise.resolve();
  #overlayReservation = 0;
  #appliedOverlayReservation = 0;

  constructor(database: PrivateRecordDatabase, scopes: AccountScopeSource) {
    this.#database = database;
    this.#scopes = scopes;
  }

  read(): Promise<AccountDataV1 | null> {
    return this.#withLock(async () => {
      const startingScope = this.#scopes.displayScope();
      if (startingScope === null) return null;
      const parsed = parseAccountData(
        await this.#database.get(PRIVATE_RECORD_KEYS.accountData),
      );
      if (parsed.kind === "invalid") {
        try {
          await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
        } catch {
          // Invalid data is already unreadable. Cleanup is diagnostic/best effort.
        }
        return null;
      }
      if (parsed.kind !== "valid") return null;
      const currentScope = this.#scopes.displayScope();
      return (
        sameAccountScope(startingScope, currentScope) &&
        sameAccountScope(parsed.value.scope, currentScope)
      )
        ? parsed.value
        : null;
    });
  }

  ensureScope(requestedScope: AccountScope): Promise<AccountDataWriteResult> {
    return this.#publish(requestedScope, (current) => current);
  }

  publishSummary(
    requestedScope: AccountScope,
    value: unknown,
  ): Promise<AccountDataWriteResult> {
    const summary = copyAccountSummary(value);
    if (summary === null) return Promise.resolve({ kind: "invalid_model" });
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      summary,
      capacityRecovery:
        summary.pro ||
        (
          current.capacityRecovery !== null &&
          summary.libraryCount < current.capacityRecovery.blockedLibraryCount
        )
          ? null
          : current.capacityRecovery,
    }));
  }

  publishCapacityBlocked(
    requestedScope: AccountScope,
    at: number,
  ): Promise<AccountDataWriteResult> {
    if (!Number.isSafeInteger(at) || at < 0) {
      return Promise.resolve({ kind: "invalid_model" });
    }
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      capacityRecovery: current.capacityRecovery ?? Object.freeze({
        blockedAt: at,
        blockedLibraryCount: current.summary?.libraryCount ?? 0,
        nextPromptAt: 0,
      }),
    }));
  }

  acknowledgeCapacityRecovery(
    requestedScope: AccountScope,
    acknowledgement: CapacityRecoveryAcknowledgement,
    at: number,
  ): Promise<AccountDataWriteResult> {
    if (
      (acknowledgement !== "shown" && acknowledgement !== "dismissed") ||
      !Number.isSafeInteger(at) ||
      at < 0
    ) {
      return Promise.resolve({ kind: "invalid_model" });
    }
    const delay = acknowledgement === "dismissed"
      ? CAPACITY_DISMISSAL_MS
      : CAPACITY_PROMPT_COOLDOWN_MS;
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      capacityRecovery: current.capacityRecovery === null
        ? null
        : Object.freeze({
            ...current.capacityRecovery,
            nextPromptAt: Math.max(
              current.capacityRecovery.nextPromptAt,
              at + delay,
            ),
          }),
    }));
  }

  clearCapacityRecovery(
    requestedScope: AccountScope,
  ): Promise<AccountDataWriteResult> {
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      capacityRecovery: null,
    }));
  }

  publishOverlay(
    requestedScope: AccountScope,
    value: unknown,
    reservation = this.reserveOverlayWrite(),
  ): Promise<AccountDataWriteResult> {
    const overlay = copyAccountOverlay(value);
    if (overlay === null) return Promise.resolve({ kind: "invalid_model" });
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      overlay,
    }), reservation);
  }

  publishConfirmedStory(
    requestedScope: AccountScope,
    confirmation: ConfirmedStorySave,
  ): Promise<AccountDataWriteResult> {
    return this.publishAuthoritativeStory(requestedScope, confirmation);
  }

  /**
   * Publishes an exact server acknowledgement into the account-scoped root.
   * Finish qualification responses from the first additive server release may
   * omit syncVersion, so preserve the current opaque version in that case.
   */
  publishAuthoritativeStory(
    requestedScope: AccountScope,
    confirmation: Readonly<{
      workKey: string;
      entryId: string;
      entry: unknown;
      syncVersion?: string;
    }>,
    reservation = this.reserveOverlayWrite(),
  ): Promise<AccountDataWriteResult> {
    const entry = copyLibraryOverlayEntry(confirmation.entry);
    if (
      entry === null ||
      entry.entryId === undefined ||
      entry.entryId !== confirmation.entryId
    ) {
      return Promise.resolve({ kind: "invalid_model" });
    }
    return this.#publish(requestedScope, (current) => {
      const overlay = current.overlay ?? Object.freeze({
        entries: Object.freeze({}),
        workPreferences: Object.freeze({}),
        syncVersion: new Date(0).toISOString(),
      });
      return Object.freeze({
        ...current,
        overlay: Object.freeze({
          entries: Object.freeze({
            ...overlay.entries,
            [confirmation.workKey]: entry,
          }),
          workPreferences: overlay.workPreferences,
          syncVersion: confirmation.syncVersion ?? overlay.syncVersion,
        }),
      });
    }, reservation);
  }

  removeAuthoritativeStory(
    requestedScope: AccountScope,
    identity: Readonly<{ workKey: string; entryId: string }>,
    reservation = this.reserveOverlayWrite(),
  ): Promise<AccountDataWriteResult> {
    return this.#publish(requestedScope, (current) => {
      const overlay = current.overlay;
      const stored = overlay?.entries[identity.workKey];
      if (overlay === null || stored?.entryId !== identity.entryId) return current;
      const entries = { ...overlay.entries };
      delete entries[identity.workKey];
      return Object.freeze({
        ...current,
        overlay: Object.freeze({
          ...overlay,
          entries: Object.freeze(entries),
        }),
      });
    }, reservation);
  }

  /**
   * Reserve before starting an overlay request. A command confirmation that
   * publishes while that request is in flight receives a newer reservation,
   * so the older full response cannot erase the command's exact entry.
   */
  reserveOverlayWrite(): number {
    this.#overlayReservation += 1;
    return this.#overlayReservation;
  }

  /**
   * Calling this mutates the lock tail synchronously. Disconnect can therefore
   * detach the returned promise while still ordering an immediate Reconnect's
   * later account-root write after this deletion.
   */
  clear(): Promise<void> {
    return this.#withLock(async () => {
      await this.#database.delete(PRIVATE_RECORD_KEYS.accountData);
    });
  }

  #publish(
    requestedScope: AccountScope,
    update: (current: AccountDataV1) => AccountDataV1,
    overlayReservation?: number,
  ): Promise<AccountDataWriteResult> {
    return this.#withLock(async () => {
      if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
        return { kind: "rejected_scope" };
      }
      if (
        overlayReservation !== undefined &&
        overlayReservation < this.#appliedOverlayReservation
      ) {
        return { kind: "stale_write" };
      }
      const parsed = parseAccountData(
        await this.#database.get(PRIVATE_RECORD_KEYS.accountData),
      );
      if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
        return { kind: "rejected_scope" };
      }
      const current = parsed.kind === "valid" && sameAccountScope(parsed.value.scope, requestedScope)
        ? parsed.value
        : createEmptyAccountData(requestedScope);
      const next = update(current);
      const validated = parseAccountData(next);
      if (validated.kind !== "valid" || !sameAccountScope(validated.value.scope, requestedScope)) {
        return { kind: "invalid_model" };
      }
      await this.#database.put(PRIVATE_RECORD_KEYS.accountData, validated.value);
      if (overlayReservation !== undefined) {
        this.#appliedOverlayReservation = overlayReservation;
      }
      return { kind: "published", value: validated.value };
    });
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
