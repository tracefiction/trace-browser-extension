# Extension Store Copy - 0.5.3

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

Trace extension 0.5.3 improves first-story onboarding:

- Opens the Trace first-story setup page after a fresh extension install.
- Lets Trace send a supported AO3 or FanFiction.net story URL to the extension
  so the first story can open with the Trace control focused, and save
  immediately when the extension can run on that archive page.
- Improves iOS Safari setup by letting the signed-in Trace app share the current
  Trace session with the bundled Safari extension.
- Adds app-led iOS handoff for pasted AO3/FFN story URLs: Trace stores a
  short-lived pending URL, opens Safari, and the extension saves the matching
  story once Safari grants site access.
- Retries transient account checks before showing reconnect guidance, reducing
  false setup failures while the Trace session is still settling.

Privacy boundary unchanged: Trace still reads story metadata and reading
progress from supported pages, not AO3/FFN credentials, cookies, private account
pages, story text, or unrelated browsing history. The new onboarding handoff
uses the same supported story URLs and Trace auth token already used for
authenticated extension actions.

## Chrome / Firefox Submission Notes

This release uses the same host permissions for supported Trace, AO3, and
FanFiction.net pages. Chrome and Firefox packages do not request Safari native
messaging permission; the build strips that Safari-only permission from their
store manifests.

- `+ ADD` and reading-status controls send authenticated Trace API requests
  through the background worker.
- First-story setup requests from Trace web pages are same-origin messages that
  ask the extension to open a supported archive story URL.
- `HIDE` stores a user-owned hidden-work preference in Trace, keyed by supported
  AO3/FFN work id.
- The popup continues to expose automatic tracking, library-status overlay, and
  metadata-improvement preferences.

The extension does not request cookie permissions.

## App Store Connect - iOS What's New

Trace for iOS 0.5.3 improves Safari extension onboarding:

- Connects the Safari extension to the signed-in Trace app session during
  onboarding, so first-story handoff can work without signing in again inside
  Safari.
- Opens Safari extension settings from the Trace app on supported iOS versions,
  with a fallback path for older iOS settings screens.
- Lets the Trace app hand a pasted AO3 or FanFiction.net story URL to Safari,
  then lets the bundled extension save the matching story when site access is
  allowed.
- Keeps first-story setup recovery copy focused on Safari website permissions
  instead of asking readers to sign in twice.

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

1. Install the app and sign in to Trace in the app.
2. Use the app's Safari extension setup action. On supported iOS versions this
   opens Safari extension settings; on older versions use Settings -> Apps ->
   Safari -> Extensions, or Settings -> Safari -> Extensions.
3. Allow Trace on Trace, archiveofourown.org, and fanfiction.net.
4. Return to the app and open AO3, open FanFiction.net, or paste a supported
   story URL. Safari should open and the extension should already be connected.
5. Use `+ ADD`, status controls, import, hide/undo, and final-chapter finish
   prompts on supported pages.
