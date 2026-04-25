#!/usr/bin/env node
/**
 * Builds Trace browser extension assets:
 * - Injects TRACE_API_BASE / TRACE_WEB_ORIGIN into background.js
 * - Syncs manifest version from package.json
 * - Writes Safari Resources + dist/chrome + dist/firefox (Firefox manifest includes gecko id)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const BUILD_MODE =
  process.env.TRACE_BUILD_MODE === "release" ||
  fileEnv.TRACE_BUILD_MODE === "release"
    ? "release"
    : "dev";
// Dev builds prefer repo `.env` so local config is stable. Release builds prefer shell env so CI
// and one-off verification can override a local `.env` without editing tracked files.
const env =
  BUILD_MODE === "release"
    ? { ...fileEnv, ...process.env }
    : { ...process.env, ...fileEnv };
const IS_RELEASE = BUILD_MODE === "release";
const SITE_HOST_MATCHES = [
  "https://archiveofourown.org/*",
  "https://*.archiveofourown.org/*",
  "https://archiveofourown.gay/*",
  "https://*.archiveofourown.gay/*",
  "https://archive.transformativeworks.org/*",
  "https://ao3.org/*",
  "https://*.ao3.org/*",
  "https://www.fanfiction.net/*",
  "https://m.fanfiction.net/*",
];
const SITE_AUTH_EXCLUDE_MATCHES = [
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
const PROD_TRACE_WEB_MATCHES = [
  "https://tracefiction.com/*",
  "https://www.tracefiction.com/*",
];
const LOCAL_TRACE_WEB_MATCHES = [
  "http://localhost:5173/*",
  "http://127.0.0.1:5173/*",
];
const LOCAL_TRACE_API_MATCHES = [
  "http://localhost:3001/*",
  "http://127.0.0.1:3001/*",
];

function isLocalLike(value) {
  return /localhost|127\.0\.0\.1/i.test(value);
}

function assertReleaseUrl(name, value) {
  if (!value) {
    throw new Error(`${name} must be set for release builds.`);
  }
  if (!/^https:\/\//i.test(value)) {
    throw new Error(`${name} must use https:// for release builds. Received: ${value}`);
  }
  if (isLocalLike(value)) {
    throw new Error(`${name} cannot point at localhost for release builds. Received: ${value}`);
  }
}

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

/**
 * Host match pattern for manifest (e.g. https://preview.example.com/*).
 * Used so dev/staging Trace URLs get sync.js + background fetch permissions.
 */
function originHostMatchPattern(baseUrl) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

const TRACE_API_BASE = (
  env.TRACE_API_BASE ?? "http://localhost:3001"
).replace(/\/$/, "");
const TRACE_WEB_ORIGIN = (
  env.TRACE_WEB_ORIGIN ?? "http://localhost:5173"
).replace(/\/$/, "");

if (IS_RELEASE) {
  assertReleaseUrl("TRACE_API_BASE", TRACE_API_BASE);
  assertReleaseUrl("TRACE_WEB_ORIGIN", TRACE_WEB_ORIGIN);
} else if (isLocalLike(TRACE_API_BASE) || isLocalLike(TRACE_WEB_ORIGIN)) {
  console.warn(
    "[Trace build] Using local development origins. Use TRACE_BUILD_MODE=release for store/App Store artifacts.",
  );
}

let bg = fs.readFileSync(SRC_BG, "utf8");
bg = bg
  .replace(/__TRACE_API_BASE__/g, TRACE_API_BASE)
  .replace(/__TRACE_WEB_ORIGIN__/g, TRACE_WEB_ORIGIN);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";

const outBg = path.join(RES, "background.js");
fs.writeFileSync(outBg, bg, "utf8");
console.log("Wrote", outBg);

const manifestPath = path.join(RES, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;

const apiHostMatch = originHostMatchPattern(TRACE_API_BASE);
const webHostMatch = originHostMatchPattern(TRACE_WEB_ORIGIN);
const extraHostPermissions = [
  apiHostMatch,
  webHostMatch,
  ...(!IS_RELEASE ? LOCAL_TRACE_WEB_MATCHES : []),
  ...(!IS_RELEASE ? LOCAL_TRACE_API_MATCHES : []),
];
const syncMatches = [
  ...PROD_TRACE_WEB_MATCHES,
  webHostMatch,
  ...(!IS_RELEASE ? LOCAL_TRACE_WEB_MATCHES : []),
];

manifest.host_permissions = unique([
  ...SITE_HOST_MATCHES,
  ...PROD_TRACE_WEB_MATCHES,
  ...extraHostPermissions,
]);
manifest.content_scripts = (manifest.content_scripts || []).map((entry) => {
  const scripts = Array.isArray(entry.js) ? entry.js : [];
  if (scripts.includes("collector.js")) {
    return {
      ...entry,
      matches: SITE_HOST_MATCHES,
      exclude_matches: SITE_AUTH_EXCLUDE_MATCHES,
    };
  }
  if (scripts.includes("sync.js")) {
    return {
      ...entry,
      matches: unique(syncMatches),
    };
  }
  return entry;
});

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Set manifest version to", version);

const skipResources = (full, name) =>
  name === ".DS_Store" || full.endsWith("manifest.json");

// dist/chrome: extension root for Chrome / Edge (load unpacked)
const distChrome = path.join(ROOT, "dist", "chrome");
rmrf(distChrome);
copyDirFiltered(RES, distChrome, { skip: (sp, name) => skipResources(sp, name) });
fs.writeFileSync(path.join(distChrome, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

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
  ...manifest,
  background: {
    scripts: ffBackgroundScripts,
  },
  browser_specific_settings: {
    gecko: {
      id: "trace@tracefiction.com",
      // 140+ required for `data_collection_permissions` built-in install UI (AMO).
      strict_min_version: "140.0",
      // AMO (new listings, ~Nov 2025+): required manifest disclosure for data sent off-device.
      // Align with https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
      data_collection_permissions: ffDataCollection,
    },
    // Android needs 142+ for the same key; avoids addons-linter min-version warnings.
    gecko_android: {
      strict_min_version: "142.0",
      data_collection_permissions: ffDataCollection,
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
console.log("Built dist/chrome and dist/firefox");
console.log("TRACE_API_BASE=" + TRACE_API_BASE);
console.log("TRACE_WEB_ORIGIN=" + TRACE_WEB_ORIGIN);
