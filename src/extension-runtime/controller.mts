import {
  SessionService,
  type DiagnosticEvent,
  type DiagnosticsPort,
  type SessionActionResult,
  type SessionSnapshot,
} from "../extension-core/index.mjs";
import {
  BrowserCredentialPort,
  BrowserSessionStoragePort,
  BrowserStorage,
  ExplicitCredentialProvider,
  KernelAlarmState,
  LegacyAccountState,
  NativePendingFirstStoryReader,
  VerificationApi,
  type PendingFirstStoryResponse,
  type AlarmsPort,
  type RuntimePort,
  type StorageArea,
  type TabsPort,
} from "./browser-adapters.mjs";
import {
  BrowserPrivateRecordDatabase,
  type PrivateRecordDatabase,
} from "./private-database.mjs";

export type SessionMode = "kernel" | "disabled";

export const SESSION_MESSAGE_TYPES = Object.freeze({
  snapshot: "TRACE_SESSION_GET_SNAPSHOT",
  action: "TRACE_SESSION_ACTION",
  connectAndSave: "TRACE_CONNECT_AND_SAVE",
  pendingFirstStory: "TRACE_IOS_PENDING_FIRST_STORY_GET",
  status: "TRACE_EXTENSION_STATUS_QUERY",
});

type SessionAction = "connect" | "cancel" | "disconnect" | "retry" | "reconnect";

interface RuntimeEnvironment {
  readonly mode: SessionMode;
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly alarms: AlarmsPort;
  readonly storageArea: StorageArea;
  readonly databaseFactory: IDBFactory;
  readonly privateDatabase?: PrivateRecordDatabase;
  readonly storageMode: "callback" | "promise";
  readonly fetch: typeof fetch;
  readonly apiBase: string;
  readonly webOrigin: string;
  readonly randomId: () => string;
  readonly retryClock?: RetryClock;
}

interface RetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface RuntimeResponse {
  readonly ok: true;
  readonly snapshot: PublicSessionSnapshot;
  readonly action?: SessionActionResult;
  readonly error?: "commands_unavailable";
}

type PublicSessionSnapshot = Pick<
  SessionSnapshot,
  "state" | "reason" | "canExecuteAuthenticated"
>;

interface ExtensionStatusResponse {
  readonly installed: true;
  readonly connected: boolean;
  readonly authState: "connected" | "signed_out" | "reconnect_required" | "error" | "unknown";
}

function toExtensionStatus(snapshot: SessionSnapshot): ExtensionStatusResponse {
  const authState: ExtensionStatusResponse["authState"] =
    snapshot.state === "connected"
      ? "connected"
      : snapshot.state === "signed_out"
        ? "signed_out"
        : snapshot.state === "reconnect_required"
          ? "reconnect_required"
          : snapshot.state === "degraded"
            ? "unknown"
            : "unknown";
  return Object.freeze({
    installed: true,
    connected: snapshot.state === "connected",
    authState,
  });
}

function toPublicSessionSnapshot(snapshot: SessionSnapshot): PublicSessionSnapshot {
  return Object.freeze({
    state: snapshot.state,
    reason: snapshot.reason,
    canExecuteAuthenticated: snapshot.canExecuteAuthenticated,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionAction(value: unknown): value is SessionAction {
  return (
    value === "connect" ||
    value === "cancel" ||
    value === "disconnect" ||
    value === "retry" ||
    value === "reconnect"
  );
}

const DEGRADED_STORAGE_SNAPSHOT: SessionSnapshot = Object.freeze({
  state: "degraded",
  accountId: null,
  canExecuteAuthenticated: false,
  reason: "storage_unavailable",
});

const DISABLED_SNAPSHOT: SessionSnapshot = Object.freeze({
  state: "signed_out",
  accountId: null,
  canExecuteAuthenticated: false,
  reason: "none",
});

const RETRY_DELAYS_MS = Object.freeze([750, 2_500, 8_000] as const);

const DEFAULT_RETRY_CLOCK: RetryClock = Object.freeze({
  setTimeout(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

type RuntimeSender = Parameters<Parameters<RuntimePort["onMessage"]["addListener"]>[0]>[1];

function isSupportedArchiveSender(sender: RuntimeSender | undefined): boolean {
  const rawUrl = sender?.tab?.url ?? sender?.url;
  if (typeof rawUrl !== "string") return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "archiveofourown.org" ||
      host.endsWith(".archiveofourown.org") ||
      host === "archiveofourown.gay" ||
      host.endsWith(".archiveofourown.gay") ||
      host === "archive.transformativeworks.org" ||
      host === "www.fanfiction.net" ||
      host === "m.fanfiction.net"
    );
  } catch {
    return false;
  }
}

class MemoryDiagnostics implements DiagnosticsPort {
  readonly #events: DiagnosticEvent[] = [];

  record(event: DiagnosticEvent): void {
    this.#events.push(Object.freeze({ ...event }));
    if (this.#events.length > 80) this.#events.shift();
  }
}

export class SessionRuntimeController {
  readonly #mode: SessionMode;
  readonly #sessionStorage: BrowserSessionStoragePort;
  readonly #credentials: BrowserCredentialPort;
  readonly #database: PrivateRecordDatabase;
  readonly #legacy: LegacyAccountState;
  readonly #alarms: KernelAlarmState;
  readonly #pendingFirstStory: NativePendingFirstStoryReader;
  readonly #service: SessionService;
  readonly #retryClock: RetryClock;
  #initialization: Promise<void> | null = null;
  #storageFailure = false;
  #automaticVerificationRetry = false;
  #retryAttempt = 0;
  #retryGeneration = 0;
  #retryTimer: unknown | null = null;

  constructor(environment: RuntimeEnvironment) {
    this.#mode = environment.mode;
    const storage = new BrowserStorage(
      environment.storageArea,
      environment.runtime,
      environment.storageMode,
    );
    this.#database = environment.privateDatabase ?? new BrowserPrivateRecordDatabase(
      environment.databaseFactory,
    );
    this.#sessionStorage = new BrowserSessionStoragePort(this.#database);
    this.#legacy = new LegacyAccountState(storage);
    this.#alarms = new KernelAlarmState(
      environment.alarms,
      environment.runtime,
      environment.storageMode,
    );
    this.#pendingFirstStory = new NativePendingFirstStoryReader(
      environment.runtime,
      environment.storageMode,
    );
    this.#retryClock = environment.retryClock ?? DEFAULT_RETRY_CLOCK;
    this.#credentials = new BrowserCredentialPort(
      this.#database,
      new ExplicitCredentialProvider({
        runtime: environment.runtime,
        tabs: environment.tabs,
        mode: environment.storageMode,
        webOrigin: environment.webOrigin,
        randomId: environment.randomId,
      }),
      environment.randomId,
    );
    this.#service = new SessionService({
      storage: this.#sessionStorage,
      credentials: this.#credentials,
      api: new VerificationApi(environment.fetch, environment.apiBase, (disposition) => {
        this.#automaticVerificationRetry = disposition === "automatic";
      }),
      diagnostics: new MemoryDiagnostics(),
    });
  }

  start(): Promise<void> {
    this.#initialization ??= this.#startOnce();
    return this.#initialization;
  }

  snapshot(): SessionSnapshot {
    if (this.#storageFailure) return DEGRADED_STORAGE_SNAPSHOT;
    if (this.#mode === "disabled") return DISABLED_SNAPSHOT;
    return this.#service.snapshot();
  }

  async handle(
    message: unknown,
    sender?: RuntimeSender,
  ): Promise<RuntimeResponse | ExtensionStatusResponse | PendingFirstStoryResponse | null> {
    if (!isRecord(message) || typeof message.type !== "string") return null;
    if (!Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) return null;
    await this.start();

    if (message.type === SESSION_MESSAGE_TYPES.status) {
      if (typeof message.nonce !== "string" || !message.nonce.trim()) return null;
      return toExtensionStatus(this.snapshot());
    }
    if (message.type === SESSION_MESSAGE_TYPES.pendingFirstStory) {
      return isSupportedArchiveSender(sender)
        ? this.#pendingFirstStory.read()
        : { ok: false, error: "native_unavailable" };
    }
    if (message.type === SESSION_MESSAGE_TYPES.snapshot) return this.#response();
    if (message.type === SESSION_MESSAGE_TYPES.connectAndSave) {
      if (!isSupportedArchiveSender(sender)) return null;
      const action = await this.#runManualAction("connect");
      return this.#response(
        action,
        this.snapshot().state === "connected" ? "commands_unavailable" : undefined,
      );
    }
    if (!isSessionAction(message.action)) return this.#response({ kind: "ignored" });
    return this.#response(await this.#runManualAction(message.action));
  }

  async #startOnce(): Promise<void> {
    try {
      await this.#legacy.clear();
      if (this.#mode === "disabled") {
        await this.#alarms.clearAll();
        await this.#database.deleteDatabase();
      } else {
        await this.#alarms.clearRetired();
        this.#automaticVerificationRetry = false;
        await this.#service.start();
      }
      this.#storageFailure = false;
    } catch {
      this.#storageFailure = true;
    }
    this.#reconcileAutomaticRetry();
  }

  async #retryInitialization(): Promise<SessionActionResult> {
    if (!this.#storageFailure) return { kind: "ignored" };
    try {
      await this.#legacy.clear();
      if (this.#mode === "disabled") {
        await this.#alarms.clearAll();
        await this.#database.deleteDatabase();
      } else {
        await this.#alarms.clearRetired();
        await this.#service.start();
      }
      this.#storageFailure = false;
      return this.#mode === "disabled"
        ? { kind: "completed", state: "signed_out" }
        : { kind: "ignored" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async #runAction(action: SessionAction): Promise<SessionActionResult> {
    if (action === "connect" || action === "retry" || action === "reconnect") {
      this.#automaticVerificationRetry = false;
    }
    if (action === "retry" && this.#storageFailure) return this.#retryInitialization();
    if (this.#storageFailure || this.#mode === "disabled") return { kind: "ignored" };

    if (action === "connect") return this.#service.connect();
    if (action === "retry") return this.#service.retry();
    if (action === "cancel") {
      const result = await this.#service.cancelConnect();
      await this.#clearLegacyAfterDisconnect(result);
      return result;
    }
    if (action === "disconnect") {
      const result = await this.#service.disconnect();
      await this.#clearLegacyAfterDisconnect(result);
      return result;
    }

    const disconnected = await this.#service.disconnect();
    await this.#clearLegacyAfterDisconnect(disconnected);
    if (disconnected.kind !== "completed" || disconnected.state !== "signed_out") {
      return disconnected;
    }
    return this.#service.connect();
  }

  async #runManualAction(action: SessionAction): Promise<SessionActionResult> {
    this.#cancelAutomaticRetry(true);
    const result = await this.#runAction(action);
    this.#reconcileAutomaticRetry();
    return result;
  }

  #automaticRetryIsEligible(): boolean {
    const snapshot = this.snapshot();
    return (
      snapshot.state === "degraded" &&
      (
        snapshot.reason === "storage_unavailable" ||
        (snapshot.reason === "verification_unavailable" && this.#automaticVerificationRetry)
      )
    );
  }

  #reconcileAutomaticRetry(): void {
    if (!this.#automaticRetryIsEligible()) {
      this.#cancelAutomaticRetry(true);
      return;
    }
    if (this.#retryTimer !== null || this.#retryAttempt >= RETRY_DELAYS_MS.length) return;
    const generation = this.#retryGeneration;
    const delayMs = RETRY_DELAYS_MS[this.#retryAttempt]!;
    this.#retryAttempt += 1;
    this.#retryTimer = this.#retryClock.setTimeout(() => {
      this.#retryTimer = null;
      void this.#runAutomaticRetry(generation);
    }, delayMs);
  }

  async #runAutomaticRetry(generation: number): Promise<void> {
    if (generation !== this.#retryGeneration || !this.#automaticRetryIsEligible()) return;
    await this.#runAction("retry");
    if (generation !== this.#retryGeneration) return;
    this.#reconcileAutomaticRetry();
  }

  #cancelAutomaticRetry(resetAttempt: boolean): void {
    this.#retryGeneration += 1;
    if (this.#retryTimer !== null) {
      this.#retryClock.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (resetAttempt) this.#retryAttempt = 0;
  }

  async #clearLegacyAfterDisconnect(result: SessionActionResult): Promise<void> {
    if (result.kind !== "completed" || result.state !== "signed_out") return;
    try {
      await this.#legacy.clear();
    } catch {
      // The higher persisted epoch owns correctness. Legacy cleanup is retried
      // on every boot and never permits the gated legacy owner to run.
    }
  }

  #response(action?: SessionActionResult, error?: RuntimeResponse["error"]): RuntimeResponse {
    return Object.freeze({
      ok: true as const,
      snapshot: toPublicSessionSnapshot(this.snapshot()),
      ...(action === undefined ? {} : { action }),
      ...(error === undefined ? {} : { error }),
    });
  }
}

export function installSessionRuntime(environment: RuntimeEnvironment): SessionRuntimeController {
  const controller = new SessionRuntimeController(environment);
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || !Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) {
      return false;
    }
    void controller.handle(message, sender).then(
      (response) => sendResponse(response),
      () => sendResponse({
        ok: true,
        snapshot: toPublicSessionSnapshot(DEGRADED_STORAGE_SNAPSHOT),
      }),
    );
    return true;
  });
  void controller.start();
  return controller;
}
