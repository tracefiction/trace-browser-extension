import { extensionCall, type RuntimePort } from "./browser-platform.mjs";

/** Only coarse browser/OS and release number leave the worker. */
export function activityHeaders(
  runtime: RuntimePort,
  os: string,
  userAgent: string,
): Record<string, string> {
  const ios = os === "ios" || /iPhone|iPad|iPod/i.test(userAgent);
  const mobile = ios || os === "android" || /Android/i.test(userAgent);
  const headers: Record<string, string> = {
    "X-Trace-Platform": mobile ? "web_mobile" : "web_desktop",
  };
  const scheme = String(runtime.getURL?.("") ?? "");
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
  let dimensions: Promise<Record<string, string>> | undefined;
  const metadata = () =>
    (dimensions ??= (async () => {
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
      for (const [name, value] of Object.entries(await metadata()))
        headers.set(name, value);
      return fetchImpl(input, { ...init, headers });
    }
    return fetchImpl(input, init);
  };
}
