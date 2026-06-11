#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const deviceName = process.env.TRACE_IOS_SIMULATOR_NAME ?? "iPhone 17";
const os = process.env.TRACE_IOS_SIMULATOR_OS ?? "26.2";
const derivedDataPath =
  process.env.TRACE_IOS_DERIVED_DATA_PATH ?? "/tmp/trace-ios-simulator-build";
const destination =
  process.env.TRACE_IOS_DESTINATION ??
  (process.env.TRACE_IOS_SIMULATOR_NAME || process.env.TRACE_IOS_SIMULATOR_OS
    ? `platform=iOS Simulator,name=${deviceName},OS=${os}`
    : "generic/platform=iOS Simulator");

const result = spawnSync(
  "xcodebuild",
  [
    "-project",
    "Trace.xcodeproj",
    "-scheme",
    "Trace (iOS)",
    "-configuration",
    "Debug",
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
