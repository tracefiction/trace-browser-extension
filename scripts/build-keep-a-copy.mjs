#!/usr/bin/env node

/**
 * Builds the standalone Keep a Copy extension for Chrome and Firefox into
 * dist/keep-a-copy-chrome and dist/keep-a-copy-firefox. It shares the AO3
 * code in src/extension-runtime with the main extension and nothing else:
 * no account, no other site, no Safari build (Safari has no downloads API).
 */

import { build as esbuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "src", "extension-runtime");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// TODO(owner): the published name, description and Firefox id are still to be chosen.
const NAME = "Keep a Copy";
const DESCRIPTION = "Keeps AO3's own download of every work you bookmark, mark for later or subscribe to, and updates it with each new chapter.";
const FIREFOX_ID = "keep-a-copy@example.invalid";
const AO3_HOSTS = ["https://archiveofourown.org/*", "https://*.archiveofourown.org/*"];

export function keepACopyManifest(browser) {
  const manifest = {
    manifest_version: 3,
    name: NAME,
    version: pkg.version,
    description: DESCRIPTION,
    // Chrome: downloads.ui hides the bubble during a backup; offscreen holds files as blobs.
    permissions: ["downloads", "storage", "alarms", ...(browser === "chrome" ? ["downloads.ui", "offscreen"] : [])],
    host_permissions: AO3_HOSTS,
    background: browser === "chrome" ? { service_worker: "background.js" } : { scripts: ["background.js"] },
    action: { default_title: NAME, default_popup: "popup.html" },
    content_scripts: [{ matches: ["https://archiveofourown.org/*"], js: ["page.js"], run_at: "document_idle" }],
  };
  if (browser === "firefox") {
    manifest.browser_specific_settings = {
      gecko: { id: FIREFOX_ID, strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
    };
  }
  return manifest;
}

async function buildFor(browser) {
  const out = path.join(ROOT, "dist", `keep-a-copy-${browser}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await esbuild({
    entryPoints: {
      background: path.join(RUNTIME, "keep-a-copy-runtime.mts"),
      page: path.join(RUNTIME, "keep-a-copy-page.mts"),
      popup: path.join(RUNTIME, "keep-a-copy-popup.mts"),
      ...(browser === "chrome" ? { offscreen: path.join(RUNTIME, "keep-a-copy-offscreen.mts") } : {}),
    },
    outdir: out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    logLevel: "silent",
  });
  fs.copyFileSync(path.join(ROOT, "src", "keep-a-copy", "popup.html"), path.join(out, "popup.html"));
  if (browser === "chrome") fs.writeFileSync(path.join(out, "offscreen.html"), '<!doctype html>\n<meta charset="utf-8">\n<script src="offscreen.js"></script>\n');
  fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(out, "LICENSE"));
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(keepACopyManifest(browser), null, 2)}\n`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const browser of ["chrome", "firefox"]) console.log(`Built ${path.relative(ROOT, await buildFor(browser))}`);
}
