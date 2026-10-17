export const PRIVATE_DATABASE_NAME = "traceKernelPrivateV1" as const;
export const PRIVATE_DATABASE_VERSION = 1 as const;
export const PRIVATE_RECORD_STORE = "records" as const;

export const PRIVATE_RECORD_KEYS = Object.freeze({
  browserInstallationId: "browser-installation-id",
  sessionEnvelope: "session-envelope",
  sessionCredentials: "session-credentials",
  accountData: "account-data",
} as const);

export type PrivateRecordKey =
  (typeof PRIVATE_RECORD_KEYS)[keyof typeof PRIVATE_RECORD_KEYS];

export interface PrivateRecordDatabase {
  get(key: PrivateRecordKey): Promise<unknown | null>;
  put(key: PrivateRecordKey, value: unknown): Promise<void>;
  delete(key: PrivateRecordKey): Promise<void>;
  deleteDatabase(): Promise<void>;
}

function databaseError(message: string, error: DOMException | null = null): Error {
  const detail = error?.message?.trim();
  return new Error(detail ? `${message}: ${detail}` : message, { cause: error ?? undefined });
}

/**
 * How long an open or a transaction may go without an answer. Safari can lose
 * a background's database connection while it is in the background (the
 * storage process is ended), after which requests on it may never answer.
 */
export const PRIVATE_DATABASE_OPEN_TIMEOUT_MS = 5_000;
export const PRIVATE_DATABASE_TRANSACTION_TIMEOUT_MS = 5_000;

/** Raised when the connection itself failed, not the request on it. */
class ConnectionLost extends Error {}

export class BrowserPrivateRecordDatabase implements PrivateRecordDatabase {
  readonly #factory: IDBFactory;
  readonly #openTimeoutMs: number;
  readonly #transactionTimeoutMs: number;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(
    factory: IDBFactory,
    options: Readonly<{ openTimeoutMs?: number; transactionTimeoutMs?: number }> = {},
  ) {
    this.#factory = factory;
    this.#openTimeoutMs = options.openTimeoutMs ?? PRIVATE_DATABASE_OPEN_TIMEOUT_MS;
    this.#transactionTimeoutMs = options.transactionTimeoutMs ?? PRIVATE_DATABASE_TRANSACTION_TIMEOUT_MS;
  }

  get(key: PrivateRecordKey): Promise<unknown | null> {
    return this.#runTransaction("readonly", (store) => store.get(key), (request) => (
      request.result === undefined ? null : request.result
    ));
  }

  put(key: PrivateRecordKey, value: unknown): Promise<void> {
    return this.#runTransaction("readwrite", (store) => store.put(value, key), () => undefined);
  }

  delete(key: PrivateRecordKey): Promise<void> {
    return this.#runTransaction("readwrite", (store) => store.delete(key), () => undefined);
  }

  async deleteDatabase(): Promise<void> {
    const pending = this.#openPromise;
    this.#openPromise = null;
    if (pending !== null) {
      try {
        (await pending).close();
      } catch {
        // A failed/future-version open has no usable connection to close.
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const request = this.#factory.deleteDatabase(PRIVATE_DATABASE_NAME);
      const finish = (result: "resolve" | "reject", error?: Error): void => {
        if (settled) return;
        settled = true;
        if (result === "resolve") resolve();
        else reject(error);
      };
      request.onsuccess = () => finish("resolve");
      request.onerror = () => finish(
        "reject",
        databaseError("private database deletion failed", request.error),
      );
      request.onblocked = () => finish(
        "reject",
        databaseError("private database deletion blocked"),
      );
    });
  }

  /**
   * One transaction. A connection that has stopped working is dropped and the
   * transaction is tried once more on a fresh one, so a lost connection never
   * fails every later read and write of this background. Each record is
   * written whole under its own key, so trying a write again is harmless.
   */
  async #runTransaction<T>(
    mode: IDBTransactionMode,
    start: (store: IDBObjectStore) => IDBRequest,
    readResult: (request: IDBRequest) => T,
  ): Promise<T> {
    const database = await this.#open();
    try {
      return await this.#runTransactionOn(database, mode, start, readResult);
    } catch (error) {
      if (!(error instanceof ConnectionLost)) throw error;
      this.#dropConnection(database);
      return await this.#runTransactionOn(await this.#open(), mode, start, readResult).catch(
        (retryError: unknown) => {
          if (retryError instanceof ConnectionLost) this.#dropConnection(null);
          throw retryError;
        },
      );
    }
  }

  /** Forgets the cached connection, so the next request opens a new one. */
  #dropConnection(database: IDBDatabase | null): void {
    const pending = this.#openPromise;
    this.#openPromise = null;
    const close = (connection: IDBDatabase | null | undefined): void => {
      try {
        connection?.close();
      } catch {
        // A connection that is already gone has nothing to close.
      }
    };
    close(database);
    if (pending !== null) void pending.then(close, () => undefined);
  }

  #runTransactionOn<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    start: (store: IDBObjectStore) => IDBRequest,
    readResult: (request: IDBRequest) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let request: IDBRequest;
      let result: T;
      let requestSucceeded = false;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(PRIVATE_RECORD_STORE, mode);
      } catch (error) {
        // A closed or lost connection cannot start a transaction at all.
        reject(new ConnectionLost(
          databaseError("private database connection lost", error instanceof DOMException ? error : null).message,
        ));
        return;
      }
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          transaction.abort();
        } catch {
          // The transaction may already be finishing.
        }
        reject(new ConnectionLost("private database transaction timed out"));
      }, this.#transactionTimeoutMs);
      const finishReject = (message: string, error: DOMException | null = null): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(databaseError(message, error));
      };

      try {
        request = start(transaction.objectStore(PRIVATE_RECORD_STORE));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The original synchronous request error is the useful failure.
        }
        finishReject(
          "private database request failed",
          error instanceof DOMException ? error : null,
        );
        return;
      }

      request.onsuccess = () => {
        try {
          result = readResult(request);
          requestSucceeded = true;
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // The result conversion error is retained below.
          }
          finishReject(
            "private database result invalid",
            error instanceof DOMException ? error : null,
          );
        }
      };
      request.onerror = () => {
        const name = request.error?.name;
        // The transaction failing under the request is decided by its abort.
        if (name === "AbortError" || name === "UnknownError") return;
        finishReject("private database request failed", request.error);
      };
      transaction.onabort = () => {
        // An abort with no request error of its own, or WebKit's "UnknownError",
        // is the connection failing under the transaction.
        if (!settled && (transaction.error === null || transaction.error.name === "UnknownError")) {
          settled = true;
          globalThis.clearTimeout(timer);
          reject(new ConnectionLost(
            databaseError("private database connection lost", transaction.error).message,
          ));
          return;
        }
        finishReject("private database transaction aborted", transaction.error);
      };
      transaction.onerror = () => {
        // `abort` is the terminal transaction event and carries the same error.
      };
      transaction.oncomplete = () => {
        if (settled) return;
        if (!requestSucceeded) {
          finishReject("private database request completed without a result");
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(result!);
      };
    });
  }

  #open(): Promise<IDBDatabase> {
    if (this.#openPromise !== null) return this.#openPromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finishReject = (message: string, error: DOMException | null = null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) globalThis.clearTimeout(timer);
        reject(databaseError(message, error));
      };
      let request: IDBOpenDBRequest;
      try {
        request = this.#factory.open(PRIVATE_DATABASE_NAME, PRIVATE_DATABASE_VERSION);
      } catch (error) {
        finishReject("private database open failed", error instanceof DOMException ? error : null);
        return;
      }
      // An open that never answers must not hold every later request.
      timer = globalThis.setTimeout(
        () => finishReject("private database open timed out"),
        this.#openTimeoutMs,
      );

      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (
          (event as IDBVersionChangeEvent).oldVersion !== 0 ||
          database.objectStoreNames.length !== 0
        ) {
          request.transaction?.abort();
          return;
        }
        database.createObjectStore(PRIVATE_RECORD_STORE);
      };
      request.onerror = () => finishReject("private database open failed", request.error);
      request.onblocked = () => finishReject("private database open blocked");
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (
          database.version !== PRIVATE_DATABASE_VERSION ||
          !database.objectStoreNames.contains(PRIVATE_RECORD_STORE) ||
          database.objectStoreNames.length !== 1
        ) {
          database.close();
          finishReject("private database schema invalid");
          return;
        }
        settled = true;
        if (timer !== null) globalThis.clearTimeout(timer);
        database.onversionchange = () => {
          database.close();
          if (this.#openPromise === cached) this.#openPromise = null;
        };
        // Closed by the browser (its storage went away): open anew next time.
        database.onclose = () => {
          if (this.#openPromise === cached) this.#openPromise = null;
        };
        resolve(database);
      };
    });
    const cached = opening.catch((error: unknown) => {
      if (this.#openPromise === cached) this.#openPromise = null;
      throw error;
    });
    this.#openPromise = cached;
    return cached;
  }
}
