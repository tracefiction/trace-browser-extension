# Extension Store Copy - 0.5.1

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

Trace extension 0.5.1 is a reliability patch for iOS sign-in:

- Fixes an issue where the iOS wrapper could lose native-shell context while
  returning from external OAuth sign-in.
- Preserves the configured Trace web origin when rewriting iOS auth callbacks,
  including local DEBUG scheme and port settings.
- Keeps the existing browser extension permissions and supported site behavior
  unchanged.

Privacy boundary unchanged: Trace still reads story metadata and reading
progress from supported pages, not AO3/FFN credentials, cookies, private account
pages, story text, or unrelated browsing history.

## Chrome / Firefox Submission Notes

This release uses the same host permissions for supported Trace, AO3, and
FanFiction.net pages. User-visible browsing behavior is unchanged:

- `+ ADD` and reading-status controls send authenticated Trace API requests
  through the background worker.
- `HIDE` stores a user-owned hidden-work preference in Trace, keyed by supported
  AO3/FFN work id.
- The popup continues to expose automatic tracking, library-status overlay, and
  metadata-improvement preferences.

The extension does not request cookie permissions.

## App Store Connect - iOS What's New

Trace for iOS 0.5.1 improves sign-in reliability:

- Fixes an issue where sign-in could fail to resume correctly after returning
  from the browser.
- Keeps Safari extension permissions and supported site behavior unchanged.

## App Review Notes

Trace is a reading-library companion for AO3 and FanFiction.net. The Safari Web
Extension reads visible story metadata and reading-progress signals from pages
the user opens so it can save works, sync progress, and show Trace library
status overlays. It does not request AO3/FFN credentials or browser cookies.

To test:

1. Install the app and enable the Safari extension in Settings -> Apps ->
   Safari -> Extensions. On older iOS versions, this may appear as Settings ->
   Safari -> Extensions.
2. In Safari, allow Trace on tracefiction.com, archiveofourown.org, and
   fanfiction.net when prompted.
3. Sign in at tracefiction.com in Safari.
4. Open the extension popup on tracefiction.com to connect the extension.
5. Visit a supported AO3 or FanFiction.net story/listing page and refresh if
   needed.
6. Use `+ ADD`, status controls, import, and hide/undo on supported pages.
