#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, ".trace-build", "extension-core");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

fs.rmSync(OUTPUT, { recursive: true, force: true });

const result = spawnSync(process.execPath, [TSC, "-p", "tsconfig.extension-core.json"], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
