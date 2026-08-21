import assert from "node:assert/strict";
import test from "node:test";

import { embeddedBundleIdentifierError } from "../scripts/ios-bundle-identifiers.mjs";

const APP_BUNDLE_IDENTIFIER = "com.tracefiction.trace";

test("accepts one embedded component below the app bundle identifier", () => {
  assert.equal(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.tracefiction.trace.active-tab-probe",
    ),
    null,
  );
  assert.equal(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.tracefiction.trace.TraceWidget",
    ),
    null,
  );
  assert.equal(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.tracefiction.trace.active-tab-optional-probe",
    ),
    null,
  );
  assert.equal(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.tracefiction.trace.earned-v3",
    ),
    null,
  );
});

test("rejects multiple components below the app bundle identifier", () => {
  assert.match(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.tracefiction.trace.extension.active-tab-probe",
    ),
    /exactly one component/,
  );
});

test("rejects an embedded identifier outside the app namespace", () => {
  assert.match(
    embeddedBundleIdentifierError(
      APP_BUNDLE_IDENTIFIER,
      "com.example.trace-extension",
    ),
    /must start with/,
  );
});
