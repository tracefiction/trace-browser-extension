import {
  SessionService,
  type DiagnosticEvent,
  type DiagnosticsPort,
  type SessionActionResult,
  type SessionSnapshot,
} from "../extension-core/index.mjs";
import {
  ShadowBrowserStorage,
  ShadowCredentialPort,
  ShadowSessionStoragePort,
  ShadowVerificationApi,
  type ShadowFetch,
  type ShadowRuntimePort,
  type ShadowStorageArea,
} from "./browser-adapters.mjs";

export const SHADOW_CONTROL_TYPES = Object.freeze({
  status: "TRACE_SHADOW_TEST_STATUS",
  connect: "TRACE_SHADOW_TEST_CONNECT",
  disconnect: "TRACE_SHADOW_TEST_DISCONNECT",
  retry: "TRACE_SHADOW_TEST_RETRY",
  compare: "TRACE_SHADOW_TEST_COMPARE",
  failCredentialDelete: "TRACE_SHADOW_TEST_FAIL_CREDENTIAL_DELETE",
  reset: "TRACE_SHADOW_TEST_RESET",
});

interface ShadowExpectedSnapshot {
  readonly state: SessionSnapshot["state"];
  readonly accountId?: string | null;
  readonly canExecuteAuthenticated?: boolean;
}

interface ShadowDiagnosticEvent {
  readonly code: DiagnosticEvent["code"] | "shadow_snapshot_mismatch";
  readonly state: SessionSnapshot["state"];
  readonly epoch: number;
}

interface ShadowStorageSummary {
  readonly sessionPresent: boolean;
  readonly credentialReferenceCount: number;
}

interface ShadowControlResponse {
  readonly ok: true;
  readonly snapshot: SessionSnapshot;
  readonly action?: SessionActionResult;
  readonly matches?: boolean;
  readonly diagnostics: readonly ShadowDiagnosticEvent[];
  readonly storage: ShadowStorageSummary;
}

interface ShadowControlError {
  readonly ok: false;
  readonly error: "invalid_control" | "unauthorized" | "shadow_internal_error";
}

export interface ShadowObserverEnvironment {
  readonly runtime: ShadowRuntimePort;
  readonly storageArea: ShadowStorageArea;
  readonly storageMode: "callback" | "promise";
  readonly fetch: ShadowFetch;
  readonly apiBase: string;
  readonly randomId: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSessionState(value: unknown): value is SessionSnapshot["state"] {
  return (
    value === "initializing" ||
    value === "signed_out" ||
    value === "connecting" ||
    value === "verifying" ||
    value === "connected" ||
    value === "degraded" ||
    value === "reconnect_required"
  );
}

class ShadowDiagnostics implements DiagnosticsPort {
  readonly #events: ShadowDiagnosticEvent[] = [];
  #lastEpoch = 0;

  record(event: DiagnosticEvent): void {
    this.#lastEpoch = event.epoch;
    this.#push({ code: event.code, state: event.state, epoch: event.epoch });
  }

  recordMismatch(state: SessionSnapshot["state"]): void {
    this.#push({ code: "shadow_snapshot_mismatch", state, epoch: this.#lastEpoch });
  }

  events(): readonly ShadowDiagnosticEvent[] {
    return Object.freeze(this.#events.map((event) => Object.freeze({ ...event })));
  }

  clear(): void {
    this.#events.length = 0;
  }

  #push(event: ShadowDiagnosticEvent): void {
    this.#events.push(Object.freeze(event));
    if (this.#events.length > 80) this.#events.shift();
  }
}

export class ShadowObserverController {
  readonly #sessionStorage: ShadowSessionStoragePort;
  readonly #credentials: ShadowCredentialPort;
  readonly #diagnostics: ShadowDiagnostics;
  readonly #service: SessionService;
  #start: Promise<SessionSnapshot> | null = null;

  constructor(environment: ShadowObserverEnvironment) {
    const storage = new ShadowBrowserStorage(
      environment.storageArea,
      environment.runtime,
      environment.storageMode,
    );
    this.#sessionStorage = new ShadowSessionStoragePort(storage);
    this.#credentials = new ShadowCredentialPort(storage, environment.randomId);
    this.#diagnostics = new ShadowDiagnostics();
    this.#service = new SessionService({
      storage: this.#sessionStorage,
      credentials: this.#credentials,
      api: new ShadowVerificationApi(environment.fetch, environment.apiBase),
      diagnostics: this.#diagnostics,
    });
  }

  start(): Promise<SessionSnapshot> {
    this.#start ??= this.#service.start();
    return this.#start.then(() => this.#service.snapshot());
  }

  async handle(message: unknown): Promise<ShadowControlResponse | ShadowControlError> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return { ok: false, error: "invalid_control" };
    }

    await this.start();
    switch (message.type) {
      case SHADOW_CONTROL_TYPES.status:
        return this.#response();
      case SHADOW_CONTROL_TYPES.connect: {
        if (!isNonEmpty(message.credential)) {
          return { ok: false, error: "invalid_control" };
        }
        this.#credentials.offer(message.credential);
        try {
          return this.#response(await this.#service.connect());
        } finally {
          this.#credentials.discardOffer();
        }
      }
      case SHADOW_CONTROL_TYPES.disconnect:
        return this.#response(await this.#service.disconnect());
      case SHADOW_CONTROL_TYPES.retry:
        return this.#response(await this.#service.retry());
      case SHADOW_CONTROL_TYPES.compare: {
        const expected = this.#parseExpected(message.expected);
        if (expected === null) return { ok: false, error: "invalid_control" };
        const snapshot = this.#service.snapshot();
        const matches = this.#matches(snapshot, expected);
        if (!matches) this.#diagnostics.recordMismatch(snapshot.state);
        return this.#response(undefined, matches);
      }
      case SHADOW_CONTROL_TYPES.failCredentialDelete:
        this.#credentials.failNextDelete();
        return this.#response();
      case SHADOW_CONTROL_TYPES.reset:
        await this.#service.disconnect();
        await this.#credentials.clearAll();
        await this.#sessionStorage.clearAll();
        this.#diagnostics.clear();
        return this.#response();
      default:
        return { ok: false, error: "invalid_control" };
    }
  }

  async #response(
    action?: SessionActionResult,
    matches?: boolean,
  ): Promise<ShadowControlResponse> {
    const [sessionPresent, credentialReferenceCount] = await Promise.all([
      this.#sessionStorage.isPresent(),
      this.#credentials.count(),
    ]);
    return Object.freeze({
      ok: true as const,
      snapshot: this.#service.snapshot(),
      ...(action === undefined ? {} : { action }),
      ...(matches === undefined ? {} : { matches }),
      diagnostics: this.#diagnostics.events(),
      storage: Object.freeze({ sessionPresent, credentialReferenceCount }),
    });
  }

  #parseExpected(value: unknown): ShadowExpectedSnapshot | null {
    if (!isRecord(value) || !isSessionState(value.state)) return null;
    if (
      Object.hasOwn(value, "accountId") &&
      value.accountId !== null &&
      typeof value.accountId !== "string"
    ) {
      return null;
    }
    if (
      Object.hasOwn(value, "canExecuteAuthenticated") &&
      typeof value.canExecuteAuthenticated !== "boolean"
    ) {
      return null;
    }
    return {
      state: value.state,
      ...(Object.hasOwn(value, "accountId")
        ? { accountId: value.accountId as string | null }
        : {}),
      ...(Object.hasOwn(value, "canExecuteAuthenticated")
        ? { canExecuteAuthenticated: value.canExecuteAuthenticated as boolean }
        : {}),
    };
  }

  #matches(snapshot: SessionSnapshot, expected: ShadowExpectedSnapshot): boolean {
    return (
      snapshot.state === expected.state &&
      (!Object.hasOwn(expected, "accountId") || snapshot.accountId === expected.accountId) &&
      (!Object.hasOwn(expected, "canExecuteAuthenticated") ||
        snapshot.canExecuteAuthenticated === expected.canExecuteAuthenticated)
    );
  }
}

export function installShadowObserver(
  environment: ShadowObserverEnvironment,
): ShadowObserverController {
  const controller = new ShadowObserverController(environment);
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message) || !Object.values(SHADOW_CONTROL_TYPES).includes(message.type as never)) {
      return false;
    }
    if (
      environment.runtime.id &&
      sender.id &&
      sender.id !== environment.runtime.id
    ) {
      sendResponse({ ok: false, error: "unauthorized" } satisfies ShadowControlError);
      return false;
    }
    void controller.handle(message).then(
      sendResponse,
      () => sendResponse({ ok: false, error: "shadow_internal_error" } satisfies ShadowControlError),
    );
    return true;
  });
  void controller.start().catch(() => {
    // The control surface reports fail-closed state; boot errors are never logged.
  });
  return controller;
}
