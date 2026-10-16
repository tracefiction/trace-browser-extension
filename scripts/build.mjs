#!/usr/bin/env node
/**
 * Builds Trace browser extension assets:
 * - Injects TRACE_API_BASE / TRACE_WEB_ORIGIN into background.js and popup config
 * - Syncs manifest version from package.json
 * - Writes Safari Resources + dist/chrome + dist/firefox (Firefox manifest includes gecko id)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import {
  AO3_HOST_MATCHES,
  FFN_HOST_MATCHES,
  MINIMIZED_SITE_HOST_MATCHES,
  SITE_HOST_MATCHES,
  configuredOriginPermissions,
} from "./build-origin-permissions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RES = path.join(ROOT, "Shared (Extension)", "Resources");
const SRC_BG = path.join(ROOT, "src", "background.js");

function loadEnvFile(p) {
  const out = {};
  try {
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {
    // optional file
  }
  return out;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFiltered(srcDir, destDir, { skip } = { skip: () => false }) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const sp = path.join(srcDir, name);
    const dp = path.join(destDir, name);
    if (skip(sp, name)) continue;
    const st = fs.statSync(sp);
    if (st.isDirectory()) copyDirFiltered(sp, dp, { skip });
    else fs.copyFileSync(sp, dp);
  }
}

const fileEnv = loadEnvFile(path.join(ROOT, ".env"));
const requestedBuildMode = process.env.TRACE_BUILD_MODE ?? fileEnv.TRACE_BUILD_MODE;
const BUILD_MODE = requestedBuildMode === "release"
  ? "release"
  : "dev";
// Dev builds prefer repo `.env` so local config is stable. Release builds prefer shell env so CI
// and one-off verification can override a local `.env` without editing tracked files.
const env =
  BUILD_MODE === "release"
    ? { ...fileEnv, ...process.env }
    : { ...process.env, ...fileEnv };
const IS_RELEASE = BUILD_MODE === "release";
const IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE = /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE ?? ""),
);
const IOS_EARNED_PERMISSION_ONBOARDING = /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_EARNED_PERMISSION_ONBOARDING ?? ""),
);
const IOS_EARNED_PERMISSION_PREVIEW_RELEASE = /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_EARNED_PERMISSION_PREVIEW_RELEASE ?? ""),
);
const IOS_ACTIVE_TAB_PROBE = IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE || /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_ACTIVE_TAB_PROBE ?? ""),
);
// The iPhone and iPad build declares its story sites as optional, so the first
// tap on Trace opens it without a website question, and registers its page
// scripts once the reader allows those sites. The earlier shape, with the
// sites required and the scripts declared in the manifest, stays buildable.
const IOS_EARNED_PERMISSION_REQUIRED_HOSTS = /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_EARNED_PERMISSION_REQUIRED_HOSTS ?? ""),
);
if (IOS_EARNED_PERMISSION_REQUIRED_HOSTS && !IOS_EARNED_PERMISSION_ONBOARDING) {
  throw new Error(
    "TRACE_IOS_EARNED_PERMISSION_REQUIRED_HOSTS requires the earned-permission build.",
  );
}
const IOS_OPTIONAL_STORY_SITE_ACCESS =
  IOS_EARNED_PERMISSION_ONBOARDING && !IOS_EARNED_PERMISSION_REQUIRED_HOSTS;
// Saving the story the reader opens Trace on, before lasting access, without
// a further tap. It has not yet been proven end to end in Safari. So it is a
// development switch, and three rules keep it one.
//  1. No release build can turn it on, whatever else is set. Shipping it is a
//     change to this file, made on purpose, not a setting.
//  2. A development build that talks to the production service can turn it on
//     only with a second switch, named for what it is, given on the command
//     line. A line in `.env` is never enough.
//  3. It changes only when a save is made, never what the sheet shows: every
//     build with optional story sites carries the same sheet, its background
//     wiring and its page file. With the switch off the sheet opens on "Save
//     this story" and the reader's tap saves.
const IOS_FIRST_TAP_SAVE = /^(?:1|true)$/i.test(
  String(env.TRACE_IOS_FIRST_TAP_SAVE ?? ""),
);
const IOS_FIRST_TAP_PRODUCTION_PROOF = /^(?:1|true)$/i.test(
  String(process.env.TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF ?? ""),
);
if (IOS_FIRST_TAP_SAVE && !IOS_OPTIONAL_STORY_SITE_ACCESS) {
  throw new Error(
    "TRACE_IOS_FIRST_TAP_SAVE requires the iPhone build with optional story sites.",
  );
}
if (IOS_FIRST_TAP_SAVE && IS_RELEASE) {
  throw new Error(
    "TRACE_IOS_FIRST_TAP_SAVE cannot be turned on in a release build.",
  );
}
if (IOS_FIRST_TAP_PRODUCTION_PROOF && !IOS_FIRST_TAP_SAVE) {
  throw new Error(
    "TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF is only for a build with TRACE_IOS_FIRST_TAP_SAVE.",
  );
}
if (
  IOS_EARNED_PERMISSION_PREVIEW_RELEASE &&
  (!IOS_EARNED_PERMISSION_ONBOARDING || !IS_RELEASE)
) {
  throw new Error(
    "TRACE_IOS_EARNED_PERMISSION_PREVIEW_RELEASE requires the release-mode earned-permission build.",
  );
}
const requestedSessionMode = process.env.TRACE_SESSION_MODE ?? fileEnv.TRACE_SESSION_MODE ?? "legacy";
if (!["legacy", "kernel", "disabled"].includes(requestedSessionMode)) {
  throw new Error(
    `TRACE_SESSION_MODE must be legacy, kernel, or disabled. Received: ${requestedSessionMode}`,
  );
}
const SESSION_MODE = requestedSessionMode;
const NATIVE_IMPORT_HANDOFF = env.TRACE_NATIVE_IMPORT_CONTRACT === "trace-native-library-import-v1";
if (env.TRACE_NATIVE_IMPORT_CONTRACT && !NATIVE_IMPORT_HANDOFF) {
  throw new Error("Unsupported TRACE_NATIVE_IMPORT_CONTRACT.");
}
if (NATIVE_IMPORT_HANDOFF && SESSION_MODE !== "kernel") {
  throw new Error("Native Import requires the kernel paired package.");
}
const HAS_SESSION_RUNTIME = SESSION_MODE !== "legacy";
// The AO3 History experiment (src/extension-runtime/ao3-history-experiment.mts)
// is for one physical-iPhone test. Three rules keep it out of everything else.
//  1. No release build can turn it on, whatever else is set.
//  2. The switch is read from the command line only; a line in `.env` is never
//     enough.
//  3. It exists only in the kernel iPhone build with optional story sites.
//     Every other build has none of its background code, its sheet section or
//     its page file.
const AO3_HISTORY_EXPERIMENT = /^(?:1|true)$/i.test(
  String(process.env.TRACE_AO3_HISTORY_EXPERIMENT ?? ""),
);
if (AO3_HISTORY_EXPERIMENT && IS_RELEASE) {
  throw new Error("TRACE_AO3_HISTORY_EXPERIMENT cannot be turned on in a release build.");
}
if (AO3_HISTORY_EXPERIMENT && !(IOS_OPTIONAL_STORY_SITE_ACCESS && SESSION_MODE === "kernel")) {
  throw new Error(
    "TRACE_AO3_HISTORY_EXPERIMENT requires the kernel iPhone build with optional story sites.",
  );
}
const AO3_HISTORY_EXPERIMENT_PANEL = "ao3-history-experiment-panel.js";
// The sheet that saves a story by the reader's tap and then asks for lasting
// access. Rule 3 above: the same in every build with optional story sites.
const IOS_FIRST_TAP_SHEET = IOS_OPTIONAL_STORY_SITE_ACCESS && SESSION_MODE === "kernel";
if (IOS_ACTIVE_TAB_PROBE && SESSION_MODE !== "kernel") {
  throw new Error("TRACE_IOS_ACTIVE_TAB_PROBE requires TRACE_SESSION_MODE=kernel.");
}
const AO3_AUTH_EXCLUDE_MATCHES = [
  "https://archiveofourown.org/users/login*",
  "https://*.archiveofourown.org/users/login*",
  "https://archiveofourown.org/users/sign_up*",
  "https://*.archiveofourown.org/users/sign_up*",
  "https://archiveofourown.org/users/password*",
  "https://*.archiveofourown.org/users/password*",
  "https://archiveofourown.org/users/auth/*",
  "https://*.archiveofourown.org/users/auth/*",
  "https://archiveofourown.org/users/logout*",
  "https://*.archiveofourown.org/users/logout*",
  "https://archiveofourown.gay/users/login*",
  "https://*.archiveofourown.gay/users/login*",
  "https://archiveofourown.gay/users/sign_up*",
  "https://*.archiveofourown.gay/users/sign_up*",
  "https://archiveofourown.gay/users/password*",
  "https://*.archiveofourown.gay/users/password*",
  "https://archiveofourown.gay/users/auth/*",
  "https://*.archiveofourown.gay/users/auth/*",
  "https://archiveofourown.gay/users/logout*",
  "https://*.archiveofourown.gay/users/logout*",
  "https://archive.transformativeworks.org/users/login*",
  "https://archive.transformativeworks.org/users/sign_up*",
  "https://archive.transformativeworks.org/users/password*",
  "https://archive.transformativeworks.org/users/auth/*",
  "https://archive.transformativeworks.org/users/logout*",
  "https://ao3.org/users/login*",
  "https://*.ao3.org/users/login*",
  "https://ao3.org/users/sign_up*",
  "https://*.ao3.org/users/sign_up*",
  "https://ao3.org/users/password*",
  "https://*.ao3.org/users/password*",
  "https://ao3.org/users/auth/*",
  "https://*.ao3.org/users/auth/*",
  "https://ao3.org/users/logout*",
  "https://*.ao3.org/users/logout*",
];
const FFN_AUTH_EXCLUDE_MATCHES = [
  "https://www.fanfiction.net/login.php*",
  "https://www.fanfiction.net/signup.php*",
  "https://www.fanfiction.net/account/login*",
  "https://www.fanfiction.net/account/signup*",
  "https://www.fanfiction.net/auth/*",
  "https://m.fanfiction.net/login.php*",
  "https://m.fanfiction.net/signup.php*",
  "https://m.fanfiction.net/account/login*",
  "https://m.fanfiction.net/account/signup*",
  "https://m.fanfiction.net/auth/*",
];
const SITE_AUTH_EXCLUDE_MATCHES = [
  ...AO3_AUTH_EXCLUDE_MATCHES,
  ...FFN_AUTH_EXCLUDE_MATCHES,
];
const RELEASE_TRACE_API_BASE = "https://api.tracefiction.com";
const RELEASE_TRACE_WEB_ORIGIN = "https://www.tracefiction.com";
const EARNED_PERMISSION_DEV_API_BASE =
  "https://api.development.example.test";
const EARNED_PERMISSION_DEV_WEB_ORIGIN =
  "https://web.development.example.test";
// This input belongs only to the deliberately opted-in development package.
// Resolve it once so runtime URLs and exact release assertions cannot diverge.
const devConfigPath = env.TRACE_EXTENSION_DEV_CONFIG;
if (devConfigPath !== undefined && !IOS_EARNED_PERMISSION_PREVIEW_RELEASE) {
  throw new Error("TRACE_EXTENSION_DEV_CONFIG requires the explicit earned-permission preview-release mode.");
}
function validatedDevelopmentOrigin(value) {
  if (typeof value !== "string" || value.length > 253 ||
      !/^https:\/\/[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new Error("Development configuration requires canonical HTTPS origins without credentials, ports, paths, query or fragment.");
  }
  const url = new URL(value);
  const labels = url.hostname.split(".");
  if (url.origin !== value || labels.length < 2 || labels.some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      labels.includes("localhost") || /^[0-9.]+$/.test(url.hostname)) {
    throw new Error("Development configuration requires a non-local, exact DNS origin without wildcards.");
  }
  return value;
}
const developmentOrigins = (() => {
  if (devConfigPath === undefined) return {
    apiOrigin: EARNED_PERMISSION_DEV_API_BASE, webOrigin: EARNED_PERMISSION_DEV_WEB_ORIGIN,
  };
  if (!path.isAbsolute(devConfigPath)) throw new Error("TRACE_EXTENSION_DEV_CONFIG must be an absolute JSON file path.");
  const config = JSON.parse(fs.readFileSync(devConfigPath, "utf8"));
  if (!config || Array.isArray(config) || typeof config !== "object" ||
      Object.keys(config).sort().join(",") !== "apiOrigin,webOrigin") {
    throw new Error("Development configuration requires exactly apiOrigin and webOrigin.");
  }
  return {
    apiOrigin: validatedDevelopmentOrigin(config.apiOrigin),
    webOrigin: validatedDevelopmentOrigin(config.webOrigin),
  };
})();
const FIREFOX_RELEASE_EXTENSION_ID = "trace@tracefiction.com";
const FIREFOX_DEV_EXTENSION_ID = "trace-dev@tracefiction.com";
const SAFARI_ONLY_PERMISSIONS = ["nativeMessaging"];
const NORMAL_SAFARI_PERMISSIONS = ["alarms", "tabs", "storage", ...(SESSION_MODE === "kernel" ? ["scripting"] : []), ...SAFARI_ONLY_PERMISSIONS];
// No `tabs`: with it, or with required story sites, Safari asks about the
// site before Trace opens. `activeTab` covers the one tab the reader tapped
// Trace on; `scripting` registers the page scripts after the grant.
const IOS_ACTIVE_TAB_PROBE_PERMISSIONS = [
  "alarms",
  "storage",
  ...SAFARI_ONLY_PERMISSIONS,
  "activeTab",
  "scripting",
];
const IOS_ACTIVE_TAB_PERMISSIONS =
  IOS_ACTIVE_TAB_PROBE || IOS_OPTIONAL_STORY_SITE_ACCESS;

function isLocalLike(value) {
  return /localhost|127\.0\.0\.1/i.test(value);
}

const RELEASE_ORIGINS_HINT =
  "Release builds (including npm run agent:check) need the production origins, as CI sets them: " +
  "TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com";

function assertReleaseUrl(name, value, expected) {
  if (!value) {
    throw new Error(`${name} must be set for release builds. ${RELEASE_ORIGINS_HINT}`);
  }
  if (!/^https:\/\//i.test(value)) {
    throw new Error(`${name} must use https:// for release builds. Received: ${value}. ${RELEASE_ORIGINS_HINT}`);
  }
  if (isLocalLike(value)) {
    throw new Error(`${name} cannot point at localhost for release builds. Received: ${value}`);
  }
  if (value !== expected) {
    throw new Error(`${name} must be ${expected} for store/App Store release builds. Received: ${value}`);
  }
}

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function firefoxCompatibleMatchPattern(pattern) {
  if (typeof pattern !== "string") return pattern;
  const match = pattern.match(/^([^:/]+):\/\/([^/]+)(\/.*)$/);
  if (!match) return pattern;

  const [, scheme, host, pathPart] = match;
  const hostWithoutPort = host.replace(/:\d+$/, "");
  return `${scheme}://${hostWithoutPort}${pathPart}`;
}

function firefoxCompatibleManifest(baseManifest) {
  return {
    ...baseManifest,
    host_permissions: unique(
      (baseManifest.host_permissions || []).map(firefoxCompatibleMatchPattern),
    ),
    content_scripts: (baseManifest.content_scripts || []).map((entry) => ({
      ...entry,
      matches: unique((entry.matches || []).map(firefoxCompatibleMatchPattern)),
      exclude_matches: Array.isArray(entry.exclude_matches)
        ? unique(entry.exclude_matches.map(firefoxCompatibleMatchPattern))
        : entry.exclude_matches,
    })),
  };
}

function browserStoreManifest(baseManifest, browserHostPermissions) {
  const safariOnlyPermissions = new Set(SAFARI_ONLY_PERMISSIONS);
  return {
    ...baseManifest,
    host_permissions: browserHostPermissions,
    permissions: unique(
      (baseManifest.permissions || []).filter(
        (permission) => !safariOnlyPermissions.has(permission),
      ),
    ),
  };
}

const TRACE_API_BASE = (
  IOS_EARNED_PERMISSION_PREVIEW_RELEASE ? developmentOrigins.apiOrigin : (env.TRACE_API_BASE ?? "http://localhost:3001")
).replace(/\/$/, "");
const TRACE_WEB_ORIGIN = (
  IOS_EARNED_PERMISSION_PREVIEW_RELEASE ? developmentOrigins.webOrigin : (env.TRACE_WEB_ORIGIN ?? "http://localhost:5173")
).replace(/\/$/, "");

if (NATIVE_IMPORT_HANDOFF) {
  const origin = new URL(TRACE_API_BASE);
  if (origin.protocol !== "https:" || origin.origin !== TRACE_API_BASE || origin.port) {
    throw new Error("Native Import requires an exact HTTPS API origin for its paired package.");
  }
}

const savedFiltersScript = "ao3-saved-filters.js";
const finishQualifyScript = "trace-finish-qualify.js";
// Keep the optional-permission runtime and the generated Safari manifest on
// one canonical content-script declaration. The background worker receives
// this same configuration at build time so a grant made in Safari Settings
// can register the scripts without requiring the popup to open first.
const archiveContentScript = {
  matches: SITE_HOST_MATCHES,
  js: [
    "content-config.js",
    finishQualifyScript,
    "collector.js",
    "library-overlay-keys.js",
    "library-overlay.js",
  ],
  run_at: "document_end",
  exclude_matches: SITE_AUTH_EXCLUDE_MATCHES,
};
const savedFiltersContentScript = {
  matches: AO3_HOST_MATCHES,
  js: [savedFiltersScript],
  run_at: "document_end",
  exclude_matches: AO3_AUTH_EXCLUDE_MATCHES,
};
const earnedPermissionRegistrations = [
  {
    id: "trace-archive-automation-v1",
    matches: MINIMIZED_SITE_HOST_MATCHES,
    js: archiveContentScript.js,
    runAt: "document_end",
    persistAcrossSessions: true,
    excludeMatches: SITE_AUTH_EXCLUDE_MATCHES,
  },
  {
    id: "trace-ao3-saved-filters-v1",
    matches: MINIMIZED_SITE_HOST_MATCHES.filter((match) =>
      match.includes("archiveofourown") || match.includes("transformativeworks"),
    ),
    js: savedFiltersContentScript.js,
    runAt: "document_end",
    persistAcrossSessions: true,
    excludeMatches: AO3_AUTH_EXCLUDE_MATCHES,
  },
];
const earnedPermissionRuntimeConfig = {
  // 4 is the first generation registered at runtime in a released build. A
  // registration left by anything earlier is replaced once, not trusted by id.
  version: IOS_OPTIONAL_STORY_SITE_ACCESS ? 4 : 3,
  registrationMode: IOS_OPTIONAL_STORY_SITE_ACCESS ? "dynamic" : "static",
  ...(IOS_FIRST_TAP_SAVE ? { firstTapSave: true } : {}),
  origins: MINIMIZED_SITE_HOST_MATCHES,
  registrations: earnedPermissionRegistrations,
};

// Rule 2 above. The proof build is for trying the first-tap save against the
// real service before it ships; it is a development build in every other way.
if (
  IOS_FIRST_TAP_SAVE &&
  (TRACE_API_BASE === RELEASE_TRACE_API_BASE || TRACE_WEB_ORIGIN === RELEASE_TRACE_WEB_ORIGIN) &&
  !IOS_FIRST_TAP_PRODUCTION_PROOF
) {
  throw new Error(
    "TRACE_IOS_FIRST_TAP_SAVE with the production service needs TRACE_IOS_FIRST_TAP_PRODUCTION_PROOF=1 on the command line.",
  );
}

if (IS_RELEASE) {
  assertReleaseUrl(
    "TRACE_API_BASE",
    TRACE_API_BASE,
    IOS_EARNED_PERMISSION_PREVIEW_RELEASE
      ? developmentOrigins.apiOrigin
      : RELEASE_TRACE_API_BASE,
  );
  assertReleaseUrl(
    "TRACE_WEB_ORIGIN",
    TRACE_WEB_ORIGIN,
    IOS_EARNED_PERMISSION_PREVIEW_RELEASE
      ? developmentOrigins.webOrigin
      : RELEASE_TRACE_WEB_ORIGIN,
  );
} else if (isLocalLike(TRACE_API_BASE) || isLocalLike(TRACE_WEB_ORIGIN)) {
  console.warn(
    "[Trace build] Using local development origins. Use TRACE_BUILD_MODE=release for store/App Store artifacts.",
  );
}

let bg = fs.readFileSync(SRC_BG, "utf8");
bg = bg
  .replace(/__TRACE_API_BASE__/g, TRACE_API_BASE)
  .replace(/__TRACE_WEB_ORIGIN__/g, TRACE_WEB_ORIGIN);

const sessionRuntimeOutput = path.join(ROOT, ".trace-build", "extension-session-runtime.js");
if (HAS_SESSION_RUNTIME) {
  await esbuild({
    // The experiment build bundles its own entry: the ordinary background,
    // then the experiment. Every other build bundles index.mts alone.
    entryPoints: [path.join(ROOT, "src", "extension-runtime",
      AO3_HISTORY_EXPERIMENT ? "ao3-history-experiment-entry.mts" : "index.mts")],
    outfile: sessionRuntimeOutput,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    splitting: false,
    minify: false,
    sourcemap: false,
    define: {
      __TRACE_SESSION_MODE__: JSON.stringify(SESSION_MODE),
      __TRACE_API_BASE__: JSON.stringify(TRACE_API_BASE),
      __TRACE_WEB_ORIGIN__: JSON.stringify(TRACE_WEB_ORIGIN),
      __TRACE_NATIVE_IMPORT_HANDOFF__: JSON.stringify(NATIVE_IMPORT_HANDOFF),
      __TRACE_IOS_FIRST_TAP_SAVE__: JSON.stringify(IOS_FIRST_TAP_SAVE),
      __TRACE_IOS_FIRST_TAP_SHEET__: JSON.stringify(IOS_FIRST_TAP_SHEET),
      __TRACE_IOS_EARNED_PERMISSION_CONFIG__: JSON.stringify(
        IOS_EARNED_PERMISSION_ONBOARDING
          ? earnedPermissionRuntimeConfig
          : null,
      ),
    },
    logLevel: "silent",
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";

const outBg = path.join(RES, "background.js");
const popupConfigPath = path.join(RES, "popup-config.js");
const contentConfigPath = path.join(RES, "content-config.js");
// Remove resources emitted by the proof-only multi-file packaging seam. The
// production owner is one classic background entry so Safari, Chrome, and
// Firefox execute the same ordered artifact.
fs.rmSync(path.join(RES, "extension-session-runtime.js"), { force: true });
fs.rmSync(path.join(RES, "legacy-background.js"), { force: true });
// The first-tap sheet's page file is part of every package that has the sheet.
const pageManualModePath = path.join(RES, "page-manual-mode.js");
if (IOS_FIRST_TAP_SHEET) {
  fs.copyFileSync(path.join(ROOT, "src", "page-manual-mode.js"), pageManualModePath);
} else {
  fs.rmSync(pageManualModePath, { force: true });
}
// The experiment's sheet section belongs to the experiment build alone.
const ao3HistoryExperimentPanelPath = path.join(RES, AO3_HISTORY_EXPERIMENT_PANEL);
if (AO3_HISTORY_EXPERIMENT) {
  fs.copyFileSync(path.join(ROOT, "src", AO3_HISTORY_EXPERIMENT_PANEL), ao3HistoryExperimentPanelPath);
} else {
  fs.rmSync(ao3HistoryExperimentPanelPath, { force: true });
}
if (HAS_SESSION_RUNTIME) {
  const runtimeHeader = `// Generated ${SESSION_MODE} runtime. Do not edit by hand.
const TRACE_API_BASE = ${JSON.stringify(TRACE_API_BASE)};
const TRACE_WEB_ORIGIN = ${JSON.stringify(TRACE_WEB_ORIGIN)};
`;
  fs.writeFileSync(
    outBg,
    `${runtimeHeader}${fs.readFileSync(sessionRuntimeOutput, "utf8")}`,
    "utf8",
  );
} else {
  fs.writeFileSync(outBg, bg, "utf8");
}
console.log("Wrote", outBg);

const manifestPath = path.join(RES, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
// The description is written once, in the English locale file, and copied
// into every manifest. Apple refuses a Safari extension whose description is
// longer than 112 characters, in the manifest or in a locale.
const SAFARI_DESCRIPTION_LIMIT = 112;
const localeMessages = JSON.parse(
  fs.readFileSync(path.join(RES, "_locales", "en", "messages.json"), "utf8"),
);
const extensionDescription = localeMessages.extension_description?.message;
if (
  typeof extensionDescription !== "string" ||
  extensionDescription.length === 0 ||
  extensionDescription.length > SAFARI_DESCRIPTION_LIMIT
) {
  throw new Error(
    `_locales/en/messages.json extension_description must be 1 to ${SAFARI_DESCRIPTION_LIMIT} characters. Received ${
      typeof extensionDescription === "string" ? extensionDescription.length : "no text"
    }.`,
  );
}
manifest.description = extensionDescription;
// A build with the unfinished first-tap save on carries that in its name, so
// it cannot be mistaken for the extension that ships.
const extensionName = localeMessages.extension_name?.message;
if (typeof extensionName !== "string" || extensionName.length === 0) {
  throw new Error("_locales/en/messages.json extension_name must be set.");
}
manifest.name = IOS_FIRST_TAP_SAVE ? `${extensionName} (first-tap proof)` : extensionName;
manifest.permissions = IOS_ACTIVE_TAB_PERMISSIONS
  ? [...IOS_ACTIVE_TAB_PROBE_PERMISSIONS]
  : [...NORMAL_SAFARI_PERMISSIONS];

const {
  safariHostPermissions,
  browserHostPermissions,
  syncMatches,
} = configuredOriginPermissions({
  traceApiBase: TRACE_API_BASE,
  traceWebOrigin: TRACE_WEB_ORIGIN,
});

// The required-hosts build preserves the permission-bearing Safari manifest
// shipped in 0.6.5. The iPhone build names the same story sites as optional,
// and no longer names Trace's own site: the app, not a page, connects it.
manifest.host_permissions = IOS_ACTIVE_TAB_PERMISSIONS ? [] : safariHostPermissions;
if (IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE || IOS_OPTIONAL_STORY_SITE_ACCESS) {
  manifest.optional_host_permissions = [...MINIMIZED_SITE_HOST_MATCHES];
} else {
  delete manifest.optional_host_permissions;
}
const traceContentScript = {
  matches: unique(syncMatches),
  js: ["content-config.js", "sync.js"],
  run_at: "document_idle",
};
const normalContentScripts = [
  archiveContentScript,
  traceContentScript,
  savedFiltersContentScript,
];
const earnedCompatibilityContentScripts = [
  {
    ...archiveContentScript,
    js: [
      "popup-config.js",
      finishQualifyScript,
      "collector.js",
      "library-overlay-keys.js",
      "library-overlay.js",
    ],
  },
  {
    ...traceContentScript,
    js: ["popup-config.js", "sync.js"],
  },
  savedFiltersContentScript,
];
const popupConfig = `// Generated by npm run build (scripts/build.mjs). Do not edit by hand.
globalThis.TRACE_EXTENSION_WEB_ORIGIN = ${JSON.stringify(TRACE_WEB_ORIGIN)};
${HAS_SESSION_RUNTIME ? `globalThis.TRACE_SESSION_MODE = ${JSON.stringify(SESSION_MODE)};\n` : ""}${IOS_ACTIVE_TAB_PROBE ? "globalThis.TRACE_IOS_ACTIVE_TAB_PROBE = true;\n" : ""}${IOS_EARNED_PERMISSION_ONBOARDING ? `globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING = ${JSON.stringify({
  ...earnedPermissionRuntimeConfig,
})};
(function () {
  var config = globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING;
  var host = String(globalThis.location && globalThis.location.hostname || "").toLowerCase();
  var archiveHost =
    host === "archiveofourown.org" ||
    host.endsWith(".archiveofourown.org") ||
    host === "archiveofourown.gay" ||
    host.endsWith(".archiveofourown.gay") ||
    host === "archive.transformativeworks.org" ||
    host === "www.fanfiction.net" ||
    host === "m.fanfiction.net";
  if (!config || config.registrationMode !== "static" || !archiveHost) return;
  globalThis.TRACE_EARNED_PERMISSION_COMPLETE = false;
  var extension = globalThis.browser || globalThis.chrome;
  var publish = function (response) {
    if (!response || response.ok !== true || response.completeGrant !== true || response.registered !== true) return;
    globalThis.TRACE_EARNED_PERMISSION_COMPLETE = true;
    try {
      document.dispatchEvent(new CustomEvent("trace-earned-permission-ready"));
    } catch (_) {}
  };
  // Safari injects into open tabs as soon as the extension (re)loads, which can
  // be before the background has registered its listeners. That reply is
  // empty, not a reconcile result, so ask again instead of leaving this page
  // gated until a reload. A background that could not read its permission
  // state answers registration_failed, which is also transient. A definite
  // answer, complete or not, ends this round of asking.
  var retryDelaysMs = [250, 1000, 3000, 8000];
  var replyTimeoutMs = 10000;
  // After an app update Safari can take longer than every bounded retry to
  // wake the new background, and a reader who keeps reading never leaves the
  // tab. Their next touch or scroll asks again, at most this often.
  var interactionAskIntervalMs = 10000;
  var lastAskAt = 0;
  var unanswered = false;
  var attempt = 0;
  var request = 0;
  var inFlight = false;
  var timer = null;
  var reconcile;
  var retryFor = function (id) {
    return function () {
      if (id !== request || !inFlight) return;
      inFlight = false;
      if (attempt >= retryDelaysMs.length) {
        unanswered = true;
        return;
      }
      timer = setTimeout(reconcile, retryDelaysMs[attempt]);
      attempt += 1;
    };
  };
  var settleFor = function (id) {
    var retry = retryFor(id);
    return function (response) {
      if (id !== request || !inFlight) return;
      if (!response || typeof response !== "object" || typeof response.completeGrant !== "boolean" ||
          (response.ok !== true && response.error === "registration_failed")) {
        retry();
        return;
      }
      inFlight = false;
      publish(response);
    };
  };
  reconcile = function () {
    timer = null;
    if (globalThis.TRACE_EARNED_PERMISSION_COMPLETE === true) return;
    request += 1;
    inFlight = true;
    lastAskAt = Date.now();
    unanswered = false;
    var retry = retryFor(request);
    var settle = settleFor(request);
    // A reply Safari never delivers must not hold the page gated.
    setTimeout(retry, replyTimeoutMs);
    try {
      if (globalThis.browser && extension === globalThis.browser) {
        Promise.resolve(extension.runtime.sendMessage({ type: "TRACE_EARNED_PERMISSION_RECONCILE" })).then(settle, retry);
      } else {
        extension.runtime.sendMessage({ type: "TRACE_EARNED_PERMISSION_RECONCILE" }, function (response) {
          if (extension.runtime.lastError) {
            retry();
            return;
          }
          settle(response);
        });
      }
    } catch (_) {
      retry();
    }
  };
  // A page restored from the back-forward cache, or brought back to the
  // foreground, may have spent its bounded retries while Safari had the
  // background asleep, or the grant may have changed meanwhile. Start a fresh
  // round instead of leaving the page without Trace until Safari restarts.
  var resume = function (event) {
    if (globalThis.TRACE_EARNED_PERMISSION_COMPLETE === true || inFlight) return;
    if (event && event.type === "visibilitychange" && globalThis.document && globalThis.document.hidden) return;
    if (timer !== null) clearTimeout(timer);
    attempt = 0;
    reconcile();
  };
  var nudge = function () {
    // Only a page whose questions all went unanswered asks again; a definite
    // answer (for example, access not allowed) is not repeated.
    if (!unanswered || globalThis.TRACE_EARNED_PERMISSION_COMPLETE === true || inFlight || timer !== null) return;
    if (Date.now() - lastAskAt < interactionAskIntervalMs) return;
    attempt = 0;
    reconcile();
  };
  try {
    globalThis.addEventListener("pageshow", resume);
    globalThis.addEventListener("focus", resume);
    globalThis.document.addEventListener("visibilitychange", resume);
    globalThis.addEventListener("scroll", nudge, { passive: true });
    globalThis.addEventListener("touchstart", nudge, { passive: true });
    globalThis.addEventListener("pointerdown", nudge, { passive: true });
  } catch (_) {}
  reconcile();
})();
` : ""}`;
// Only the experiment build's sheet loads the experiment section, and only in
// the sheet itself, never on a page that loads this file.
const ao3HistoryExperimentLoader = AO3_HISTORY_EXPERIMENT ? `(function () {
  try {
    var extension = globalThis.browser || globalThis.chrome;
    if (!extension || !extension.runtime || typeof extension.runtime.getURL !== "function") return;
    if (String(globalThis.location && globalThis.location.href || "").indexOf(extension.runtime.getURL("popup.html")) !== 0) return;
    var script = document.createElement("script");
    script.src = ${JSON.stringify(AO3_HISTORY_EXPERIMENT_PANEL)};
    document.head.appendChild(script);
  } catch (_) {}
})();
` : "";
const contentConfig = `// Generated by npm run build (scripts/build.mjs). Do not edit by hand.
globalThis.TRACE_EXTENSION_WEB_ORIGIN = ${JSON.stringify(TRACE_WEB_ORIGIN)};
${HAS_SESSION_RUNTIME ? `globalThis.TRACE_SESSION_MODE = ${JSON.stringify(SESSION_MODE)};\n` : ""}`;
fs.writeFileSync(popupConfigPath, popupConfig + ao3HistoryExperimentLoader, "utf8");
console.log("Wrote", popupConfigPath);
fs.writeFileSync(contentConfigPath, contentConfig, "utf8");
console.log("Wrote", contentConfigPath);

manifest.content_scripts = SESSION_MODE === "disabled" || IOS_ACTIVE_TAB_PROBE
  ? []
  : IOS_EARNED_PERMISSION_ONBOARDING
    ? earnedCompatibilityContentScripts
    : normalContentScripts;
// The iPhone build declares no page scripts at all; the background registers
// them after the grant. Safari rejects an explicitly empty declaration, so the
// key is left out.
if (IOS_OPTIONAL_STORY_SITE_ACCESS) delete manifest.content_scripts;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Set manifest version to", version);

// The Chrome and Firefox packages keep their own permission model whichever
// Safari variant was built beside them.
const packagedSourceManifest = IOS_ACTIVE_TAB_PROBE
  ? {
      ...manifest,
      permissions: [...NORMAL_SAFARI_PERMISSIONS],
      host_permissions: safariHostPermissions,
      content_scripts: normalContentScripts,
    }
  : IOS_OPTIONAL_STORY_SITE_ACCESS
    ? {
        ...manifest,
        permissions: [...NORMAL_SAFARI_PERMISSIONS],
        host_permissions: safariHostPermissions,
        content_scripts: earnedCompatibilityContentScripts,
      }
    : manifest;
delete packagedSourceManifest.optional_host_permissions;
const packagedManifest = browserStoreManifest(
  packagedSourceManifest,
  browserHostPermissions,
);

// The first-tap sheet's page file belongs to the iPhone build alone.
// So do the experiment's sheet section and its loader (rule 3 above).
const skipResources = (full, name) =>
  name === ".DS_Store" || name === "page-manual-mode.js" || name === AO3_HISTORY_EXPERIMENT_PANEL ||
  full.endsWith("manifest.json");

// dist/chrome: extension root for Chrome / Edge (load unpacked)
const distChrome = path.join(ROOT, "dist", "chrome");
rmrf(distChrome);
copyDirFiltered(RES, distChrome, { skip: (sp, name) => skipResources(sp, name) });
if (AO3_HISTORY_EXPERIMENT) fs.writeFileSync(path.join(distChrome, "popup-config.js"), popupConfig, "utf8");
if (IOS_ACTIVE_TAB_PROBE) {
  fs.writeFileSync(
    path.join(distChrome, "popup-config.js"),
    contentConfig,
    "utf8",
  );
}
fs.writeFileSync(
  path.join(distChrome, "manifest.json"),
  JSON.stringify(packagedManifest, null, 2) + "\n",
);

// dist/firefox: same + browser_specific_settings for AMO
const distFf = path.join(ROOT, "dist", "firefox");
rmrf(distFf);
copyDirFiltered(RES, distFf, { skip: (sp, name) => skipResources(sp, name) });
if (AO3_HISTORY_EXPERIMENT) fs.writeFileSync(path.join(distFf, "popup-config.js"), popupConfig, "utf8");
if (IOS_ACTIVE_TAB_PROBE) {
  fs.writeFileSync(
    path.join(distFf, "popup-config.js"),
    contentConfig,
    "utf8",
  );
}
// Firefox MV3 uses `background.scripts` (not extension service workers). Omit
// `service_worker` in dist/firefox so addons-linter does not warn it is ignored.
const sw = manifest.background?.service_worker;
const ffBackgroundScripts =
  typeof sw === "string"
    ? [sw]
    : Array.isArray(manifest.background?.scripts)
      ? manifest.background.scripts
      : ["background.js"];
const ffDataCollection = {
  required: ["authenticationInfo", "websiteContent"],
};
const ffManifest = {
  ...firefoxCompatibleManifest(packagedManifest),
  background: {
    scripts: ffBackgroundScripts,
  },
  browser_specific_settings: {
    gecko: {
      id: IS_RELEASE ? FIREFOX_RELEASE_EXTENSION_ID : FIREFOX_DEV_EXTENSION_ID,
      // 140+ required for `data_collection_permissions` built-in install UI (AMO).
      strict_min_version: "140.0",
      // AMO (new listings, ~Nov 2025+): required manifest disclosure for data sent off-device.
      // Align with https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
      data_collection_permissions: ffDataCollection,
    },
    // Android needs 142+ for Firefox's built-in data-collection consent UI.
    gecko_android: {
      strict_min_version: "142.0",
    },
  },
};
fs.writeFileSync(
  path.join(distFf, "manifest.json"),
  JSON.stringify(ffManifest, null, 2) + "\n",
);

console.log("Build mode=" + BUILD_MODE);
console.log("TRACE_SESSION_MODE=" + SESSION_MODE);
console.log("TRACE_IOS_ACTIVE_TAB_PROBE=" + IOS_ACTIVE_TAB_PROBE);
console.log(
  "TRACE_IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE=" +
    IOS_ACTIVE_TAB_OPTIONAL_HOSTS_PROBE,
);
console.log(
  "TRACE_IOS_EARNED_PERMISSION_ONBOARDING=" +
    IOS_EARNED_PERMISSION_ONBOARDING,
);
console.log(
  "TRACE_IOS_EARNED_PERMISSION_REQUIRED_HOSTS=" +
    IOS_EARNED_PERMISSION_REQUIRED_HOSTS,
);
console.log("TRACE_IOS_FIRST_TAP_SAVE=" + IOS_FIRST_TAP_SAVE);
console.log("TRACE_AO3_HISTORY_EXPERIMENT=" + AO3_HISTORY_EXPERIMENT);
if (AO3_HISTORY_EXPERIMENT) {
  console.warn("[Trace build] AO3 HISTORY EXPERIMENT build. Not for release.");
}
if (IOS_FIRST_TAP_SAVE) {
  console.warn(
    IOS_FIRST_TAP_PRODUCTION_PROOF
      ? "[Trace build] FIRST-TAP PROOF BUILD against the production service. Not for release."
      : "[Trace build] First-tap save is ON in this development build. Not for release.",
  );
}
console.log(
  "TRACE_IOS_EARNED_PERMISSION_PREVIEW_RELEASE=" +
    IOS_EARNED_PERMISSION_PREVIEW_RELEASE,
);
console.log("Built dist/chrome and dist/firefox");
console.log("TRACE_API_BASE=" + TRACE_API_BASE);
console.log("TRACE_WEB_ORIGIN=" + TRACE_WEB_ORIGIN);
