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
const RELEASE_TRACE_HOSTS = new Set([
  "tracefiction.com",
  "www.tracefiction.com",
  "api.tracefiction.com",
]);

const manifestPath = path.join(srcDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Missing ${manifestPath} — run npm run build first.`);
  process.exit(1);
}

function hostFromMatchPattern(pattern) {
  if (typeof pattern !== "string") return null;
  const match = pattern.match(/^https?:\/\/([^/]+)\//i);
  if (!match) return null;
  return match[1].replace(/^\*\./, "").replace(/:\d+$/, "").toLowerCase();
}

function isTraceRelatedHost(host) {
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.includes("trace") ||
    host.includes("railway.app") ||
    host.includes("vercel.app")
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const hostPatterns = [
  ...(manifest.host_permissions ?? []),
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []),
];
const badTraceHosts = hostPatterns
  .map(hostFromMatchPattern)
  .filter((host) => isTraceRelatedHost(host) && !RELEASE_TRACE_HOSTS.has(host));

if (badTraceHosts.length > 0) {
  console.error(
    `${target} store zip refused: manifest includes non-production Trace hosts: ${Array.from(new Set(badTraceHosts)).join(", ")}.\n` +
      `Run: npm run package:${target}\n` +
      `Or: npm run build:release && npm run zip:${target}`,
  );
  process.exit(1);
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
