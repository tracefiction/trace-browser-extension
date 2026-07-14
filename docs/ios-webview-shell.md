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
- Maintains an app-owned Safari credential provider in a shared Keychain access group while the app is signed in; the extension can read it only after an explicit Safari-side Connect gesture.
- Stores short-lived direct-story and fixed-host AO3 browse handoffs in app-group storage before opening Safari.
- Opens external non-Trace links outside the shell.
- Uses `ASWebAuthenticationSession` for OAuth flows instead of completing OAuth inside an embedded web view.

OAuth callbacks are rewritten back to the configured Trace web origin at
`/auth/callback`, preserving the origin scheme/port for DEBUG builds and adding
`trace_app=1` so the web app can reliably detect the native shell after a cold
start callback.

## Safari Extension Setup

Installing the iOS app does not automatically enable the Safari extension or grant site access. User-facing help should keep the setup path explicit and app-led:

1. Sign in to Trace inside the iOS app shell. Signing in on tracefiction.com in Safari does not connect the extension.
2. Use the in-app settings action (one trip). On iOS versions that support Safari extension settings APIs, Trace opens the extension settings screen directly. On older iOS versions, show the concise fallback: Settings > Apps > Safari > Extensions > Trace. Two changes on that screen: turn on **Allow Extension**, then set **Other Websites** to **Allow** (verified on-device: this flips every listed host to Allow in ~5 taps; per-site rows remain the choice for readers who prefer narrower grants). The aA page-menu gesture ("Always Allow on Every Website") is recovery-only.
3. Return to the app; it re-checks **Allow Extension** on focus, but keeps the
   permission gate visible until the reader confirms Website Access is Allow.
4. Open AO3 or paste a supported story URL in the app. Trace stores a short-lived
   pending direct-story or AO3-browse handoff and opens Safari. When the
   extension offers **Connect** or **Connect and save**, press it; the extension
   reads the app-owned provider and verifies the account before continuing.
   The extension emits an opaque receipt only after it reaches the matching
   story, then saves/focuses the story on that page.

The app can report whether the Safari extension is enabled when the OS API is available, but it cannot read per-site permissions directly. The proof that a content script ran is the extension heartbeat: content scripts ping the background on archive pages, the background forwards run timestamps (and confirmed-save timestamps for track/quick-add) through `SafariWebExtensionHandler` into the shared app group, and the app surfaces them in the `TRACE_IOS_EXTENSION_STATE` payload (`lastArchiveRunAt`, `lastArchiveSaveAt`, `lastRunHandoffId`). The background sends that core receipt before asynchronously recording its `browser.permissions.getAll()` snapshot as `grantedOrigins` / `permissionSnapshotAt`; that snapshot is diagnostic data, not a native query of current Website Access. The iOS native message bridge supplies a credential only in response to the explicit Connect flow, so Trace's own web origin is not an initial reader permission requirement.

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
3. Install via TestFlight/internal distribution, sign in inside the app, then use the
   wizard's one Settings trip: **Allow Extension** on and **Other Websites** →
   **Allow**. Return to Safari and press **Connect** or **Connect and save**
   when the extension offers it.
4. On iOS versions with the settings deep link, record whether it lands on the
   Extensions list or the Trace detail page. With the grant in place, paste a
   supported story URL, return to the app, and confirm the wizard only reaches
   success after both the archive-run heartbeat and a server-confirmed save.
5. Repeat with AO3 or FanFiction.net set to Ask or Deny. The handoff may open
   Safari, but the app must report that Trace did not confirm a run rather than
   claim the story saved. Recovery must repeat both settings (Allow Extension
   and Website Access → Allow) and offer the aA path, then retry the story.
