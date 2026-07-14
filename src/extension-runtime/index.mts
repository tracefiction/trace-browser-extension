import { installSessionRuntime, type SessionMode } from "./controller.mjs";
import type { RuntimePort, StorageArea, TabsPort } from "./browser-adapters.mjs";

declare const __TRACE_SESSION_MODE__: SessionMode;
declare const __TRACE_API_BASE__: string;
declare const __TRACE_WEB_ORIGIN__: string;

interface ExtensionApi {
  readonly runtime: RuntimePort;
  readonly storage: { readonly local: StorageArea };
  readonly tabs: TabsPort;
}

interface RuntimeGlobal {
  readonly browser?: ExtensionApi;
  readonly chrome?: ExtensionApi;
  readonly crypto?: { randomUUID?: () => string };
  TRACE_SESSION_MODE?: "legacy" | SessionMode;
  __traceSessionRuntimeBootFailed?: true;
}

const scope = globalThis as unknown as RuntimeGlobal;
scope.TRACE_SESSION_MODE = __TRACE_SESSION_MODE__;

try {
  const extension = scope.browser ?? scope.chrome;
  if (!extension) throw new Error("extension environment unavailable");
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
    storageArea: extension.storage.local,
    storageMode: scope.browser ? "promise" : "callback",
    fetch: globalThis.fetch.bind(globalThis),
    apiBase: __TRACE_API_BASE__,
    webOrigin: __TRACE_WEB_ORIGIN__,
    randomId,
  });
} catch {
  scope.__traceSessionRuntimeBootFailed = true;
}
