# Archive Bunker: Mozilla add-on review, reproducible build

This file is in the source archive submitted to addons.mozilla.org with **Archive Bunker** (`archive-bunker@tracefiction.com`). It gives the step-by-step build AMO asks for.

The archive is the whole `trace-browser-extension` repository, because Archive Bunker shares its AO3 code with the Trace extension. Only the files listed below go into Archive Bunker. `README.mozilla.md` describes the separate Trace extension and doesn't apply here.

## What you are reviewing

Archive Bunker keeps local copies of AO3 downloads (EPUB by default) when the reader bookmarks, marks for later, subscribes or leaves kudos on archiveofourown.org. Copies go to the browser's Downloads folder, under `Archive Bunker/`. It has no account, talks to no server but archiveofourown.org, and collects no data.

| Shipped file | How it is produced |
|--------------|--------------------|
| `background.js` | **Bundled** by `scripts/build-keep-a-copy.mjs` with esbuild from `src/extension-runtime/keep-a-copy-standalone.mts` and the modules it imports in `src/extension-runtime/`. Unminified IIFE, no remote code. |
| `page.js` | Bundled the same way from `src/extension-runtime/keep-a-copy-page.mts` (the AO3 content script). |
| `popup.js` | Bundled the same way from `src/extension-runtime/keep-a-copy-popup.mts`. |
| `popup.html` | Copied from `src/keep-a-copy/popup.html`. |
| `icon-16.png` … `icon-128.png` | Drawn from `src/keep-a-copy/icon-small.svg` (16, 32) and `icon-large.svg` (48, 128) with `sharp`. |
| `manifest.json` | Written by `keepACopyManifest("firefox")` in `scripts/build-keep-a-copy.mjs`. The version comes from `package.json`. |
| `LICENSE` | Copied from the repository root. |

## Environment

- Node.js 18 or later, with npm 9 or later.
- macOS, Linux or Windows. Packaging the zip uses the `zip` command.

## Steps

From the root of this archive:

```bash
npm ci
npm run build:keep-a-copy
```

This writes `dist/keep-a-copy-firefox/` (and `dist/keep-a-copy-chrome/`). Its contents should match the submitted package file for file:

```bash
mkdir -p /tmp/archive-bunker-submitted && unzip -o -q <submitted package>.zip -d /tmp/archive-bunker-submitted
diff -r dist/keep-a-copy-firefox /tmp/archive-bunker-submitted
```

## For maintainers

From a clean, committed checkout, `npm run package:archive-bunker` builds both browsers and writes `dist/archive-bunker-chrome.zip`, `dist/archive-bunker-firefox.zip` and `dist/archive-bunker-amo-source.zip` (tracked files only, via `git archive`).
