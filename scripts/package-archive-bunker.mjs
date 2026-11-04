#!/usr/bin/env node
/**
 * Archive Bunker's store packages and AMO source archive, from a clean checkout:
 *   dist/archive-bunker-chrome.zip, dist/archive-bunker-firefox.zip
 *   dist/archive-bunker-amo-source.zip (tracked files only, with README.archive-bunker.mozilla.md)
 * Run `npm run build:keep-a-copy` first (the package script does).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIREFOX_ID, NAME } from "./build-keep-a-copy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const run = (command, args, cwd = ROOT) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const clean = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (clean.status !== 0 || clean.stdout.trim() !== "") {
  console.error("Archive Bunker packages come from a committed checkout: commit or stash first.");
  process.exit(1);
}

for (const browser of ["chrome", "firefox"]) {
  const dir = path.join(DIST, `keep-a-copy-${browser}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (manifest.name !== NAME || (browser === "firefox" && manifest.browser_specific_settings?.gecko?.id !== FIREFOX_ID)) {
    console.error(`dist/keep-a-copy-${browser} isn't an Archive Bunker build: run npm run build:keep-a-copy.`);
    process.exit(1);
  }
  const zip = path.join(DIST, `archive-bunker-${browser}.zip`);
  fs.rmSync(zip, { force: true });
  run("zip", ["-q", "-r", "-X", zip, ".", "-x", "*.DS_Store", "-x", "*__MACOSX*", "-x", "*/._*", "-x", "._*"], dir);
  console.log(`Wrote ${path.relative(ROOT, zip)}`);
}

const source = path.join(DIST, "archive-bunker-amo-source.zip");
fs.rmSync(source, { force: true });
run("git", ["archive", "--format=zip", "-o", source, "HEAD"]);
console.log(`Wrote ${path.relative(ROOT, source)}`);
