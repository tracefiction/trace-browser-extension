# Trace Browser Extension Source

This repository is public for transparency. Trace reads fanfiction story metadata so readers can import stories, sync reading progress, and see their Trace library status while browsing. Users should be able to verify the boundary themselves: metadata, reading-status choices, progress, and explicit browsing preferences — not AO3/FanFiction.net logins, cookies, private account pages, or full page HTML.

The code here covers the Trace browser extension plus the iOS/macOS Safari Web Extension wrapper.

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

Trace uses this to import a story, update reading progress, show whether stories are already in your Trace library, let you change reading status from supported overlay surfaces, and hide works from Trace's browsing overlay when you explicitly choose to. Trace can also detect when you reach the last posted chapter of a supported story page so it can ask whether the work is complete, ongoing, on hiatus, or abandoned before marking your library entry finished or caught up.

When you explicitly save an AO3 saved filter, Trace stores that AO3 filter query state in extension storage so it can reapply the filter later. If you are signed in to Trace, saved filters sync to your Trace account so they can appear on your other devices. Signed-out or offline saved filters remain local until a later signed-in sync.
You can hide the saved filters surface from AO3 filter pages in the extension popup; this local preference does not delete saved presets.

## What Trace Sends

Trace may send this data to the Trace API when you import, quick-add, auto-track, or help improve shared metadata:

- story URL
- title and author
- fandoms/tags and related story metadata
- chapter and word counts
- reading-progress metadata
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
The iOS app shell also exposes its app version, build number, and release
channel to the Trace web app. Trace sends those values with a privacy-safe
authenticated onboarding diagnostic so release-specific setup failures can be
distinguished without collecting story URLs, archive browsing history, or
account email.

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

For a tagged release, confirm `package.json` version matches the generated manifest version. Safari consumes checked-in files under `Shared (Extension)/Resources`; Chromium and Firefox packages are generated into `dist/`, which is intentionally not committed.

`Shared (Extension)/Resources/background.js` is a committed build artifact.
Kernel builds bundle `src/extension-runtime/index.mts` and its core/runtime
dependency graph; the generated header records the configured API and web
origins for release auditing. Only `build:legacy:release` generates that file
from `src/background.js` by literal substitution. Safari requires the selected
release artifact to be checked in. `Shared (Extension)/Resources/popup-config.js`,
`Shared (Extension)/Resources/content-config.js`, and
`iOS (App)/TraceWebOrigin.generated.swift` are committed for the same reason —
popup navigation, page-script configuration, and the iOS DEBUG `WKWebView` shell
need compiled constants, and all generated artifacts use the same `.env` values.

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
localhost, non-HTTPS, and non-production Trace origins. The explicit
`build:legacy:release` command remains available as the bounded rollback path;
it is not used by the store packaging commands.

## Load Locally

Chrome / Edge: open `chrome://extensions`, enable Developer Mode, choose `Load unpacked`, and select `dist/chrome`.

Firefox: open `about:debugging#/runtime/this-firefox`, choose `Load Temporary Add-on`, and select `dist/firefox/manifest.json`.

Safari: open `Trace.xcodeproj` in Xcode, select your own Apple signing team
locally, and build the iOS or macOS app target. Use **Debug** with local/dev/
staging generated origins; use **Release** only with the canonical production
origins. The iOS Release shell intentionally remains production-bound. The
public Xcode project intentionally does not include a private Apple development
team.

## Repo Layout

- `src/background.js` - source for the extension service worker. The build injects configured Trace origins and writes `Shared (Extension)/Resources/background.js`.
- `Shared (Extension)/Resources/` - browser extension assets used by Safari and copied into Chromium/Firefox `dist/` builds.
- `Shared (App)/`, `iOS (App)/`, `macOS (App)/` - minimal Apple app shells that host the Safari Web Extension / Trace web view.
- `TraceWidget/` - WidgetKit source for the iOS wrapper.
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
