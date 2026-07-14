import { TRACE_SHADOW_API_BASE } from "./config.mjs";
import {
  installShadowObserver,
  type ShadowObserverController,
} from "./observer.mjs";
import type {
  ShadowFetch,
  ShadowRuntimePort,
  ShadowStorageArea,
} from "./browser-adapters.mjs";

interface ShadowGlobalScope {
  readonly browser?: {
    readonly runtime: ShadowRuntimePort;
    readonly storage: { readonly local: ShadowStorageArea };
  };
  readonly chrome?: {
    readonly runtime: ShadowRuntimePort;
    readonly storage: { readonly local: ShadowStorageArea };
  };
  readonly fetch?: ShadowFetch;
  readonly crypto?: { randomUUID?: () => string };
  __traceShadowObserver?: ShadowObserverController;
  __traceShadowObserverBootFailed?: true;
}

const scope = globalThis as unknown as ShadowGlobalScope;

try {
  const extension = scope.browser ?? scope.chrome;
  if (!extension || !scope.fetch) throw new Error("shadow environment unavailable");
  let fallbackReference = 0;
  const randomId = (): string => {
    const uuid = scope.crypto?.randomUUID?.();
    if (uuid) return uuid;
    fallbackReference += 1;
    return `${Date.now()}-${fallbackReference}`;
  };
  scope.__traceShadowObserver = installShadowObserver({
    runtime: extension.runtime,
    storageArea: extension.storage.local,
    storageMode: scope.browser ? "promise" : "callback",
    fetch: scope.fetch.bind(globalThis),
    apiBase: TRACE_SHADOW_API_BASE,
    randomId,
  });
} catch {
  // Shadow boot must never prevent the legacy dev worker from loading.
  scope.__traceShadowObserverBootFailed = true;
}
