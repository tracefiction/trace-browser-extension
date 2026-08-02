import type {
  ArchivePermissionSnapshot,
  ArchivePermissionSnapshotPort,
  ArchiveReadinessReceiptPort,
  ArchiveRunReceipt,
  CredentialAcquisition,
  CredentialPort,
  SessionApiPort,
  SessionEnvelope,
  SessionStoragePort,
  PendingStoryHandoffPort,
  StorySaveReceiptPort,
  StoryHostKind,
  VerificationResult,
} from "../extension-core/index.mjs";
import {
  PRIVATE_RECORD_KEYS,
  type PrivateRecordDatabase,
} from "./private-database.mjs";
import {
  BrowserStorage,
  extensionCall,
  type AlarmsPort,
  type BrowserTab,
  type PermissionsPort,
  type RuntimePort,
  type TabsPort,
} from "./browser-platform.mjs";
export {
  BrowserStorage,
  extensionCall,
  type AlarmsPort,
  type BrowserTab,
  type PermissionsPort,
  type RuntimeMessageListener,
  type RuntimeMessageSender,
  type RuntimePort,
  type StorageArea,
  type TabsPort,
} from "./browser-platform.mjs";

export const LEGACY_SESSION_ENVELOPE_KEY = "traceSessionEnvelopeV1" as const;
export const LEGACY_SESSION_CREDENTIALS_KEY = "traceSessionCredentialsV1" as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ACCOUNT_DATA_ALARM = "traceAccountDataRefresh" as const;
export const SAVED_FILTER_SYNC_ALARM = "traceAo3SavedFiltersSync" as const;
export const LEGACY_ACCOUNT_ALARMS = Object.freeze([
  "traceLibraryOverlay",
] as const);

export const SAVED_FILTER_LOCAL_KEYS = Object.freeze({
  presets: "traceAo3SavedFiltersV1",
  deleted: "traceAo3SavedFiltersDeletedV1",
  syncMeta: "traceAo3SavedFiltersSyncV1",
  clientId: "traceAo3SavedFiltersClientIdV1",
  activeMeta: "traceAo3SavedFiltersActiveV1",
} as const);

export const LEGACY_ACCOUNT_KEYS = Object.freeze([
  LEGACY_SESSION_ENVELOPE_KEY,
  LEGACY_SESSION_CREDENTIALS_KEY,
  "authToken",
  "traceAuthState",
  "traceAccountId",
  "libraryOverlayCache",
  "libraryOverlayFetchedAt",
  "traceWorkStatesV1",
  "traceUserPro",
  "traceLibraryCount",
  "traceFirstSaveSeen",
] as const);

export const DISABLED_LOCAL_KEYS = Object.freeze([
  ...LEGACY_ACCOUNT_KEYS,
  ...Object.values(SAVED_FILTER_LOCAL_KEYS),
  "traceArchiveReadiness",
] as const);

export class BrowserSessionStoragePort implements SessionStoragePort {
  readonly #database: PrivateRecordDatabase;

  constructor(database: PrivateRecordDatabase) {
    this.#database = database;
  }

  read(): Promise<unknown | null> {
    return this.#database.get(PRIVATE_RECORD_KEYS.sessionEnvelope);
  }

  write(envelope: SessionEnvelope): Promise<void> {
    return this.#database.put(PRIVATE_RECORD_KEYS.sessionEnvelope, envelope);
  }

  clearAll(): Promise<void> {
    return this.#database.delete(PRIVATE_RECORD_KEYS.sessionEnvelope);
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
  readonly #database: PrivateRecordDatabase;
  readonly #provider: CredentialProvider;
  readonly #randomId: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    database: PrivateRecordDatabase,
    provider: CredentialProvider,
    randomId: () => string,
  ) {
    this.#database = database;
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
        await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
      } else {
        await this.#writeEntries(entries);
      }
    });
  }

  clearAll(): Promise<void> {
    // #withLock mutates #tail synchronously, which is the ordering guarantee
    // SessionService relies on when it detaches cleanup before a later Connect.
    return this.#withLock(async () => {
      await this.#database.delete(PRIVATE_RECORD_KEYS.sessionCredentials);
    });
  }

  async #readEntries(): Promise<Record<string, string>> {
    return parseCredentialStore(
      await this.#database.get(PRIVATE_RECORD_KEYS.sessionCredentials),
    );
  }

  #writeEntries(entries: Record<string, string>): Promise<void> {
    const value: CredentialStore = Object.freeze({
      version: 1,
      entries: Object.freeze({ ...entries }),
    });
    return this.#database.put(PRIVATE_RECORD_KEYS.sessionCredentials, value);
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

  clearAll(): Promise<void> {
    return this.#storage.remove(DISABLED_LOCAL_KEYS);
  }
}

export class KernelAlarmState {
  readonly #alarms: AlarmsPort;
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(
    alarms: AlarmsPort,
    runtime: RuntimePort,
    mode: "callback" | "promise",
  ) {
    this.#alarms = alarms;
    this.#runtime = runtime;
    this.#mode = mode;
  }

  async clearRetired(): Promise<void> {
    for (const name of LEGACY_ACCOUNT_ALARMS) await this.#clear(name);
  }

  async clearAll(): Promise<void> {
    await this.#clear(ACCOUNT_DATA_ALARM);
    await this.#clear(SAVED_FILTER_SYNC_ALARM);
    await this.clearRetired();
  }

  async #clear(name: string): Promise<void> {
    await extensionCall<unknown>(
      this.#alarms as unknown as Record<string, (...args: unknown[]) => unknown>,
      "clear",
      [name],
      this.#runtime,
      this.#mode,
    );
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

async function sendNativeMessageWithFallback(
  runtime: RuntimePort,
  mode: "callback" | "promise",
  message: Readonly<Record<string, unknown>>,
  timeoutMs = 5_000,
): Promise<unknown | null> {
  if (typeof runtime.sendNativeMessage !== "function") return null;
  const attempts: readonly (readonly unknown[])[] = [
    [message],
    ["com.tracefiction.trace", message],
  ];
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (const args of attempts) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const response = await withTimeout(
      extensionCall<unknown>(
        runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
        "sendNativeMessage",
        args,
        runtime,
        mode,
      ),
      remainingMs,
    );
    if (response !== null) return response;
  }
  return null;
}

const IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS = 2_500;
const IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS = 1_000;
const IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS = 150;

export class NativeArchiveReadinessReceiptPort implements ArchiveReadinessReceiptPort {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(runtime: RuntimePort, mode: "callback" | "promise") {
    this.#runtime = runtime;
    this.#mode = mode;
  }

  publishRunReceipt(receipt: ArchiveRunReceipt): Promise<boolean> {
    return this.#publish({
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: receipt.hostKind,
      at: receipt.at,
      ...(receipt.handoffId === undefined ? {} : { handoffId: receipt.handoffId }),
    });
  }

  publishPermissionSnapshot(snapshot: ArchivePermissionSnapshot): Promise<boolean> {
    return this.#publish({
      type: "TRACE_IOS_EXTENSION_HEARTBEAT",
      hostKind: snapshot.hostKind,
      at: snapshot.at,
      permissionSnapshot: true,
      grantedOrigins: [...snapshot.grantedOrigins],
    });
  }

  async #publish(message: Readonly<Record<string, unknown>>): Promise<boolean> {
    const response = await sendNativeMessageWithFallback(
      this.#runtime,
      this.#mode,
      message,
    );
    return isRecord(response) && (response.ok === true || response.ok === "true");
  }
}

export class NativeStorySaveReceiptPort implements StorySaveReceiptPort {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(runtime: RuntimePort, mode: "callback" | "promise") {
    this.#runtime = runtime;
    this.#mode = mode;
  }

  async publishSaveReceipt(receipt: Readonly<{
    hostKind: StoryHostKind;
    action: "quick_add";
    at: number;
    handoffId?: string;
  }>): Promise<boolean> {
    const response = await sendNativeMessageWithFallback(
      this.#runtime,
      this.#mode,
      {
        type: "TRACE_IOS_EXTENSION_HEARTBEAT",
        hostKind: receipt.hostKind,
        action: receipt.action,
        at: receipt.at,
        ...(receipt.handoffId === undefined ? {} : { handoffId: receipt.handoffId }),
      },
    );
    return isRecord(response) && (response.ok === true || response.ok === "true");
  }
}

export class NativePendingStoryHandoffPort implements PendingStoryHandoffPort {
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(runtime: RuntimePort, mode: "callback" | "promise") {
    this.#runtime = runtime;
    this.#mode = mode;
  }

  async clearExpected(handoffId: string): Promise<boolean> {
    const response = await sendNativeMessageWithFallback(
      this.#runtime,
      this.#mode,
      {
        type: "TRACE_IOS_PENDING_FIRST_STORY_CLEAR",
        handoffId,
      },
    );
    return (
      isRecord(response) &&
      (response.ok === true || response.ok === "true") &&
      response.cleared !== false &&
      response.cleared !== "false"
    );
  }
}

export class BrowserArchivePermissionSnapshotPort implements ArchivePermissionSnapshotPort {
  readonly #permissions: PermissionsPort | undefined;
  readonly #runtime: RuntimePort;
  readonly #mode: "callback" | "promise";

  constructor(
    permissions: PermissionsPort | undefined,
    runtime: RuntimePort,
    mode: "callback" | "promise",
  ) {
    this.#permissions = permissions;
    this.#runtime = runtime;
    this.#mode = mode;
  }

  async readGrantedOrigins(): Promise<readonly string[] | null> {
    if (this.#permissions === undefined) return null;
    const response = await withTimeout(
      extensionCall<unknown>(
        this.#permissions as unknown as Record<string, (...args: unknown[]) => unknown>,
        "getAll",
        [],
        this.#runtime,
        this.#mode,
      ),
      2_000,
    );
    if (!isRecord(response) || !Array.isArray(response.origins)) return null;
    return Object.freeze(
      Array.from(new Set(
        response.origins
          .filter((origin): origin is string => typeof origin === "string")
          .map((origin) => origin.trim().slice(0, 256))
          .filter(Boolean),
      )).slice(0, 64),
    );
  }
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
      ? await this.#acquireNative(generation)
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

  async #acquireNativeOnce(timeoutMs: number): Promise<CredentialAcquisition> {
    const request = { type: "TRACE_IOS_AUTH_TOKEN_REQUEST", protocolVersion: 3 };
    const response = await sendNativeMessageWithFallback(
      this.#runtime,
      this.#mode,
      request,
      timeoutMs,
    );
    if (!isRecord(response)) return { kind: "unavailable" };
    const credential =
      typeof response.credential === "string"
        ? response.credential.trim()
        : typeof response.token === "string"
          ? response.token.trim()
          : "";
    const credentialKind = response.credentialKind;
    const validKind =
      credentialKind === "device_session" ||
      credentialKind === "access_token";
    const validDeviceMetadata =
      credentialKind !== "device_session" ||
      (
        typeof response.sessionId === "string" &&
        UUID_PATTERN.test(response.sessionId) &&
        typeof response.expiresAt === "string" &&
        Number.isFinite(Date.parse(response.expiresAt))
      );
    if (
      (response.ok === true || response.ok === "true") &&
      credential &&
      validKind &&
      validDeviceMetadata
    ) {
      return { kind: "credential", credential };
    }
    return response.error === "missing_token"
      ? { kind: "absent" }
      : { kind: "unavailable" };
  }

  async #acquireNative(generation: number): Promise<CredentialAcquisition> {
    const deadline = Date.now() + IOS_NATIVE_CREDENTIAL_READ_BUDGET_MS;
    const read = () =>
      this.#acquireNativeOnce(
        Math.min(
          IOS_NATIVE_CREDENTIAL_READ_ATTEMPT_TIMEOUT_MS,
          Math.max(0, deadline - Date.now()),
        ),
      );

    const first = await read();
    if (first.kind !== "unavailable" || generation !== this.#generation) {
      return first;
    }

    const remainingBeforeDelay = deadline - Date.now();
    if (remainingBeforeDelay <= IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS) {
      return first;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, IOS_NATIVE_CREDENTIAL_READ_RETRY_DELAY_MS);
    });
    if (generation !== this.#generation || Date.now() >= deadline) {
      return { kind: "cancelled" };
    }

    return read();
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
    const request = { type: "TRACE_IOS_PENDING_FIRST_STORY_GET" };
    const response = await sendNativeMessageWithFallback(
      this.#runtime,
      this.#mode,
      request,
    );
    return response === null
      ? { ok: false, error: "native_unavailable" }
      : sanitizePendingFirstStoryResponse(response);
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
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/account`;
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
