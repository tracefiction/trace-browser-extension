import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("the app synchronizer is the sole versioned writer and native utility handlers do not acquire tokens", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  assert.doesNotMatch(app, /storeCurrentTraceTokenForSafariExtension/);
  assert.match(app, /traceAuthTokenAccount = "extension-provider-v2"/);
  assert.match(app, /retiredTraceAuthTokenAccount = "extension-token"/);
  assert.match(app, /traceProviderRecordVersion = 2/);
  assert.match(app, /struct TraceSafariProviderRecord: Codable/);
  assert.match(app, /case "TRACE_IOS_AUTH_TOKEN_CLEAR"/);
  assert.match(app, /traceLegacyProviderProtocolVersion = 2/);
  assert.match(app, /traceDeviceProviderProtocolVersion = 3/);
  assert.match(app, /case "TRACE_IOS_AUTH_PROVIDER_STATUS_REQUEST"/);
  assert.match(
    app,
    /case "TRACE_IOS_AUTH_TOKEN_UPDATE":[\s\S]*traceLegacyProviderProtocolVersion[\s\S]*handleTraceSafariAuthTokenUpdate[\s\S]*traceDeviceProviderProtocolVersion[\s\S]*handleTraceSafariDeviceSessionUpdate/,
  );
  assert.match(
    app,
    /case "TRACE_IOS_AUTH_TOKEN_CLEAR":[\s\S]*traceLegacyProviderProtocolVersion[\s\S]*traceDeviceProviderProtocolVersion[\s\S]*handleTraceSafariAuthTokenClear/,
  );
  assert.doesNotMatch(app, /prepareSharedProviderForWebShell/);
  assert.match(app, /handleTraceSafariAuthTokenUpdate[\s\S]*storeSharedTraceToken/);
  assert.match(
    app,
    /let updateStatus = SecItemUpdate[\s\S]*updateStatus == errSecItemNotFound[\s\S]*SecItemAdd/,
  );
  const providerWriter = app.slice(
    app.indexOf("private static func writeSharedProviderRecord"),
    app.indexOf("private static func clearSharedTraceTokens"),
  );
  assert.doesNotMatch(providerWriter, /SecItemDelete/);
  assert.match(app, /deleteSharedTraceToken\(account: traceAuthTokenAccount\)/);
  assert.match(app, /deleteSharedTraceToken\(account: retiredTraceAuthTokenAccount\)/);
  assert.match(app, /status == errSecSuccess \|\| status == errSecItemNotFound/);

  const extension = read("Shared (Extension)", "SafariWebExtensionHandler.swift");
  assert.match(extension, /traceAuthTokenAccount = "extension-provider-v2"/);
  assert.doesNotMatch(extension, /"extension-token"/);
  assert.match(extension, /traceProviderRecordVersion = 2/);
  assert.match(extension, /enum SharedTraceCredential/);
  assert.match(
    extension,
    /status == errSecItemNotFound[\s\S]*return \.missing[\s\S]*status == errSecSuccess[\s\S]*return \.unavailable/,
  );
  assert.match(
    extension,
    /JSONDecoder\(\)\.decode[\s\S]*record\.version == 1[\s\S]*record\.version == traceProviderRecordVersion/,
  );
  assert.match(
    extension,
    /case \.missing:[\s\S]*"error": "missing_token"[\s\S]*case \.unavailable:[\s\S]*"error": "provider_unavailable"/,
  );
  assert.match(
    extension,
    /#if DEBUG && targetEnvironment\(simulator\)[\s\S]*traceDebugSimulatorProviderCredential[\s\S]*#endif/,
  );
  assert.match(extension, /traceDebugSimulatorProviderRequestCount/);
  assert.match(extension, /traceDebugSimulatorProviderRequestResult/);
  assert.match(extension, /traceSimulatorMissingProviderFixture/);
  assert.match(extension, /recordSimulatorProviderRequest\(credential\)/);
  assert.match(
    extension,
    /case Self\.traceIosPendingFirstStoryClear:[\s\S]*expectedHandoffId:[\s\S]*"cleared": cleared/,
  );
  assert.match(
    extension,
    /guard[\s\S]*sanitizedHandoffId\(pending\["handoffId"\]\) == expectedHandoffId[\s\S]*else \{[\s\S]*return false/,
  );
  assert.match(
    app,
    /#if DEBUG && targetEnvironment\(simulator\)[\s\S]*traceDebugSimulatorAppProviderV2[\s\S]*traceDebugSimulatorAppProviderRetired[\s\S]*#endif/,
  );
  assert.match(app, /traceDebugSeedStaleProvider/);
  assert.match(app, /traceDebugFailProviderClear/);
  assert.match(
    app,
    /if traceSimulatorFailNextProviderClear \{[\s\S]*traceSimulatorFailNextProviderClear = false[\s\S]*throw TraceSafariExtensionBridgeError\.tokenShareFailed/,
  );
  assert.match(
    app,
    /#if DEBUG && targetEnvironment\(simulator\)[\s\S]*UserDefaults\.standard\.set\(data, forKey: traceSimulatorProviderV2Key\)[\s\S]*#else[\s\S]*SecItemUpdate[\s\S]*SecItemAdd/,
  );
  assert.match(
    app,
    /#if DEBUG && targetEnvironment\(simulator\)[\s\S]*removeObject\(forKey: traceSimulatorProviderV2Key\)[\s\S]*removeObject\(forKey: traceSimulatorRetiredProviderKey\)[\s\S]*#else[\s\S]*SecItemDelete/,
  );
  assert.match(
    app,
    /object\(forKey: traceSimulatorProviderV2Key\) == nil[\s\S]*object\(forKey: traceSimulatorRetiredProviderKey\) == nil/,
  );
});

test("the one app-opening route is fixed and unknown destinations fail closed", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  assert.match(app, /url\.host\?\.lowercased\(\) == "open"/);
  assert.match(app, /callbackParts\.path\.isEmpty/);
  assert.match(app, /queryItems\.count == 1/);
  assert.match(app, /queryItems\[0\]\.name == "destination"/);
  assert.match(app, /queryItems\[0\]\.value == "extension-connect"/);
  assert.match(app, /parts\.path = "\/setup"/);
  assert.match(app, /URLQueryItem\(name: "setupPath", value: "ios-app"\)/);
  assert.match(app, /parts\.fragment = "first-story-setup"/);
  assert.match(
    app,
    /guard url\.host\?\.lowercased\(\) == "callback",[\s\S]*callbackParts\.path\.isEmpty,[\s\S]*callbackParts\.user == nil,[\s\S]*callbackParts\.password == nil,[\s\S]*callbackParts\.port == nil/,
  );
});

test("native auth callbacks use one verified HTTPS route with a custom-scheme fallback", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  const debugEntitlements = read("Trace-iOS-Debug.entitlements");
  const releaseEntitlements = read("Trace-iOS-Release.entitlements");

  assert.match(app, /verifiedHTTPSAuthCallbackHost = "www\.tracefiction\.com"/);
  assert.match(app, /verifiedHTTPSAuthCallbackPath = "\/auth\/callback"/);
  assert.match(app, /guard #available\(iOS 17\.4, \*\) else \{ return nil \}/);
  assert.match(app, /metadata\["httpsAuthCallbackURL"\] = callbackURL\.absoluteString/);
  assert.match(
    app,
    /parts\.scheme\?\.lowercased\(\) == "https"[\s\S]*parts\.host\?\.lowercased\(\) == verifiedHTTPSAuthCallbackHost[\s\S]*parts\.path == verifiedHTTPSAuthCallbackPath[\s\S]*parts\.user == nil[\s\S]*parts\.password == nil[\s\S]*parts\.port == nil/,
  );
  assert.match(
    app,
    /let redirectItems = \(authorizeParts\.queryItems \?\? \[\]\)\.filter[\s\S]*redirectItems\.count == 1[\s\S]*redirectItems\[0\]\.value == callbackURL\.absoluteString/,
  );
  assert.match(
    app,
    /ASWebAuthenticationSession\([\s\S]*callback: callback,[\s\S]*completionHandler: completionHandler/,
  );
  assert.match(
    app,
    /ASWebAuthenticationSession\([\s\S]*callbackURLScheme: "traceauth",[\s\S]*completionHandler: completionHandler/,
  );
  assert.match(debugEntitlements, /webcredentials:www\.tracefiction\.com/);
  assert.match(releaseEntitlements, /webcredentials:www\.tracefiction\.com/);
  assert.doesNotMatch(debugEntitlements, /authsrv:/);
  assert.doesNotMatch(releaseEntitlements, /authsrv:/);
});

test("opening iOS extension Settings is immediate and independent of authentication", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  const start = app.indexOf(
    "private func handleTraceSafariExtensionSettingsRequest",
  );
  const end = app.indexOf(
    "private func handleTraceSafariStoryOpenRequest",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const settingsHandler = app.slice(start, end);
  assert.match(settingsHandler, /SFSafariSettings\.openExtensionsSettings/);
  assert.doesNotMatch(settingsHandler, /\bTask\b|\bawait\b/);
  assert.doesNotMatch(
    settingsHandler,
    /storeCurrentTraceTokenForSafariExtension/,
  );
});

test("archive onboarding choices open fixed mobile destinations and record the attempted URL", () => {
  const app = read("iOS (App)", "TraceWebViewController.swift");
  assert.match(
    app,
    /case \.ao3:[\s\S]*URL\(string: "https:\/\/archiveofourown\.org\/"\)!/,
  );
  assert.match(
    app,
    /case \.ffn:[\s\S]*URL\(string: "https:\/\/m\.fanfiction\.net\/"\)!/,
  );
  assert.match(
    app,
    /let url = hostKind\.mobileHomeURL[\s\S]*UIApplication\.shared\.open\(url, options: \[:\]\)/,
  );
  assert.match(app, /Opening archive home host=%\{public\}@ destination=%\{public\}@/);
  assert.match(app, /Archive home open completed host=%\{public\}@ destination=%\{public\}@ success=%\{public\}@/);
});

test("kernel popup and page bridge have no ambient or website-auth fallback", () => {
  const popupHtml = read("Shared (Extension)", "Resources", "popup.html");
  assert.match(popupHtml, /Checking extension status/);
  assert.doesNotMatch(popupHtml, /href="https:\/\/tracefiction\.com/);

  const popup = read("Shared (Extension)", "Resources", "popup.js");
  assert.match(popup, /Signing in on tracefiction\.com in Safari does not connect/);
  assert.match(popup, /TRACE_SESSION_ACTION/);
  assert.match(popup, /traceauth:\/\/open\?destination=extension-connect/);
  assert.match(popup, /Open Trace app/);

  const sync = read("Shared (Extension)", "Resources", "sync.js");
  assert.match(sync, /TRACE_CREDENTIAL_GRANT_REQUEST/);
  assert.match(sync, /if \(!KERNEL_SESSION_ACTIVE\) \{/);
  assert.match(sync, /pendingCredentialGrants\.get\(requestId\)/);
});

test("installed iOS Connect-and-save uses a temporary authorized-sender driver", () => {
  const runner = read("scripts", "test-extension-session-ios.mjs");
  const ui = read("test", "installed-ios", "TraceInstalledLifecycleUITests.swift");

  assert.match(runner, /if \(relative === "\.env"\) return false/);
  assert.match(runner, /PROVIDER_MISSING_FIXTURE/);
  assert.match(runner, /function installConnectAndSaveDriver/);
  assert.match(runner, /entry\.matches\?\.some\(\(pattern\) => pattern\.includes\("archiveofourown\.org"\)\)/);
  assert.match(runner, /archiveEntry\.js\.push\(CONNECT_AND_SAVE_DRIVER\)/);
  assert.match(runner, /kernelPendingFirstStory = \{ workKey, handoffId: "installed-ios-connect-and-save" \}/);
  assert.match(runner, /message\.type === TRACE_CONNECT_AND_SAVE_MESSAGE/);
  assert.match(runner, /removeConnectAndSaveDriver\(sourceRoot\);[\s\S]*build:kernel:release/);
  assert.match(runner, /installed Connect-and-save driver leaked into the Release extension bundle/);
  assert.match(runner, /simctl\("openurl", DEVICE_ID, url\)/);
  assert.match(
    runner,
    /appMode = "signed-out"[\s\S]*testAppSignedOutColdStartPreservesDeviceProvider[\s\S]*appEvents\.length,[\s\S]*priorColdStartEventCount/,
  );
  assert.match(runner, /protocolVersion: 3,[\s\S]*kind: "device_session"/);
  assert.match(runner, /request\.url === "\/api\/extension\/account"/);
  assert.match(runner, /"browser-only Connect",[\s\S]*"missing",[\s\S]*browserOnlyProviderBaseline/);
  assert.match(
    runner,
    /"installed Connect-and-save",[\s\S]*"present",[\s\S]*connectAndSaveProviderBaseline/,
  );
  assert.match(
    runner,
    /runTest\("testConnectAndSaveFromInstalledArchiveSender", \{ url: AO3_WORK_URL \}\)/,
  );

  assert.match(ui, /func testConnectAndSaveFromInstalledArchiveSender\(\)/);
  assert.match(ui, /Installed Connect-and-save driver ready/);
  assert.match(ui, /Installed result: connected \/ saved/);
  assert.doesNotMatch(ui, /keyboards\.buttons\["go"\]/);
});
