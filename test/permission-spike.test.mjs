import assert from "node:assert/strict";
import test from "node:test";

import {
  AO3_PERMISSION_BUNDLE,
  AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES,
  AO3_PERMISSION_SPIKE_SCRIPT_ID,
  permissionBundleCoverage,
  registeredProbeScript,
} from "../Shared (Extension)/Resources/permission-spike-core.mjs";

test("AO3 permission bundle contains every currently supported manifest pattern", () => {
  assert.deepEqual(AO3_PERMISSION_BUNDLE, [
    "https://archiveofourown.org/*",
    "https://*.archiveofourown.org/*",
    "https://archiveofourown.gay/*",
    "https://*.archiveofourown.gay/*",
    "https://archive.transformativeworks.org/*",
  ]);
});

test("permission coverage fails closed when one AO3 variant is absent", () => {
  const granted = AO3_PERMISSION_BUNDLE.slice(0, -1);
  const coverage = permissionBundleCoverage(granted);

  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing, [
    "https://archive.transformativeworks.org/*",
  ]);
});

test("permission coverage accepts the complete bundle or Safari blanket grant", () => {
  assert.equal(permissionBundleCoverage(AO3_PERMISSION_BUNDLE).complete, true);
  assert.equal(permissionBundleCoverage(["*://*/*"]).complete, true);
  assert.equal(permissionBundleCoverage(["<all_urls>"]).complete, true);
});

test("registered probe script covers the complete bundle and persists", () => {
  const script = registeredProbeScript();

  assert.equal(script.id, AO3_PERMISSION_SPIKE_SCRIPT_ID);
  assert.deepEqual(script.js, ["permission-spike-content.js"]);
  assert.deepEqual(script.matches, [...AO3_PERMISSION_BUNDLE]);
  assert.deepEqual(
    script.excludeMatches,
    [...AO3_PERMISSION_SPIKE_EXCLUDE_MATCHES],
  );
  assert.equal(script.persistAcrossSessions, true);
  assert.equal(script.runAt, "document_idle");
  assert.equal(
    script.excludeMatches.includes(
      "https://archiveofourown.org/users/login*",
    ),
    true,
  );
  assert.equal(
    script.excludeMatches.includes(
      "https://archive.transformativeworks.org/users/auth/*",
    ),
    true,
  );
});
