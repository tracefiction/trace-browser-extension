#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const deviceName = process.env.TRACE_IOS_SIMULATOR_NAME ?? "iPhone 17";
const os = process.env.TRACE_IOS_SIMULATOR_OS ?? "26.2";
const derivedDataPath =
  process.env.TRACE_IOS_DERIVED_DATA_PATH ?? "/tmp/trace-ios-simulator-build";
const appPath = `${derivedDataPath}/Build/Products/Debug-iphonesimulator/Trace.app`;
const bundleId = "com.tracefiction.trace";
const screenshotPath =
  process.env.TRACE_IOS_SCREENSHOT_PATH ??
  "/private/tmp/trace-ios-load-failure.png";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

run("node", ["scripts/ios-simulator-build.mjs"], {
  env: {
    ...process.env,
    TRACE_IOS_SIMULATOR_NAME: deviceName,
    TRACE_IOS_SIMULATOR_OS: os,
    TRACE_IOS_DERIVED_DATA_PATH: derivedDataPath,
  },
});

const devicesJson = runCapture("xcrun", ["simctl", "list", "devices", "-j"]);
const devices = JSON.parse(devicesJson);
const runtimeKey = Object.keys(devices.devices).find((key) =>
  key.endsWith(`iOS-${os.replaceAll(".", "-")}`),
);
const device = runtimeKey
  ? devices.devices[runtimeKey].find((candidate) => candidate.name === deviceName)
  : undefined;

if (!device) {
  console.error(`Could not find simulator "${deviceName}" for iOS ${os}.`);
  process.exit(1);
}

if (device.state !== "Booted") {
  run("xcrun", ["simctl", "boot", device.udid]);
}
run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
run("xcrun", ["simctl", "install", device.udid, appPath]);
run("xcrun", [
  "simctl",
  "launch",
  device.udid,
  bundleId,
  "--trace-show-load-failure",
]);
mkdirSync(dirname(screenshotPath), { recursive: true });
await new Promise((resolve) => setTimeout(resolve, 1500));
run("xcrun", ["simctl", "io", device.udid, "screenshot", screenshotPath]);

console.log(`Wrote ${screenshotPath}`);
