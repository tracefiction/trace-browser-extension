#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") {
  console.log("Skipping Swift Keep a Copy mailbox contract outside macOS");
  process.exit(0);
}

const output = path.join(os.tmpdir(), `trace-keep-a-copy-mailbox-${process.pid}`);
const moduleCache = path.join(
  os.tmpdir(),
  `trace-keep-a-copy-mailbox-module-cache-${process.pid}`,
);
let exitStatus = 1;
try {
  const compile = spawnSync(
    "xcrun",
    [
      "swiftc",
      "Shared (Extension)/TraceKeepACopyMailbox.swift",
      "test/swift/TraceKeepACopyMailboxContract.swift",
      "-module-cache-path",
      moduleCache,
      "-o",
      output,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (compile.status !== 0) {
    process.stderr.write(compile.stderr || compile.stdout);
    exitStatus = compile.status ?? 1;
  } else {
    const contract = spawnSync(output, [], { encoding: "utf8" });
    process.stdout.write(contract.stdout);
    process.stderr.write(contract.stderr);
    exitStatus = contract.status ?? 1;
  }
  if (exitStatus === 0) {
    // Through SafariWebExtensionHandler's own dispatch.
    const handler = spawnSync("xcrun", ["swiftc", "-parse-as-library",
      "Shared (Extension)/SafariWebExtensionHandler.swift", "Shared (Extension)/TraceSafariProviderCodec.swift",
      "Shared (Extension)/TraceSafariImportInbox.swift", "Shared (Extension)/TraceSafariHistoryInbox.swift",
      "Shared (Extension)/TraceKeepACopyMailbox.swift", "test/swift/TraceKeepACopyHandlerContract.swift",
      "-module-cache-path", moduleCache, "-o", `${output}-handler`], { cwd: process.cwd(), encoding: "utf8" });
    if (handler.status !== 0) {
      process.stderr.write(handler.stderr || handler.stdout);
      exitStatus = handler.status ?? 1;
    } else {
      const contract = spawnSync(`${output}-handler`, [], { encoding: "utf8" });
      process.stdout.write(contract.stdout);
      process.stderr.write(contract.stderr);
      exitStatus = contract.status ?? 1;
    }
  }
} finally {
  rmSync(output, { force: true });
  rmSync(`${output}-handler`, { force: true });
  rmSync(moduleCache, { force: true, recursive: true });
}
process.exit(exitStatus);
