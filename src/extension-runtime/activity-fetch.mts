import {
  extensionCall,
  type BrowserStorage,
  type RuntimePort,
} from "./browser-platform.mjs";

/** Only coarse browser/OS and release number leave the worker. */
export function activityHeaders(
  runtime: RuntimePort,
  os: string,
  userAgent: string,
): Record<string, string> {
  const scheme = String(runtime.getURL?.("") ?? "");
  // Firefox has no opt-in for technicalAndInteraction data in this release.
  // Unknown runtimes also fail closed: no added platform/browser/version data.
  if (!/^(chrome|safari-web)-extension:/.test(scheme)) return {};
  const ios = os === "ios" || /iPhone|iPad|iPod/i.test(userAgent);
  const mobile = ios || os === "android" || /Android/i.test(userAgent);
  const headers: Record<string, string> = {
    "X-Trace-Platform": mobile ? "web_mobile" : "web_desktop",
  };
  const browser = scheme.startsWith("moz-extension:")
    ? "firefox"
    : scheme.startsWith("chrome-extension:")
      ? /Edg\//.test(userAgent)
        ? "edge"
        : "chrome"
      : scheme.startsWith("safari-web-extension:")
        ? ios
          ? "safari_ios"
          : os === "mac"
            ? "safari_macos"
            : null
        : null;
  if (browser) headers["X-Trace-Extension-Browser"] = browser;
  const version = runtime.getManifest?.().version;
  if (
    typeof version === "string" &&
    /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/.test(version)
  )
    headers["X-Trace-Extension-Version"] = version;
  return headers;
}

export function createActivityFetch(
  fetchImpl: typeof fetch,
  runtime: RuntimePort,
  mode: "callback" | "promise",
  apiBase: string,
  storage?: Pick<BrowserStorage, "get" | "set">,
): typeof fetch {
  const apiOrigin = new URL(apiBase).origin;
  const cacheKey = `traceActivityCorsV1:${apiOrigin}`;
  // A persisted expiry avoids probing again whenever an MV3 worker wakes.
  // This is origin-wide API compatibility, never auth or permission evidence.
  const ttl = 60 * 60_000;
  let acceptedUntil = 0;
  let loaded = false;
  let probe: Promise<boolean> | undefined;
  const remember = (until: number) =>
    optionalCache(() => storage?.set({ [cacheKey]: until }));
  const accepts = (
    url: string,
    headers: Headers,
    credentials?: RequestCredentials,
  ) => {
    if (acceptedUntil > Date.now()) return Promise.resolve(true);
    return (probe ??= (async () => {
      if (!loaded) {
        loaded = true;
        const snapshot = await optionalCache(() => storage?.get(cacheKey));
        const until = snapshot?.[cacheKey];
        if (
          typeof until === "number" &&
          until > Date.now() &&
          until <= Date.now() + ttl
        ) acceptedUntil = until;
      }
      if (acceptedUntil > Date.now()) return true;
      // Shared by concurrent callers; one caller cancelling must not abort it.
      const allowed = await acceptsActivityHeaders(
        fetchImpl, url, headers, credentials,
      );
      if (allowed) {
        acceptedUntil = Date.now() + ttl;
        await remember(acceptedUntil);
      } else metadataDisabled = true;
      return allowed;
    })().finally(() => {
      probe = undefined;
    }));
  };
  const invalidate = async () => {
    acceptedUntil = 0;
    await remember(0);
  };
  let metadataDisabled = false;
  let dimensions: Promise<Record<string, string>> | undefined;
  const metadata = () =>
    (dimensions ??= (async () => {
      try {
        if (
          !/^(chrome|safari-web)-extension:/.test(
            String(runtime.getURL?.("") ?? ""),
          )
        )
          return {};
      } catch {
        return {};
      }
      let os = "unknown";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (runtime.getPlatformInfo) {
          const info = await Promise.race([
            extensionCall<{ os?: string }>(
              runtime as unknown as Record<
                string,
                (...args: unknown[]) => unknown
              >,
              "getPlatformInfo",
              [],
              runtime,
              mode,
            ),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 250);
            }),
          ]);
          os = info?.os ?? "unknown";
        }
      } catch {
        /* Optional dimensions must never block an API request. */
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        return activityHeaders(
          runtime,
          os,
          globalThis.navigator?.userAgent ?? "",
        );
      } catch {
        return {};
      }
    })());
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (
      url.origin === apiOrigin &&
      url.pathname.startsWith("/api/extension/") &&
      headers.has("Authorization")
    ) {
      // Preserve the original request body, credentials and cancellation.
      // Never retry a write after an opaque fetch failure: it may have committed.
      for (const name of ACTIVITY_HEADERS) headers.delete(name);
      const baseline = new Headers(headers);
      const extra = metadataDisabled ? {} : await metadata();
      if (Object.keys(extra).length) {
        for (const [name, value] of Object.entries(extra))
          headers.set(name, value);
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const credentials =
          init?.credentials ??
          (input instanceof Request ? input.credentials : undefined);
        signal?.throwIfAborted();
        const allowed = await accepts(url.href, headers, credentials);
        signal?.throwIfAborted();
        if (!allowed) {
          metadataDisabled = true;
          // The failed attempt was OPTIONS only; send the actual request once
          // without optional headers, then stay downgraded for this worker.
          return fetchImpl(input, { ...init, headers: baseline });
        }
      }
      try {
        const response = await fetchImpl(input, { ...init, headers });
        if (Object.keys(extra).length && !response.ok) await invalidate();
        return response;
      } catch (error) {
        // Invalidate for the NEXT call only. The failed write may have committed.
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (Object.keys(extra).length && !signal?.aborted) await invalidate();
        throw error;
      }
    }
    return fetchImpl(input, init);
  };
}

const ACTIVITY_HEADERS = [
  "X-Trace-Platform",
  "X-Trace-App-Version",
  "X-Trace-Extension-Browser",
  "X-Trace-Extension-Version",
];

/** Browsers expose CORS and ordinary network failures alike. Probe the exact
 * destination/header set with side-effect-free OPTIONS BEFORE the real call.
 * Old allow-lists reject the probe in preflight; no mutation has been sent. */
async function acceptsActivityHeaders(
  send: typeof fetch,
  url: string,
  headers: Headers,
  credentials?: RequestCredentials,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const allowed = await Promise.race([
      send(url, {
        method: "OPTIONS",
        headers,
        mode: "cors",
        redirect: "error",
        ...(credentials ? { credentials } : {}),
        signal: controller.signal,
      }).then(
        (response) => response.ok,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, 1000);
      }),
    ]);
    return allowed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Optional cache storage must not hold up saves when unavailable or stalled. */
async function optionalCache<T>(
  operation: () => Promise<T> | undefined,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
