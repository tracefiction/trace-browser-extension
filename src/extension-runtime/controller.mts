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
  LegacyAccountState,
  VerificationApi,
  type RuntimePort,
  type StorageArea,
  type TabsPort,
} from "./browser-adapters.mjs";

export type SessionMode = "kernel" | "disabled";

export const SESSION_MESSAGE_TYPES = Object.freeze({
  snapshot: "TRACE_SESSION_GET_SNAPSHOT",
  action: "TRACE_SESSION_ACTION",
  connectAndSave: "TRACE_CONNECT_AND_SAVE",
  status: "TRACE_EXTENSION_STATUS_QUERY",
});

type SessionAction = "connect" | "cancel" | "disconnect" | "retry" | "reconnect";

interface RuntimeEnvironment {
  readonly mode: SessionMode;
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly storageArea: StorageArea;
  readonly storageMode: "callback" | "promise";
  readonly fetch: typeof fetch;
  readonly apiBase: string;
  readonly webOrigin: string;
  readonly randomId: () => string;
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
            ? "error"
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
  readonly #legacy: LegacyAccountState;
  readonly #service: SessionService;
  #initialization: Promise<void> | null = null;
  #storageFailure = false;

  constructor(environment: RuntimeEnvironment) {
    this.#mode = environment.mode;
    const storage = new BrowserStorage(
      environment.storageArea,
      environment.runtime,
      environment.storageMode,
    );
    this.#sessionStorage = new BrowserSessionStoragePort(storage);
    this.#legacy = new LegacyAccountState(storage);
    this.#credentials = new BrowserCredentialPort(
      storage,
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
      api: new VerificationApi(environment.fetch, environment.apiBase),
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

  async handle(message: unknown): Promise<RuntimeResponse | ExtensionStatusResponse | null> {
    if (!isRecord(message) || typeof message.type !== "string") return null;
    if (!Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) return null;
    await this.start();

    if (message.type === SESSION_MESSAGE_TYPES.status) {
      if (typeof message.nonce !== "string" || !message.nonce.trim()) return null;
      return toExtensionStatus(this.snapshot());
    }
    if (message.type === SESSION_MESSAGE_TYPES.snapshot) return this.#response();
    if (message.type === SESSION_MESSAGE_TYPES.connectAndSave) {
      const action = await this.#runAction("connect");
      return this.#response(
        action,
        this.snapshot().state === "connected" ? "commands_unavailable" : undefined,
      );
    }
    if (!isSessionAction(message.action)) return this.#response({ kind: "ignored" });
    return this.#response(await this.#runAction(message.action));
  }

  async #startOnce(): Promise<void> {
    try {
      await this.#legacy.clear();
      if (this.#mode === "disabled") {
        await this.#sessionStorage.clearAll();
        await this.#credentials.clearAll();
      } else {
        await this.#service.start();
      }
      this.#storageFailure = false;
    } catch {
      this.#storageFailure = true;
    }
  }

  async #retryInitialization(): Promise<SessionActionResult> {
    if (!this.#storageFailure) return { kind: "ignored" };
    try {
      await this.#legacy.clear();
      if (this.#mode === "disabled") {
        await this.#sessionStorage.clearAll();
        await this.#credentials.clearAll();
      } else {
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
  environment.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRecord(message) || !Object.values(SESSION_MESSAGE_TYPES).includes(message.type as never)) {
      return false;
    }
    void controller.handle(message).then(
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
