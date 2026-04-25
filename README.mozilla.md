# Mozilla add-on review — reproducible build

This file is included in the **source code zip** submitted to addons.mozilla.org (AMO). It satisfies AMO’s requirement for **step-by-step build instructions** in a README.

## What you are reviewing

The **Trace** browser extension: MV3 JavaScript under `src/` and `Shared (Extension)/Resources/`. There is **no** minifier, transpiler, or Webpack-style bundler. The only machine-generated extension file produced by our build is **`Shared (Extension)/Resources/background.js`**, generated from **`src/background.js`** by literal string substitution of API/web origins (see `scripts/build.mjs`). All other shipped `.js` files are human-authored source as committed.

## Environment

| Requirement | Version / notes |
|---------------|-----------------|
| **OS** | macOS, Linux, or Windows with a POSIX shell (`bash`) for the optional packaging script; any OS works if you run the `npm` commands manually. |
| **Node.js** | **≥ 18** (see `package.json` → `engines`). |
| **npm** | Comes with Node; use **npm 9+** recommended. |

## Step-by-step — reproduce the Firefox store package

Run these commands from the **root of this archive**.

### 1. Install dependencies (clean install)

```bash
npm ci
```

If `npm ci` fails (no lockfile in archive), use:

```bash
npm install
```

### 2. Configure production build URLs

Copy the example env file and set **HTTPS** production values (no trailing slashes):

```bash
cp .env.example .env
```

Edit `.env` and set **HTTPS** production origins (no trailing slashes) to match the submitted XPI — same values as in packaged `background.js` / `dist/firefox/manifest.json` `host_permissions`. For example:

```bash
TRACE_API_BASE=https://api.tracefiction.com
TRACE_WEB_ORIGIN=https://www.tracefiction.com
```

**`build:release` rejects `http://` and localhost** for these variables.

### 3. Run the release build (executes all extension build steps)

The **build entrypoint** is:

```bash
npm run build:release
```

This runs `TRACE_BUILD_MODE=release node scripts/build.mjs`, which:

1. Reads `src/background.js`, replaces `__TRACE_API_BASE__` and `__TRACE_WEB_ORIGIN__`, writes `Shared (Extension)/Resources/background.js`.
2. Syncs `Shared (Extension)/Resources/manifest.json` (version from `package.json`, host permissions from env).
3. Writes **`dist/chrome`** and **`dist/firefox`** (Firefox manifest includes `browser_specific_settings` for AMO).

### 4. (Optional) Produce the same zip layout as store upload

```bash
npm run zip:firefox
```

Output: **`dist/trace-firefox-store.zip`**. Unzip it: `manifest.json` must be at the **root** of the archive (not inside a wrapper folder).

## Scripts reference (`package.json`)

| Script | Purpose |
|--------|---------|
| `npm run build` | Development build (allows localhost in manifest when dev rules apply). |
| `npm run build:release` | **Store / AMO** build; validates HTTPS production URLs. |
| `npm run zip:firefox` | Zips `dist/firefox` contents for AMO (excludes macOS Finder junk). |
| `npm run zip:chrome` | Zips `dist/chrome` for Chrome Web Store. |

## Create the source zip (for maintainers)

From a full git checkout:

```bash
npm run package:amo-source
```

Writes **`dist/trace-browser-extension-amo-source.zip`** containing **tracked files only** (via `git archive`), so secrets, `node_modules/`, and `dist/` are not included.

---

Project overview: see **`README.md`**.
