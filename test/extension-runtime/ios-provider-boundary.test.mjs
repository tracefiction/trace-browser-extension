import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("the app synchronizer is the sole v2 writer and native utility handlers do not acquire tokens", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  assert.doesNotMatch(app, /storeCurrentTraceTokenForSafariExtension/);
  assert.match(app, /traceAuthTokenAccount = "extension-provider-v2"/);
  assert.match(app, /retiredTraceAuthTokenAccount = "extension-token"/);
  assert.match(app, /case "TRACE_IOS_AUTH_TOKEN_CLEAR"/);
  assert.match(app, /traceProviderProtocolVersion = 2/);
  assert.match(
    app,
    /case "TRACE_IOS_AUTH_TOKEN_UPDATE":[\s\S]*body\["protocolVersion"\] as\? Int == Self\.traceProviderProtocolVersion[\s\S]*handleTraceSafariAuthTokenUpdate/,
  );
  assert.match(
    app,
    /case "TRACE_IOS_AUTH_TOKEN_CLEAR":[\s\S]*body\["protocolVersion"\] as\? Int == Self\.traceProviderProtocolVersion[\s\S]*handleTraceSafariAuthTokenClear/,
  );
  assert.match(app, /sharedProviderBootstrapReady = prepareSharedProviderForWebShell\(\)/);
  assert.match(
    app,
    /if !sharedProviderBootstrapReady \{[\s\S]*sharedProviderBootstrapReady = prepareSharedProviderForWebShell\(\)[\s\S]*guard sharedProviderBootstrapReady[\s\S]*storeSharedTraceToken/,
  );
  assert.match(app, /for account in \[traceAuthTokenAccount, retiredTraceAuthTokenAccount\]/);
  assert.match(app, /status == errSecSuccess \|\| status == errSecItemNotFound/);

  const extension = read("Shared (Extension)", "SafariWebExtensionHandler.swift");
  assert.match(extension, /traceAuthTokenAccount = "extension-provider-v2"/);
  assert.doesNotMatch(extension, /"extension-token"/);
  assert.match(
    extension,
    /#if DEBUG && targetEnvironment\(simulator\)[\s\S]*traceDebugSimulatorProviderCredential[\s\S]*#endif/,
  );
});

test("the one app-opening route is fixed and unknown destinations fail closed", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  assert.match(app, /url\.host\?\.lowercased\(\) == "open"/);
  assert.match(app, /callbackParts\?\.path\.isEmpty == true/);
  assert.match(app, /queryItems\.count == 1/);
  assert.match(app, /queryItems\[0\]\.name == "destination"/);
  assert.match(app, /queryItems\[0\]\.value == "extension-connect"/);
  assert.match(app, /parts\.path = "\/setup"/);
  assert.match(app, /URLQueryItem\(name: "setupPath", value: "ios-app"\)/);
  assert.match(app, /parts\.fragment = "first-story-setup"/);
  assert.match(app, /guard url\.host\?\.lowercased\(\) == "callback" else \{ return nil \}/);
});

test("kernel popup and page bridge have no ambient or website-auth fallback", () => {
  const popupHtml = read("Shared (Extension)", "Resources", "popup.html");
  assert.match(popupHtml, /Checking extension status/);
  assert.doesNotMatch(popupHtml, /href="https:\/\/tracefiction\.com/);

  const popup = read("Shared (Extension)", "Resources", "popup.js");
  assert.match(popup, /Signing in on tracefiction\.com in Safari does not connect/);
  assert.match(popup, /TRACE_SESSION_ACTION/);

  const sync = read("Shared (Extension)", "Resources", "sync.js");
  assert.match(sync, /TRACE_CREDENTIAL_GRANT_REQUEST/);
  assert.match(sync, /if \(!KERNEL_SESSION_ACTIVE\) \{/);
  assert.match(sync, /pendingCredentialGrants\.get\(requestId\)/);
});
