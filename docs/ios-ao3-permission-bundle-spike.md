# iOS AO3 permission-bundle capability spike

This isolated capability spike tests whether Safari can grant every AO3 origin Trace
supports through one runtime permission request. It does not change the normal
production build and it does not read or send story data.

## Compile check

```bash
npm run build:ios-permission-spike
npm run ios:build
```

The second command proves the generated resources compile inside the iOS app.
It does not exercise Safari's consent UI. For the decisive result, rerun
`npm run build:ios-permission-spike`, open `Trace.xcodeproj` in Xcode, and run
the **Trace (iOS)** Debug scheme on a real iPhone or iPad.

## TestFlight build

For the 0.6.4 permission experiment, use the dedicated production-origin spike
build before archiving:

```bash
TRACE_API_BASE=https://api.tracefiction.com \
TRACE_WEB_ORIGIN=https://www.tracefiction.com \
npm run build:ios-permission-spike:release
```

Archive the **Trace (iOS)** scheme without running another extension build.
The grant experiment was build **13**. The update-restoration experiment is
version **0.6.4**, build **14**. A normal
`npm run build:release` restores the production Safari manifest and popup.

The spike build changes only the generated Safari manifest:

- AO3 patterns move from `host_permissions` to `optional_host_permissions`.
- AO3 static content scripts are omitted so an existing manifest request cannot
  influence the result.
- `activeTab` and `scripting` are enabled.
- the Safari action opens `permission-spike.html` instead of the production
  popup.
- build 14 removes build 13's harmless verification badge and dynamically
  restores Trace's real AO3 collector, overlay, and saved-filter scripts when
  Safari still reports the complete granted bundle.
- update, startup, permission-change, and explicit popup reconciliation are
  idempotent; all exclude AO3 login, signup, password, authentication, and
  logout pages.

Chrome and Firefox packages remain production-shaped. Running `npm run build`
or `npm run build:release` restores the normal Safari manifest.

## Build 13 clean grant test

1. Delete the existing Trace app and confirm its Safari extension is absent.
2. Build and install the debug app, then enable **Allow Extension** only. Do not
   change Website Access.
3. Open Safari, use the page menu to open **Extensions > Trace**, and press
   **Request complete AO3 access**.
4. Record Safari's exact permission dialog and approve it.
5. The panel passes only when `permissions.request()` resolves true and the
   subsequent `permissions.getAll()` includes all five required patterns (or a
   Safari blanket grant).
6. Expand **Raw test evidence**. Confirm the registered script covers all five
   patterns with `persistAcrossSessions: true` and `nativeAcknowledged` is true.
7. Visit the reachable AO3 variants below. A green local-only badge proves the
   dynamically registered script ran:
   - `https://archiveofourown.org/works`
   - `https://archiveofourown.gay/works`
   - `https://archive.transformativeworks.org/works`
8. Force-quit Safari, reopen it, revisit the variants, reopen Trace, and press
   **Recheck after restarting Safari**. The permission bundle and registered
   script must still be present.
9. Rebuild/reinstall the extension and confirm whether the permission survives
   the update. Registered scripts may require re-registration after an update;
   the production design must restore them from the granted-origin snapshot.

## Build 14 update-restoration test

1. Keep build 13 installed with the complete AO3 bundle granted and the green
   probe visible. Do not delete the app or change Website Access.
2. Install build 14 over build 13 through TestFlight.
3. Force-quit Safari, reopen it, and load or refresh an AO3 works page.
4. Pass: the green probe is gone and Trace's real overlay appears. The popup's
   raw evidence lists `trace-ao3-runtime-main` and
   `trace-ao3-runtime-saved-filters`, not the old probe ID.
5. Return to the Trace app and verify AO3. Pass: the normal archive heartbeat
   makes verification succeed without granting Website Access again.
6. Repeat on the reachable `.gay` and Transformative Works variants, then
   restart Safari once more and verify that the real scripts still run.

## Decision rule

Use runtime permission as the primary onboarding path only if the complete AO3
bundle is granted atomically, remains granted after Safari restarts, and can be
restored safely after extension updates. Otherwise keep Website Access in
Settings as the permanent-access path and use `activeTab` only as a first-story
recovery mode.
