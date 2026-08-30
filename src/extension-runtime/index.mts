import { installSessionRuntime, type SessionMode } from "./controller.mjs";
import { installArchiveReadinessRuntime } from "./archive-readiness.mjs";
import { installEarnedPermissionRegistrationRuntime } from "./earned-permission-registration.mjs";
import { installTraceFirstInstallActivation } from "./trace-web-navigation.mjs";
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
  AlarmsPort,
  PermissionsPort,
  RuntimePort,
  ScriptingPort,
  StorageArea,
  TabsPort,
} from "./browser-platform.mjs";
import { BrowserStorage } from "./browser-platform.mjs";
import { BrowserArchiveReadinessStatus } from "./archive-readiness-status.mjs";

declare const __TRACE_SESSION_MODE__: SessionMode;
declare const __TRACE_API_BASE__: string;
declare const __TRACE_WEB_ORIGIN__: string;
declare const __TRACE_IOS_EARNED_PERMISSION_CONFIG__: EarnedPermissionRegistrationConfig | null;

type EarnedPermissionRegistrationConfig = Readonly<{
  version: number;
  registrationMode?: "dynamic" | "static";
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
  readonly runtime: RuntimePort;
  readonly alarms: AlarmsPort;
  readonly storage: { readonly local: StorageArea };
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
  if (__TRACE_SESSION_MODE__ === "kernel") {
    installTraceFirstInstallActivation({
      runtime: extension.runtime,
      tabs: extension.tabs,
      mode: storageMode,
      webOrigin: __TRACE_WEB_ORIGIN__,
    });
    // Install positive archive-run evidence before any IndexedDB, credential,
    // account-projection, or session-restoration work can stall the worker.
    installArchiveReadinessRuntime({
      runtime: extension.runtime,
      ...(extension.permissions === undefined
        ? {}
        : { permissions: extension.permissions }),
      storageMode,
      status: archiveReadinessStatus,
    });
    if (
      __TRACE_IOS_EARNED_PERMISSION_CONFIG__ !== null &&
      extension.permissions !== undefined &&
      (__TRACE_IOS_EARNED_PERMISSION_CONFIG__.registrationMode === "static" ||
        extension.scripting !== undefined)
    ) {
      installEarnedPermissionRegistrationRuntime({
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
  installSessionRuntime({
    mode: __TRACE_SESSION_MODE__,
    runtime: extension.runtime,
    tabs: extension.tabs,
    alarms: extension.alarms,
    storageArea: extension.storage.local,
    databaseFactory: scope.indexedDB,
    storageMode,
    fetch: globalThis.fetch.bind(globalThis),
    apiBase: __TRACE_API_BASE__,
    webOrigin: __TRACE_WEB_ORIGIN__,
    randomId,
    archiveReadinessStatus,
  });
} catch {
  scope.__traceSessionRuntimeBootFailed = true;
}
