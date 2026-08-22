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
  scripting: ScriptingPort;
  storage: BrowserStorage;
  storageMode: "callback" | "promise";
  config: EarnedPermissionRegistrationConfig;
  clock?: () => number;
}>;

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
      () => this.#reconcile(),
      () => this.#reconcile(),
    );
    this.#tail = next;
    return next;
  }

  async #reconcile(): Promise<EarnedPermissionRegistrationResult> {
    const { config, permissions, runtime, scripting, storageMode, storage } =
      this.#environment;
    const [permissionSnapshot, semanticGrant, stored] = await Promise.all([
      callExtensionApi<{ readonly origins?: readonly string[] }>(
        permissions as unknown as Record<string, (...args: unknown[]) => unknown>,
        "getAll",
        [],
        runtime,
        storageMode,
      ).catch(() => Object.freeze({ origins: [] })),
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
    const granted = new Set<string>(
      Array.isArray(permissionSnapshot.origins)
        ? permissionSnapshot.origins.filter(
            (origin) => typeof origin === "string",
          )
        : [],
    );
    const completeGrant =
      config.origins.length > 0 &&
      (typeof semanticGrant === "boolean"
        ? semanticGrant
        : config.origins.every((origin) => granted.has(origin)));
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
        await callExtensionApi<void>(
          scripting as unknown as Record<string, (...args: unknown[]) => unknown>,
          "unregisterContentScripts",
          [{ ids: staleIds }],
          runtime,
          storageMode,
        );
      }
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
    void controller.reconcile();
  });
  environment.permissions.onRemoved?.addListener(() => {
    void controller.reconcile();
  });
  environment.runtime.onInstalled?.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
      void controller.reconcile();
    }
  });
  void controller.reconcile();
  return controller;
}
