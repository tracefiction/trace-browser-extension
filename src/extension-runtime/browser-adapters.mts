import type {
  CredentialAcquisition,
  CredentialPort,
  SessionApiPort,
  SessionEnvelope,
  SessionStoragePort,
  VerificationResult,
} from "../extension-core/index.mjs";

export const SESSION_ENVELOPE_KEY = "traceSessionEnvelopeV1" as const;
export const SESSION_CREDENTIALS_KEY = "traceSessionCredentialsV1" as const;

export const LEGACY_ACCOUNT_KEYS = Object.freeze([
  "authToken",
  "traceAuthState",
  "traceAccountId",
  "libraryOverlayCache",
  "libraryOverlayFetchedAt",
  "traceWorkStatesV1",
  "traceUserPro",
  "traceLibraryCount",
  "traceFirstSaveSeen",
  "traceAo3SavedFiltersV1",
  "traceAo3SavedFiltersDeletedV1",
  "traceAo3SavedFiltersSyncV1",
  "traceAo3SavedFiltersClientIdV1",
  "traceAo3SavedFiltersActiveV1",
] as const);

export interface RuntimePort {
  readonly id?: string;
  readonly lastError?: { readonly message?: string };
  readonly onMessage: {
    addListener(listener: RuntimeMessageListener): void;
  };
  readonly getPlatformInfo?: (...args: unknown[]) => unknown;
  readonly sendNativeMessage?: (...args: unknown[]) => unknown;
}

export interface TabsPort {
  readonly query: (...args: unknown[]) => unknown;
  readonly sendMessage: (...args: unknown[]) => unknown;
}

export type RuntimeMessageListener = (
  message: unknown,
  sender: {
    readonly id?: string;
    readonly url?: string;
    readonly tab?: { readonly url?: string };
  },
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface StorageArea {
  readonly get: (...args: unknown[]) => unknown;
  readonly set: (...args: unknown[]) => unknown;
  readonly remove: (...args: unknown[]) => unknown;
}

export interface BrowserTab {
  readonly id?: number;
  readonly url?: string;
  readonly active?: boolean;
  readonly lastAccessed?: number;
}

export class BrowserStorage {
  readonly #area: StorageArea;
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(area: StorageArea, runtime: RuntimePort, mode: "callback" | "promise") {
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
          if (message) reject(new Error(message));
          else resolve(value);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}

export class BrowserSessionStoragePort implements SessionStoragePort {
  readonly #storage: BrowserStorage;

  constructor(storage: BrowserStorage) {
    this.#storage = storage;
  }

  async read(): Promise<unknown | null> {
    const snapshot = await this.#storage.get(SESSION_ENVELOPE_KEY);
    return snapshot[SESSION_ENVELOPE_KEY] ?? null;
  }

  write(envelope: SessionEnvelope): Promise<void> {
    return this.#storage.set({ [SESSION_ENVELOPE_KEY]: envelope });
  }

  clearAll(): Promise<void> {
    return this.#storage.remove(SESSION_ENVELOPE_KEY);
  }
}

interface CredentialStore {
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

export interface CredentialProvider {
  acquire(purpose: "connect" | "refresh"): Promise<CredentialAcquisition>;
  cancel(): void;
}

export class BrowserCredentialPort implements CredentialPort {
  readonly #storage: BrowserStorage;
  readonly #provider: CredentialProvider;
  readonly #randomId: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(storage: BrowserStorage, provider: CredentialProvider, randomId: () => string) {
    this.#storage = storage;
    this.#provider = provider;
    this.#randomId = randomId;
  }

  acquire(purpose: "connect" | "refresh"): Promise<CredentialAcquisition> {
    return this.#provider.acquire(purpose);
  }

  cancelAcquisition(): void {
    this.#provider.cancel();
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
      if (!suffix) throw new TypeError("credential reference is empty");
      const reference = `session:${epoch}:${suffix}`;
      const entries = await this.#readEntries();
      entries[reference] = credential;
      await this.#writeEntries(entries);
      return reference;
    });
  }

  delete(reference: string): Promise<void> {
    return this.#withLock(async () => {
      const entries = await this.#readEntries();
      delete entries[reference];
      if (Object.keys(entries).length === 0) {
        await this.#storage.remove(SESSION_CREDENTIALS_KEY);
      } else {
        await this.#writeEntries(entries);
      }
    });
  }

  clearAll(): Promise<void> {
    // #withLock mutates #tail synchronously, which is the ordering guarantee
    // SessionService relies on when it detaches cleanup before a later Connect.
    return this.#withLock(async () => {
      await this.#storage.remove(SESSION_CREDENTIALS_KEY);
    });
  }

  async #readEntries(): Promise<Record<string, string>> {
    const snapshot = await this.#storage.get(SESSION_CREDENTIALS_KEY);
    return parseCredentialStore(snapshot[SESSION_CREDENTIALS_KEY]);
  }

  #writeEntries(entries: Record<string, string>): Promise<void> {
    const value: CredentialStore = Object.freeze({
      version: 1,
      entries: Object.freeze({ ...entries }),
    });
    return this.#storage.set({ [SESSION_CREDENTIALS_KEY]: value });
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

export class LegacyAccountState {
  readonly #storage: BrowserStorage;

  constructor(storage: BrowserStorage) {
    this.#storage = storage;
  }

  clear(): Promise<void> {
    return this.#storage.remove(LEGACY_ACCOUNT_KEYS);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    promise.then((value) => finish(value), () => finish(null));
  });
}

function extensionCall<T>(
  target: Record<string, (...args: unknown[]) => unknown>,
  method: string,
  args: readonly unknown[],
  runtime: RuntimePort,
  mode: "callback" | "promise",
): Promise<T> {
  if (mode === "promise") {
    try {
      return Promise.resolve(target[method]!(...args) as T | PromiseLike<T>);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    try {
      target[method]!(...args, (value: T) => {
        const message = runtime.lastError?.message;
        if (message) reject(new Error(message));
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export class ExplicitCredentialProvider implements CredentialProvider {
  readonly #runtime: RuntimePort;
  readonly #tabs: TabsPort;
  readonly #mode: "callback" | "promise";
  readonly #webOrigin: string;
  readonly #webTabPattern: string;
  readonly #randomId: () => string;
  #generation = 0;
  #isIos: Promise<boolean> | null = null;

  constructor(options: {
    runtime: RuntimePort;
    tabs: TabsPort;
    mode: "callback" | "promise";
    webOrigin: string;
    randomId: () => string;
  }) {
    this.#runtime = options.runtime;
    this.#tabs = options.tabs;
    this.#mode = options.mode;
    const webUrl = new URL(options.webOrigin);
    this.#webOrigin = webUrl.origin;
    this.#webTabPattern = `${webUrl.protocol}//${webUrl.hostname}/*`;
    this.#randomId = options.randomId;
  }

  async acquire(purpose: "connect" | "refresh"): Promise<CredentialAcquisition> {
    const generation = ++this.#generation;
    const result = (await this.#detectIos())
      ? await this.#acquireNative()
      : await this.#acquireFromTraceTab(purpose);
    return generation === this.#generation ? result : { kind: "cancelled" };
  }

  cancel(): void {
    this.#generation += 1;
  }

  async #detectIos(): Promise<boolean> {
    this.#isIos ??= (async () => {
      if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
      if (typeof this.#runtime.getPlatformInfo !== "function") return false;
      try {
        const info = await extensionCall<{ readonly os?: string }>(
          this.#runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
          "getPlatformInfo",
          [],
          this.#runtime,
          this.#mode,
        );
        return info?.os === "ios";
      } catch {
        return false;
      }
    })();
    return this.#isIos;
  }

  async #acquireFromTraceTab(
    purpose: "connect" | "refresh",
  ): Promise<CredentialAcquisition> {
    let tabs: readonly BrowserTab[];
    try {
      tabs = await extensionCall<readonly BrowserTab[]>(
        this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
        "query",
        [{ url: [this.#webTabPattern] }],
        this.#runtime,
        this.#mode,
      );
    } catch {
      return { kind: "unavailable" };
    }
    const candidates = tabs
      .filter((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") return false;
        try {
          return new URL(tab.url).origin === this.#webOrigin;
        } catch {
          return false;
        }
      })
      .sort((left, right) =>
        Number(right.active === true) - Number(left.active === true) ||
        (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0),
      );

    const deadline = Date.now() + 10_000;
    for (const tab of candidates) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const requestId = this.#randomId();
      const response = await withTimeout(
        extensionCall<unknown>(
          this.#tabs as unknown as Record<string, (...args: unknown[]) => unknown>,
          "sendMessage",
          [tab.id, {
            type: "TRACE_CREDENTIAL_GRANT_REQUEST",
            protocolVersion: 1,
            requestId,
            purpose,
          }],
          this.#runtime,
          this.#mode,
        ),
        remainingMs,
      );
      if (!isRecord(response) || response.requestId !== requestId) continue;
      const credential = typeof response.token === "string" ? response.token.trim() : "";
      if (response.ok === true && credential) return { kind: "credential", credential };
    }
    return { kind: "absent" };
  }

  async #acquireNative(): Promise<CredentialAcquisition> {
    if (typeof this.#runtime.sendNativeMessage !== "function") return { kind: "absent" };
    const request = { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", protocolVersion: 2 };
    const attempts: readonly (readonly unknown[])[] = [
      [request],
      ["com.tracefiction.trace", request],
    ];
    const deadline = Date.now() + 5_000;
    for (const args of attempts) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await withTimeout(
        extensionCall<unknown>(
          this.#runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
          "sendNativeMessage",
          args,
          this.#runtime,
          this.#mode,
        ),
        remainingMs,
      );
      if (!isRecord(response)) continue;
      const credential = typeof response.token === "string" ? response.token.trim() : "";
      if ((response.ok === true || response.ok === "true") && credential) {
        return { kind: "credential", credential };
      }
    }
    return { kind: "absent" };
  }
}

export interface PendingFirstStoryResponse {
  readonly ok: boolean;
  readonly url?: string;
  readonly mode?: "story" | "browse";
  readonly hostKind?: "ao3" | "ffn";
  readonly handoffId?: string;
  readonly expiresAt?: number;
  readonly expired?: true;
  readonly error?: "native_unavailable" | "native_error";
}

function sanitizePendingFirstStoryResponse(response: unknown): PendingFirstStoryResponse {
  if (!isRecord(response)) return { ok: false, error: "native_unavailable" };
  if (response.ok !== true && response.ok !== "true") {
    return { ok: false, error: "native_error" };
  }
  const sanitized: {
    ok: true;
    url: string;
    mode?: "story" | "browse";
    hostKind?: "ao3" | "ffn";
    handoffId?: string;
    expiresAt?: number;
    expired?: true;
  } = { ok: true, url: "" };
  if (typeof response.url === "string" && response.url.length <= 4_096) {
    sanitized.url = response.url.trim();
  }
  if (response.mode === "story" || response.mode === "browse") {
    sanitized.mode = response.mode;
  }
  if (response.hostKind === "ao3" || response.hostKind === "ffn") {
    sanitized.hostKind = response.hostKind;
  }
  if (
    typeof response.handoffId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(response.handoffId.trim())
  ) {
    sanitized.handoffId = response.handoffId.trim();
  }
  const expiresAt = typeof response.expiresAt === "number"
    ? response.expiresAt
    : typeof response.expiresAt === "string"
      ? Number(response.expiresAt)
      : Number.NaN;
  if (Number.isFinite(expiresAt)) sanitized.expiresAt = expiresAt;
  if (response.expired === true || response.expired === "true") sanitized.expired = true;
  return Object.freeze(sanitized);
}

export class NativePendingFirstStoryReader {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(runtime: RuntimePort, mode: "callback" | "promise") {
    this.#runtime = runtime;
    this.#mode = mode;
  }

  async read(): Promise<PendingFirstStoryResponse> {
    if (typeof this.#runtime.sendNativeMessage !== "function") {
      return { ok: false, error: "native_unavailable" };
    }
    const request = { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" };
    const attempts: readonly (readonly unknown[])[] = [
      [request],
      ["com.tracefiction.trace", request],
    ];
    const deadline = Date.now() + 5_000;
    for (const args of attempts) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await withTimeout(
        extensionCall<unknown>(
          this.#runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
          "sendNativeMessage",
          args,
          this.#runtime,
          this.#mode,
        ),
        remainingMs,
      );
      if (response !== null) return sanitizePendingFirstStoryResponse(response);
    }
    return { ok: false, error: "native_unavailable" };
  }
}

export class VerificationApi implements SessionApiPort {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #onRetryDisposition: (disposition: "automatic" | "manual" | "none") => void;

  constructor(
    fetchImpl: typeof fetch,
    apiBase: string,
    onRetryDisposition: (disposition: "automatic" | "manual" | "none") => void = () => {},
  ) {
    this.#fetch = fetchImpl;
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/account/me`;
    this.#onRetryDisposition = onRetryDisposition;
  }

  async verifyCredential(credential: string): Promise<VerificationResult> {
    const response = await withTimeout(
      this.#fetch(this.#endpoint, {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential}` },
      }),
      10_000,
    );
    if (response === null) {
      this.#onRetryDisposition("automatic");
      return { kind: "unavailable" };
    }
    if (response.status === 429) {
      this.#onRetryDisposition("manual");
      return { kind: "unavailable" };
    }
    if (response.status >= 500) {
      this.#onRetryDisposition("automatic");
      return { kind: "unavailable" };
    }
    this.#onRetryDisposition("none");
    if (response.status === 401 || response.status === 403) return { kind: "rejected" };
    if (!response.ok) return { kind: "account_unavailable" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "invalid_response" };
    }
    if (!isRecord(body) || typeof body.account_id !== "string" || !body.account_id.trim()) {
      return { kind: "invalid_response" };
    }
    return { kind: "verified", accountId: body.account_id.trim() };
  }
}
