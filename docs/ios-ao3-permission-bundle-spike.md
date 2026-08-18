# iOS AO3 permission-bundle capability spike

This debug-only spike tests whether Safari can grant every AO3 origin Trace
supports through one runtime permission request. It does not change a normal or
release build and it does not read or send story data.

## Compile check

```bash
npm run build:ios-permission-spike
npm run ios:build
```

The second command proves the generated resources compile inside the iOS app.
It does not exercise Safari's consent UI. For the decisive result, rerun
`npm run build:ios-permission-spike`, open `Trace.xcodeproj` in Xcode, and run
the **Trace (iOS)** Debug scheme on a real iPhone or iPad.

The spike build changes only the generated Safari manifest:

- AO3 patterns move from `host_permissions` to `optional_host_permissions`.
- AO3 static content scripts are omitted so an existing manifest request cannot
  influence the result.
- `activeTab` and `scripting` are enabled.
- the Safari action opens `permission-spike.html` instead of the production
  popup.
- the harmless verification badge is excluded from AO3 login, signup,
  password, authentication, and logout pages.

Chrome and Firefox packages remain production-shaped. Running `npm run build`
or `npm run build:release` restores the normal Safari manifest.

## Clean real-device test

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

## Decision rule

Use runtime permission as the primary onboarding path only if the complete AO3
bundle is granted atomically, remains granted after Safari restarts, and can be
restored safely after extension updates. Otherwise keep Website Access in
Settings as the permanent-access path and use `activeTab` only as a first-story
recovery mode.
