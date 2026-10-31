/**
 * Where Keep a Copy keeps its works: IndexedDB, one record per work and one
 * small record for the rest (settings, queue), each account's apart, and one
 * pacer for the device: AO3's limits and stops are the browser's, whichever
 * account is in use. Only the works a step changed are written. Nothing is
 * kept in `storage.local`, whose every change reaches each open AO3 page and
 * the popup, and whose space a large Library would fill.
 */

import type { KeepState, KeptWork } from "./keep-a-copy.mjs";

const DATABASE = "traceKeepACopyV1";
const CORES = "cores";
const WORKS = "works";
const META = "meta";
/** The device's pacer, in the small records. */
export const PACER_KEY = "pacerV1";

/**
 * An account's stored state under the device's pacer: until the device has
 * one, the account's own (kept with it before) stands in, and is moved to
 * the device with the next write. For an account with no state, the pacer
 * alone; undefined when neither is stored.
 */
export function withDevicePacer(core: unknown, pacer: unknown): unknown {
  const device = pacer !== null && typeof pacer === "object" ? { pacer } : null;
  if (!core || typeof core !== "object") return device ?? undefined;
  return device ? { ...core, ...device } : core;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

export class IndexedDbKeepStore {
  #db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly keyRange: { bound(lower: unknown, upper: unknown): IDBKeyRange } = (globalThis as unknown as { IDBKeyRange: { bound(lower: unknown, upper: unknown): IDBKeyRange } }).IDBKeyRange,
    private readonly name = DATABASE,
  ) {}

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.factory.open(this.name, 1);
      open.onupgradeneeded = () => {
        for (const store of [CORES, WORKS, META]) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }).catch((error: unknown) => {
      this.#db = null;
      throw error;
    });
    return this.#db;
  }

  /** One account's state, works and all, under the device's pacer (`withDevicePacer`). */
  async read(scope: string): Promise<unknown> {
    const db = await this.#open();
    const tx = db.transaction([CORES, WORKS, META], "readonly");
    const [core, works, pacer] = await Promise.all([
      request(tx.objectStore(CORES).get(scope)),
      // Every [scope, workId] key sorts between [scope] and [scope, []].
      request(tx.objectStore(WORKS).getAll(this.keyRange.bound([scope], [scope, []]))),
      request(tx.objectStore(META).get(PACER_KEY)),
    ]);
    if (!core || typeof core !== "object") return withDevicePacer(undefined, pacer);
    const byId: Record<string, KeptWork> = {};
    for (const work of works as KeptWork[]) if (work && typeof work.workId === "string") byId[work.workId] = work;
    return withDevicePacer({ ...(core as object), works: byId }, pacer);
  }

  /** Writes the state's small record, the device's pacer, and only the works in `changed`. */
  async write(state: KeepState, changed: ReadonlySet<string>, scope: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction([CORES, WORKS, META], "readwrite");
    const { works, pacer, ...core } = state;
    tx.objectStore(CORES).put(core, scope);
    tx.objectStore(META).put(pacer, PACER_KEY);
    const store = tx.objectStore(WORKS);
    for (const workId of changed) {
      const work = works[workId];
      if (work) store.put(work, [scope, workId]);
      else store.delete([scope, workId]);
    }
    await done(tx);
  }

  async getMeta(key: string): Promise<unknown> {
    const db = await this.#open();
    return request(db.transaction(META, "readonly").objectStore(META).get(key));
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put(value, key);
    await done(tx);
  }
}
