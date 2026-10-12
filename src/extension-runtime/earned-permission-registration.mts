import type {
  AlarmsPort,
  BrowserStorage,
  PermissionsPort,
  RuntimePort,
  ScriptingPort,
} from "./browser-platform.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";

export const EARNED_PERMISSION_REGISTRATION_MESSAGE =
  "TRACE_EARNED_PERMISSION_RECONCILE";
export const EARNED_PERMISSION_STATE_KEY =
  "traceEarnedPermissionOnboardingV1";
/** The popup sends this each time it opens. */
const POPUP_OPENED_MESSAGE = "TRACE_ARCHIVE_ACCESS_REPORT";
/**
 * Retry alarms are named `<this>:<n>` for the n-th further try, and
 * `<this>:rest` once those have run out. The names themselves carry how far
 * the retries have got, so the bound holds without anything being stored.
 */
export const EARNED_PERMISSION_RETRY_ALARM = "traceEarnedPermissionRetry";
/**
 * Minutes before each further try after a reconcile that could not finish.
 * After the last one a single resting alarm is left, and nothing more is
 * scheduled until it fires, an update, a new grant, or a success clears it.
 */
export const EARNED_PERMISSION_RETRY_DELAYS_MINUTES: readonly number[] =
  Object.freeze([1, 5, 30, 180]);
export const EARNED_PERMISSION_RETRY_REST_MINUTES = 24 * 60;
/** Set once an ended grant has been confirmed; cleared when access returns. */
export const EARNED_PERMISSION_ENDED_KEY = "traceEarnedPermissionEndedV1";

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

/** One look at the browser's website access for the configured origins. */
type GrantReading = Readonly<{
  complete: boolean;
  /** Whether the browser also listed what is granted. */
  listed: boolean;
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
  /** How far apart the two readings are that end a grant and remove its scripts. */
  endedGrantConfirmDelayMs?: number;
  /** Wakes a sleeping worker to try again after a reconcile that could not finish. */
  alarms?: AlarmsPort;
  /** Called when page scripts were just registered, or registered late. */
  onScriptsRegistered?: () => void;
}>;

const DEFAULT_RECONCILE_TIMEOUT_MS = 5_000;
const DEFAULT_ENDED_GRANT_CONFIRM_DELAY_MS = 2_000;
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

  async #readGrant(): Promise<GrantReading> {
    const { config, permissions, runtime, storageMode } = this.#environment;
    const [permissionSnapshot, semanticGrant] = await Promise.all([
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
    return Object.freeze({
      complete:
        config.origins.length > 0 &&
        (typeof semanticGrant === "boolean"
          ? semanticGrant
          : config.origins.every((origin) => granted.has(origin))),
      listed: typeof permissionSnapshot !== "symbol",
    });
  }

  // Once the scripts are gone, nothing on a story page wakes this worker, so
  // a grant wrongly read as ended would stop saving without a word until
  // something else started the worker. Take the reading again after a pause,
  // and end the grant only when both readings say so and the browser listed
  // what is granted both times.
  async #grantHasEnded(first: GrantReading, generation: number): Promise<boolean> {
    if (first.complete || !first.listed) return false;
    const delayMs =
      this.#environment.endedGrantConfirmDelayMs ??
      DEFAULT_ENDED_GRANT_CONFIRM_DELAY_MS;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    this.#assertCurrent(generation);
    const second = await this.#readGrant().catch(() => null);
    return second !== null && !second.complete && second.listed;
  }

  async #reconcile(generation: number): Promise<EarnedPermissionRegistrationResult> {
    const { config, runtime, scripting, storageMode, storage } =
      this.#environment;
    const [reading, stored, endedConfirmed] = await Promise.all([
      this.#readGrant(),
      storage
        .get(EARNED_PERMISSION_STATE_KEY)
        .then((value) => storedState(value[EARNED_PERMISSION_STATE_KEY]))
        .catch(() => Object.freeze({}) as StoredState),
      storage
        .get(EARNED_PERMISSION_ENDED_KEY)
        .then((value) => typeof value[EARNED_PERMISSION_ENDED_KEY] === "number")
        .catch(() => false),
    ]);
    if (reading.complete && endedConfirmed) {
      // Access is back: an ending confirmed earlier says nothing about now.
      await storage.remove(EARNED_PERMISSION_ENDED_KEY).catch(() => undefined);
    }
    const completeGrant = reading.complete;
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
      // For a reader who had the grant, one incomplete reading is not yet an
      // answer: their scripts stay, and the caller is told to ask again.
      const hadGrant =
        staleIds.length > 0 ||
        stored.promptResult === "granted" ||
        typeof stored.completedAt === "number";
      // The pause between two readings is paid once per ending. After it
      // has been confirmed and recorded, and with no script left to lose,
      // one more incomplete reading changes nothing and needs no second look.
      // A new grant clears the record, so the next ending is confirmed again.
      const alreadyConfirmed = endedConfirmed && staleIds.length === 0;
      if (hadGrant && !alreadyConfirmed) {
        if (!(await this.#grantHasEnded(reading, generation))) {
          throw new Error("permission_state_unconfirmed");
        }
        this.#assertCurrent(generation);
        await storage
          .set({ [EARNED_PERMISSION_ENDED_KEY]: this.#environment.clock?.() ?? Date.now() })
          .catch(() => undefined);
      }
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
      // A reader who finished setup before, under a build that declared its
      // scripts in the manifest or under an earlier registration, is carried
      // over as they were: putting their scripts back is not a new grant, and
      // must not send them through setup again.
      const completedAt =
        typeof stored.completedAt === "number" ? stored.completedAt : null;
      const grantAt =
        completedAt !== null && typeof stored.grantAt === "number"
          ? stored.grantAt
          : (this.#environment.clock?.() ?? Date.now());
      this.#assertCurrent(generation);
      await storage.set({
        [EARNED_PERMISSION_STATE_KEY]: {
          ...stored,
          grantAt,
          registrationVersion: config.version,
          promptResult: "granted",
          completedAt,
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
  const { alarms, runtime, storage, storageMode } = environment;
  const alarm = (method: string, args: readonly unknown[]): Promise<unknown> =>
    alarms === undefined
      ? Promise.resolve()
      : callExtensionApi<unknown>(
          alarms as unknown as Record<string, (...args: unknown[]) => unknown>,
          method,
          args,
          runtime,
          storageMode,
        ).catch(() => undefined);
  const RETRY_PREFIX = `${EARNED_PERMISSION_RETRY_ALARM}:`;
  const REST_ALARM = `${RETRY_PREFIX}rest`;
  const RETRIES = EARNED_PERMISSION_RETRY_DELAYS_MINUTES.length;
  const ALL_RETRY_ALARMS = [
    ...EARNED_PERMISSION_RETRY_DELAYS_MINUTES.map((_, index) => `${RETRY_PREFIX}${index}`),
    REST_ALARM,
  ];
  /** The retry alarms now waiting; null when the browser cannot say. */
  const waitingRetries = async (): Promise<readonly string[] | null> => {
    if (typeof alarms?.getAll !== "function") return null;
    try {
      const all = await callExtensionApi<readonly { readonly name?: string }[]>(
        alarms as unknown as Record<string, (...args: unknown[]) => unknown>,
        "getAll",
        [],
        runtime,
        storageMode,
      );
      return all
        .map(({ name }) => name)
        .filter((name): name is string => typeof name === "string" && name.startsWith(RETRY_PREFIX));
    } catch {
      return null;
    }
  };
  // How far the retries have got is carried by the alarm that fired, never by
  // a stored count: a storage write that fails cannot lift the bound.
  let nextRetry: number | null = null;
  const clearRetries = async (): Promise<void> => {
    nextRetry = null;
    for (const name of (await waitingRetries()) ?? ALL_RETRY_ALARMS) {
      await alarm("clear", [name]);
    }
  };
  // A reconcile that could not finish (an unreadable permission state, a
  // registration that failed, a browser call that never answered, a grant
  // that read as incomplete once) leaves a reader who allowed the story sites
  // with no page script, and no page script means nothing wakes this worker.
  // Try again by alarm, a bounded number of times and further apart each
  // time. A complete registration, or a settled "not allowed", ends it.
  let unfinished = false;
  const finished = async (registered: boolean, changed: boolean): Promise<void> => {
    const late = unfinished;
    unfinished = false;
    if (registered && (changed || late)) environment.onScriptsRegistered?.();
    await clearRetries();
  };
  const tryLater = async (): Promise<void> => {
    unfinished = true;
    if (typeof alarms?.create !== "function") return;
    let next = nextRetry;
    nextRetry = null;
    if (next === null) {
      // No retry alarm led here. One already waiting, or the rest after the
      // last, is left as it is; only a first failure starts the sequence.
      if (((await waitingRetries()) ?? []).length > 0) return;
      next = 0;
    }
    await alarm("create", next < RETRIES
      ? [`${RETRY_PREFIX}${next}`, { delayInMinutes: EARNED_PERMISSION_RETRY_DELAYS_MINUTES[next] }]
      : [REST_ALARM, { delayInMinutes: EARNED_PERMISSION_RETRY_REST_MINUTES }]);
  };
  const reconcile = (): Promise<EarnedPermissionRegistrationResult> => {
    const result = controller.reconcile();
    void result
      .then(
        (value) =>
          value.ok || value.error === "permission_incomplete"
            ? finished(value.ok, value.changed)
            : tryLater(),
        () => tryLater(),
      )
      .catch(() => undefined);
    return result;
  };
  // An update, or the reader allowing sites, starts the count afresh; a new
  // grant also means the next ending has to be confirmed again.
  const reconcileAfresh = async (newGrant: boolean): Promise<void> => {
    await clearRetries();
    if (newGrant) await storage.remove(EARNED_PERMISSION_ENDED_KEY).catch(() => undefined);
    await reconcile().catch(() => undefined);
  };
  alarms?.onAlarm?.addListener((fired) => {
    const name = fired?.name;
    if (typeof name !== "string" || !ALL_RETRY_ALARMS.includes(name)) return;
    // The alarm that fired says which try this is. After the rest, the count
    // stays at its end: one try, then rest again.
    nextRetry = name === REST_ALARM ? RETRIES : Number(name.slice(RETRY_PREFIX.length)) + 1;
    void reconcile().catch(() => undefined);
  });
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRecord(message)) return false;
    // The popup opening is a chance to put right a registration that an
    // earlier reconcile could not finish, whatever stage of setup it shows.
    // Its own listener answers this message.
    if (
      message.type === POPUP_OPENED_MESSAGE &&
      isPopupSender(sender, runtime.id)
    ) {
      void reconcile().catch(() => undefined);
      return false;
    }
    if (message.type !== EARNED_PERMISSION_REGISTRATION_MESSAGE) return false;
    void reconcile().then(
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
    void reconcileAfresh(true);
  });
  environment.permissions.onRemoved?.addListener(() => {
    void reconcile().catch(() => undefined);
  });
  runtime.onInstalled?.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
      void reconcileAfresh(false);
    }
  });
  void reconcile().catch(() => undefined);
  return controller;
}
