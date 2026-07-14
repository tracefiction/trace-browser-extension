import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const RESOURCES = path.join(ROOT, "Shared (Extension)", "Resources");
const RELEASE_ENV = {
  ...process.env,
  TRACE_API_BASE: "https://api.tracefiction.com",
  TRACE_WEB_ORIGIN: "https://www.tracefiction.com",
};

function runBuild(script) {
  const result = spawnSync("npm", ["run", script], {
    cwd: ROOT,
    env: RELEASE_ENV,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function manifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
}

function hasSavedFilterScript(value) {
  return value.content_scripts.some((entry) => entry.js?.includes("ao3-saved-filters.js"));
}

test("legacy, kernel, and disabled packages have one deterministic classic owner", () => {
  try {
    runBuild("build:release");
    const legacyChrome = path.join(ROOT, "dist", "chrome");
    assert.deepEqual(manifest(legacyChrome).background, { service_worker: "background.js" });
    assert.equal(hasSavedFilterScript(manifest(legacyChrome)), true);
    const source = fs.readFileSync(path.join(ROOT, "src", "background.js"), "utf8")
      .replaceAll("__TRACE_API_BASE__", "https://api.tracefiction.com")
      .replaceAll("__TRACE_WEB_ORIGIN__", "https://www.tracefiction.com");
    assert.equal(fs.readFileSync(path.join(RESOURCES, "background.js"), "utf8"), source);

    for (const [script, mode] of [
      ["build:kernel:release", "kernel"],
      ["build:disabled:release", "disabled"],
    ]) {
      runBuild(script);
      const chromeRoot = path.join(ROOT, "dist", "chrome");
      const firefoxRoot = path.join(ROOT, "dist", "firefox");
      const chromeManifest = manifest(chromeRoot);
      const firefoxManifest = manifest(firefoxRoot);
      assert.deepEqual(chromeManifest.background, { service_worker: "background.js" });
      assert.equal(Object.hasOwn(chromeManifest.background, "type"), false);
      assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
      assert.equal(hasSavedFilterScript(chromeManifest), false);
      assert.equal(hasSavedFilterScript(firefoxManifest), false);
      const bundle = fs.readFileSync(path.join(chromeRoot, "background.js"), "utf8");
      assert.match(bundle, /TRACE_SESSION_MODE === "legacy"/);
      assert.match(bundle, new RegExp(`TRACE_SESSION_MODE = "${mode}"`));
      assert.match(bundle, /traceSessionEnvelopeV1/);
      assert.match(bundle, /traceSessionCredentialsV1/);
      assert.equal(fs.existsSync(path.join(chromeRoot, "extension-session-runtime.js")), false);
      assert.equal(fs.existsSync(path.join(chromeRoot, "legacy-background.js")), false);
    }
  } finally {
    runBuild("build:release");
  }
});
