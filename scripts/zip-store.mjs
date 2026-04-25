#!/usr/bin/env node
/**
 * Store-ready zip for Chrome Web Store / AMO (manifest at archive root, no Finder junk).
 * Do not use macOS "Compress" on the folder — it adds __MACOSX.
 * For AMO: run `npm run package:firefox` (release build + zip), or `npm run build:release` then this script.
 * Plain `npm run build` is dev mode and keeps localhost in the manifest.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "chrome" && target !== "firefox") {
  console.error("Usage: node scripts/zip-store.mjs <chrome|firefox>");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const srcDir = path.join(ROOT, "dist", target);
const outZip = path.join(ROOT, "dist", `trace-${target}-store.zip`);

const manifestPath = path.join(srcDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Missing ${manifestPath} — run npm run build first.`);
  process.exit(1);
}

if (target === "firefox") {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hosts = manifest.host_permissions ?? [];
  const hasLocal = hosts.some(
    (h) =>
      typeof h === "string" &&
      (/localhost/i.test(h) || /127\.0\.0\.1/.test(h)),
  );
  if (hasLocal) {
    console.error(
      "Firefox store zip refused: manifest host_permissions include localhost/127.0.0.1 (dev build output).\n" +
        "Run: npm run package:firefox\n" +
        "Or: npm run build:release && npm run zip:firefox",
    );
    process.exit(1);
  }
}

if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

const args = [
  "-r",
  outZip,
  ".",
  "-x",
  "*.DS_Store",
  "-x",
  "*__MACOSX*",
  "-x",
  "*/._*",
  "-x",
  "._*",
];
const r = spawnSync("zip", args, { cwd: srcDir, stdio: "inherit" });
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("Wrote", outZip);
