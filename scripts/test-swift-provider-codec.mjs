#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
if (process.platform !== "darwin") {
  console.log("Skipping Swift provider codec contract outside macOS");
  process.exit(0);
}
const temporary = mkdtempSync(path.join(os.tmpdir(), "trace-provider-codec-"));
const synthetic = "https://api.synthetic.example.test";
try {
  for (const [name, flags, metadata, expected] of [
    ["production", [], synthetic, ""],
    ["review-only", ["TRACE_INTERNAL_REVIEW"], synthetic, ""],
    ["development-only", ["TRACE_NATIVE_DEVELOPMENT_API"], synthetic, ""],
    ["default", ["TRACE_INTERNAL_REVIEW", "TRACE_NATIVE_DEVELOPMENT_API"], null, "https://api.development.example.test"],
    ["paired", ["TRACE_INTERNAL_REVIEW", "TRACE_NATIVE_DEVELOPMENT_API"], synthetic, synthetic],
    ["invalid", ["TRACE_INTERNAL_REVIEW", "TRACE_NATIVE_DEVELOPMENT_API"], "https://user@api.example.test", ""],
  ]) {
    const plist = path.join(temporary, `${name}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${metadata === null ? "" : `<key>TraceDevelopmentAPIOrigin</key><string>${metadata}</string>`}</dict></plist>`);
    const output = path.join(temporary, name);
    const compile = spawnSync("xcrun", ["swiftc", "Shared (Extension)/TraceSafariProviderCodec.swift",
      "test/swift/TraceSafariProviderCodecContract.swift", ...flags.flatMap(flag => ["-D", flag]),
      "-module-cache-path", path.join(temporary, "cache"),
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
      "-o", output], { encoding: "utf8" });
    if (compile.status !== 0) throw new Error(compile.stderr || compile.stdout);
    const contract = spawnSync(output, [], { encoding: "utf8", env: { ...process.env, EXPECTED_DEV_ORIGIN: expected } });
    if (contract.status !== 0) throw new Error(`${name}: ${contract.stderr || contract.stdout}`);
    console.log(`${name}: ${contract.stdout.trim()}`);
  }
} finally { rmSync(temporary, { force: true, recursive: true }); }
