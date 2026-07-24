import { installSessionRuntime, type SessionMode } from "./controller.mjs";
import { installArchiveReadinessRuntime } from "./archive-readiness.mjs";
export * from "./account-projection.mjs";
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
  StorageArea,
  TabsPort,
} from "./browser-platform.mjs";
import { BrowserStorage } from "./browser-platform.mjs";
import { BrowserArchiveReadinessStatus } from "./archive-readiness-status.mjs";

declare const __TRACE_SESSION_MODE__: SessionMode;
declare const __TRACE_API_BASE__: string;
declare const __TRACE_WEB_ORIGIN__: string;

interface ExtensionApi {
  readonly runtime: RuntimePort;
  readonly alarms: AlarmsPort;
  readonly storage: { readonly local: StorageArea };
  readonly tabs: TabsPort;
  readonly permissions?: PermissionsPort;
}

interface RuntimeGlobal {
  readonly browser?: ExtensionApi;
  readonly chrome?: ExtensionApi;
  readonly crypto?: { randomUUID?: () => string };
  readonly indexedDB?: IDBFactory;
  TRACE_SESSION_MODE?: "legacy" | SessionMode;
  __traceSessionRuntimeBootFailed?: true;
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
  }
  if (!scope.indexedDB) throw new Error("private database unavailable");
  let fallbackId = 0;
  const randomId = (): string => {
    const uuid = scope.crypto?.randomUUID?.();
    if (uuid) return uuid;
    fallbackId += 1;
    return `${Date.now()}-${fallbackId}`;
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
