# Extension Store Copy — 0.3.0

Use this copy for Chrome Web Store, Firefox Add-ons, App Store Connect, and
public release notes. Keep evergreen store descriptions separate from
version-specific "What's New" copy.

## One-Line Description

Save and manage AO3 and FanFiction.net stories from your browser.

## Short Description

Trace is a private fanfiction library that works while you browse AO3 and
FanFiction.net: save works, see reading status, hide works from your overlay, and
keep chapter progress up to date.

## Full Description

Trace is a private reading library for fanfiction readers. The browser extension
works alongside AO3 and FanFiction.net so your library is useful while you
browse, not only after you switch back to the Trace app.

With the extension you can:

- Add supported AO3 and FanFiction.net works to Trace from story and listing
  pages.
- See your Trace reading status and chapter progress while browsing supported
  archive pages.
- Change reading status from supported Trace overlay controls.
- Hide works from Trace browsing overlays when you do not want to keep seeing
  them.
- Import story metadata from the page you are already viewing, including AO3
  listings and bookmark pages.
- Sync chapter progress as you move through supported story pages.

Trace does not ask for your AO3 or FanFiction.net password. It does not request
browser cookie permission, collect story text, or read unrelated browsing
history. The source is published so readers can inspect the extension's
permissions, page access, and data flow.

Trace is an unofficial companion for fanfiction readers and is not affiliated
with AO3, the Organization for Transformative Works, FanFiction.net, or
FictionPress.

## What's New / Release Notes

Trace extension 0.3.0 improves the AO3 and FanFiction.net browsing experience:

- New compact on-page library lens for saved works, reading status, and chapter
  progress.
- One-click add from supported story and listing pages, with clearer saving and
  error states.
- Reading-status controls for Planning, Reading, Paused, Finished, and Dropped.
- Hide and undo controls for works you do not want to keep seeing in Trace
  browsing overlays.
- Mobile-friendly story sheet for managing the current work without leaving the
  archive page.
- Refreshed extension popup with connection status, import, and extension
  behavior controls.
- Improved reconnect, sign-in, free-limit, and password-page handling.

Privacy boundary unchanged: Trace still reads story metadata and reading
progress from supported pages, not AO3/FFN credentials, cookies, private account
pages, story text, or unrelated browsing history.

## Chrome / Firefox Submission Notes

This release uses the same host permissions for supported Trace, AO3, and
FanFiction.net pages. The new user-visible behavior is additive UI on supported
pages:

- `+ ADD` and reading-status controls send authenticated Trace API requests
  through the background worker.
- `HIDE` stores a user-owned hidden-work preference in Trace, keyed by supported
  AO3/FFN work id.
- The popup continues to expose automatic tracking, library-status overlay, and
  metadata-improvement preferences.

The extension does not request cookie permissions.

## App Store Connect — iOS What's New

Trace for iOS now includes the updated Safari extension experience:

- See Trace library status and chapter progress while browsing AO3 and
  FanFiction.net in Safari.
- Add supported works from story and listing pages.
- Change reading status from the extension overlay.
- Hide works from Trace browsing overlays, with undo.
- Use the refreshed extension popup for connection status, import, and behavior
  controls.

This update also improves reconnect handling, mobile overlay placement, and
extension feedback while saving.

## App Review Notes

Trace is a reading-library companion for AO3 and FanFiction.net. The Safari Web
Extension reads visible story metadata and reading-progress signals from pages
the user opens so it can save works, sync progress, and show Trace library
status overlays. It does not request AO3/FFN credentials or browser cookies.

To test:

1. Install the app and enable the Safari extension in Settings -> Safari ->
   Extensions.
2. Sign in at tracefiction.com in Safari.
3. Open the extension popup on tracefiction.com to connect the extension.
4. Visit an AO3 or FanFiction.net story/listing page and refresh if needed.
5. Use `+ ADD`, status controls, import, and hide/undo on supported pages.
