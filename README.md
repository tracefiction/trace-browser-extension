# Trace Browser Extension Source

This repository is public for transparency. Trace reads fanfiction story metadata so readers can import stories, sync reading progress, and see their Trace library status while browsing. Users should be able to verify the boundary themselves: metadata, reading-status choices, progress, and explicit browsing preferences — not AO3/FanFiction.net logins, cookies, private account pages, or full page HTML.

The code here is the canonical source for the Trace extension on Chrome,
Firefox, iOS Safari, and macOS Safari. The production Apple containing app,
Xcode project, signing configuration, and native Trace app features live in a
separate private repository. That app pins an exact commit from this public
repository rather than carrying a second copy of the extension.

## What This Repository Helps You Verify

- Trace never asks for your AO3 or FanFiction.net password.
- The extension does not request browser cookie permission.
- The Safari build uses native messaging only to talk to the bundled Trace app
  for app-led setup, auth-token sharing, and first-story handoff.
- Content scripts run only on supported AO3/FFN pages and Trace pages listed in the manifest.
- Obvious AO3/FFN login/signup/auth pages are excluded in the manifest.
- Collection and overlay scripts also disable themselves at runtime on login/signup/password pages and pages with unknown password forms. AO3's known header login form can appear on normal story/listing pages; Trace ignores only that header form so supported reading pages still work.
- Network requests go through the extension background worker to Trace API endpoints.

If anything claiming to be Trace asks for your AO3 or FanFiction.net password, it is not legitimate.

## What Trace Reads

On supported AO3 and FanFiction.net story/listing pages, Trace reads visible story metadata from the page DOM:

- story URL
- title and author
- fandoms, tags, warnings, ratings, characters, and relationships when present
- chapter and word counts
- current chapter / reading-progress metadata
- on your own AO3 History page only: each work's "Last visited" date and visit count, so an import can keep when you last read it (works marked for later are left out)

Trace uses this to import a story, update reading progress, show whether stories are already in your Trace library, let you change reading status from supported overlay surfaces, and hide works from Trace's browsing overlay when you explicitly choose to. Trace can also detect when the last lines of the last posted chapter have stayed on screen for a moment, so it can mark your library entry finished or caught up (with Undo), or ask whether the work is complete, ongoing, on hiatus, or abandoned when the site does not say. This uses only the page's layout and your scrolling on that page; it does not read or send story text.

When you explicitly save an AO3 saved filter, Trace stores that AO3 filter query state in extension storage so it can reapply the filter later. If you are signed in to Trace, saved filters sync to your Trace account so they can appear on your other devices. Signed-out or offline saved filters remain local until a later signed-in sync.
You can hide the saved filters surface from AO3 filter pages in the extension popup; this local preference does not delete saved presets.

## What Trace Sends

Trace may send this data to the Trace API when you import, quick-add, auto-track, or help improve shared metadata:

- story URL
- title and author
- fandoms/tags and related story metadata
- chapter and word counts
- reading-progress metadata
- when you import from your AO3 History page: each work's last-visited date, which Trace uses as its last-read date only when it has no later one (the visit count stays in the import and is not stored)
- reading-status updates you explicitly choose in the Trace overlay: Saved, Reading, Caught up, Paused, Finished, or Dropped
- finish/caught-up decisions you explicitly choose at the end of a supported story, including whether you identify the work as complete, ongoing, on hiatus, or abandoned
- last-posted-chapter finish-qualification signals for stories already in your Trace library, so Trace can recover or improve work-status metadata
- hidden-work browsing preferences you explicitly choose in the Trace overlay, keyed by the supported AO3/FFN work id
- AO3 saved filter presets you explicitly create, stored as normalized AO3 filter query parameters plus the preset name/scope
- your Trace auth token for authenticated Trace API requests, or on iOS Safari
  an extension-scoped device credential instead

On iOS Safari, the app stores an opaque device credential in the shared
Keychain after you sign in to Trace in the app. That credential can call only
Trace extension API routes; the bundled Safari extension does not receive the
app's Auth0 access token.
The private containing app also exposes its app version, build number, and
release channel to the Trace web app. That app-owned diagnostic does not
include story URLs, archive browsing history, or account email.

The iOS earned-permission build asks for Website Access before any first-story
write. If access was missed in Settings, an explicit Safari toolbar tap lets the
popup identify the current supported story, request exactly five optional
AO3/FanFiction.net origin patterns, register the production scripts, and reload
the story. The normal content-script handoff then supplies the fresh run and
server-confirmed save. Denial or partial coverage saves nothing; there is no
toolbar-only completion mode. Its diagnostic funnel stays in extension-local
storage and contains only bounded event names and timestamps; it is not network
telemetry and contains no URLs, story or account identity, page content, or
browsing history. See
[`docs/ios-earned-permission-onboarding.md`](docs/ios-earned-permission-onboarding.md).

The metadata-improvement preference is separate from automatic progress tracking and can be turned off in the extension popup.
Hidden-work preferences affect Trace browsing overlays only; they are separate from reading status and do not hide or change the source site itself.
Saved AO3 filters sync only when you are signed in. They do not include AO3 credentials, cookies, page HTML, or story text.

## What Trace Does Not Send

Trace does not send:

- AO3 or FanFiction.net passwords
- browser cookies
- AO3/FFN private messages
- drafts
- comments
- account settings
- full page HTML
- unrelated browsing history

## Where To Inspect

Start with these files:

- `Shared (Extension)/Resources/manifest.json` - permissions, host permissions, content-script matches, and excluded login/auth pages.
- `Shared (Extension)/Resources/collector.js` - AO3/FFN metadata extraction and auto-track messages.
- `Shared (Extension)/Resources/library-overlay.js` - on-page library status and quick-add UI.
- `Shared (Extension)/Resources/sync.js` - Trace-site auth token bridge.
- `src/background.js` - network requests to the Trace API.
- `src/extension-core/` and `src/extension-runtime/` - the modular session,
  archive-readiness, account-projection, and authenticated story-command
  boundaries used by the normal kernel release. `src/background.js` remains
  only as the explicit legacy rollback owner.

Kernel builds distinguish save-if-absent commands from automatic progress
commands and use the account projection as the sole library read owner.
Story/listing content scripts request only validated work keys visible on the
current supported archive page. Existing-entry status, rating, chapter
progress, finish qualification, and visibility actions use typed kernel
commands bound to the sender host, work key, authoritative entry id, and
current account epoch. Popup import is owned by the same controller: it accepts
only the extension popup, collects a bounded payload from the active supported
archive tab, and opens the configured Trace import page. Desktop first-story
handoff accepts only the configured Trace origin and routes the resulting
story-page save through the existing story-command owner. A missing archive
content script is reported as a site-permission problem instead of a generic
import failure.

Kernel metadata contribution keeps page extraction in the AO3/FFN collector
but moves preference enforcement, authenticated API access, account fencing,
and projection invalidation into one background owner. Story metadata must
match the browser-provided top-frame story sender. Batched listing enrichment
is item-count and byte bounded, and every item must match the sender's archive
host. FFN listing pages select tracked rows through a bounded account-projection
read rather than reading legacy token or overlay-cache keys. The normal release
uses the kernel owner after the parity and installed-browser audit; the legacy
owner is available only through the explicit rollback build.

Kernel builds also retain the existing local-first AO3 saved-filter surface.
Local creates, edits, and deletes remain usable while signed out or offline;
the kernel owns only authenticated synchronization. It validates the AO3
top-frame request, drains upserts and tombstones in bounded batches, applies the
server's last-write-wins timestamps without overwriting a newer dirty local
edit, and serializes remote merges against account transitions. A periodic
pull preserves cross-device updates. The content script receives no Trace
credential or account identifier, and disabled builds omit the surface and
remove its local data.

The kernel Trace-page bridge accepts status and first-story requests only from
the exact configured Trace origin and opens only same-origin Trace URLs
requested by supported archive content scripts. Status responses and pushes
contain coarse session and onboarding evidence only: booleans, enums, epoch
timestamps, and a browser kind. They do not expose credentials, account ids,
story ids, URLs, titles, private library fields, or raw errors. Archive
readiness records are serialized in local storage, and a successful action
clears an older coarse issue. Disabled builds inject no content scripts and
delete both private kernel state and extension-local feature/readiness state.
On desktop first install, the activation page's authenticated status handshake
and token-free activation-readiness signal cause one explicit kernel Connect or
Reconnect action; they do not restore the legacy ambient-token path.

On desktop browsers, Connect in an archive page's notice, story sheet, or
listing controls runs the same kernel action as the popup's Connect. If no
signed-in Trace page answers, the extension opens the Trace website and stores
a content-free connect request (an expiry time only, at most 30 minutes) in
extension storage; first install stores the same request. While it is pending,
a Trace page that shows it is signed in triggers one Connect through the
normal request-ID credential grant. `sync.js` learns this by asking the page
once on load for its token and sending the background a token-free hint when
the page posts it; the posted token itself is never forwarded or accepted.
Disconnect withdraws the request. After a connection change the background
bumps the content-free projection revision, so open archive pages update
without a reload. iPhone and iPad keep linking the extension through the Trace
app.

For a tagged release, confirm `package.json` version matches the generated manifest version. Safari consumes checked-in files under `Shared (Extension)/Resources`; Chromium and Firefox packages are generated into `dist/`, which is intentionally not committed.

`Shared (Extension)/Resources/background.js` is a committed build artifact.
Kernel builds bundle `src/extension-runtime/index.mts` and its core/runtime
dependency graph; the generated header records the configured API and web
origins for release auditing. Only `build:legacy:release` generates that file
from `src/background.js` by literal substitution. Safari requires the selected
release artifact to be checked in. `Shared (Extension)/Resources/popup-config.js`
and `Shared (Extension)/Resources/content-config.js` are committed for the same
reason: Safari consumes those generated extension constants directly. Native
app configuration is generated and validated in the private Apple client.

## Build And Test

Use Node 18 or newer.

```bash
npm install
npm test
```

Visual fixture screenshots use Playwright Chromium. After a fresh install, run:

```bash
npm run visual:install-browsers
npm run visual:screenshots
```

For a local extension build, copy `.env.example` to `.env` and set:

```bash
TRACE_API_BASE=http://localhost:3001
TRACE_WEB_ORIGIN=http://localhost:5173
```

Then run:

```bash
npm run build
```

The default development build uses the kernel session owner. The explicit
`build:legacy` command exists only for bounded rollback diagnostics; do not use
it for normal development or installed-extension QA.

The developer-only iOS active-tab first-value experiment is documented in
[`docs/ios-active-tab-first-value-probe.md`](docs/ios-active-tab-first-value-probe.md).
It declares no website origins and is not part of normal builds.

For a release-style build, use HTTPS Trace origins:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run build:release
```

`build:release` packages the kernel session owner and rejects missing,
localhost, non-HTTPS, and non-production Trace origins. `npm run agent:check` runs
`build:release`, so run it with the same two variables, as CI does:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run agent:check
```

Without them the release step stops at the localhost default from `.env`
or the build script. That is the guard working, not a test failure. The explicit
`build:legacy:release` command remains available as the bounded rollback path;
it is not used by the store packaging commands.

## Load Locally

Chrome / Edge: open `chrome://extensions`, enable Developer Mode, choose `Load unpacked`, and select `dist/chrome`.

Firefox: open `about:debugging#/runtime/this-firefox`, choose `Load Temporary Add-on`, and select `dist/firefox/manifest.json`.

Safari: Apple requires a Safari Web Extension to be embedded in a containing
app. This repository intentionally does not publish Trace's production Xcode
app project. The extension sources under `Shared (Extension)/`, plus the iOS
and macOS extension property lists and entitlements, are consumed at a pinned
revision by the private Apple client.

### Restoring site access

Trace checks all declared host permissions with `permissions.contains` on
install/update, startup, permission changes, and popup opening. This includes
all AO3 origins and mirrors, both FanFiction.net origins, and the configured
Trace web/API origins needed to connect. Firefox, Chrome and Edge show a **!**
toolbar badge and **Site access is off — click to allow** tooltip while any
of those hosts is missing access.

Click the icon, then **Allow Trace on AO3 and FanFiction.net** in the popup.
That direct click requests every declared host together and closes the popup
immediately, leaving Firefox's single permission prompt unobstructed.
Approval restores Trace on supported open archive pages;
the badge clears only when the full host set is granted. Declining leaves
Allow available to try again.

A toolbar click may activate Trace on the current archive page without granting
persistent access. While the popup is closed, that page keeps a non-dismissable
line: **Trace is only on
for this page. Allow it on AO3 to keep it on — click the Trace icon.**
FanFiction.net pages name FanFiction.net instead. The line remains through
Connect-notice dismissal and account-state changes, and disappears when the
full permission grant arrives, without reloading the page. Opening the toolbar
popup hides the line; closing it without granting access shows the line again.
The background handles approval even after the popup closes.

Without even one-page access, content scripts cannot run to show a notice. The
popup requests directly from its own click handler: Firefox's restricted API
set in a web-accessible extension iframe on an HTTP(S) page does not expose
`browser.permissions`, and a background message hop does not preserve the
required user gesture. No additional hosts or collected data are introduced.
Safari keeps its existing Website Access flow.

## Repo Layout

- `src/background.js` - source for the extension service worker. The build injects configured Trace origins and writes `Shared (Extension)/Resources/background.js`.
- `Shared (Extension)/Resources/` - browser extension assets used by Safari and copied into Chromium/Firefox `dist/` builds.
- `Shared (Extension)/*.swift` - the public Safari native-message handler and credential codec.
- `iOS (Extension)/` and `macOS (Extension)/` - public Safari extension target metadata consumed by the private containing app.
- `scripts/` - build and packaging scripts.
- `test/` - Node test suite for collector, popup, background, sync, and overlay behavior.

## More

- Security and reporting: `SECURITY.md`
- Firefox source package notes: `README.mozilla.md`
- Store listing and release copy: `docs/store-listings.md`

## Reporting issues

This repository is published for transparency. The following are welcome via [GitHub Issues](https://github.com/tracefiction/trace-browser-extension/issues):

- **AO3 or FanFiction.net page changes** that broke import, library overlay, or progress tracking. Use the "AO3/FFN page broke" issue template — it asks for the site, page URL pattern, and what failed.
- **Bug reports** for the extension's behavior in any supported browser. Use the "Bug report" template.
- **Security or privacy concerns**: please follow `SECURITY.md` rather than filing a public issue.

We do **not** currently accept feature pull requests. The PolyForm Noncommercial License is intended for inspection and personal use; accepting outside contributions complicates the licensing terms. Bug-fix PRs that come with a clear issue and a small surface area may be considered case by case — please open an issue first to discuss.

## License

This repository is source-available under the PolyForm Noncommercial License 1.0.0.

It is published for transparency so users can inspect how the Trace extension handles page data, browser permissions, and network requests. Commercial reuse is not permitted.

For native first-story setup, an opt-in local save record carries only the
confirmed Library entry ID, canonical AO3/FFN work key, account ID, operation and
attempt IDs, timestamps, API origin and a non-secret provider equality digest.
It is stored in the app/extension shared container, never sent as telemetry.
The containing app must verify the current account/provider and read that exact
entry before displaying it. A bounded batch retains the first and most recent confirmed stories (up to 32),
deduplicated by entry ID; it is not a total-save count. Records expire as current
evidence after 24 hours; no heartbeat or permission-scope claim is implied.
No additional page permission, cookie access, story text or private-site data
is introduced. Receipt failure does not replay or block a confirmed save. This local record
also covers confirmed automatic reading writes, which can create the first
Library entry; it does not label them as manual quick-add actions or establish
later independent use.
Production packages accept only the production API origin. An explicitly paired
native development package uses its immutable Import API-origin metadata for
receipt validation; page messages cannot choose the environment. Production and
development attempts and receipts never mix.

On iOS, the popup may ask the open story page for its visible title, author
and site so it can name the story it is confirming. That reply goes only to
the extension's own popup, is shown locally, and is never stored or sent. The
one-time saved note keeps a tab-scoped `sessionStorage` marker holding only
the work key and times, so a replaced page can finish the same note. Popup
state includes the current account's confirmed record for the active tab's
story from the local projection; no URL leaves the runtime.

Popup story commands use a content-script-opened runtime port through the
background worker, so an existing Safari tab can reconnect after the extension
reloads. The worker selects the active tab and accepts only its own supported
top-frame page port. Connections and request identifiers remain in memory;
title replies are bounded and are neither stored nor sent to a server. A tab
change, navigation, disconnect, or account transition invalidates a pending
reply. Relayed saves and status changes retain the existing page validation,
current-account scope, and authoritative library-entry checks. Missing ports
keep the popup's existing unavailable/fallback state.

## Reconnecting after an extension update

On background start and installation/update, Trace attempts to reinject its
manifest-declared archive scripts into already-open, granted story-site tabs.
The scripting API permission enables this recovery; host permissions are
unchanged and recovery never requests website access. Each tab is checked
individually, credential paths remain excluded, and scripts guard against
duplicate initialization. Failed or denied injections do not reload tabs.

If the popup cannot reach the page, it shows “Trace needs to reconnect to this
page” with “Reload page”. That action reloads the active archive tab and checks
again. A cached library entry alone is not evidence that the page is connected.
[Safari supports the scripting API](https://developer.apple.com/videos/play/wwdc2023/10119/), but recovery after app replacement must be
verified separately on installed iOS Safari; API availability does not prove
that an orphaned script context can be replaced.


### Local Safari automatic-saving preference

The Safari background worker publishes the installation's automatic-saving
setting to the bundled app on preference changes and story-site heartbeats.
This app-group snapshot contains a version, verified account ID, paired API
origin, non-secret provider equality binding, boolean `enabled`, `setAt` and
`observedAt` (epoch milliseconds). It contains no URLs or story data and is
never sent to a server. Existing installations without a change timestamp use
the first observation as `setAt`; later heartbeats preserve it. The preference
remains installation-local; the snapshot is evidence scoped to the currently
verified account, not account preference synchronization.

The existing native provider boundary prepares the equality binding before
account adoption and checks it again when storing. The app accepts only its
current account, API origin and provider. Missing, malformed, future, replaced-
provider or more-than-24-hour-old observations are unknown, never off. A late
snapshot cannot replace a newer change. A preference is not proof of Safari
access, activation or a successful save. Old app/extension versions can ignore
the additive messages; absence leaves existing behavior intact.

## Aggregate release and browser diagnostics

Safari and Chromium-family clients may attach installed extension version and
coarse mobile/desktop and browser categories to authenticated Trace API calls.
The server uses these for aggregate release adoption and failure diagnostics.
Firefox sends **none** of these optional activity headers: this release does not
request `technicalAndInteraction` consent and does not enable that collection.

Before first adding headers, the extension checks the API URL/header set with a
bodyless, side-effect-free OPTIONS request, bounded to one second. Success is
cached per API origin for one hour, including across worker restarts; concurrent
calls share the probe. Steady-state saves add no compatibility round trip. Only
expiry or an actual request failure causes a new probe on the next call. The
local cache holds just the API-origin key and expiry timestamp, never account,
credential or reading data. If the probe fails (including CORS rejection) or
times out, the actual request is sent once with its original authorization/body
and without the optional headers. Added telemetry remains disabled for that
worker's lifetime. An HTTP error or ambiguous network failure on the actual save
is never replayed by this adapter. Existing save reconciliation/retry ownership
remains unchanged. Firefox sends no probe.

No permission, destination, raw user agent, page content, unrelated browsing
history or installation identifier is added. OPTIONS is additional API traffic,
not an additional activity event. Existing clients remain unattributed.

**Release dependency:** requires a Trace API version that accepts these headers.
Deploy the compatible API BEFORE releasing or pinning any extension build
containing this change into the Apple app. Older allow-lists reject these
headers during preflight; they do not silently ignore them. The compatibility
fallback is defensive, not permission to reverse deployment order. Owner privacy
review is required before merge or release; no merge, pin update or store
submission is authorized here.

## Browser connection continuity

Chrome, Firefox (including Android), and desktop Safari exchange a Trace
website sign-in grant for a scoped installation credential in the background.
It stays in extension-private IndexedDB and authorizes only extension API
routes. Tracking does not require an open Trace tab after connecting. Existing
valid website tokens migrate when next loaded. An already expired connection
may require one reconnect after upgrading. Disconnect clears local authority
and attempts server revocation; offline revocation is best effort. Server idle
and absolute expiry still apply. iOS continues to use the app-owned provider.

When reconnect opens Trace from a story, successful sign-in returns to the
existing reading tab without reloading it. Only browser tab IDs and a bounded
expiry are retained for that return; no reading URL or page content is stored.
If the tab closed or the reader moved away from the sign-in tab, connection
still succeeds without changing the selected tab.
