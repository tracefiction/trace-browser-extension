import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { embeddedBundleIdentifierError } from "./ios-bundle-identifiers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];

if (!input) {
  console.error(
    "Usage: npm run ios:verify-archive -- /path/to/Trace.xcarchive",
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
const errors = [];

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
if (requirePath(pluginsPath, "Trace embedded plug-ins")) {
  for (const entry of fs.readdirSync(pluginsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".appex")) continue;
    const embeddedInfoPlist = path.join(pluginsPath, entry.name, "Info.plist");
    if (!requirePath(embeddedInfoPlist, `${entry.name} Info.plist`)) continue;
    const embeddedBundleIdentifier = readPlistValue(
      embeddedInfoPlist,
      "CFBundleIdentifier",
    );
    const identifierError = embeddedBundleIdentifierError(
      appBundleIdentifier,
      embeddedBundleIdentifier,
    );
    if (identifierError) errors.push(`${entry.name}: ${identifierError}`);
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
}

if (errors.length > 0) {
  console.error("iOS package verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `iOS package verified: Trace ${appVersion} (${appBuild}), ${resourceCount} extension resources match source`,
);
