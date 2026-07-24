export const PRIVATE_DATABASE_NAME = "traceKernelPrivateV1" as const;
export const PRIVATE_DATABASE_VERSION = 1 as const;
export const PRIVATE_RECORD_STORE = "records" as const;

export const PRIVATE_RECORD_KEYS = Object.freeze({
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

export class BrowserPrivateRecordDatabase implements PrivateRecordDatabase {
  readonly #factory: IDBFactory;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
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

  async #runTransaction<T>(
    mode: IDBTransactionMode,
    start: (store: IDBObjectStore) => IDBRequest,
    readResult: (request: IDBRequest) => T,
  ): Promise<T> {
    const database = await this.#open();
    return new Promise<T>((resolve, reject) => {
      let request: IDBRequest;
      let result: T;
      let requestSucceeded = false;
      let settled = false;
      const transaction = database.transaction(PRIVATE_RECORD_STORE, mode);
      const finishReject = (message: string, error: DOMException | null = null): void => {
        if (settled) return;
        settled = true;
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
      request.onerror = () => finishReject(
        "private database request failed",
        request.error,
      );
      transaction.onabort = () => finishReject(
        "private database transaction aborted",
        transaction.error,
      );
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
        resolve(result!);
      };
    });
  }

  #open(): Promise<IDBDatabase> {
    if (this.#openPromise !== null) return this.#openPromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = this.#factory.open(PRIVATE_DATABASE_NAME, PRIVATE_DATABASE_VERSION);
      const finishReject = (message: string, error: DOMException | null = null): void => {
        if (settled) return;
        settled = true;
        reject(databaseError(message, error));
      };

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
        database.onversionchange = () => {
          database.close();
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
