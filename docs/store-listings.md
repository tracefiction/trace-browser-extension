# Extension Store Copy - 0.5.2

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

Trace extension 0.5.2 improves end-of-story handling and iOS tap reliability:

- Adds an end-of-story prompt on supported AO3 and FanFiction.net final posted
  chapters so readers can mark a library entry Finished or Caught up and
  identify the work as complete, ongoing, on hiatus, or abandoned.
- Updates reading-status language in extension controls to Saved, Reading,
  Caught up, Paused, Finished, and Dropped.
- Fixes iOS wrapper issues where data export could open as raw ZIP bytes,
  public collection links could stay trapped inside the app shell, and the
  first tap after leaving the app and returning could be ignored.
- Keeps the native iOS app surface vertically scrollable without sideways
  rubber-banding on bounded Trace screens.
- Improves FanFiction.net author-page metadata refreshes so Trace can fill in
  fields that are not available on FFN story pages when they appear in author
  listings.
- Uses production Trace API and web origins in the generated release build.

Privacy boundary unchanged: Trace still reads story metadata and reading
progress from supported pages, not AO3/FFN credentials, cookies, private account
pages, story text, or unrelated browsing history. The new finish prompt sends
only the explicit reader decision and the same supported-work chapter metadata
Trace already uses for progress tracking.

## Chrome / Firefox Submission Notes

This release uses the same host permissions for supported Trace, AO3, and
FanFiction.net pages. The extension now includes an additional bundled content
script, `trace-finish-qualify.js`, injected only on the same supported AO3 and
FanFiction.net story-page matches already covered by the manifest.

- `+ ADD` and reading-status controls send authenticated Trace API requests
  through the background worker.
- End-of-story finish prompts send authenticated Trace API requests through the
  background worker when the reader explicitly chooses Finished/Caught up and a
  work status.
- `HIDE` stores a user-owned hidden-work preference in Trace, keyed by supported
  AO3/FFN work id.
- The popup continues to expose automatic tracking, library-status overlay, and
  metadata-improvement preferences.

The extension does not request cookie permissions.

## App Store Connect - iOS What's New

Trace for iOS 0.5.2 improves Safari extension behavior:

- Fixes an issue where the first tap after returning to Trace could be ignored.
- Exports account data through the native iOS share sheet instead of opening
  unreadable ZIP bytes inside the web view.
- Opens public collection pages outside the app shell so shared links behave
  like public web pages.
- Prevents sideways web-view rubber-banding on bounded Trace app screens.
- Adds end-of-story prompts on supported AO3 and FanFiction.net final posted
  chapters so readers can mark entries Finished or Caught up.

## Screenshot Preparation

Prepare iPhone screenshots for the accepted App Store Connect sizes with:

```bash
npm run screenshots:store -- ~/Desktop/trace-screenshots --out dist/store-screenshots
```

The script accepts image files or folders, auto-rotates images from EXIF
metadata, and writes exact PNG canvases for the matching orientation:

- `1284 x 2778` and `1242 x 2688` for portrait screenshots.
- `2778 x 1284` and `2688 x 1242` for landscape screenshots.

By default it uses center `cover` resizing so normal iPhone screenshots fill the
required canvas. Use `--fit contain` when preserving every source pixel matters
more than filling the canvas, and `--orientation all` when a submission needs all
four sizes from the same source image.

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
6. Use `+ ADD`, status controls, import, hide/undo, and final-chapter finish
   prompts on supported pages.
