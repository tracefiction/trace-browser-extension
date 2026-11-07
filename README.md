# Trace browser extension

This is the source code for the Trace extension on Chrome, Edge, Firefox and Safari. I've made it public so you can check for yourself what it does on AO3 and FanFiction.net.

In short, it reads the details of the stories you open (title, author, tags, chapters, word count) and where you are in them, and it sends those to your Trace library. It never asks for your AO3 or FanFiction.net password, it doesn't ask for permission to read your cookies, and it doesn't send story text or whole pages to Trace. If anything claiming to be Trace ever asks for your AO3 or FanFiction.net password, it isn't me.

The Safari extension ships inside the Trace iPhone app. The app itself lives in a separate private repo, but it builds the extension from a pinned commit of this one, so what runs in Safari is this repo at whatever commit the app has pinned.

## What it reads

On AO3 and FanFiction.net story and listing pages, the extension reads what's already shown on the page:

- the story's address, title and author
- fandoms, tags, warnings, rating, characters and relationships, where the site lists them
- chapter and word counts
- which chapter you're on
- on your own AO3 History page, and only when you import it: each work's "Last visited" date and visit count (works marked for later are left out)

That's how Trace saves a story, keeps your place, and shows on AO3 whether a story's already in your library. When you reach the end of the last posted chapter, it notices from the page layout and how you've scrolled, and marks the story finished or caught up, with Undo. If the site doesn't say whether the work is complete, it asks you instead. It doesn't read the story text to do this.

If you save an AO3 search filter, the filter is kept in the extension so you can use it again. When you're signed in, it's also synced to your account so it shows up on your other devices.

## The pages it fetches, and why

Most of the time the extension only looks at the page you have open. There are four cases where it fetches another page itself, all from your own AO3 or FanFiction.net tab, as if you'd opened the page. The two summary lookups can be turned off with **Improve story details** in the popup. The other two only happen when you press something.

### FanFiction.net summaries

FanFiction.net's phone pages don't show a story's summary, but the author's page does. So when you save a story from a phone page, Trace fetches that author's story list (`/u/<author>/?a=s`) from your tab, finds the story and keeps only its summary. It does the same, slowly, for other saved FanFiction.net stories that are missing one (sometimes reading the story's own page first to find the author), but only while you have FanFiction.net open: one request at a time, at least 30 seconds apart and usually minutes, and only a few per visit. It never opens a new tab. If FanFiction.net shows a check page or an error, it stops for about an hour.

### AO3 summaries

AO3 only shows a work's summary on chapter 1. If you start reading at chapter 2 or later, Trace looks the work up in AO3's search, at most once a day per work, and keeps the summary from the search result. It doesn't open the work, so nothing gets added to your AO3 History.

### Bare links on AO3

Some AO3 pages, like Subscriptions, list a work as just a link. When you press **+ Add to Trace** beside one, Trace searches AO3 for that work and saves the details from the search result. Again, it doesn't open the work itself.

### Your AO3 History

When you import your AO3 History, Trace reads each page of it from your AO3 tab. You then choose what to add on Trace's review page before anything is saved.

There's more detail on the limits and timings in [docs/technical-notes.md](docs/technical-notes.md).

## What it sends to Trace

When you save a story, read one, or change something with Trace's buttons on AO3 and FanFiction.net, the extension sends:

- the story details listed above
- your reading progress
- the status you pick: Saved, Reading, Caught up, Paused, Finished or Dropped
- what you tell it at the end of a story, including whether the work is complete, ongoing, on hiatus or abandoned
- that you reached the end of the last posted chapter, for stories already in your library
- works you've chosen to hide from Trace's lists (this only hides them in Trace, not on AO3 or FanFiction.net)
- AO3 filters you've saved
- from an AO3 History import, each work's last-visited date, which Trace uses as the last-read date (the visit count is sent with the import but not kept)
- a key from your Trace sign-in, so the server knows it's you. It only works for the extension's own requests
- on Chrome, Edge and Safari, the extension's version and roughly what browser you're on (phone or computer), so I can see when a release breaks something. Firefox sends none of this

On iPhone and iPad the Trace app hands the extension that key, so the extension never sees your Trace sign-in itself.

## What it never sends

- your AO3 or FanFiction.net password
- browser cookies
- private messages, drafts, comments or account settings
- the story text or the full page
- anything about sites other than AO3, FanFiction.net and Trace

## Where to look in the code

- `Shared (Extension)/Resources/manifest.json`: which sites the extension can run on and which permissions it asks for. The Chrome and Firefox manifests are generated by `scripts/build.mjs`, which is also where AO3 and FanFiction.net login and sign-up pages are excluded (`SITE_AUTH_EXCLUDE_MATCHES`). The page scripts also switch themselves off on any page with a password box (apart from AO3's usual header login form).
- `Shared (Extension)/Resources/collector.js`: what it reads from AO3 and FanFiction.net pages.
- `Shared (Extension)/Resources/library-overlay.js`: the Trace buttons and story sheet you see on those pages.
- `Shared (Extension)/Resources/sync.js`: how it picks up your sign-in from the Trace website.
- `src/extension-runtime/` and `src/extension-core/`: everything that talks to Trace's servers. Only the background script does that; the page scripts ask it for what they need.
- `src/background.js`: the older background script, kept only for a rollback build.

`Shared (Extension)/Resources/background.js`, `popup-config.js` and `content-config.js` are generated, but committed because Safari uses them as they are. Don't edit them by hand. Run `npm run build:ios-earned-permission-onboarding:release` and commit what it writes. `npm test` fails if they're out of date.

## Building it

You'll need Node 18 or newer.

```bash
npm install
npm test
```

For a local build pointed at a local Trace server, copy `.env.example` to `.env`, set

```bash
TRACE_API_BASE=http://localhost:3001
TRACE_WEB_ORIGIN=http://localhost:5173
```

and run `npm run build`.

A release build only accepts the real Trace addresses:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run build:release
```

`npm run check:release` runs every test and then the release build, the same as CI. It needs the same two addresses. Without them the build stops at the localhost default, which is on purpose.

The screenshot tests use Playwright's Chromium. After a fresh install, run `npm run visual:install-browsers` once, then `npm run visual:screenshots`.

## Trying it in your browser

**Chrome or Edge:** go to `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `dist/chrome`.

**Firefox:** go to `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on** and pick `dist/firefox/manifest.json`.

**Safari:** Apple only allows Safari extensions inside an app, and the Trace app's Xcode project isn't public. The files under `Shared (Extension)/`, `iOS (Extension)/` and `macOS (Extension)/` are what the app builds from.

If Chrome, Edge or Firefox loses access to AO3 or FanFiction.net, the Trace icon shows a **!**. Click it, then **Allow Trace on AO3 and FanFiction.net**.

## What's where

- `Shared (Extension)/Resources/`: the extension itself, used by Safari as is and copied into the Chrome and Firefox builds in `dist/`
- `Shared (Extension)/*.swift`: the Safari side of talking to the Trace app
- `iOS (Extension)/` and `macOS (Extension)/`: Safari extension settings used by the app
- `src/`: the background script source
- `scripts/`: build and packaging
- `test/`: tests
- `docs/`: longer notes, starting with [technical-notes.md](docs/technical-notes.md)
- `README.mozilla.md`: notes for Firefox's source review

## Reporting problems

If AO3 or FanFiction.net changed something and Trace stopped working on a page, or you've found a bug, please open an [issue](https://github.com/tracefiction/trace-browser-extension/issues). There's a template for each. For anything about security or privacy, email me instead, as described in [SECURITY.md](SECURITY.md).

I'm not taking feature pull requests, mostly because of the licence. If you've got a small bug fix, open an issue first and we can talk about it.

## Licence

The code is source-available under the PolyForm Noncommercial License 1.0.0. You're welcome to read it, check it and run it for yourself, but not to use it commercially.
