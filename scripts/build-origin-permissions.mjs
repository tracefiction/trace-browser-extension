export const AO3_HOST_MATCHES = [
  "https://archiveofourown.org/*",
  "https://*.archiveofourown.org/*",
  "https://archiveofourown.gay/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
];

// ao3.org is an official redirect to archiveofourown.org. The redirect
// completes before any Trace content script needs to run, so requesting its
// separate Safari website permission only adds onboarding friction.

export const FFN_HOST_MATCHES = [
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];

export const SITE_HOST_MATCHES = [...AO3_HOST_MATCHES, ...FFN_HOST_MATCHES];

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

/**
 * Converts the active configured origin into the manifest pattern Safari uses
 * for background network access and Trace-site token sync.
 */
export function originHostMatchPattern(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/**
 * The manifest must name only the currently configured Trace origins. Static
 * production and localhost fallbacks make Safari's iOS permission screen ask
 * users about hosts that the active build never uses.
 */
export function configuredOriginPermissions({ traceApiBase, traceWebOrigin }) {
  const apiHostMatch = originHostMatchPattern(traceApiBase);
  const webHostMatch = originHostMatchPattern(traceWebOrigin);

  return {
    // Safari background fetches use the API's explicit extension-origin CORS
    // policy. Keeping the API out of the Safari manifest avoids an unrelated
    // website row in iOS settings; it is not a page where Trace runs.
    safariHostPermissions: unique([
      ...SITE_HOST_MATCHES,
      webHostMatch,
    ]),
    // Chromium and Firefox require a host permission for extension-background
    // cross-origin fetches, so keep the API host in their packaged manifests.
    browserHostPermissions: unique([
      ...SITE_HOST_MATCHES,
      apiHostMatch,
      webHostMatch,
    ]),
    syncMatches: unique([webHostMatch]),
  };
}
