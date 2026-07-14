import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const chromeRoot = path.join(ROOT, "dist", "chrome");
const firefoxRoot = path.join(ROOT, "dist", "firefox");

test("shadow build installs one Chrome-only module worker without changing other targets", () => {
  const chromeManifest = JSON.parse(
    fs.readFileSync(path.join(chromeRoot, "manifest.json"), "utf8"),
  );
  assert.deepEqual(chromeManifest.background, {
    service_worker: "shadow-background.mjs",
    type: "module",
  });
  assert.equal(fs.existsSync(path.join(chromeRoot, "extension-core", "index.mjs")), true);
  assert.equal(fs.existsSync(path.join(chromeRoot, "extension-shadow", "index.mjs")), true);
  assert.equal(fs.existsSync(path.join(chromeRoot, "shadow-control.html")), true);
  assert.equal(
    fs.readFileSync(path.join(chromeRoot, "extension-shadow", "config.mjs"), "utf8")
      .includes("__TRACE_API_BASE__"),
    false,
  );

  const firefoxManifest = JSON.parse(
    fs.readFileSync(path.join(firefoxRoot, "manifest.json"), "utf8"),
  );
  assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
  assert.equal(fs.existsSync(path.join(firefoxRoot, "extension-core")), false);
  assert.equal(fs.existsSync(path.join(firefoxRoot, "extension-shadow")), false);
  assert.equal(fs.existsSync(path.join(firefoxRoot, "shadow-control.html")), false);

  assert.equal(
    fs.existsSync(path.join(ROOT, "Shared (Extension)", "Resources", "extension-shadow")),
    false,
  );
});
