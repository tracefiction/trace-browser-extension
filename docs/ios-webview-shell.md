# iOS WKWebView Shell

The iOS app target includes a small `WKWebView` shell that loads Trace and embeds the Safari Web Extension. The shell exists so the same Trace web experience can be distributed as an iOS app while keeping the browser-extension source inspectable in this repository.

The long-term product direction may include a more native iOS app, but this shell is the current supported iOS distribution path.

## What This Shell Does

- Loads the configured Trace web origin in a full-screen `WKWebView`.
- Shows a native retry surface when the Trace main-frame web app load fails before the web UI can recover.
- Marks the session as the native shell so the web app can show mobile-appropriate auth UI.
- Uses the verified Trace HTTPS `/auth/callback` on production iOS 17.4+ and
  retains `traceauth://callback` for older iOS and local/debug fallback.
- Shows a native retry alert when the external OAuth session is cancelled or fails before returning to the web view.
- Reports iOS notification permission results back to the web app so denial and setup failures have visible recovery copy.
- Opens Apple's subscription management sheet for Apple-billed Trace Unlimited accounts.
- Requests an App Store review only after sustained successful library use and
  exposes a permanent, user-initiated review link through the web settings UI.
- Bridges Safari extension setup actions from the web shell to native iOS code.
- Maintains an app-owned, scoped device-session provider in a shared Keychain
  access group; the extension can read it only after an explicit Safari-side
  Connect gesture.
- Stores short-lived direct-story and fixed-host AO3/FFN browse handoffs in app-group storage before opening Safari.
- Opens external non-Trace links outside the shell.
- Uses `ASWebAuthenticationSession` for OAuth flows instead of completing OAuth inside an embedded web view.

OAuth callbacks are rewritten back to the configured Trace web origin at
`/auth/callback`, preserving the origin scheme/port for DEBUG builds and adding
`trace_app=1` so the web app can reliably detect the native shell after a cold
start callback.

The canonical production callback host is declared as a `webcredentials:`
Associated Domain and serves `/.well-known/apple-app-site-association` from the
web app.
Redirect-only hosts are intentionally not declared.
`ASWebAuthenticationSession.Callback.https` matches the HTTPS callback on iOS
17.4 and later. The shell only advertises this capability when its configured
web origin is a production Trace HTTPS host; otherwise the web app requests the
custom callback.

## App Store Review Request

The web app reports only successful, high-value library changes: a status
change, progress update, or positive rating. The message contains an opaque
entry ID and is accepted only from the WKWebView main frame. Notes, tags,
rating values, and other private story data are not sent through this bridge.

Native iOS stores the eligibility counters locally in `UserDefaults`. A review
request becomes eligible after activity on three distinct stories across at
least two local calendar days. Trace then waits until the app is active, the
authenticated library route is visible, and a two-second calm window has
passed. Navigating away or backgrounding the app cancels the pending request.
Trace records an attempt before calling StoreKit and will not request again in
the same app version. Apple still decides whether the system sheet appears.
StoreKit intentionally suppresses this system sheet in TestFlight builds.

The Settings → Rate Trace action is separate from automatic eligibility and
opens the App Store product page with `action=write-review`. A direct user tap
must not call the in-app request API.

## Safari Extension Setup

Installing the iOS app does not automatically enable the Safari extension or grant site access. User-facing help should keep the setup path explicit and app-led:

1. Sign in to Trace inside the iOS app shell. Signing in on tracefiction.com in Safari does not connect the extension.
2. Use the in-app settings action (one trip). On iOS versions that support Safari extension settings APIs, Trace opens the extension settings screen directly. On older iOS versions, show the concise fallback: Settings > Apps > Safari > Extensions > Trace. Two changes on that screen: turn on **Allow Extension**, then set **Other Websites** to **Allow** (verified on-device: this flips every listed host to Allow in ~5 taps; per-site rows remain the choice for readers who prefer narrower grants). The aA page-menu gesture ("Always Allow on Every Website") is recovery-only.
3. Return to the app; it re-checks **Allow Extension** on focus, but keeps the
   permission gate visible until the reader confirms Website Access is Allow.
4. Open AO3 or FanFiction.net, or paste a supported story URL in the app. Trace
   stores a short-lived pending direct-story or archive-browse handoff and opens
   Safari. Mobile archive launches use AO3's normal host and FFN's mobile host;
   canonical FFN story URLs remain on `www.fanfiction.net`. That scoped,
   app-issued handoff is the explicit authorization for the extension to read
   the app-owned provider, verify the account, and save exactly once when the
   matching story opens. After authoritative confirmation, the page scrolls to
   and focuses the normal clickable Trace story control. The extension emits an
   opaque receipt only after the matching story is confirmed.

The app can report whether the Safari extension is enabled when the OS API is available, but it cannot read per-site permissions directly. The proof that a content script ran is the extension heartbeat: content scripts ping the background on archive pages, the background forwards run timestamps (and confirmed-save timestamps for track/quick-add) through `SafariWebExtensionHandler` into the shared app group, and the app surfaces them in the `TRACE_IOS_EXTENSION_STATE` payload (`lastArchiveRunAt`, `lastArchiveSaveAt`, `lastRunHandoffId`). The background sends that core receipt before asynchronously recording its `browser.permissions.getAll()` snapshot as `grantedOrigins` / `permissionSnapshotAt`; that snapshot is diagnostic data, not a native query of current Website Access. The iOS native message bridge supplies a credential only for a scoped app-issued handoff or an explicit Connect action, so Trace's own web origin is not an initial reader permission requirement.

## Device-Session Provider

Provider protocol v3 stores a version-2 record containing only
`device_session`, the server session UUID, an opaque `trd_v1_...` credential,
and absolute expiry. The app reports a random installation UUID and provider
metadata to the Trace web shell without returning the credential to web
content. The server credential is valid only for `/api/extension/*`; it is not
an Auth0 refresh token and cannot call general Trace APIs.

The web shell resolves or issues a device session while authenticated with
Auth0, waits for the native Keychain write acknowledgement, and only then
revokes the replaced session. Native updates and clears share one serialized,
generation-fenced lane. Temporary Keychain errors are unavailable rather than
signed out. Explicit app logout revokes the server session, clears the provider,
then ends Auth0; ambient browser-session loss does not clear a valid provider.

Protocol-v2 access-token records remain readable/writable only for the 0.6.0 to
0.6.2 compatibility window. New extension requests use native protocol v3 and
validate device-session metadata before accepting the credential.

The released v0.6.0 shell stored its Auth0 JWT bytes directly under the same
Keychain account later used by versioned provider records. On upgrade, the app
recognizes only that bounded three-segment JWT format as replaceable legacy
data, reports no current provider, and lets the authenticated device-session
lifecycle atomically overwrite it. Other malformed records and Keychain errors
remain unavailable rather than being silently replaced.

Device-session expiry uses the API contract's ISO-8601 string form, including
JavaScript's normal fractional seconds. Both the app writer and extension
reader also accept the equivalent form without fractional seconds.

Xcode reinstall behavior is not authoritative for fresh users. A local build over an existing install can preserve or restore Safari extension settings and website access, making the extension look "magically" enabled. Treat that as diagnostic only; the acceptance test for first-run onboarding is a clean TestFlight/internal-distribution install after deleting Trace and confirming Safari Extensions state first.

## What To Inspect

- `iOS (App)/TraceWebViewController.swift` - web view setup, navigation handling, OAuth callback handling.
- `iOS (App)/TraceReviewCoordinator.swift` - local eligibility persistence,
  calm-moment scheduling, and StoreKit request.
- `iOS (App)/TraceReviewEligibility.swift` - deterministic eligibility state
  covered by the standalone Swift contract.
- `iOS (App)/TraceWebOrigin.generated.swift` - generated Trace web origin used by the shell.
- `Shared (Extension)/Resources/` - Safari Web Extension resources included in the app build.

The generated web origin is written by `npm run build` / `npm run build:release`.

Before an iOS release, confirm both the deployed callback URL and
`traceauth://callback` are in the Auth0 application's callback allowlist. Fetch
the AASA file from every associated production domain and verify it returns
JSON without authentication or a cross-host redirect. Confirm the Apple App ID
and distribution provisioning profile include the Associated Domains
capability; the signing-free simulator build cannot validate provisioning.

After archiving, verify that the app version, build number, signed Associated
Domains entitlement, and every embedded Safari extension resource match this
checkout:

```bash
npm run ios:verify-archive -- "/path/to/Trace (iOS).xcarchive"
```

This check intentionally fails if Xcode archived a differently versioned
checkout or bundled stale generated extension resources.

## Agent Simulator Validation

Use `npm run ios:build` for a signing-free generic iOS simulator build. Set `TRACE_IOS_DESTINATION` for a specific Xcode destination, or set `TRACE_IOS_SIMULATOR_NAME` and `TRACE_IOS_SIMULATOR_OS` to target a named simulator.

Use `npm run ios:screenshot:load-failure` to build when needed, boot the simulator, launch Trace with the DEBUG-only `--trace-show-load-failure` argument, and write a native screenshot to `/private/tmp/trace-ios-load-failure.png`.

## Device Acceptance Guidance

Use TestFlight or an internal distribution install for the realistic first-user test:

1. Delete Trace from the iPhone.
2. Confirm Trace is absent or disabled under Safari Extensions before reinstalling.
3. Install via TestFlight/internal distribution, sign in inside the app, then use the
   wizard's one Settings trip: **Allow Extension** on and **Other Websites** →
   **Allow**. Repeat the app-issued story handoff and confirm the matching story
   connects and saves without a second Safari click.
4. On iOS versions with the settings deep link, record whether it lands on the
   Extensions list or the Trace detail page. With the grant in place, paste a
   supported story URL, return to the app, and confirm the wizard only reaches
   success after both the archive-run heartbeat and a server-confirmed save.
5. Repeat with AO3 or FanFiction.net set to Ask or Deny. The handoff may open
   Safari, but the app must report that Trace did not confirm a run rather than
   claim the story saved. Recovery must repeat both settings (Allow Extension
   and Website Access → Allow) and offer the aA path, then retry the story.
