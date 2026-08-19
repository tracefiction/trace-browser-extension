# iOS Safari popup permission spike

This developer-only 0.6.4 build 17 tests whether Trace can replace Safari
Settings website-access instructions with one explicit action inside Trace's
Safari extension popup. It does not change the normal release build and it
does not add any website or data collection beyond Trace's existing AO3 and
FanFiction.net boundary.

## What the spike changes

When `TRACE_IOS_POPUP_PERMISSION_SPIKE=1`:

- the seven existing AO3 and FanFiction.net patterns move from Safari
  `host_permissions` to `optional_host_permissions`;
- the normal Trace popup becomes a focused **Allow story sites** surface;
- its button calls `permissions.request()` directly inside the click gesture;
- after complete permission coverage, the popup dynamically registers the
  existing archive runtime and AO3 saved-filter scripts;
- login, signup, password, authentication, and logout exclusions remain in
  force;
- the Trace web-origin bridge remains separate from the archive permission
  bundle;
- Chrome and Firefox packages remain production-shaped.

The popup reports only current browser permission and script-registration
state. It does not claim that a story was saved or that automatic tracking is
ready. Opening AO3 and receiving the existing archive heartbeat remains the
stronger readiness proof.

## Build

Create the production-origin TestFlight resources with:

```bash
npm run build:ios-popup-permission-spike:release
npm run ios:build
```

Archive the **Trace (iOS)** scheme without running another extension build.
The experiment is version **0.6.4**, build **17**. A normal
`npm run build:release` restores the production Safari manifest and popup
configuration.

## Clean-device test

Use a real iPhone or iPad. Simulator compilation cannot exercise Safari's
permission prompt.

1. Delete Trace and confirm it is absent under Safari Extensions.
2. Install build 17 and sign in inside the Trace app.
3. Enable **Allow Extension** only. Do not grant website access in Settings.
4. In Safari, attempt to finish Trace setup without referring to Settings.
   Record whether the tester can find Trace in Safari's page menu and how many
   wrong turns or prompts are required.
5. Open Trace's extension popup. It must show **Allow story sites** above the
   fold, name AO3 and FanFiction.net, and tell the tester to choose
   **Always Allow**.
6. Press **Allow AO3 & FFN** and record Safari's exact prompt and choices.
7. Choose **Always Allow**. The popup must immediately show both sites as
   **Allowed**, confirm both script groups are ready, and expose
   **Open AO3 to verify** without requiring a scroll.
8. Open AO3. Confirm Trace appears on a supported page and the app receives a
   fresh archive heartbeat. Permission status alone is not sufficient.
9. Force-quit Safari, reopen it, and reopen Trace's popup. It must still show
   complete access and restore any missing registered script automatically.
10. Visit reachable AO3 variants and both FFN hosts. Record any host that does
    not receive Trace despite the complete bundle result.
11. Reinstall or update the extension and repeat the popup and heartbeat checks.

Also repeat once with **Allow for One Day** and once with **Don't Allow**.
Safari does not expose the selected duration through `permissions.getAll()`,
so a one-day choice may look successful immediately. That limitation must be
treated as a UX risk, not misclassified as durable readiness.

## Decision rule

Advance the popup route into an onboarding prototype only if:

- an uncoached tester can find the extension popup;
- the prompt grants all seven patterns from one button gesture;
- the result is visible without scrolling;
- the existing archive scripts run after grant and after Safari restarts;
- denial has a clear retry path;
- testers reliably choose **Always Allow**, or the onboarding can safely
  recover when temporary access expires.

Any partial grant, missing host, silent script-registration failure, or
unrecoverable temporary grant fails the spike. A technical pass does not by
itself select this as the production onboarding flow; it earns the popup route
a place in moderated comparison against the two Safari Settings variants.
