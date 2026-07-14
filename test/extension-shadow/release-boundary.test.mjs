import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("release output contains no shadow worker, controls, core, or observer", () => {
  for (const browserName of ["chrome", "firefox"]) {
    const root = path.join(ROOT, "dist", browserName);
    assert.equal(fs.existsSync(path.join(root, "shadow-background.mjs")), false);
    assert.equal(fs.existsSync(path.join(root, "shadow-control.html")), false);
    assert.equal(fs.existsSync(path.join(root, "extension-core")), false);
    assert.equal(fs.existsSync(path.join(root, "extension-shadow")), false);
    for (const filename of fs.readdirSync(root)) {
      const fullPath = path.join(root, filename);
      if (!fs.statSync(fullPath).isFile() || !/\.(?:html|js|json|mjs)$/.test(filename)) {
        continue;
      }
      assert.doesNotMatch(fs.readFileSync(fullPath, "utf8"), /TRACE_SHADOW_TEST_/);
    }
  }

  const chromeManifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "dist", "chrome", "manifest.json"), "utf8"),
  );
  assert.deepEqual(chromeManifest.background, { service_worker: "background.js" });
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(ROOT, "Shared (Extension)", "Resources", "background.js"),
      "utf8",
    ),
    /TRACE_SHADOW_TEST_|traceShadowSessionV1|traceShadowCredentialV1/,
  );
});
