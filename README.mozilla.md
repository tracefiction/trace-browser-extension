# Mozilla add-on review — reproducible build

This file is included in the **source code zip** submitted to addons.mozilla.org (AMO). It satisfies AMO’s requirement for **step-by-step build instructions** in a README.

## What you are reviewing

The **Trace** browser extension (Manifest V3). Most shipped files under `Shared (Extension)/Resources/` are human-authored JavaScript, HTML and CSS, committed as-is and copied into the package unchanged.

The build generates four shipped files:

| Shipped file | How it is produced |
|--------------|--------------------|
| `background.js` | **Bundled.** `scripts/build.mjs` uses **esbuild** to bundle the TypeScript sources in `src/extension-runtime/` and `src/extension-core/` (entry: `src/extension-runtime/index.mts`) into one **unminified** IIFE. It also prepends the two configured Trace origins. There is no minification, obfuscation or remote code. |
| `manifest.json` | `scripts/build.mjs` sets `version` from `package.json` and the permissions, host permissions and content scripts for the release origins. The Firefox package adds `browser_specific_settings`. |
| `popup-config.js`, `content-config.js` | Small generated configuration files holding the Trace origins and build flags. |

`npm run build:core` first type-checks and compiles the same TypeScript with `tsc` (`tsconfig.extension-core.json`) into `.trace-build/`, which is not shipped.

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

**`build:release` accepts exactly these two values.** It rejects any other origin, including `https://tracefiction.com` without `www`, non-HTTPS values and localhost. You can also pass the two variables on the command line instead of creating `.env`:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run build:release
```

### 3. Run the release build (executes all extension build steps)

The **build entrypoint** is:

```bash
npm run build:release
```

This runs `npm run build:core` (the `tsc` compile described above), then `TRACE_BUILD_MODE=release TRACE_SESSION_MODE=kernel node scripts/build.mjs`. That step:

1. Bundles `src/extension-runtime/index.mts` with esbuild into `Shared (Extension)/Resources/background.js`. The bundle is unminified.
2. Writes `Shared (Extension)/Resources/manifest.json`, `popup-config.js` and `content-config.js`. The version comes from `package.json`, and the origins come from the environment.
3. Writes **`dist/chrome`** and **`dist/firefox`**. The Firefox manifest includes `browser_specific_settings` for AMO.

The result should match the submitted package file for file. To check:

```bash
npm run zip:firefox
mkdir -p /tmp/trace-rebuilt && unzip -o -q dist/trace-firefox-store.zip -d /tmp/trace-rebuilt
diff -r /tmp/trace-rebuilt <unzipped submitted package>
```

### 4. (Optional) Produce the same zip layout as store upload

```bash
npm run zip:firefox
```

Output: **`dist/trace-firefox-store.zip`**. Unzip it: `manifest.json` must be at the **root** of the archive (not inside a wrapper folder).

## Scripts reference (`package.json`)

| Script | Purpose |
|--------|---------|
| `npm run build` | Development build (allows localhost in manifest when dev rules apply). |
| `npm run build:core` | Type-checks and compiles the TypeScript sources with `tsc` into `.trace-build/` (not shipped). |
| `npm run build:release` | **Store / AMO** build: `build:core`, then the esbuild bundle and the manifests. It accepts only the production Trace origins. |
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
