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
  SITE_HOST_MATCHES,
  configuredOriginPermissions,
} from "./build-origin-permissions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RES = path.join(ROOT, "Shared (Extension)", "Resources");
const SRC_BG = path.join(ROOT, "src", "background.js");
const XCODE_PROJECT = path.join(ROOT, "Trace.xcodeproj", "project.pbxproj");

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
const requestedSessionMode = process.env.TRACE_SESSION_MODE ?? fileEnv.TRACE_SESSION_MODE ?? "legacy";
if (!["legacy", "kernel", "disabled"].includes(requestedSessionMode)) {
  throw new Error(
    `TRACE_SESSION_MODE must be legacy, kernel, or disabled. Received: ${requestedSessionMode}`,
  );
}
const SESSION_MODE = requestedSessionMode;
const HAS_SESSION_RUNTIME = SESSION_MODE !== "legacy";
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
const FIREFOX_RELEASE_EXTENSION_ID = "trace@tracefiction.com";
const FIREFOX_DEV_EXTENSION_ID = "trace-dev@tracefiction.com";
const SAFARI_ONLY_PERMISSIONS = ["nativeMessaging"];

function isLocalLike(value) {
  return /localhost|127\.0\.0\.1/i.test(value);
}

function assertReleaseUrl(name, value, expected) {
  if (!value) {
    throw new Error(`${name} must be set for release builds.`);
  }
  if (!/^https:\/\//i.test(value)) {
    throw new Error(`${name} must use https:// for release builds. Received: ${value}`);
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

function syncXcodeMarketingVersion(version) {
  let project = fs.readFileSync(XCODE_PROJECT, "utf8");
  let replacements = 0;
  project = project.replace(
    /MARKETING_VERSION = [^;]+;/g,
    () => {
      replacements += 1;
      return `MARKETING_VERSION = ${version};`;
    },
  );
  if (replacements === 0) {
    throw new Error("Could not find MARKETING_VERSION in Trace.xcodeproj/project.pbxproj");
  }
  fs.writeFileSync(XCODE_PROJECT, project, "utf8");
  console.log(`Set Xcode marketing version to ${version} (${replacements} build settings)`);
}

const TRACE_API_BASE = (
  env.TRACE_API_BASE ?? "http://localhost:3001"
).replace(/\/$/, "");
const TRACE_WEB_ORIGIN = (
  env.TRACE_WEB_ORIGIN ?? "http://localhost:5173"
).replace(/\/$/, "");

if (IS_RELEASE) {
  assertReleaseUrl("TRACE_API_BASE", TRACE_API_BASE, RELEASE_TRACE_API_BASE);
  assertReleaseUrl("TRACE_WEB_ORIGIN", TRACE_WEB_ORIGIN, RELEASE_TRACE_WEB_ORIGIN);
} else if (isLocalLike(TRACE_API_BASE) || isLocalLike(TRACE_WEB_ORIGIN)) {
  console.warn(
    "[Trace build] Using local development origins. Use TRACE_BUILD_MODE=release for store/App Store artifacts.",
  );
}

let bg = fs.readFileSync(SRC_BG, "utf8");
bg = bg
  .replace(/__TRACE_API_BASE__/g, TRACE_API_BASE)
  .replace(/__TRACE_WEB_ORIGIN__/g, TRACE_WEB_ORIGIN);
const gatedLegacyBackground = `// Generated legacy runtime gate.\nif (globalThis.TRACE_SESSION_MODE === "legacy") {\n${bg}\n}\n`;

const sessionRuntimeOutput = path.join(ROOT, ".trace-build", "extension-session-runtime.js");
if (HAS_SESSION_RUNTIME) {
  await esbuild({
    entryPoints: [path.join(ROOT, "src", "extension-runtime", "index.mts")],
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
    },
    logLevel: "silent",
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";
syncXcodeMarketingVersion(version);

const outBg = path.join(RES, "background.js");
const popupConfigPath = path.join(RES, "popup-config.js");
const popupConfig = `// Generated by npm run build (scripts/build.mjs). Do not edit by hand.
globalThis.TRACE_EXTENSION_WEB_ORIGIN = ${JSON.stringify(TRACE_WEB_ORIGIN)};
${HAS_SESSION_RUNTIME ? `globalThis.TRACE_SESSION_MODE = ${JSON.stringify(SESSION_MODE)};\n` : ""}`;
// Remove resources emitted by the proof-only multi-file packaging seam. The
// production owner is one classic background entry so Safari, Chrome, and
// Firefox execute the same ordered artifact.
fs.rmSync(path.join(RES, "extension-session-runtime.js"), { force: true });
fs.rmSync(path.join(RES, "legacy-background.js"), { force: true });
if (HAS_SESSION_RUNTIME) {
  fs.writeFileSync(
    outBg,
    `${fs.readFileSync(sessionRuntimeOutput, "utf8")}\n${gatedLegacyBackground}`,
    "utf8",
  );
} else {
  fs.writeFileSync(outBg, bg, "utf8");
}
console.log("Wrote", outBg);
fs.writeFileSync(popupConfigPath, popupConfig, "utf8");
console.log("Wrote", popupConfigPath);

const manifestPath = path.join(RES, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
manifest.permissions = unique([
  ...(manifest.permissions || []),
  ...SAFARI_ONLY_PERMISSIONS,
]);

const {
  safariHostPermissions,
  browserHostPermissions,
  syncMatches,
} = configuredOriginPermissions({
  traceApiBase: TRACE_API_BASE,
  traceWebOrigin: TRACE_WEB_ORIGIN,
});

manifest.host_permissions = safariHostPermissions;
const savedFiltersScript = "ao3-saved-filters.js";
const finishQualifyScript = "trace-finish-qualify.js";
const contentScripts = (manifest.content_scripts || []).map((entry) => {
  const scripts = Array.isArray(entry.js) ? entry.js : [];
  if (scripts.includes("collector.js")) {
    return {
      ...entry,
      matches: SITE_HOST_MATCHES,
      js: unique([
        finishQualifyScript,
        ...scripts.filter((script) => script !== savedFiltersScript && script !== finishQualifyScript),
      ]),
      exclude_matches: SITE_AUTH_EXCLUDE_MATCHES,
    };
  }
  if (scripts.includes("sync.js")) {
    return {
      ...entry,
      matches: unique(syncMatches),
      js: unique(["popup-config.js", ...scripts]),
    };
  }
  return entry;
}).filter((entry) => Array.isArray(entry.js) && entry.js.length > 0);

manifest.content_scripts = [
  ...contentScripts.filter((entry) => !(entry.js || []).includes(savedFiltersScript)),
  ...(SESSION_MODE === "legacy"
    ? [{
        matches: AO3_HOST_MATCHES,
        js: [savedFiltersScript],
        run_at: "document_end",
        exclude_matches: AO3_AUTH_EXCLUDE_MATCHES,
      }]
    : []),
];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Set manifest version to", version);

const packagedManifest = browserStoreManifest(manifest, browserHostPermissions);

const skipResources = (full, name) =>
  name === ".DS_Store" || full.endsWith("manifest.json");

// dist/chrome: extension root for Chrome / Edge (load unpacked)
const distChrome = path.join(ROOT, "dist", "chrome");
rmrf(distChrome);
copyDirFiltered(RES, distChrome, { skip: (sp, name) => skipResources(sp, name) });
fs.writeFileSync(
  path.join(distChrome, "manifest.json"),
  JSON.stringify(packagedManifest, null, 2) + "\n",
);

// dist/firefox: same + browser_specific_settings for AMO
const distFf = path.join(ROOT, "dist", "firefox");
rmrf(distFf);
copyDirFiltered(RES, distFf, { skip: (sp, name) => skipResources(sp, name) });
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

// iOS shell (DEBUG): same TRACE_WEB_ORIGIN as extension — single source in `.env`
const iosGenerated = path.join(ROOT, "iOS (App)", "TraceWebOrigin.generated.swift");
const swiftLiteral = JSON.stringify(TRACE_WEB_ORIGIN);
const iosSwift = `// TraceWebOrigin.generated.swift
// Generated by npm run build (scripts/build.mjs). Do not edit by hand.
// Set TRACE_WEB_ORIGIN in repository root \`.env\`, then run \`npm run build\`.

import Foundation

enum TraceWebOriginGenerated {
    /// Same origin injected into Shared (Extension)/Resources/background.js for import / sync.
    static let httpsOrigin: String = ${swiftLiteral}
}
`;
fs.writeFileSync(iosGenerated, iosSwift, "utf8");
console.log("Wrote", iosGenerated);

console.log("Build mode=" + BUILD_MODE);
console.log("TRACE_SESSION_MODE=" + SESSION_MODE);
console.log("Built dist/chrome and dist/firefox");
console.log("TRACE_API_BASE=" + TRACE_API_BASE);
console.log("TRACE_WEB_ORIGIN=" + TRACE_WEB_ORIGIN);
