#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRIVATE_HARNESS_PATHS = ["AGENTS.md", "CLAUDE.md", "docs/agents"];
const DEPENDENCY_DIRS = new Set(["node_modules"]);

const SOURCE_SCAN_DIRS = [
  "src",
  "Shared (Extension)/Resources",
];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".html"]);

const RELEASE_ORIGIN_PATHS = [
  "Shared (Extension)/Resources",
  "iOS (Extension)/Info.plist",
  "macOS (Extension)/Info.plist",
];

const MANIFEST_PATH = "Shared (Extension)/Resources/manifest.json";
const BACKGROUND_SOURCE_PATH = "src/background.js";
const GENERATED_BACKGROUND_PATH = "Shared (Extension)/Resources/background.js";
const POPUP_CONFIG_PATH = "Shared (Extension)/Resources/popup-config.js";
const PRIVATE_SURFACE_PATHS = [
  "Shared (Extension)/Resources/popup.js",
  "Shared (Extension)/Resources/collector.js",
  "Shared (Extension)/Resources/library-overlay.js",
  "Shared (Extension)/Resources/sync.js",
];
const PRIVATE_DATABASE_MARKERS = [
  "indexedDB",
  "private-database",
  "traceKernelPrivateV1",
  "session-envelope",
  "session-credentials",
  "account-data",
];

const errors = [];
const warnings = [];

function fromRepoPath(repoPath) {
  return path.join(ROOT, ...repoPath.split("/"));
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function lineNumberForPattern(text, pattern) {
  const index = text.indexOf(pattern);
  return index === -1 ? 1 : lineNumberForIndex(text, index);
}

function addError(file, line, message) {
  errors.push({ file, line, message });
}

function addWarning(file, line, message) {
  warnings.push({ file, line, message });
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function gitListFiles(args) {
  const result = runGit([...args, "-z"]);
  return result.stdout.split("\0").filter(Boolean);
}

function gitTrackedFiles(paths) {
  return gitListFiles(["ls-files", "--", ...paths]);
}

function publicWorkingFiles() {
  return gitListFiles(["ls-files", "-co", "--exclude-standard"]).filter((repoPath) =>
    fs.existsSync(fromRepoPath(repoPath)),
  );
}

function readText(repoPath) {
  return fs.readFileSync(fromRepoPath(repoPath), "utf8");
}

function pathHasDependencyDir(repoPath) {
  return repoPath.split("/").some((part) => DEPENDENCY_DIRS.has(part));
}

function isUnderPath(repoPath, basePath) {
  return repoPath === basePath || repoPath.startsWith(`${basePath}/`);
}

function isSourceFile(repoPath) {
  return (
    SOURCE_SCAN_DIRS.some((dir) => isUnderPath(repoPath, dir)) &&
    SOURCE_EXTENSIONS.has(path.extname(repoPath))
  );
}

function isReleaseOriginFile(repoPath) {
  return RELEASE_ORIGIN_PATHS.some((entry) => isUnderPath(repoPath, entry));
}

function printIssues() {
  for (const issue of errors) {
    console.error(`ERROR ${issue.file}:${issue.line} ${issue.message}`);
  }
  for (const issue of warnings) {
    console.warn(`WARN ${issue.file}:${issue.line} ${issue.message}`);
  }

  if (errors.length || warnings.length) {
    console.log(`agent-checks: ${errors.length} error(s), ${warnings.length} warning(s)`);
  } else {
    console.log("agent-checks: ok");
  }
}

function checkPackageManagerFiles(files) {
  for (const repoPath of files) {
    if (pathHasDependencyDir(repoPath)) continue;

    if (path.basename(repoPath) === "yarn.lock") {
      addError(repoPath, 1, "do not add Yarn lockfiles; this repo uses npm.");
      continue;
    }

    if (path.basename(repoPath) === "package-lock.json" && repoPath !== "package-lock.json") {
      addError(repoPath, 1, "only the root package-lock.json is allowed.");
    }
  }
}

function checkPrivateHarnessIsUntracked() {
  for (const repoPath of gitTrackedFiles(PRIVATE_HARNESS_PATHS)) {
    addError(repoPath, 1, "local agent guidance files must remain untracked in this public repo.");
  }
}

const privacyPatterns = [
  {
    pattern: /\bchrome\.cookies\b/g,
    message: "do not use chrome.cookies in the public extension source.",
  },
  {
    pattern: /\bbrowser\.cookies\b/g,
    message: "do not use browser.cookies in the public extension source.",
  },
  {
    pattern: /\bdocument\.body\.innerHTML\b/g,
    message: "do not read or serialize document.body.innerHTML.",
  },
  {
    pattern: /\bdocument\.documentElement\.outerHTML\b/g,
    message: "do not capture full-page HTML via document.documentElement.outerHTML.",
  },
  {
    pattern: /\bdocument\.(?:body|documentElement)\.outerHTML\b/g,
    message: "do not capture page HTML via document outerHTML.",
  },
  {
    pattern: /\bdocument\.querySelector\(\s*["'](?:html|body)["']\s*\)\.outerHTML\b/g,
    message: "do not capture page HTML via html/body outerHTML.",
  },
  {
    pattern: /\bserializeToString\(\s*document(?:\.(?:body|documentElement))?\s*\)/g,
    message: "do not serialize the full document or root page node.",
  },
  {
    pattern: /\bdocument\.documentElement\.innerHTML\b/g,
    message: "do not capture full-page HTML via document.documentElement.innerHTML.",
  },
];

function checkForbiddenPrivacyPatterns(files) {
  for (const repoPath of files.filter(isSourceFile)) {
    const text = readText(repoPath);
    for (const { pattern, message } of privacyPatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        addError(repoPath, lineNumberForIndex(text, match.index), message);
      }
    }
  }
}

const localOriginPattern = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)\b/gi;

function checkReleaseArtifactsDoNotUseLocalOrigins(files) {
  for (const repoPath of files.filter(isReleaseOriginFile)) {
    const text = readText(repoPath);
    localOriginPattern.lastIndex = 0;
    for (const match of text.matchAll(localOriginPattern)) {
      addError(
        repoPath,
        lineNumberForIndex(text, match.index),
        "release-facing extension artifacts must not contain local development origins.",
      );
    }
  }
}

function generatedBackgroundOrigin(text, constantName) {
  const match = text.match(
    new RegExp(`const ${constantName} = "([^"\\n]*)";`),
  );
  return match?.[1] ?? null;
}

function firstDifferentLine(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const count = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < count; index += 1) {
    if (expectedLines[index] !== actualLines[index]) return index + 1;
  }
  return 1;
}

function checkGeneratedBackgroundParity() {
  const source = readText(BACKGROUND_SOURCE_PATH);
  const generated = readText(GENERATED_BACKGROUND_PATH);
  const popupConfig = readText(POPUP_CONFIG_PATH);
  const apiBase = generatedBackgroundOrigin(generated, "TRACE_API_BASE");
  const webOrigin = generatedBackgroundOrigin(generated, "TRACE_WEB_ORIGIN");
  if (apiBase === null || webOrigin === null) {
    addError(
      GENERATED_BACKGROUND_PATH,
      1,
      "generated background must contain configured Trace origin constants.",
    );
    return;
  }

  const configuredMode =
    popupConfig.match(/globalThis\.TRACE_SESSION_MODE = "(kernel|disabled)"/)?.[1] ??
    "legacy";
  const expected = source
    .replace(/__TRACE_API_BASE__/g, apiBase)
    .replace(/__TRACE_WEB_ORIGIN__/g, webOrigin);
  if (configuredMode === "legacy" && generated !== expected) {
    addError(
      GENERATED_BACKGROUND_PATH,
      firstDifferentLine(expected, generated),
      "generated Safari background is stale; run npm run build or npm run build:release.",
    );
    return;
  }
  if (configuredMode === "legacy") return;

  for (const marker of [
    `scope.TRACE_SESSION_MODE = "${configuredMode}"`,
    "traceSessionEnvelopeV1",
    "traceSessionCredentialsV1",
    "traceKernelPrivateV1",
  ]) {
    if (generated.includes(marker)) continue;
    addError(
      GENERATED_BACKGROUND_PATH,
      1,
      `generated ${configuredMode} Safari background is missing ${marker}.`,
    );
  }
  for (const retiredMarker of [
    "// Generated legacy runtime gate.",
    'if (globalThis.TRACE_SESSION_MODE === "legacy")',
  ]) {
    if (!generated.includes(retiredMarker)) continue;
    addError(
      GENERATED_BACKGROUND_PATH,
      lineNumberForPattern(generated, retiredMarker),
      `generated ${configuredMode} Safari background still embeds the retired legacy owner.`,
    );
  }
}

function loadJsonFromGit(repoPath) {
  const result = runGit(["show", `HEAD:${repoPath}`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function loadJsonFromWorktree(repoPath) {
  try {
    return JSON.parse(readText(repoPath));
  } catch {
    return null;
  }
}

function contentScriptMatchShape(manifest) {
  return (manifest?.content_scripts || []).map((entry) => ({
    js: entry.js || [],
    matches: entry.matches || [],
    exclude_matches: entry.exclude_matches || [],
  }));
}

function checkManifestPermissionChanges() {
  const before = loadJsonFromGit(MANIFEST_PATH);
  const after = loadJsonFromWorktree(MANIFEST_PATH);
  if (!before || !after) return;

  if (JSON.stringify(before.host_permissions || []) !== JSON.stringify(after.host_permissions || [])) {
    const line = lineNumberForPattern(readText(MANIFEST_PATH), '"host_permissions"');
    addWarning(MANIFEST_PATH, line, "manifest host_permissions changed; review permission scope.");
  }

  if (JSON.stringify(contentScriptMatchShape(before)) !== JSON.stringify(contentScriptMatchShape(after))) {
    const line = lineNumberForPattern(readText(MANIFEST_PATH), '"content_scripts"');
    addWarning(MANIFEST_PATH, line, "manifest content script matches changed; review injected page scope.");
  }
}

function checkSurfacesCannotBypassPrivateDatabase() {
  for (const repoPath of PRIVATE_SURFACE_PATHS) {
    const text = readText(repoPath);
    for (const marker of PRIVATE_DATABASE_MARKERS) {
      const index = text.indexOf(marker);
      if (index === -1) continue;
      addError(
        repoPath,
        lineNumberForIndex(text, index),
        `surface must use bounded runtime messages, not private database marker ${marker}.`,
      );
    }
  }
}

function main() {
  const files = publicWorkingFiles();
  checkPackageManagerFiles(files);
  checkPrivateHarnessIsUntracked();
  checkForbiddenPrivacyPatterns(files);
  checkReleaseArtifactsDoNotUseLocalOrigins(files);
  checkGeneratedBackgroundParity();
  checkManifestPermissionChanges();
  checkSurfacesCannotBypassPrivateDatabase();

  printIssues();
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
