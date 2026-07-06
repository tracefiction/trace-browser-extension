# iOS WKWebView Shell

The iOS app target includes a small `WKWebView` shell that loads Trace and embeds the Safari Web Extension. The shell exists so the same Trace web experience can be distributed as an iOS app while keeping the browser-extension source inspectable in this repository.

The long-term product direction may include a more native iOS app, but this shell is the current supported iOS distribution path.

## What This Shell Does

- Loads the configured Trace web origin in a full-screen `WKWebView`.
- Shows a native retry surface when the Trace main-frame web app load fails before the web UI can recover.
- Marks the session as the native shell so the web app can show mobile-appropriate auth UI.
- Handles the `traceauth://callback` URL scheme and returns the OAuth result to the web view.
- Shows a native retry alert when the external OAuth session is cancelled or fails before returning to the web view.
- Reports iOS notification permission results back to the web app so denial and setup failures have visible recovery copy.
- Opens Apple's subscription management sheet for Apple-billed Trace Unlimited accounts.
- Bridges Safari extension setup actions from the web shell to native iOS code.
- Shares the signed-in web-shell access token with the Safari extension through a shared Keychain access group.
- Stores short-lived first-story handoff URLs in app-group storage before opening AO3 or FanFiction.net in Safari.
- Opens external non-Trace links outside the shell.
- Uses `ASWebAuthenticationSession` for OAuth flows instead of completing OAuth inside an embedded web view.

OAuth callbacks are rewritten back to the configured Trace web origin at
`/auth/callback`, preserving the origin scheme/port for DEBUG builds and adding
`trace_app=1` so the web app can reliably detect the native shell after a cold
start callback.

## Safari Extension Setup

Installing the iOS app does not automatically enable the Safari extension or grant site access. User-facing help should keep the setup path explicit and app-led:

1. Sign in to Trace inside the iOS app shell.
2. Use the in-app "Enable Safari extension" action. On iOS versions that support Safari extension settings APIs, Trace opens the extension settings screen directly. On older iOS versions, show the concise fallback: Settings > Apps > Safari > Extensions > Trace, then allow Trace on Trace, AO3, and FanFiction.net.
3. Return to the app after enabling the extension and site access.
4. Open AO3, open FanFiction.net, or paste a supported story URL in the app. Trace stores a short-lived pending story URL, opens Safari, and the Safari extension saves/focuses the story when it runs on the matching page.

The app can report whether the Safari extension is enabled when the OS API is available, but it cannot fully toggle or prove per-site permissions by itself. Safari controls those permissions; the final proof is that the extension runs on Trace, AO3, or FanFiction.net.

Xcode reinstall behavior is not authoritative for fresh users. A local build over an existing install can preserve or restore Safari extension settings and website access, making the extension look "magically" enabled. Treat that as diagnostic only; the acceptance test for first-run onboarding is a clean TestFlight/internal-distribution install after deleting Trace and confirming Safari Extensions state first.

## What To Inspect

- `iOS (App)/TraceWebViewController.swift` - web view setup, navigation handling, OAuth callback handling.
- `iOS (App)/TraceWebOrigin.generated.swift` - generated Trace web origin used by the shell.
- `Shared (Extension)/Resources/` - Safari Web Extension resources included in the app build.

The generated web origin is written by `npm run build` / `npm run build:release`.

## Agent Simulator Validation

Use `npm run ios:build` for a signing-free generic iOS simulator build. Set `TRACE_IOS_DESTINATION` for a specific Xcode destination, or set `TRACE_IOS_SIMULATOR_NAME` and `TRACE_IOS_SIMULATOR_OS` to target a named simulator.

Use `npm run ios:screenshot:load-failure` to build when needed, boot the simulator, launch Trace with the DEBUG-only `--trace-show-load-failure` argument, and write a native screenshot to `/private/tmp/trace-ios-load-failure.png`.

## Device Acceptance Guidance

Use TestFlight or an internal distribution install for the realistic first-user test:

1. Delete Trace from the iPhone.
2. Confirm Trace is absent or disabled under Safari Extensions before reinstalling.
3. Install via TestFlight/internal distribution, sign in inside the app, and observe whether iOS reports the extension enabled.
4. If iOS reports enabled because prior permissions were restored, the app should still show Manage Safari settings and should only say to allow AO3/FanFiction.net if Safari asks.
5. If AO3 or FanFiction.net is Ask or Deny, pasted-link handoff should open Safari but the extension can save only after the user grants site access.
