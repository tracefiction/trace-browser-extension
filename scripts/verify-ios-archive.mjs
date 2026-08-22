import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MINIMIZED_SITE_HOST_MATCHES } from "./build-origin-permissions.mjs";
import {
  embeddedBundleIdentifierError,
  IOS_PRODUCTION_APP_BUNDLE_IDENTIFIER,
  IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER,
  productionEmbeddedBundleIdentifierError,
} from "./ios-bundle-identifiers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const productionRelease = args.includes("--production");
const inputs = args.filter((arg) => !arg.startsWith("--"));
const input = inputs[0];

if (!input || inputs.length !== 1) {
  console.error(
    "Usage: npm run ios:verify-archive -- [--production] /path/to/Trace.xcarchive",
  );
  process.exit(2);
}

const suppliedPath = path.resolve(input);
const isArchive = suppliedPath.endsWith(".xcarchive");
const appPath = isArchive
  ? path.join(suppliedPath, "Products", "Applications", "Trace.app")
  : suppliedPath;
const extensionPath = path.join(
  appPath,
  "PlugIns",
  "Trace Extension.appex",
);
const sourceResources = path.join(ROOT, "Shared (Extension)", "Resources");
const packagedManifestPath = path.join(extensionPath, "manifest.json");
const sourceManifestPath = path.join(sourceResources, "manifest.json");
const projectPath = path.join(ROOT, "Trace.xcodeproj", "project.pbxproj");
const packagePath = path.join(ROOT, "package.json");
const appControllerPath = path.join(
  ROOT,
  "iOS (App)",
  "TraceWebViewController.swift",
);
const generatedOriginPath = path.join(
  ROOT,
  "iOS (App)",
  "TraceWebOrigin.generated.swift",
);
const errors = [];
const RELEASE_TRACE_API_BASE = "https://api.tracefiction.com";
const RELEASE_TRACE_WEB_ORIGIN = "https://www.tracefiction.com";

function requirePath(target, label) {
  if (!fs.existsSync(target)) {
    errors.push(`${label} is missing: ${target}`);
    return false;
  }
  return true;
}

function readJson(target, label) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    errors.push(`${label} is not readable JSON: ${error.message}`);
    return null;
  }
}

function readPlistValue(plistPath, key) {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plistPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    errors.push(
      `Could not read ${key} from ${plistPath}: ${result.stderr.trim()}`,
    );
    return null;
  }
  return result.stdout.trim();
}

function uniqueBuildSettingValues(source, name) {
  const pattern = new RegExp(`${name} = ([^;]+);`, "g");
  return new Set(Array.from(source.matchAll(pattern), (match) => match[1]));
}

function readGeneratedStringSetting(source, name) {
  const match = source.match(
    new RegExp(`static let ${name}: String = "([^"]+)"`),
  );
  if (!match) {
    errors.push(`Generated iOS configuration is missing ${name}`);
    return null;
  }
  return match[1];
}

function digest(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, target));
    } else if (entry.isFile()) {
      files.push(path.relative(root, target));
    }
  }
  return files.sort();
}

function compareResources() {
  if (
    !requirePath(sourceResources, "Source extension resources") ||
    !requirePath(extensionPath, "Packaged Safari extension")
  ) {
    return 0;
  }
  const resources = listFiles(sourceResources);
  for (const relativePath of resources) {
    const sourcePath = path.join(sourceResources, relativePath);
    const packagedPath = path.join(extensionPath, relativePath);
    if (!fs.existsSync(packagedPath)) {
      errors.push(`Packaged extension is missing ${relativePath}`);
      continue;
    }
    if (digest(sourcePath) !== digest(packagedPath)) {
      errors.push(`Packaged extension differs from source: ${relativePath}`);
    }
  }
  return resources.length;
}

requirePath(appPath, "Trace app");
requirePath(path.join(appPath, "Info.plist"), "Trace app Info.plist");
requirePath(packagedManifestPath, "Packaged extension manifest");
requirePath(sourceManifestPath, "Source extension manifest");

const packageJson = readJson(packagePath, "package.json");
const generatedOrigins = requirePath(
  generatedOriginPath,
  "Generated iOS origin configuration",
)
  ? fs.readFileSync(generatedOriginPath, "utf8")
  : "";
const generatedWebOrigin = readGeneratedStringSetting(
  generatedOrigins,
  "httpsOrigin",
);
const generatedApiOrigin = readGeneratedStringSetting(
  generatedOrigins,
  "apiOrigin",
);
const sourceManifest = readJson(sourceManifestPath, "Source extension manifest");
const packagedManifest = readJson(
  packagedManifestPath,
  "Packaged extension manifest",
);
const appVersion = readPlistValue(
  path.join(appPath, "Info.plist"),
  "CFBundleShortVersionString",
);
const appBundleIdentifier = readPlistValue(
  path.join(appPath, "Info.plist"),
  "CFBundleIdentifier",
);
const appBuild = readPlistValue(
  path.join(appPath, "Info.plist"),
  "CFBundleVersion",
);
const executableName = readPlistValue(
  path.join(appPath, "Info.plist"),
  "CFBundleExecutable",
);

const pluginsPath = path.join(appPath, "PlugIns");
const embeddedBundleIdentifiers = new Set();
if (requirePath(pluginsPath, "Trace embedded plug-ins")) {
  for (const entry of fs.readdirSync(pluginsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".appex")) continue;
    const embeddedInfoPlist = path.join(pluginsPath, entry.name, "Info.plist");
    if (!requirePath(embeddedInfoPlist, `${entry.name} Info.plist`)) continue;
    const embeddedBundleIdentifier = readPlistValue(
      embeddedInfoPlist,
      "CFBundleIdentifier",
    );
    if (embeddedBundleIdentifier) {
      embeddedBundleIdentifiers.add(embeddedBundleIdentifier);
    }
    const identifierError = embeddedBundleIdentifierError(
      appBundleIdentifier,
      embeddedBundleIdentifier,
    );
    if (identifierError) errors.push(`${entry.name}: ${identifierError}`);
    if (productionRelease && embeddedBundleIdentifier) {
      const productionIdentifierError =
        productionEmbeddedBundleIdentifierError(embeddedBundleIdentifier);
      if (productionIdentifierError) {
        errors.push(`${entry.name}: ${productionIdentifierError}`);
      }
    }
  }
}

if (productionRelease) {
  if (appBundleIdentifier !== IOS_PRODUCTION_APP_BUNDLE_IDENTIFIER) {
    errors.push(
      `Production app identifier must be ${IOS_PRODUCTION_APP_BUNDLE_IDENTIFIER}; received ${appBundleIdentifier}`,
    );
  }
  if (
    !embeddedBundleIdentifiers.has(IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER)
  ) {
    errors.push(
      `Production archive is missing ${IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER}`,
    );
  }
  if (generatedWebOrigin !== RELEASE_TRACE_WEB_ORIGIN) {
    errors.push(
      `Production web origin must be ${RELEASE_TRACE_WEB_ORIGIN}; received ${generatedWebOrigin}`,
    );
  }
  if (generatedApiOrigin !== RELEASE_TRACE_API_BASE) {
    errors.push(
      `Production API origin must be ${RELEASE_TRACE_API_BASE}; received ${generatedApiOrigin}`,
    );
  }
  if (!/allowReleaseExperimentOrigin: Bool = false/.test(generatedOrigins)) {
    errors.push("Production archive cannot enable the reviewed dev-preview origin seam");
  }
  if (!/earnedPermissionOnboardingEnabled: Bool = true/.test(generatedOrigins)) {
    errors.push("Production archive does not advertise the earned-permission native capability");
  }

  const sourceOptionalHosts = sourceManifest?.optional_host_permissions;
  if (
    JSON.stringify(sourceOptionalHosts) !==
    JSON.stringify(MINIMIZED_SITE_HOST_MATCHES)
  ) {
    errors.push("Production Safari manifest does not contain the exact five optional archive origins");
  }
  if (JSON.stringify(sourceManifest?.host_permissions) !== "[]") {
    errors.push("Production earned-permission manifest must have no required host permissions");
  }
  if (JSON.stringify(sourceManifest?.content_scripts) !== "[]") {
    errors.push("Production earned-permission manifest must have no static content scripts");
  }
  for (const permission of ["activeTab", "scripting", "nativeMessaging"]) {
    if (!sourceManifest?.permissions?.includes(permission)) {
      errors.push(`Production earned-permission manifest is missing ${permission}`);
    }
  }

  if (requirePath(appControllerPath, "iOS app controller")) {
    const appController = fs.readFileSync(appControllerPath, "utf8");
    if (
      !appController.includes(
        `safariExtensionBundleIdentifier = "${IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER}"`,
      )
    ) {
      errors.push("Native Settings bridge does not use the stable production extension identifier");
    }
  }

  const backgroundPath = path.join(sourceResources, "background.js");
  const popupConfigPath = path.join(sourceResources, "popup-config.js");
  if (requirePath(backgroundPath, "Generated production background")) {
    const background = fs.readFileSync(backgroundPath, "utf8");
    if (!background.includes(`const TRACE_API_BASE = "${RELEASE_TRACE_API_BASE}";`)) {
      errors.push("Generated background is not bound to the production API");
    }
  }
  if (requirePath(popupConfigPath, "Generated production popup config")) {
    const popupConfig = fs.readFileSync(popupConfigPath, "utf8");
    if (
      !popupConfig.includes(
        `globalThis.TRACE_EXTENSION_WEB_ORIGIN = "${RELEASE_TRACE_WEB_ORIGIN}";`,
      )
    ) {
      errors.push("Generated popup is not bound to the production web origin");
    }
    if (!popupConfig.includes("TRACE_IOS_EARNED_PERMISSION_ONBOARDING")) {
      errors.push("Generated popup is missing earned-permission onboarding configuration");
    }
  }
}

if (packageJson && sourceManifest && packageJson.version !== sourceManifest.version) {
  errors.push(
    `Source version mismatch: package ${packageJson.version}, manifest ${sourceManifest.version}`,
  );
}
if (packageJson && appVersion !== packageJson.version) {
  errors.push(
    `App version mismatch: source ${packageJson.version}, app ${appVersion}`,
  );
}
if (packageJson && packagedManifest?.version !== packageJson.version) {
  errors.push(
    `Embedded manifest mismatch: source ${packageJson.version}, packaged ${packagedManifest?.version}`,
  );
}

if (requirePath(projectPath, "Xcode project")) {
  const project = fs.readFileSync(projectPath, "utf8");
  const projectVersions = uniqueBuildSettingValues(project, "MARKETING_VERSION");
  const projectBuilds = uniqueBuildSettingValues(
    project,
    "CURRENT_PROJECT_VERSION",
  );
  if (projectVersions.size !== 1 || !projectVersions.has(packageJson?.version)) {
    errors.push(
      `Xcode marketing versions do not match package.json: ${Array.from(projectVersions).join(", ")}`,
    );
  }
  if (projectBuilds.size !== 1 || !projectBuilds.has(appBuild)) {
    errors.push(
      `Xcode build numbers do not match app build ${appBuild}: ${Array.from(projectBuilds).join(", ")}`,
    );
  }
}

const resourceCount = compareResources();
const executablePath = path.join(appPath, executableName || "Trace");
const debugExecutablePath = path.join(appPath, "Trace.debug.dylib");
const inspectedExecutable = fs.existsSync(debugExecutablePath)
  ? debugExecutablePath
  : executablePath;
if (requirePath(inspectedExecutable, "Trace executable")) {
  const strings = spawnSync("strings", [inspectedExecutable], {
    encoding: "utf8",
  });
  if (strings.status !== 0) {
    errors.push(`Could not inspect Trace executable: ${strings.stderr.trim()}`);
  } else {
    if (!strings.stdout.includes("httpsAuthCallbackURL")) {
      errors.push("Trace executable does not advertise the verified HTTPS callback");
    }
    if (generatedWebOrigin && !strings.stdout.includes(generatedWebOrigin)) {
      errors.push(
        `Trace executable does not contain generated web origin ${generatedWebOrigin}`,
      );
    }
    if (generatedApiOrigin && !strings.stdout.includes(generatedApiOrigin)) {
      errors.push(
        `Trace executable does not contain generated API origin ${generatedApiOrigin}`,
      );
    }
    if (
      strings.stdout.includes(
        "Safari extension settings opening without refreshed shared token",
      )
    ) {
      errors.push("Trace executable contains the retired auth-delayed Settings path");
    }
  }
}

if (isArchive && requirePath(executablePath, "Signed Trace executable")) {
  const entitlements = spawnSync(
    "/usr/bin/codesign",
    ["-d", "--entitlements", "-", appPath],
    { encoding: "utf8" },
  );
  const output = `${entitlements.stdout}\n${entitlements.stderr}`;
  if (entitlements.status !== 0) {
    errors.push("Could not read entitlements from the archived Trace app");
  } else if (!output.includes("webcredentials:www.tracefiction.com")) {
    errors.push(
      "Archived Trace app is missing webcredentials:www.tracefiction.com",
    );
  }

  const extensionEntitlements = spawnSync(
    "/usr/bin/codesign",
    ["-d", "--entitlements", "-", extensionPath],
    { encoding: "utf8" },
  );
  const extensionEntitlementsOutput =
    `${extensionEntitlements.stdout}\n${extensionEntitlements.stderr}`;
  if (extensionEntitlements.status !== 0) {
    errors.push("Could not read entitlements from the archived Safari extension");
  } else if (
    !extensionEntitlementsOutput.includes("group.com.tracefiction.trace")
  ) {
    errors.push("Archived Safari extension is missing the shared Trace app group");
  }
}

if (errors.length > 0) {
  console.error("iOS package verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `iOS package verified${productionRelease ? " for production" : ""}: Trace ${appVersion} (${appBuild}), ${resourceCount} extension resources match source`,
);
