import {
  canSyncSavedFilters,
  mergeSavedFilterSyncData,
  normalizeSavedFilterSnapshot,
  parseSavedFilterSyncData,
  type AccountScope,
  type AuthenticatedEffectResult,
  type SavedFilterSnapshot,
  type SavedFilterSyncApiOutcome,
  type SavedFilterSyncApiPort,
  type SavedFilterSyncData,
  type SavedFilterSyncRepositoryPort,
  type SavedFilterSyncRequest,
  type SavedFilterSyncSessionPort,
} from "../extension-core/index.mjs";
import {
  SAVED_FILTER_LOCAL_KEYS,
  SAVED_FILTER_SYNC_ALARM,
} from "./browser-adapters.mjs";
import {
  BrowserStorage,
  type RuntimePort,
} from "./browser-platform.mjs";

const REQUEST_TIMEOUT_MS = 12_000;

export const SAVED_FILTER_STORAGE_KEYS = SAVED_FILTER_LOCAL_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export class SavedFilterSyncApi implements SavedFilterSyncApiPort {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  #activeAbort: AbortController | null = null;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    this.#endpoint =
      `${apiBase.replace(/\/$/, "")}/api/extension/ao3-saved-filters/sync`;
  }

  async sync(
    credential: string,
    request: SavedFilterSyncRequest,
  ): Promise<AuthenticatedEffectResult<SavedFilterSyncApiOutcome>> {
    const abort = new AbortController();
    this.#activeAbort = abort;
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(request),
        signal: abort.signal,
      });
    } catch {
      return { kind: "success", value: { kind: "unavailable" } };
    } finally {
      globalThis.clearTimeout(timer);
      if (this.#activeAbort === abort) this.#activeAbort = null;
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "auth_rejected" };
    }
    if (response.status === 400) {
      return {
        kind: "success",
        value: { kind: "rejected", reason: "invalid_request" },
      };
    }
    if (response.status === 429) {
      return {
        kind: "success",
        value: { kind: "rejected", reason: "rate_limited" },
      };
    }
    if (response.status === 422) {
      const body = await this.#json(response);
      if (
        isRecord(body) &&
        body.code === "AO3_SAVED_FILTER_LIMIT_REACHED" &&
        Number.isSafeInteger(body.limit) &&
        (body.limit as number) > 0 &&
        (body.limit as number) <= 250
      ) {
        return {
          kind: "success",
          value: {
            kind: "rejected",
            reason: "limit_reached",
            limit: body.limit as number,
          },
        };
      }
      return { kind: "success", value: { kind: "invalid_response" } };
    }
    if (!response.ok) {
      return { kind: "success", value: { kind: "unavailable" } };
    }
    const body = await this.#json(response);
    if (
      !isRecord(body) ||
      !hasOnlyKeys(body, ["success", "data"]) ||
      body.success !== true
    ) {
      return { kind: "success", value: { kind: "invalid_response" } };
    }
    const data = parseSavedFilterSyncData(body.data);
    return data === null
      ? { kind: "success", value: { kind: "invalid_response" } }
      : { kind: "success", value: { kind: "accepted", data } };
  }

  cancelPending(): void {
    this.#activeAbort?.abort();
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

export class BrowserSavedFilterRepository
implements SavedFilterSyncRepositoryPort {
  readonly #storage: BrowserStorage;
  readonly #session: SavedFilterSyncSessionPort;
  readonly #randomId: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    storage: BrowserStorage;
    session: SavedFilterSyncSessionPort;
    randomId: () => string;
  }) {
    this.#storage = options.storage;
    this.#session = options.session;
    this.#randomId = options.randomId;
  }

  read(): Promise<SavedFilterSnapshot | null> {
    return this.#withLock(async () => {
      const snapshot = await this.#readUnlocked();
      if (snapshot.clientId !== null) return snapshot;
      const generated = `device:${this.#randomId()}`.slice(0, 80);
      const clientId = /^[A-Za-z0-9._:-]{1,80}$/.test(generated)
        ? generated
        : null;
      if (clientId === null) return null;
      await this.#storage.set({ [SAVED_FILTER_STORAGE_KEYS.clientId]: clientId });
      return Object.freeze({ ...snapshot, clientId });
    });
  }

  merge(
    requestedScope: AccountScope,
    data: SavedFilterSyncData,
    sentDeleteClientIds: ReadonlySet<string>,
    syncedAt: string,
  ): Promise<
    | { readonly kind: "published"; readonly snapshot: SavedFilterSnapshot }
    | { readonly kind: "stale" | "unavailable" }
  > {
    return this.#withLock(async () => {
      if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
        return { kind: "stale" };
      }
      let current: SavedFilterSnapshot;
      try {
        current = await this.#readUnlocked();
      } catch {
        return { kind: "unavailable" };
      }
      if (
        current.clientId === null ||
        !canSyncSavedFilters(this.#session.publicationScope(), requestedScope)
      ) {
        return { kind: "stale" };
      }
      const next = mergeSavedFilterSyncData(
        current,
        data,
        sentDeleteClientIds,
        syncedAt,
      );
      if (!canSyncSavedFilters(this.#session.publicationScope(), requestedScope)) {
        return { kind: "stale" };
      }
      try {
        await this.#storage.set({
          [SAVED_FILTER_STORAGE_KEYS.presets]: next.presets,
          [SAVED_FILTER_STORAGE_KEYS.deleted]: next.deleted,
          [SAVED_FILTER_STORAGE_KEYS.activeMeta]: next.activeMeta,
          [SAVED_FILTER_STORAGE_KEYS.syncMeta]: {
            syncVersion: next.syncVersion,
            lastSyncedAt: next.lastSyncedAt,
          },
          [SAVED_FILTER_STORAGE_KEYS.clientId]: next.clientId,
        });
      } catch {
        return { kind: "unavailable" };
      }
      return canSyncSavedFilters(this.#session.publicationScope(), requestedScope)
        ? { kind: "published", snapshot: next }
        : { kind: "stale" };
    });
  }

  async #readUnlocked(): Promise<SavedFilterSnapshot> {
    const raw = await this.#storage.get(Object.values(SAVED_FILTER_STORAGE_KEYS));
    const rawSyncMeta = raw[SAVED_FILTER_STORAGE_KEYS.syncMeta];
    const syncMeta: Record<string, unknown> = isRecord(rawSyncMeta)
      ? rawSyncMeta
      : {};
    return normalizeSavedFilterSnapshot({
      presets: raw[SAVED_FILTER_STORAGE_KEYS.presets],
      deleted: raw[SAVED_FILTER_STORAGE_KEYS.deleted],
      activeMeta: raw[SAVED_FILTER_STORAGE_KEYS.activeMeta],
      syncVersion: syncMeta.syncVersion,
      lastSyncedAt: syncMeta.lastSyncedAt,
      clientId: raw[SAVED_FILTER_STORAGE_KEYS.clientId],
    }, new Date().toISOString());
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

export class SavedFilterSyncAlarm {
  static readonly name = SAVED_FILTER_SYNC_ALARM;

  static install(
    alarms: {
      readonly create?: (...args: unknown[]) => unknown;
      readonly onAlarm?: {
        addListener(listener: (alarm: { readonly name?: string }) => void): void;
      };
    },
    runtime: RuntimePort,
    onAlarm: () => void,
  ): void {
    alarms.onAlarm?.addListener((alarm) => {
      if (alarm?.name === SavedFilterSyncAlarm.name) onAlarm();
    });
    try {
      const result = alarms.create?.(
        SavedFilterSyncAlarm.name,
        { periodInMinutes: 30 },
      );
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      void runtime.lastError;
    }
  }
}
