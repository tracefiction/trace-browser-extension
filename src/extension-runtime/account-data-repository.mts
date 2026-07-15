import {
  copyAccountOverlay,
  copyAccountSummary,
  createEmptyAccountData,
  parseAccountData,
  sameAccountScope,
  type AccountDataV1,
  type AccountScope,
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
  | { readonly kind: "rejected_scope" | "invalid_model" };

export class AccountDataRepository {
  readonly #database: PrivateRecordDatabase;
  readonly #scopes: AccountScopeSource;
  #tail: Promise<void> = Promise.resolve();

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
    }));
  }

  publishOverlay(
    requestedScope: AccountScope,
    value: unknown,
  ): Promise<AccountDataWriteResult> {
    const overlay = copyAccountOverlay(value);
    if (overlay === null) return Promise.resolve({ kind: "invalid_model" });
    return this.#publish(requestedScope, (current) => Object.freeze({
      ...current,
      overlay,
    }));
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
  ): Promise<AccountDataWriteResult> {
    return this.#withLock(async () => {
      if (!sameAccountScope(this.#scopes.publicationScope(), requestedScope)) {
        return { kind: "rejected_scope" };
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
