import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const readExtension = (...parts) =>
  fs.readFileSync(path.join(ROOT, "Shared (Extension)", ...parts), "utf8");

test("the public Safari provider accepts only the versioned extension credential", () => {
  const codec = readExtension("TraceSafariProviderCodec.swift");
  const handler = readExtension("SafariWebExtensionHandler.swift");

  assert.match(
    codec,
    /isLegacyV060RawAccessToken[\s\S]*data\.count >= 32,[\s\S]*data\.count <= 16_384/,
  );
  assert.match(
    codec,
    /parseISO8601Date\(expiresAt\)[\s\S]*withInternetDateTime, \.withFractionalSeconds[\s\S]*ISO8601DateFormatter\(\)\.date\(from: value\)/,
  );
  assert.match(handler, /traceAuthTokenAccount = "extension-provider-v2"/);
  assert.doesNotMatch(handler, /"extension-token"/);
  assert.match(handler, /traceProviderRecordVersion = 2/);
  assert.match(handler, /enum SharedTraceCredential/);
  assert.match(
    handler,
    /status == errSecItemNotFound[\s\S]*return \.missing[\s\S]*status == errSecSuccess[\s\S]*return \.unavailable/,
  );
  assert.match(
    handler,
    /JSONDecoder\(\)\.decode[\s\S]*record\.version == 1[\s\S]*record\.version == traceProviderRecordVersion/,
  );
  assert.match(
    handler,
    /case \.missing:[\s\S]*"error": "missing_token"[\s\S]*case \.unavailable:[\s\S]*"error": "provider_unavailable"/,
  );
  assert.match(handler, /TraceSafariProviderCodec\.deviceSession/);
});

test("Safari provider diagnostics stay observable without credential data", () => {
  const handler = readExtension("SafariWebExtensionHandler.swift");
  assert.match(handler, /Shared credential read succeeded kind=%\{public\}@/);
  assert.match(handler, /Shared credential is missing/);
  assert.match(handler, /Shared credential is unavailable/);
  assert.match(handler, /traceExtensionProviderHealthV1/);
  assert.match(handler, /recordProviderReadHealth\(credential\)/);

  const healthWriter = handler.slice(
    handler.indexOf("private static func recordProviderReadHealth"),
    handler.indexOf("private static func storeExtensionHeartbeat"),
  );
  assert.match(healthWriter, /"state": state/);
  assert.match(
    healthWriter,
    /"updatedAt": Date\(\)\.timeIntervalSince1970 \* 1000/,
  );
  assert.doesNotMatch(
    healthWriter,
    /"(?:credential|token|accountId|sessionId|story|url)"\s*:/,
  );
  assert.doesNotMatch(handler, /credential=%\{public\}/);
  assert.doesNotMatch(handler, /token=%\{public\}/);
});

test("the Safari popup has no ambient website-auth fallback", () => {
  const popupHtml = readExtension("Resources", "popup.html");
  const popup = readExtension("Resources", "popup.js");
  const sync = readExtension("Resources", "sync.js");

  assert.match(popupHtml, /Checking extension status/);
  assert.doesNotMatch(popupHtml, /href="https:\/\/tracefiction\.com/);
  assert.match(popup, /Signing in on tracefiction\.com in Safari does not connect/);
  assert.match(popup, /TRACE_SESSION_ACTION/);
  assert.match(popup, /traceauth:\/\/open\?destination=extension-connect/);
  assert.match(sync, /TRACE_CREDENTIAL_GRANT_REQUEST/);
  assert.match(sync, /if \(!KERNEL_SESSION_ACTIVE\) \{/);
});
