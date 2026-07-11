import assert from "node:assert/strict";
import test from "node:test";

import {
  AO3_HOST_MATCHES,
  configuredOriginPermissions,
} from "../scripts/build-origin-permissions.mjs";

test("remote development builds declare only their active Trace origins", () => {
  const {
    safariHostPermissions,
    browserHostPermissions,
    syncMatches,
  } = configuredOriginPermissions({
    traceApiBase: "https://ff-app-development.up.railway.app",
    traceWebOrigin: "https://trace-git-dev-zacs-projects-378417c9.vercel.app",
  });

  assert.equal(safariHostPermissions.includes("https://ff-app-development.up.railway.app/*"), false);
  assert.ok(safariHostPermissions.includes("https://trace-git-dev-zacs-projects-378417c9.vercel.app/*"));
  assert.ok(browserHostPermissions.includes("https://ff-app-development.up.railway.app/*"));
  assert.ok(browserHostPermissions.includes("https://trace-git-dev-zacs-projects-378417c9.vercel.app/*"));
  assert.deepEqual(syncMatches, ["https://trace-git-dev-zacs-projects-378417c9.vercel.app/*"]);
  assert.equal(safariHostPermissions.includes("https://tracefiction.com/*"), false);
  assert.equal(safariHostPermissions.includes("https://www.tracefiction.com/*"), false);
  assert.equal(safariHostPermissions.includes("https://ao3.org/*"), false);
  assert.equal(safariHostPermissions.includes("https://*.ao3.org/*"), false);
  assert.equal(safariHostPermissions.some((pattern) => /localhost|127\.0\.0\.1/.test(pattern)), false);
});

test("release builds preserve all supported AO3 aliases and only release Trace origins", () => {
  const {
    safariHostPermissions,
    browserHostPermissions,
    syncMatches,
  } = configuredOriginPermissions({
    traceApiBase: "https://api.tracefiction.com",
    traceWebOrigin: "https://www.tracefiction.com",
  });

  for (const pattern of AO3_HOST_MATCHES) {
    assert.ok(safariHostPermissions.includes(pattern));
    assert.ok(browserHostPermissions.includes(pattern));
  }
  assert.equal(safariHostPermissions.includes("https://api.tracefiction.com/*"), false);
  assert.ok(safariHostPermissions.includes("https://www.tracefiction.com/*"));
  assert.ok(browserHostPermissions.includes("https://api.tracefiction.com/*"));
  assert.ok(browserHostPermissions.includes("https://www.tracefiction.com/*"));
  assert.equal(safariHostPermissions.includes("https://tracefiction.com/*"), false);
  assert.equal(safariHostPermissions.includes("https://ao3.org/*"), false);
  assert.equal(safariHostPermissions.includes("https://*.ao3.org/*"), false);
  assert.deepEqual(syncMatches, ["https://www.tracefiction.com/*"]);
});
