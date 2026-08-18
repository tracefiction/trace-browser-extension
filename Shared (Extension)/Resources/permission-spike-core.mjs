export const AO3_PERMISSION_BUNDLE = Object.freeze([
  "https://archiveofourown.org/*",
  "https://*.archiveofourown.org/*",
  "https://archiveofourown.gay/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
]);

export const AO3_PERMISSION_SPIKE_SCRIPT_ID =
  "trace-ao3-permission-bundle-spike";

const AO3_AUTH_PATHS = Object.freeze([
  "users/login*",
  "users/sign_up*",
  "users/password*",
  "users/auth/*",
  "users/logout*",
]);

export const AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES = Object.freeze(
  AO3_PERMISSION_BUNDLE.flatMap((origin) => {
    const base = origin.endsWith("/*") ? origin.slice(0, -1) : origin;
    return AO3_AUTH_PATHS.map((path) => `${base}${path}`);
  }),
);

const GLOBAL_ORIGIN_PATTERNS = new Set(["<all_urls>", "*://*/*"]);

export function permissionBundleCoverage(grantedOrigins) {
  const normalized = new Set(
    Array.isArray(grantedOrigins)
      ? grantedOrigins.filter((origin) => typeof origin === "string")
      : [],
  );
  const globallyGranted = [...GLOBAL_ORIGIN_PATTERNS].some((origin) =>
    normalized.has(origin),
  );
  const missing = globallyGranted
    ? []
    : AO3_PERMISSION_BUNDLE.filter((origin) => !normalized.has(origin));
  return Object.freeze({
    complete: missing.length === 0,
    globallyGranted,
    missing: Object.freeze(missing),
  });
}

export function registeredProbeScript() {
  return {
    id: AO3_PERMISSION_SPIKE_SCRIPT_ID,
    js: ["permission-spike-content.js"],
    matches: [...AO3_PERMISSION_BUNDLE],
    excludeMatches: [...AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES],
    persistAcrossSessions: true,
    runAt: "document_idle",
  };
}
