# Trace Browser Extension Source

This repository is public for transparency. Trace reads fanfiction story metadata so readers can import stories and sync reading progress, and users should be able to verify the boundary themselves: metadata and progress, not AO3/FanFiction.net logins, cookies, private account pages, or full page HTML.

The code here covers the Trace browser extension plus the iOS/macOS Safari Web Extension wrapper.

## What This Repository Helps You Verify

- Trace never asks for your AO3 or FanFiction.net password.
- The extension does not request browser cookie permission.
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

Trace uses this to import a story, update reading progress, and show whether stories are already in your Trace library.

## What Trace Sends

Trace may send this data to the Trace API when you import, quick-add, auto-track, or help improve shared metadata:

- story URL
- title and author
- fandoms/tags and related story metadata
- chapter and word counts
- reading-progress metadata
- reader-status updates you explicitly choose in the Trace overlay, such as Planning, Reading, Paused, Finished, or Dropped
- hidden-work browsing preferences you explicitly choose in the Trace overlay, keyed by the supported AO3/FFN work id
- your Trace auth token for authenticated Trace API requests

The metadata-improvement preference is separate from automatic progress tracking and can be turned off in the extension popup.
Hidden-work preferences affect Trace browsing overlays only; they are separate from reader status and do not hide or change the source site itself.

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

For a tagged release, confirm `package.json` version matches the generated manifest version. Safari consumes checked-in files under `Shared (Extension)/Resources`; Chromium and Firefox packages are generated into `dist/`, which is intentionally not committed.

`Shared (Extension)/Resources/background.js` is a committed build artifact generated from `src/background.js` by `npm run build` / `npm run build:release` (literal string substitution of `__TRACE_API_BASE__` and `__TRACE_WEB_ORIGIN__`). Safari requires it to be checked in. When auditing the extension, read `src/background.js` as the source of truth and confirm the two files agree for the release you are inspecting. `iOS (App)/TraceWebOrigin.generated.swift` is committed for the same reason — the iOS DEBUG `WKWebView` shell needs a compiled constant, and it is regenerated from the same `.env` values.

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

For a release-style build, use HTTPS Trace origins:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://tracefiction.com npm run build:release
```

`build:release` rejects missing, localhost, and non-HTTPS origins.

## Load Locally

Chrome / Edge: open `chrome://extensions`, enable Developer Mode, choose `Load unpacked`, and select `dist/chrome`.

Firefox: open `about:debugging#/runtime/this-firefox`, choose `Load Temporary Add-on`, and select `dist/firefox/manifest.json`.

Safari: open `Trace.xcodeproj` in Xcode, select your own Apple signing team locally, and build the iOS or macOS app target. The public Xcode project intentionally does not include a private Apple development team.

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

## Reporting issues

This repository is published for transparency. The following are welcome via [GitHub Issues](https://github.com/tracefiction/trace-browser-extension/issues):

- **AO3 or FanFiction.net page changes** that broke import, library overlay, or progress tracking. Use the "AO3/FFN page broke" issue template — it asks for the site, page URL pattern, and what failed.
- **Bug reports** for the extension's behavior in any supported browser. Use the "Bug report" template.
- **Security or privacy concerns**: please follow `SECURITY.md` rather than filing a public issue.

We do **not** currently accept feature pull requests. The PolyForm Noncommercial License is intended for inspection and personal use; accepting outside contributions complicates the licensing terms. Bug-fix PRs that come with a clear issue and a small surface area may be considered case by case — please open an issue first to discuss.

## License

This repository is source-available under the PolyForm Noncommercial License 1.0.0.

It is published for transparency so users can inspect how the Trace extension handles page data, browser permissions, and network requests. Commercial reuse is not permitted.
