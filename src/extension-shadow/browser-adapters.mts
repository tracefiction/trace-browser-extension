import type {
  CredentialAcquisition,
  CredentialPort,
  SessionApiPort,
  SessionEnvelope,
  SessionStoragePort,
  VerificationResult,
} from "../extension-core/index.mjs";

export const SHADOW_SESSION_KEY = "traceShadowSessionV1" as const;
export const SHADOW_CREDENTIAL_KEY = "traceShadowCredentialV1" as const;

export interface ShadowRuntimePort {
  readonly id?: string;
  readonly lastError?: { readonly message?: string };
  readonly onMessage: {
    addListener(listener: ShadowMessageListener): void;
  };
}

export type ShadowMessageListener = (
  message: unknown,
  sender: { readonly id?: string },
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface ShadowStorageArea {
  readonly get: (...args: unknown[]) => unknown;
  readonly set: (...args: unknown[]) => unknown;
  readonly remove: (...args: unknown[]) => unknown;
}

export interface ShadowFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type ShadowFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly cache: "no-store";
    readonly headers: { readonly Authorization: string };
  },
) => Promise<ShadowFetchResponse>;

export class ShadowBrowserStorage {
  readonly #area: ShadowStorageArea;
  readonly #runtime: ShadowRuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(
    area: ShadowStorageArea,
    runtime: ShadowRuntimePort,
    mode: "callback" | "promise",
  ) {
    this.#area = area;
    this.#runtime = runtime;
    this.#mode = mode;
  }

  get(keys: string | readonly string[]): Promise<Record<string, unknown>> {
    return this.#call<Record<string, unknown>>("get", [keys]);
  }

  set(patch: Record<string, unknown>): Promise<void> {
    return this.#call<void>("set", [patch]);
  }

  remove(keys: string | readonly string[]): Promise<void> {
    return this.#call<void>("remove", [keys]);
  }

  #call<T>(method: "get" | "set" | "remove", args: readonly unknown[]): Promise<T> {
    if (this.#mode === "promise") {
      try {
        return Promise.resolve(this.#area[method](...args) as T | PromiseLike<T>);
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise<T>((resolve, reject) => {
      try {
        this.#area[method](...args, (value: T) => {
          const message = this.#runtime.lastError?.message;
          if (message) {
            reject(new Error(message));
            return;
          }
          resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}

export class ShadowSessionStoragePort implements SessionStoragePort {
  readonly #storage: ShadowBrowserStorage;

  constructor(storage: ShadowBrowserStorage) {
    this.#storage = storage;
  }

  async read(): Promise<unknown | null> {
    const snapshot = await this.#storage.get(SHADOW_SESSION_KEY);
    return snapshot[SHADOW_SESSION_KEY] ?? null;
  }

  write(envelope: SessionEnvelope): Promise<void> {
    return this.#storage.set({ [SHADOW_SESSION_KEY]: envelope });
  }

  clearAll(): Promise<void> {
    return this.#storage.remove(SHADOW_SESSION_KEY);
  }

  async isPresent(): Promise<boolean> {
    const snapshot = await this.#storage.get(SHADOW_SESSION_KEY);
    return Object.hasOwn(snapshot, SHADOW_SESSION_KEY);
  }
}

interface ShadowCredentialStore {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentialStore(raw: unknown): Record<string, string> {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.entries)) return {};
  const entries: Record<string, string> = {};
  for (const [reference, credential] of Object.entries(raw.entries)) {
    if (reference.trim() && typeof credential === "string" && credential.trim()) {
      entries[reference] = credential;
    }
  }
  return entries;
}

export class ShadowCredentialPort implements CredentialPort {
  readonly #storage: ShadowBrowserStorage;
  readonly #randomId: () => string;
  #offeredCredential: string | null = null;
  #failDeleteOnce = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(storage: ShadowBrowserStorage, randomId: () => string) {
    this.#storage = storage;
    this.#randomId = randomId;
  }

  offer(credential: string): void {
    this.#offeredCredential = credential;
  }

  discardOffer(): void {
    this.#offeredCredential = null;
  }

  failNextDelete(): void {
    this.#failDeleteOnce = true;
  }

  async acquire(_purpose: "connect" | "refresh"): Promise<CredentialAcquisition> {
    const credential = this.#offeredCredential;
    this.#offeredCredential = null;
    return credential === null
      ? { kind: "absent" }
      : { kind: "credential", credential };
  }

  cancelAcquisition(): void {
    this.#offeredCredential = null;
  }

  load(reference: string): Promise<string | null> {
    return this.#withLock(async () => {
      const entries = await this.#readEntries();
      return entries[reference] ?? null;
    });
  }

  storeUnique(credential: string, epoch: number): Promise<string> {
    return this.#withLock(async () => {
      const suffix = this.#randomId().trim();
      if (!suffix) throw new TypeError("shadow credential reference is empty");
      const reference = `shadow:${epoch}:${suffix}`;
      const entries = await this.#readEntries();
      entries[reference] = credential;
      await this.#writeEntries(entries);
      return reference;
    });
  }

  delete(reference: string): Promise<void> {
    return this.#withLock(async () => {
      if (this.#failDeleteOnce) {
        this.#failDeleteOnce = false;
        throw new Error("injected shadow credential cleanup failure");
      }
      const entries = await this.#readEntries();
      delete entries[reference];
      if (Object.keys(entries).length === 0) {
        await this.#storage.remove(SHADOW_CREDENTIAL_KEY);
      } else {
        await this.#writeEntries(entries);
      }
    });
  }

  clearAll(): Promise<void> {
    this.#offeredCredential = null;
    this.#failDeleteOnce = false;
    return this.#withLock(async () => {
      await this.#storage.remove(SHADOW_CREDENTIAL_KEY);
    });
  }

  count(): Promise<number> {
    return this.#withLock(async () => Object.keys(await this.#readEntries()).length);
  }

  async #readEntries(): Promise<Record<string, string>> {
    const snapshot = await this.#storage.get(SHADOW_CREDENTIAL_KEY);
    return parseCredentialStore(snapshot[SHADOW_CREDENTIAL_KEY]);
  }

  #writeEntries(entries: Record<string, string>): Promise<void> {
    const value: ShadowCredentialStore = Object.freeze({
      version: 1,
      entries: Object.freeze({ ...entries }),
    });
    return this.#storage.set({ [SHADOW_CREDENTIAL_KEY]: value });
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

export class ShadowVerificationApi implements SessionApiPort {
  readonly #fetch: ShadowFetch;
  readonly #endpoint: string;

  constructor(fetchImpl: ShadowFetch, apiBase: string) {
    this.#fetch = fetchImpl;
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/account/me`;
  }

  async verifyCredential(credential: string): Promise<VerificationResult> {
    let response: ShadowFetchResponse;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential}` },
      });
    } catch {
      return { kind: "unavailable" };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: "rejected" };
    }
    if (!response.ok) return { kind: "unavailable" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "malformed" };
    }
    if (!isRecord(body) || typeof body.account_id !== "string") {
      return { kind: "malformed" };
    }
    const accountId = body.account_id.trim();
    return accountId
      ? { kind: "verified", accountId }
      : { kind: "malformed" };
  }
}
