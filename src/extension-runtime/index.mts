import { createActivityFetch } from "./activity-fetch.mjs";
import { installArchiveHostAccess } from "./archive-host-access.mjs";
import { installArchiveRecovery } from "./archive-recovery.mjs";
import { installSessionRuntime, type SessionMode, type SessionRuntimeController } from "./controller.mjs";
import {
  BrowserArchiveAccessLedger,
  installArchiveAccessReport,
  installArchiveReadinessRuntime,
} from "./archive-readiness.mjs";
import { installEarnedPermissionRegistrationRuntime } from "./earned-permission-registration.mjs";
import { installFirstTapSave } from "./first-tap-runtime.mjs";
import { installSafariReadinessReport, type SafariReadinessReporter } from "./safari-readiness-report.mjs";
import { ACCOUNT_PROJECTION_REVISION_KEY } from "./runtime-messages.mjs";
import { installTraceFirstInstallActivation } from "./trace-web-navigation.mjs";
import { rememberConnectIntent } from "./connect-intent.mjs";
export * from "./account-projection.mjs";
export * from "./billing-conversion.mjs";
export * from "./archive-readiness-status.mjs";
export * from "./library-command.mjs";
export * from "./library-command-sender.mjs";
export * from "./metadata-contribution.mjs";
export * from "./metadata-contribution-sender.mjs";
export * from "./saved-filter-sync.mjs";
export * from "./saved-filter-sync-sender.mjs";
export * from "./first-story-initiation.mjs";
export * from "./story-command.mjs";
export * from "./story-command-sender.mjs";
export * from "./trace-web-navigation.mjs";
export * from "./trace-web-status.mjs";
import type {
  ActionPort,
  AlarmsPort,
  PermissionsPort,
  RuntimePort,
  ScriptingPort,
  StorageArea,
  TabsPort,
} from "./browser-platform.mjs";
import { BrowserStorage } from "./browser-platform.mjs";
import { BrowserArchiveReadinessStatus } from "./archive-readiness-status.mjs";
import { NativeStorySaveReceiptPort } from "./browser-adapters.mjs";

declare const __TRACE_SESSION_MODE__: SessionMode;
declare const __TRACE_API_BASE__: string;
declare const __TRACE_WEB_ORIGIN__: string;
declare const __TRACE_NATIVE_IMPORT_HANDOFF__: boolean;
declare const __TRACE_IOS_EARNED_PERMISSION_CONFIG__: EarnedPermissionRegistrationConfig | null;
declare const __TRACE_IOS_FIRST_TAP_SAVE__: boolean;
declare const __TRACE_IOS_FIRST_TAP_SHEET__: boolean;

type EarnedPermissionRegistrationConfig = Readonly<{
  version: number;
  registrationMode?: "dynamic" | "static";
  /** Save the story the reader opens Trace on, before lasting access. */
  firstTapSave?: boolean;
  origins: readonly string[];
  registrations: readonly Readonly<{
    id: string;
    matches: readonly string[];
    js: readonly string[];
    runAt: string;
    persistAcrossSessions: boolean;
    excludeMatches?: readonly string[];
  }>[];
}>;

interface ExtensionApi {
  readonly action?: ActionPort;
  readonly runtime: RuntimePort;
  readonly alarms: AlarmsPort;
  readonly storage: { readonly local: StorageArea; readonly session?: StorageArea; readonly onChanged?: { addListener(listener: (changes: Record<string, unknown>, area: string) => void): void } };
  readonly tabs: TabsPort;
  readonly permissions?: PermissionsPort;
  readonly scripting?: ScriptingPort;
}

interface RuntimeGlobal {
  readonly browser?: ExtensionApi;
  readonly chrome?: ExtensionApi;
  readonly crypto?: { randomUUID?: () => string };
  readonly indexedDB?: IDBFactory;
  TRACE_SESSION_MODE?: "legacy" | SessionMode;
  __traceSessionRuntimeBootFailed?: true;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fallbackUuid(seed: string): string {
  let hash = 2166136261;
  const bytes: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    for (let offset = 0; offset < seed.length; offset += 1) {
      hash ^= seed.charCodeAt(offset) + index;
      hash = Math.imul(hash, 16777619);
    }
    bytes.push((hash >>> ((index % 4) * 8)) & 0xff);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const scope = globalThis as unknown as RuntimeGlobal;
scope.TRACE_SESSION_MODE = __TRACE_SESSION_MODE__;

try {
  const extension = scope.browser ?? scope.chrome;
  if (!extension) throw new Error("extension environment unavailable");
  const storageMode = scope.browser ? "promise" : "callback";
  const archiveReadinessStatus = new BrowserArchiveReadinessStatus(
    new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
  );
  let session: SessionRuntimeController | undefined;
  let afterScriptsRegistered: (() => Promise<void>) | null = null;
  let readiness: SafariReadinessReporter | null = null;
  // Set once the registration of the page scripts is installed, below.
  let registrationSettled: (() => Promise<boolean>) | null = null;
  // The sheet's shorter wait on the same registration: it answers the reader
  // within a few seconds, and looks again later if it has to.
  let sheetRegistrationSettled: (() => Promise<boolean>) | null = null;
  if (__TRACE_SESSION_MODE__ === "kernel") {
    const recover = installArchiveRecovery({
      runtime: extension.runtime, tabs: extension.tabs, permissions: extension.permissions, scripting: extension.scripting, mode: storageMode,
      // A build that registers its page scripts after the grant has none in
      // its manifest for recovery to read.
      ...(__TRACE_IOS_EARNED_PERMISSION_CONFIG__ !== null &&
        __TRACE_IOS_EARNED_PERMISSION_CONFIG__.registrationMode !== "static"
        ? { registered: __TRACE_IOS_EARNED_PERMISSION_CONFIG__ }
        : {}),
    });
    installArchiveHostAccess({ runtime: extension.runtime, tabs: extension.tabs, action: extension.action, permissions: extension.permissions, mode: storageMode, recover });
    installTraceFirstInstallActivation({
      runtime: extension.runtime,
      tabs: extension.tabs,
      mode: storageMode,
      webOrigin: __TRACE_WEB_ORIGIN__,
      // Signing in anywhere on Trace after installing finishes the connect,
      // not only on the setup page's own address.
      onActivation: () => rememberConnectIntent(
        new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
      ),
    });
    // Install positive archive-run evidence before any IndexedDB, credential,
    // account-projection, or session-restoration work can stall the worker.
    const accessLedger = new BrowserArchiveAccessLedger(
      new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
    );
    const archiveReadiness = installArchiveReadinessRuntime({
      runtime: extension.runtime,
      ...(extension.permissions === undefined
        ? {}
        : { permissions: extension.permissions }),
      storageMode,
      status: archiveReadinessStatus,
      publishTrackingPreference: () => session?.publishTrackingPreference() ?? Promise.resolve(),
      ...(__TRACE_IOS_EARNED_PERMISSION_CONFIG__ === null
        ? {}
        : { requiredOrigins: __TRACE_IOS_EARNED_PERMISSION_CONFIG__.origins }),
      accessLedger,
      // Access is not reported as ended while an update's or a start's own
      // registration is still settling.
      accessSettled: () => registrationSettled?.() ?? Promise.resolve(true),
    });
    if (
      __TRACE_IOS_EARNED_PERMISSION_CONFIG__ !== null &&
      extension.permissions !== undefined
    ) {
      installArchiveAccessReport(archiveReadiness, {
        runtime: extension.runtime,
        permissions: extension.permissions,
        alarms: extension.alarms,
        accessLedger,
        storageMode,
      });
    }
    if (
      __TRACE_IOS_EARNED_PERMISSION_CONFIG__ !== null &&
      extension.permissions !== undefined &&
      (__TRACE_IOS_EARNED_PERMISSION_CONFIG__.registrationMode === "static" ||
        extension.scripting !== undefined)
    ) {
      const registration = installEarnedPermissionRegistrationRuntime({
        runtime: extension.runtime,
        permissions: extension.permissions,
        ...(extension.scripting === undefined
          ? {}
          : { scripting: extension.scripting }),
        storage: new BrowserStorage(
          extension.storage.local,
          extension.runtime,
          storageMode,
        ),
        storageMode,
        config: __TRACE_IOS_EARNED_PERMISSION_CONFIG__,
        alarms: extension.alarms,
        // Story tabs that are already open get the scripts too, whether the
        // reader allowed the sites from the popup or in Safari's settings.
        // A page that was saved on a first tap is told to carry on by itself.
        onScriptsRegistered: () => {
          void recover();
          void afterScriptsRegistered?.().catch(() => undefined);
        },
        onReconcileEnded: (result) => readiness?.registrationEnded(result),
      });
      registrationSettled = () => registration.settled(8_000);
      sheetRegistrationSettled = () => registration.settled(2_000);
      // Whether Trace in Safari is ready to save by itself, for the Trace
      // app beside it on iPhone and iPad. It reads and reports; it changes
      // nothing, runs nothing on a page and asks Safari for nothing.
      readiness = installSafariReadinessReport({
        runtime: extension.runtime,
        permissions: extension.permissions,
        ...(extension.scripting === undefined ? {} : { scripting: extension.scripting }),
        storage: new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
        storageMode,
        apiOrigin: __TRACE_API_BASE__,
        config: __TRACE_IOS_EARNED_PERMISSION_CONFIG__,
        registration,
        alarms: extension.alarms,
        session: () => session,
      });
    }
  }
  if (!scope.indexedDB) throw new Error("private database unavailable");
  let fallbackId = 0;
  const randomId = (): string => {
    const uuid = scope.crypto?.randomUUID?.();
    if (typeof uuid === "string" && UUID_PATTERN.test(uuid)) return uuid;
    fallbackId += 1;
    return fallbackUuid(`${Date.now()}:${fallbackId}`);
  };
  const apiFetch = createActivityFetch(
    globalThis.fetch.bind(globalThis), extension.runtime, storageMode, __TRACE_API_BASE__,
    new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
  );
  session = installSessionRuntime({
    browserDeviceSessions: true,
    mode: __TRACE_SESSION_MODE__,
    runtime: extension.runtime,
    tabs: extension.tabs,
    alarms: extension.alarms,
    storageArea: extension.storage.local,
    databaseFactory: scope.indexedDB,
    storageMode,
    fetch: apiFetch,
    apiBase: __TRACE_API_BASE__,
    nativeImportHandoff: __TRACE_NATIVE_IMPORT_HANDOFF__,
    ...(extension.scripting ? { scripting: extension.scripting } : {}),
    ...(extension.permissions ? { permissions: extension.permissions } : {}),
    webOrigin: __TRACE_WEB_ORIGIN__,
    randomId,
    archiveReadinessStatus,
    // Missing FanFiction.net summaries are read in the reader's own
    // FanFiction.net tab, slowly (ffn-summary-fill.mts).
    ffnSummaryFill: {
      sessionArea: extension.storage.session ?? null,
    },
  });
  if (
    // A build-time constant: a build without optional story sites leaves this
    // block and the modules only it uses out of the bundle altogether.
    __TRACE_IOS_FIRST_TAP_SHEET__ &&
    __TRACE_SESSION_MODE__ === "kernel" &&
    __TRACE_IOS_EARNED_PERMISSION_CONFIG__ !== null &&
    __TRACE_IOS_EARNED_PERMISSION_CONFIG__.registrationMode === "dynamic" &&
    extension.permissions !== undefined &&
    extension.scripting !== undefined
  ) {
    afterScriptsRegistered = installFirstTapSave({
      runtime: extension.runtime,
      tabs: extension.tabs,
      permissions: extension.permissions,
      scripting: extension.scripting,
      storage: new BrowserStorage(extension.storage.local, extension.runtime, storageMode),
      mode: storageMode,
      origins: __TRACE_IOS_EARNED_PERMISSION_CONFIG__.origins,
      registrationIds: __TRACE_IOS_EARNED_PERMISSION_CONFIG__.registrations.map(({ id }) => id),
      // Saving on opening is a development switch, never on in a release
      // build. Without it the sheet is the same and the reader's tap saves.
      saveOnOpen: __TRACE_IOS_FIRST_TAP_SAVE__ && __TRACE_IOS_EARNED_PERMISSION_CONFIG__.firstTapSave === true,
      session,
      fetch: apiFetch,
      apiBase: __TRACE_API_BASE__,
      // After Always Allow the registration runs on Safari's word of the new
      // access; what the sheet reads waits for it rather than racing it.
      ...(sheetRegistrationSettled ? { registrationSettled: sheetRegistrationSettled } : {}),
      // The setup the Trace app has under way, as a save reads it.
      setupAttempt: (accountId) =>
        new NativeStorySaveReceiptPort(extension.runtime, storageMode, __TRACE_API_BASE__).prepareSaveReceipt(accountId),
    });
  }
  extension.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && "prefAutoTrackEnabled" in changes) void session?.publishTrackingPreference();
    if (area !== "local" || readiness === null) return;
    if ("prefAutoTrackEnabled" in changes) readiness.preferenceChanged();
    if (ACCOUNT_PROJECTION_REVISION_KEY in changes) readiness.accountMayHaveChanged();
  });
} catch {
  scope.__traceSessionRuntimeBootFailed = true;
}
