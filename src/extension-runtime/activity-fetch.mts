import { extensionCall, type RuntimePort } from "./browser-platform.mjs";

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
): typeof fetch {
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
      url.origin === new URL(apiBase).origin &&
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
        if (
          !(await acceptsActivityHeaders(
            fetchImpl,
            url.href,
            headers,
            signal,
            credentials,
          ))
        ) {
          metadataDisabled = true;
          // The failed attempt was OPTIONS only; send the actual request once
          // without optional headers, then stay downgraded for this worker.
          return fetchImpl(input, { ...init, headers: baseline });
        }
      }
      return fetchImpl(input, { ...init, headers });
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
  signal?: AbortSignal | null,
  credentials?: RequestCredentials,
): Promise<boolean> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
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
    signal?.throwIfAborted();
    return allowed;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
