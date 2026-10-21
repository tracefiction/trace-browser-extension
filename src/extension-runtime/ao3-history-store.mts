/**
 * Where a History import keeps what it has read: the run and every work
 * found, on this device only, until the reader imports or deletes it.
 *
 * The extension's ordinary storage holds 5 MB, about 3,500 works, so a run is
 * kept in its own IndexedDB database. Each page's works and the run's next
 * page are written in one transaction: a run never moves past a page it did
 * not keep, and a page is never kept without the run knowing it.
 */

import type { HistoryWork } from "./ao3-history-page.mjs";

export const HISTORY_DATABASE_NAME = "traceAo3HistoryImportV1" as const;
export const HISTORY_DATABASE_VERSION = 1 as const;
const RUN_STORE = "run";
const WORK_STORE = "works";
const RUN_KEY = "current";
export const HISTORY_DATABASE_TIMEOUT_MS = 5_000;

/** What the store says about one page it was given. */
export interface AdmitResult {
  /** Works not seen before in this run. */
  readonly fresh: number;
  /** Works already kept from an earlier page (the History moved under the run). */
  readonly repeats: number;
}

export interface HistoryStore {
  readRun(): Promise<unknown | null>;
  writeRun(run: unknown): Promise<void>;
  /**
   * A page's works and the run, in one write; `runFor` makes the run from
   * what the store found, so its counts are kept with the works. On failure
   * neither is kept.
   */
  admit(works: readonly HistoryWork[], runFor: (result: AdmitResult) => unknown): Promise<AdmitResult>;
  readWorks(): Promise<HistoryWork[]>;
  /** The run and every work, gone. */
  clear(): Promise<void>;
}

/** The device refused to keep more: a write was over its storage quota. */
export class HistoryStoreFull extends Error {}

/**
 * A work seen again on a later page: the History lists newest visits first,
 * so the first sighting's details stand, gaps are filled from the later one,
 * and the visit day and count are the latest and the highest seen. A visit
 * count is never summed: the same visits are being seen twice.
 */
export function mergeHistoryWork(kept: HistoryWork, seen: HistoryWork): HistoryWork {
  const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a >= b ? a : b);
  const most = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
  return {
    id: kept.id,
    title: kept.title || seen.title,
    authors: kept.authors.length ? kept.authors : seen.authors,
    fandoms: kept.fandoms.length ? kept.fandoms : seen.fandoms,
    tags: kept.tags.length ? kept.tags : seen.tags,
    summary: kept.summary || seen.summary,
    words: kept.words ?? seen.words,
    chapters: kept.chapters ?? seen.chapters,
    lastVisited: later(kept.lastVisited, seen.lastVisited),
    visits: most(kept.visits, seen.visits),
    later: kept.later && seen.later,
  };
}

const clone = <T,>(value: T): T => structuredClone(value);

/** The same rules in memory, for tests and for a browser without IndexedDB. */
export class MemoryHistoryStore implements HistoryStore {
  run: unknown | null = null;
  readonly works = new Map<string, HistoryWork>();
  /** Makes the next writes fail, as a full device would. */
  failWrites: "full" | "error" | null = null;

  async readRun(): Promise<unknown | null> {
    return this.run === null ? null : clone(this.run);
  }

  async writeRun(run: unknown): Promise<void> {
    this.#check();
    this.run = clone(run);
  }

  async admit(works: readonly HistoryWork[], runFor: (result: AdmitResult) => unknown): Promise<AdmitResult> {
    this.#check();
    let fresh = 0;
    let repeats = 0;
    const next = new Map(this.works);
    for (const work of works) {
      const kept = next.get(work.id);
      if (kept === undefined) {
        fresh += 1;
        next.set(work.id, clone(work));
      } else {
        repeats += 1;
        next.set(work.id, mergeHistoryWork(kept, work));
      }
    }
    const run = clone(runFor({ fresh, repeats }));
    this.works.clear();
    for (const [id, work] of next) this.works.set(id, work);
    this.run = run;
    return { fresh, repeats };
  }

  async readWorks(): Promise<HistoryWork[]> {
    return [...this.works.values()].map(clone);
  }

  async clear(): Promise<void> {
    this.run = null;
    this.works.clear();
  }

  #check(): void {
    if (this.failWrites === "full") throw new HistoryStoreFull("history storage full");
    if (this.failWrites === "error") throw new Error("history storage failed");
  }
}

/** Raised when the connection itself failed, not the request on it. */
class ConnectionLost extends Error {}

type Stores = Readonly<{ run: IDBObjectStore; works: IDBObjectStore }>;

/**
 * The run in IndexedDB. Safari can lose a background's database connection
 * while it is in the background, after which requests on it may never
 * answer; as in private-database.mts, every open and transaction has a time
 * limit, and a transaction on a lost connection is tried once more on a
 * fresh one. Every write here gives the same result when made twice.
 */
export class IndexedDbHistoryStore implements HistoryStore {
  readonly #factory: IDBFactory;
  readonly #timeoutMs: number;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory, options: Readonly<{ timeoutMs?: number }> = {}) {
    this.#factory = factory;
    this.#timeoutMs = options.timeoutMs ?? HISTORY_DATABASE_TIMEOUT_MS;
  }

  readRun(): Promise<unknown | null> {
    return this.#transaction("readonly", ({ run }) => {
      const request = run.get(RUN_KEY);
      return () => (request.result === undefined ? null : request.result as unknown);
    });
  }

  writeRun(value: unknown): Promise<void> {
    return this.#transaction("readwrite", ({ run }) => {
      run.put(value, RUN_KEY);
      return () => undefined;
    });
  }

  admit(works: readonly HistoryWork[], runFor: (result: AdmitResult) => unknown): Promise<AdmitResult> {
    return this.#transaction("readwrite", ({ run, works: store }) => {
      let fresh = 0;
      let repeats = 0;
      // A work on the page twice is merged before it is written.
      const unique = new Map<string, HistoryWork>();
      for (const work of works) {
        const before = unique.get(work.id);
        if (before === undefined) unique.set(work.id, work);
        else {
          repeats += 1;
          unique.set(work.id, mergeHistoryWork(before, work));
        }
      }
      let waiting = unique.size;
      // The run is written once every work is, in the same transaction.
      const putRun = () => run.put(runFor({ fresh, repeats }), RUN_KEY);
      for (const work of unique.values()) {
        const request = store.get(work.id);
        request.onsuccess = () => {
          const kept = request.result as HistoryWork | undefined;
          if (kept === undefined) {
            fresh += 1;
            store.put(work);
          } else {
            repeats += 1;
            store.put(mergeHistoryWork(kept, work));
          }
          waiting -= 1;
          if (waiting === 0) putRun();
        };
      }
      if (waiting === 0) putRun();
      return () => ({ fresh, repeats });
    });
  }

  readWorks(): Promise<HistoryWork[]> {
    return this.#transaction("readonly", ({ works }) => {
      const request = works.getAll();
      return () => (Array.isArray(request.result) ? request.result as HistoryWork[] : []);
    });
  }

  clear(): Promise<void> {
    return this.#transaction("readwrite", ({ run, works }) => {
      run.clear();
      works.clear();
      return () => undefined;
    });
  }

  async #transaction<T>(mode: IDBTransactionMode, work: (stores: Stores) => () => T): Promise<T> {
    const database = await this.#open();
    try {
      return await this.#transactionOn(database, mode, work);
    } catch (error) {
      if (!(error instanceof ConnectionLost)) throw error;
      this.#drop(database);
      const fresh = await this.#open();
      try {
        return await this.#transactionOn(fresh, mode, work);
      } catch (retryError) {
        if (retryError instanceof ConnectionLost) this.#drop(fresh);
        throw retryError;
      }
    }
  }

  #drop(failed: IDBDatabase): void {
    this.#openPromise = null;
    try {
      failed.close();
    } catch {
      // A connection that is already gone has nothing to close.
    }
  }

  #transactionOn<T>(database: IDBDatabase, mode: IDBTransactionMode, work: (stores: Stores) => () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([RUN_STORE, WORK_STORE], mode);
      } catch {
        reject(new ConnectionLost("history database connection lost"));
        return;
      }
      const finish = (error: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (error === null) resolve(value as T);
        else reject(error);
      };
      const timer = globalThis.setTimeout(() => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be finishing.
        }
        finish(new ConnectionLost("history database transaction timed out"));
      }, this.#timeoutMs);
      let result: () => T;
      try {
        result = work({ run: transaction.objectStore(RUN_STORE), works: transaction.objectStore(WORK_STORE) });
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The request's own error is the useful one.
        }
        finish(error instanceof DOMException && error.name === "QuotaExceededError"
          ? new HistoryStoreFull("history storage full")
          : new Error("history database request failed", { cause: error }));
        return;
      }
      transaction.oncomplete = () => {
        try {
          finish(null, result());
        } catch (error) {
          finish(new Error("history database result invalid", { cause: error }));
        }
      };
      transaction.onabort = () => {
        const error = transaction.error;
        if (error?.name === "QuotaExceededError") finish(new HistoryStoreFull("history storage full"));
        // An abort with no error of its own, or WebKit's "UnknownError", is
        // the connection failing under the transaction.
        else if (error === null || error.name === "UnknownError") finish(new ConnectionLost("history database connection lost"));
        else finish(new Error(`history database transaction aborted: ${error.message}`, { cause: error }));
      };
    });
  }

  #open(): Promise<IDBDatabase> {
    if (this.#openPromise !== null) return this.#openPromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(new Error(message));
      };
      let request: IDBOpenDBRequest;
      try {
        request = this.#factory.open(HISTORY_DATABASE_NAME, HISTORY_DATABASE_VERSION);
      } catch {
        reject(new Error("history database open failed"));
        return;
      }
      const timer = globalThis.setTimeout(() => fail("history database open timed out"), this.#timeoutMs);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if ((event as IDBVersionChangeEvent).oldVersion !== 0 || database.objectStoreNames.length !== 0) {
          request.transaction?.abort();
          return;
        }
        database.createObjectStore(RUN_STORE);
        database.createObjectStore(WORK_STORE, { keyPath: "id" });
      };
      request.onerror = () => fail("history database open failed");
      request.onblocked = () => fail("history database open blocked");
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (
          database.version !== HISTORY_DATABASE_VERSION ||
          !database.objectStoreNames.contains(RUN_STORE) ||
          !database.objectStoreNames.contains(WORK_STORE)
        ) {
          database.close();
          fail("history database schema invalid");
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        const forget = (): void => {
          if (this.#openPromise === cached) this.#openPromise = null;
        };
        database.onversionchange = () => {
          database.close();
          forget();
        };
        database.onclose = forget;
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
