import type {
  BrowserStorage,
  PermissionsPort,
  RuntimePort,
  ScriptingPort,
} from "./browser-platform.mjs";

export const EARNED_PERMISSION_REGISTRATION_MESSAGE =
  "TRACE_EARNED_PERMISSION_RECONCILE";
export const EARNED_PERMISSION_STATE_KEY =
  "traceEarnedPermissionOnboardingV1";

export type EarnedPermissionRegistration = Readonly<{
  id: string;
  matches: readonly string[];
  js: readonly string[];
  runAt: string;
  persistAcrossSessions: boolean;
  excludeMatches?: readonly string[];
}>;

export type EarnedPermissionRegistrationConfig = Readonly<{
  version: number;
  registrationMode?: "dynamic" | "static";
  origins: readonly string[];
  registrations: readonly EarnedPermissionRegistration[];
}>;

type StoredState = Readonly<{
  grantAt?: number | null;
  registrationVersion?: number | null;
  promptResult?: "granted" | "declined" | null;
  completedAt?: number | null;
}>;

export type EarnedPermissionRegistrationResult = Readonly<{
  ok: boolean;
  completeGrant: boolean;
  registered: boolean;
  changed: boolean;
  grantAt?: number;
  error?: "permission_incomplete" | "registration_failed";
}>;

type Environment = Readonly<{
  runtime: RuntimePort;
  permissions: PermissionsPort;
  scripting?: ScriptingPort;
  storage: BrowserStorage;
  storageMode: "callback" | "promise";
  config: EarnedPermissionRegistrationConfig;
  clock?: () => number;
  /** Upper bound for one reconcile; a hung browser call must not wedge the queue. */
  reconcileTimeoutMs?: number;
}>;

const DEFAULT_RECONCILE_TIMEOUT_MS = 5_000;
const UNKNOWN_PERMISSION_STATE = Symbol("unknown permission state");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callExtensionApi<T>(
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

function storedState(value: unknown): StoredState {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze({
    ...(typeof value.grantAt === "number" && value.grantAt > 0
      ? { grantAt: value.grantAt }
      : {}),
    ...(Number.isInteger(value.registrationVersion) &&
    Number(value.registrationVersion) > 0
      ? { registrationVersion: Number(value.registrationVersion) }
      : {}),
    ...(value.promptResult === "granted" || value.promptResult === "declined"
      ? { promptResult: value.promptResult }
      : {}),
    ...(typeof value.completedAt === "number" && value.completedAt > 0
      ? { completedAt: value.completedAt }
      : {}),
  });
}

export class EarnedPermissionRegistrationController {
  readonly #environment: Environment;
  #generation = 0;
  #tail: Promise<EarnedPermissionRegistrationResult> = Promise.resolve({
    ok: false,
    completeGrant: false,
    registered: false,
    changed: false,
    error: "permission_incomplete",
  });

  constructor(environment: Environment) {
    this.#environment = environment;
  }

  reconcile(): Promise<EarnedPermissionRegistrationResult> {
    const next = this.#tail.then(
      () => this.#bounded(),
      () => this.#bounded(),
    );
    this.#tail = next;
    return next;
  }

  // Safari can leave an extension API call unanswered after it suspends and
  // wakes the background. Serialized reconciles would then wait behind it for
  // the rest of the worker's life, and every archive page would stay gated
  // until Safari restarts. Settle each run so the next one can proceed.
  //
  // Settling does not cancel the slow run, so every run carries a generation.
  // A run applies side effects (state writes, script registration changes)
  // only while it is still the latest; once it times out or a newer run has
  // started, whatever it finds later is dropped.
  #bounded(): Promise<EarnedPermissionRegistrationResult> {
    this.#generation += 1;
    const generation = this.#generation;
    const timeoutMs =
      this.#environment.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.#generation === generation) this.#generation += 1;
        reject(new Error("reconcile_timeout"));
      }, timeoutMs);
    });
    return Promise.race([this.#reconcile(generation), timeout]).finally(() => {
      clearTimeout(timer);
    });
  }

  #assertCurrent(generation: number): void {
    if (this.#generation !== generation) throw new Error("reconcile_superseded");
  }

  async #reconcile(generation: number): Promise<EarnedPermissionRegistrationResult> {
    const { config, permissions, runtime, scripting, storageMode, storage } =
      this.#environment;
    const [permissionSnapshot, semanticGrant, stored] = await Promise.all([
      callExtensionApi<{ readonly origins?: readonly string[] }>(
        permissions as unknown as Record<string, (...args: unknown[]) => unknown>,
        "getAll",
        [],
        runtime,
        storageMode,
      ).catch(() => UNKNOWN_PERMISSION_STATE),
      typeof permissions.contains === "function"
        ? callExtensionApi<boolean>(
            permissions as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >,
            "contains",
            [{ origins: config.origins }],
            runtime,
            storageMode,
          ).catch(() => null)
        : Promise.resolve(null),
      storage
        .get(EARNED_PERMISSION_STATE_KEY)
        .then((value) => storedState(value[EARNED_PERMISSION_STATE_KEY]))
        .catch(() => Object.freeze({}) as StoredState),
    ]);
    // Neither permission read answered: that is not evidence of a partial
    // grant. Report a transient failure so pages ask again and dynamic
    // registrations are not removed over a failed read.
    if (
      permissionSnapshot === UNKNOWN_PERMISSION_STATE &&
      typeof semanticGrant !== "boolean"
    ) {
      throw new Error("permission_state_unavailable");
    }
    const snapshotOrigins =
      typeof permissionSnapshot === "symbol"
        ? undefined
        : permissionSnapshot.origins;
    const granted = new Set<string>(
      Array.isArray(snapshotOrigins)
        ? snapshotOrigins.filter((origin) => typeof origin === "string")
        : [],
    );
    const completeGrant =
      config.origins.length > 0 &&
      (typeof semanticGrant === "boolean"
        ? semanticGrant
        : config.origins.every((origin) => granted.has(origin)));
    const staticRegistration = config.registrationMode === "static";
    if (staticRegistration) {
      if (!completeGrant) {
        return Object.freeze({
          ok: false,
          completeGrant: false,
          registered: false,
          changed: false,
          error: "permission_incomplete",
        });
      }
      const grantAt =
        typeof stored.grantAt === "number"
          ? stored.grantAt
          : (this.#environment.clock?.() ?? Date.now());
      if (
        stored.grantAt !== grantAt ||
        stored.registrationVersion !== config.version ||
        stored.promptResult !== "granted"
      ) {
        this.#assertCurrent(generation);
        await storage.set({
          [EARNED_PERMISSION_STATE_KEY]: {
            ...stored,
            grantAt,
            registrationVersion: config.version,
            promptResult: "granted",
          },
        });
      }
      return Object.freeze({
        ok: true,
        completeGrant: true,
        registered: true,
        changed: false,
        grantAt,
      });
    }
    if (!scripting) {
      return Object.freeze({
        ok: false,
        completeGrant: true,
        registered: false,
        changed: false,
        error: "registration_failed",
      });
    }
    const configuredIds = config.registrations.map(({ id }) => id);
    const current = await callExtensionApi<readonly { readonly id?: string }[]>(
      scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
      "getRegisteredContentScripts",
      [],
      runtime,
      storageMode,
    ).catch(() => []);
    const currentIds = new Set(
      current
        .map(({ id }) => id)
        .filter((id): id is string => typeof id === "string"),
    );
    const registered = configuredIds.every((id) => currentIds.has(id));

    if (!completeGrant) {
      const staleIds = configuredIds.filter((id) => currentIds.has(id));
      if (staleIds.length > 0) {
        this.#assertCurrent(generation);
        await callExtensionApi<void>(
          scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
          "unregisterContentScripts",
          [{ ids: staleIds }],
          runtime,
          storageMode,
        ).catch(() => undefined);
      }
      return Object.freeze({
        ok: false,
        completeGrant: false,
        registered: false,
        changed: staleIds.length > 0,
        error: "permission_incomplete",
      });
    }

    const versionCurrent = stored.registrationVersion === config.version;
    if (registered && versionCurrent) {
      const grantAt =
        typeof stored.grantAt === "number"
          ? stored.grantAt
          : (this.#environment.clock?.() ?? Date.now());
      if (stored.grantAt !== grantAt || stored.promptResult !== "granted") {
        this.#assertCurrent(generation);
        await storage.set({
          [EARNED_PERMISSION_STATE_KEY]: {
            ...stored,
            grantAt,
            registrationVersion: config.version,
            promptResult: "granted",
          },
        });
      }
      return Object.freeze({
        ok: true,
        completeGrant: true,
        registered: true,
        changed: false,
        grantAt,
      });
    }

    try {
      const staleIds = configuredIds.filter((id) => currentIds.has(id));
      if (staleIds.length > 0) {
        this.#assertCurrent(generation);
        await callExtensionApi<void>(
          scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
          "unregisterContentScripts",
          [{ ids: staleIds }],
          runtime,
          storageMode,
        );
      }
      this.#assertCurrent(generation);
      await callExtensionApi<void>(
        scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
        "registerContentScripts",
        [config.registrations],
        runtime,
        storageMode,
      );
      const confirmed = await callExtensionApi<
        readonly { readonly id?: string }[]
      >(
        scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
        "getRegisteredContentScripts",
        [],
        runtime,
        storageMode,
      );
      const confirmedIds = new Set(
        confirmed
          .map(({ id }) => id)
          .filter((id): id is string => typeof id === "string"),
      );
      if (!configuredIds.every((id) => confirmedIds.has(id))) {
        throw new Error("registration_not_confirmed");
      }
      const grantAt = this.#environment.clock?.() ?? Date.now();
      this.#assertCurrent(generation);
      await storage.set({
        [EARNED_PERMISSION_STATE_KEY]: {
          ...stored,
          grantAt,
          registrationVersion: config.version,
          promptResult: "granted",
          completedAt: null,
        },
      });
      return Object.freeze({
        ok: true,
        completeGrant: true,
        registered: true,
        changed: true,
        grantAt,
      });
    } catch {
      return Object.freeze({
        ok: false,
        completeGrant: true,
        registered: false,
        changed: false,
        error: "registration_failed",
      });
    }
  }
}

export function installEarnedPermissionRegistrationRuntime(
  environment: Environment,
): EarnedPermissionRegistrationController {
  const controller = new EarnedPermissionRegistrationController(environment);
  environment.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      !isRecord(message) ||
      message.type !== EARNED_PERMISSION_REGISTRATION_MESSAGE
    ) {
      return false;
    }
    void controller.reconcile().then(
      (response) => sendResponse(response),
      () =>
        sendResponse({
          ok: false,
          completeGrant: false,
          registered: false,
          changed: false,
          error: "registration_failed",
        }),
    );
    return true;
  });
  environment.permissions.onAdded?.addListener(() => {
    void controller.reconcile().catch(() => undefined);
  });
  environment.permissions.onRemoved?.addListener(() => {
    void controller.reconcile().catch(() => undefined);
  });
  environment.runtime.onInstalled?.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
      void controller.reconcile().catch(() => undefined);
    }
  });
  void controller.reconcile().catch(() => undefined);
  return controller;
}
