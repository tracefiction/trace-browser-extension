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
- Opens external non-Trace links outside the shell.
- Uses `ASWebAuthenticationSession` for OAuth flows instead of completing OAuth inside an embedded web view.

OAuth callbacks are rewritten back to the configured Trace web origin at
`/auth/callback`, preserving the origin scheme/port for DEBUG builds and adding
`trace_app=1` so the web app can reliably detect the native shell after a cold
start callback.

## Safari Extension Setup

Installing the iOS app does not automatically enable the Safari extension or grant site access. User-facing help should keep the setup path explicit:

1. Enable Trace in Safari Extensions. Current iOS versions commonly show this under Settings > Apps > Safari > Extensions; older versions may show Settings > Safari > Extensions.
2. In Safari, allow Trace on tracefiction.com, archiveofourown.org, and fanfiction.net when prompted.
3. Sign in to Trace in Safari, then return to a supported AO3 or FanFiction.net story page.
4. Use `+ ADD` on the page or import from the Trace extension popup.

Do not claim the app or web page can detect every installation or site-permission state. Safari controls those permissions, and Trace should present the setup steps as user actions rather than detected readiness.

## What To Inspect

- `iOS (App)/TraceWebViewController.swift` - web view setup, navigation handling, OAuth callback handling.
- `iOS (App)/TraceWebOrigin.generated.swift` - generated Trace web origin used by the shell.
- `Shared (Extension)/Resources/` - Safari Web Extension resources included in the app build.

The generated web origin is written by `npm run build` / `npm run build:release`.

## Agent Simulator Validation

Use `npm run ios:build` for a signing-free generic iOS simulator build. Set `TRACE_IOS_DESTINATION` for a specific Xcode destination, or set `TRACE_IOS_SIMULATOR_NAME` and `TRACE_IOS_SIMULATOR_OS` to target a named simulator.

Use `npm run ios:screenshot:load-failure` to build when needed, boot the simulator, launch Trace with the DEBUG-only `--trace-show-load-failure` argument, and write a native screenshot to `/private/tmp/trace-ios-load-failure.png`.
