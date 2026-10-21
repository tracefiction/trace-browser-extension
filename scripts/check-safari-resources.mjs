#!/usr/bin/env node
/**
 * Fails when the committed Safari resources are not the exact output of the
 * iOS release build. The Apple app rebuilds these files and compares them
 * byte for byte with this repository, so a hand edit or a merge leftover in
 * `Shared (Extension)/Resources` breaks every App Store archive.
 *
 * The check copies the repository's files (tracked and untracked, not
 * ignored) into a temporary directory, runs the release build there and
 * compares the resulting resources with the ones in this checkout. The
 * checkout itself is never written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = path.join("Shared (Extension)", "Resources");
const BUILD_SCRIPT = "build:ios-earned-permission-onboarding:release";

function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.name !== ".DS_Store") out.push(rel);
  }
  return out.sort();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-safari-resources-"));
let failed = false;
try {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  ).toString("utf8").split("\0").filter(Boolean);
  for (const file of files) {
    const source = path.join(ROOT, file);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) continue;
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else fs.copyFileSync(source, target);
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temp, "node_modules"), "dir");

  // The package script carries the release configuration. Drop inherited
  // TRACE_* settings so the result is the canonical package, as CI builds it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("TRACE_")),
  );
  const build = spawnSync("npm", ["run", "--silent", BUILD_SCRIPT], {
    cwd: temp,
    env,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    process.stderr.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    throw new Error(`npm run ${BUILD_SCRIPT} failed in the temporary copy.`);
  }

  const committedDir = path.join(ROOT, RESOURCES);
  const builtDir = path.join(temp, RESOURCES);
  const committed = listFiles(committedDir);
  const built = listFiles(builtDir);
  const problems = [];
  for (const file of built) {
    if (!committed.includes(file)) problems.push(`missing: ${file}`);
    else if (!fs.readFileSync(path.join(committedDir, file)).equals(fs.readFileSync(path.join(builtDir, file)))) {
      problems.push(`differs: ${file}`);
    }
  }
  for (const file of committed) {
    if (!built.includes(file)) problems.push(`not produced by the build: ${file}`);
  }

  if (problems.length > 0) {
    failed = true;
    console.error(`${RESOURCES} is not the output of npm run ${BUILD_SCRIPT}:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`Run npm run ${BUILD_SCRIPT} and commit the regenerated files.`);
  } else {
    console.log(`${RESOURCES} matches a fresh ${BUILD_SCRIPT} build (${built.length} files).`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
