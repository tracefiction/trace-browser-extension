import assert from "node:assert/strict";
import test from "node:test";

import {
  embeddedBundleIdentifierError,
  IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER,
  productionEmbeddedBundleIdentifierError,
} from "../scripts/ios-bundle-identifiers.mjs";

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
      IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER,
    ),
    null,
  );
});

test("accepts only the stable extension and widget identities for production", () => {
  assert.equal(
    productionEmbeddedBundleIdentifierError(
      IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER,
    ),
    null,
  );
  assert.equal(
    productionEmbeddedBundleIdentifierError(
      "com.tracefiction.trace.TraceWidget",
    ),
    null,
  );
  assert.match(
    productionEmbeddedBundleIdentifierError(
      "com.tracefiction.trace.earned-v5",
    ),
    /Unexpected production embedded bundle identifier/,
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
