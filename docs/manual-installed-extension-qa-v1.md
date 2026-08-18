# Trace Extension V1 Manual Installed-Extension QA

Use this checklist for the final installed-extension pass on real AO3 and
FanFiction.net pages. Do not use `/dev/extension-overlay-preview` or fixture
screenshots as proof for this pass.

## Scope

Test real installed extensions in:

- Chrome or Edge with the unpacked `dist/chrome` extension.
- Safari with the built macOS or iOS Safari Web Extension wrapper.
- Real AO3 pages on `archiveofourown.org`.
- Real FFN pages on `www.fanfiction.net` and `m.fanfiction.net`.

Use a Trace QA account with:

- At least one unknown AO3 work and one unknown FFN work visible in listings.
- At least one known AO3 work and one known FFN work in the library.
- One library work in `Saved` with chapter progress `0` and a known chapter total.
- One hidden-only work preference that is not in the library.
- One account at, or near, the free library cap.
- One signed-out/reconnect scenario.

## Setup

### Build And Load

For a production-origin release build:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://www.tracefiction.com npm run build:release
```

Chrome or Edge:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `dist/chrome`.
5. After code changes, rerun the build and click the extension card's reload
   button in `chrome://extensions`.
6. Reload every AO3/FFN tab under test.

For Google Chrome Stable QA, use the `chrome://extensions` UI path above as
the source of truth. Chrome `148.0.7778.179` ignored command-line unpacked
extension loading during D3e QA with:
`--load-extension is not allowed in Google Chrome, ignoring.` A recorded
extension path in the profile's `Secure Preferences` is not proof that the
runtime is active. Confirm the Trace card appears on `chrome://extensions` and
that either `Inspect views service worker` is listed or
`chrome-extension://<extension-id>/popup.html` opens the Trace popup. Use
Chrome for Testing or Chromium if a repeatable command-line harness is needed.

Safari:

1. Open `Trace.xcodeproj`.
2. Select the macOS or iOS app target and a local signing team.
3. Match the Xcode configuration to the generated origins:
   - Use **Debug** for local, dev, or staging `TRACE_WEB_ORIGIN` and
     `TRACE_API_BASE` values.
   - Use **Release** only with the canonical production origins. The iOS
     Release shell intentionally hardcodes the production web origin even when
     extension resources were generated for dev. Pairing a dev extension with
     a Release app creates incompatible native credentials and is not valid QA.
4. Build and run the app target.
5. Enable the Trace extension in Safari Settings -> Extensions. On iOS, use
   Settings -> Apps -> Safari -> Extensions when available, or Settings ->
   Safari -> Extensions on older versions. Turn on **Allow Extension**.
6. On iOS Safari, under **Permissions**, set **Other Websites** to **Allow**
   (not Ask or Deny), or set every listed AO3/FFN site to Allow individually.
   The configured Trace web origin is not an iOS credential provider; iOS
   connection requires app sign-in followed by a scoped app-issued handoff or
   an explicit extension Connect action.
7. After code changes, rebuild/rerun the app target, then disable/enable the
   Safari extension if Safari keeps an old copy.
8. Reload every AO3/FFN tab under test.

### iOS App Handoff And Receipt

On a clean TestFlight/internal-distribution install, sign in in the Trace app
and complete both settings above. The app-issued handoff is the explicit
authorization to connect and save the matching first story; it should complete
without another click in Safari. Then test all three paths:

1. Paste a direct AO3 or FFN story URL. Pass: the app reports success only
   after the matching Safari handoff reaches the story and the save confirms.
2. Use **Open AO3**, choose a story, then return to the app. Pass: the browse
   handoff stays neutral until a story opens, then saves once, scrolls to and
   focuses the normal clickable Trace story control, and does not treat AO3
   home as a successful run.
3. Change the archive permission to Ask or Deny and retry. Pass: recovery says
   Trace did not confirm a run, repeats both settings, and offers the aA route;
   it must not claim a missing heartbeat proves permission was denied.

### Page Refresh

Chrome or Edge:

- Use `Cmd+Shift+R` on macOS or `Ctrl+Shift+R` on Windows/Linux.
- If behavior looks stale, close and reopen the AO3/FFN tab after reloading the
  extension.

Safari:

- Use `Option+Cmd+R` where available.
- If behavior looks stale, enable the Develop menu and use `Develop -> Empty
  Caches`, then reload the page.
- On iOS, close the tab and reopen the page after rebuilding.

### Required Production API

Hide depends on the production API accepting:

- `POST /api/extension/work-preferences`
- Authenticated body: `{ "key": "ao3:<id>|ffn:<id>", "hidden": true|false }`
- Backing persistence for hidden work preferences.
- Overlay cache refresh returning hidden-only preferences for works that are not
  library entries.

This endpoint must be live before release QA can pass. Hide must not require a
library entry.

Reading status mutation depends on:

- `PATCH /api/library/:entryId`
- Canonical status values: `SAVED`, `READING`, `CAUGHT_UP`, `PAUSED`,
  `FINISHED`, `DROPPED`
- Optional chapter progress payload for Saved -> Reading:
  `{ "progress": { "unit": "CHAPTER", "value": 1, "total": number|null } }`

## Pass/Fail Criteria

Pass only if all apply:

- Native AO3/FFN content stays readable and aligned.
- Inline controls are quiet and do not compete with host page chrome.
- Add saves immediately and never opens the full management surface by default.
- Existing status/lens opens the management surface.
- Management surfaces are not clipped and all actions are reachable.
- Hide collapses the row to `Hidden by Trace | Undo`.
- Undo restores the work in place without requiring a page refresh.
- Status changes persist after hard refresh.
- Saved -> Reading from `0` persists/displays `1/N` or `1/?`, never `0/N`.
- Signed-out, reconnect, free-cap, and password-page guards still behave.

Fail if any apply:

- Trace UI appears under AO3 title/author on listing pages.
- Unknown signed-in works expose Add but not Hide.
- Hidden rows remain full-size with only a hidden badge.
- Management surface has a redundant TRACE bubble/header brand.
- Status choices include alternate labels such as `Later` or `Read`.
- Any password/login page shows Trace overlay UI.
- Any action shows success before the server confirms it.

## AO3 Listing Desktop

Use a normal desktop viewport on an AO3 works listing.

- Unknown work Add:
  - Find a work not in the Trace library.
  - Verify `+ Add` appears near the date metadata, not under title/author.
  - Click `+ Add`.
  - Pass: row updates inline to `Saved`; no full management surface
    opens.

- Unknown work Hide:
  - Find a different unknown work.
  - Verify both `+ Add` and `HIDE` are visible.
  - Click `HIDE`.
  - Pass: row collapses to `Hidden by Trace | Undo`.
  - Click `Undo`.
  - Pass: original row is restored in place with Add/Hide available again.

- Known work lens:
  - Find a known library work.
  - Pass: lens is directly below the AO3 updated/date value and preserves the
    native date text/alignment.

- Management surface:
  - Click the known work lens.
  - Pass: surface opens near the lens, is not clipped, and has no green TRACE
    bubble.
  - Verify visible actions: reading status choices, progress display,
    Hide/Unhide, Open in Trace.

- Status changes:
  - Change status through `Saved`, `Reading`, `Caught up`, `Paused`,
    `Finished`, `Dropped`.
  - Hard-refresh after each or at the end.
  - Pass: latest status persists and no `Reading | 0/N` display appears.

- Hidden collapse:
  - From the management surface, click `HIDE`.
  - Pass: listing row collapses to `Hidden by Trace | Undo`.
  - Click `Undo`.
  - Pass: row restores in place.

## AO3 Listing Mobile

Use Chrome device emulation and at least one real mobile Safari/iOS pass if
available.

- Date/metadata placement:
  - Open an AO3 listing at a narrow viewport.
  - Pass: lens/Add/Hide remains associated with the date metadata and not title
    or author.

- Add/Hide accessibility:
  - Verify `+ Add` and `HIDE` are reachable without horizontal scrolling.
  - Pass: tap targets are usable and do not overlap AO3 links.

- Management surface layout:
  - Tap an existing lens.
  - Pass: sheet/surface fits the viewport, can be dismissed, and status/actions
    are reachable without being obscured by browser bottom UI.

## AO3 Story Page

- Add quick action:
  - Open an AO3 story not in the library.
  - Click/tap Add.
  - Pass: Add saves immediately and does not open the full sheet.

- Existing status opens sheet:
  - Open an AO3 story already in the library.
  - Click/tap the Trace handle.
  - Pass: sheet opens with compact header, progress, status choices, and Open in
    Trace.

- Status change:
  - Change status to each exact Trace status.
  - Hard-refresh.
  - Pass: last status persists.

- Saved -> Reading progress:
  - Use a work seeded as `Saved` with chapter progress `0`.
  - Change to `Reading`.
  - Pass: display becomes `Reading | 1/N` or `Reading | 1/?`; server state
    persists chapter `1` after refresh.

- Bottom viewport:
  - On mobile, open the sheet near the bottom browser UI.
  - Pass: status choices and Open in Trace are reachable and not hidden under
    Safari/Chrome controls.

## FFN Listing Desktop And Mobile

Use both `www.fanfiction.net` and `m.fanfiction.net` listing pages.

- Title-line preservation:
  - Pass: Trace controls never split or disrupt the FFN story title/author line.

- Add/Hide:
  - Unknown signed-in works show both Add and Hide.
  - Add saves inline without opening management.
  - Hide collapses to `Hidden by Trace | Undo`.

- Known status lens:
  - Known works show a compact status/progress lens near FFN metadata.
  - Pass: native FFN metadata remains readable and aligned.

- Management surface:
  - Open the known lens.
  - Pass: surface is useful, not clipped, includes full status choices,
    progress, Hide/Unhide, and Open in Trace.

## FFN Story Page

- Story handle placement:
  - Open desktop and mobile FFN story pages.
  - Pass: Trace handle appears near the story metadata/header and does not break
    FFN title or controls.

- Sheet layout:
  - Open the sheet from an existing status.
  - Pass: compact header, progress, full statuses, and actions are visible.

- Status changes:
  - Change through all six statuses.
  - Hard-refresh.
  - Pass: last status persists and display remains accurate.

## Auth, Limits, And Guards

- Signed out:
  - Clear/revoke Trace auth or use a fresh browser profile.
  - Open AO3/FFN listing and story pages.
  - Pass: no Add/Hide actions appear; reconnect guidance appears where expected.

- Reconnect:
  - Use an expired token/session.
  - Pass: actions show reconnect/session-expired behavior and do not claim
    success.

- Free cap:
  - Use a free account at the library limit.
  - Try Add on an unknown work.
  - Pass: UI shows library-full/free-limit state and does not show the work as
    saved.

- Password/login pages:
  - Visit AO3 login/signup/password reset pages and FFN login/signup pages.
  - Pass: no Trace overlay, Add, Hide, lens, story handle, or sheet appears.

- Extension popup:
  - Signed out: tells the user to open/sign in to Trace in the same browser,
    then return to an AO3/FFN story page. It must not imply AO3/FFN
    credentials are needed.
  - Connected, no local first-save signal, not on a supported archive page:
    points to AO3 and FFN as the next step instead of generic help.
  - Connected, no local first-save signal, on a supported AO3/FFN story page:
    makes `+ ADD` or page import the obvious first-story action.
  - Connected after a successful quick add/track or account library count:
    shows compact connected state, current toggles, and the Library/import path
    where applicable.
  - Reconnect/error: shows recovery/error state.
  - iOS Safari popup help, where shown: names both enabling the Safari
    extension and allowing it on Trace, AO3, and FFN.
  - Pass: popup state matches auth/page context and controls are not
    misleading.

## Screenshots To Capture

Capture PNG screenshots for the release QA record:

- Chrome AO3 listing desktop: unknown Add/Hide visible.
- Chrome AO3 listing desktop: hidden collapsed row with Undo.
- Chrome AO3 listing desktop: known lens under date.
- Chrome AO3 listing desktop: opened management surface with all statuses.
- Chrome AO3 listing mobile: date/metadata placement.
- Chrome AO3 story page: quick Add after success.
- Chrome AO3 story page: opened sheet.
- Chrome AO3 story page: Saved -> Reading result showing `1/N` or `1/?`.
- Chrome FFN listing desktop and mobile: title line intact with Trace controls.
- Chrome FFN story page: opened sheet.
- Safari AO3 listing: placement and management surface.
- Safari AO3 story: sheet bottom viewport.
- Safari FFN listing/story: placement and sheet.
- Signed-out/reconnect popup.
- Free-cap Add failure.
- Password/login page with no Trace UI.

Include browser, viewport, account type, page URL, and build SHA/version in the
filename or notes.

## Known Fixture Limitations

Automated fixture screenshots are useful for fast iteration, but they do not
prove release readiness because:

- They run injected scripts, not the installed Chrome/Safari extension.
- They use static AO3/FFN snapshots, not live host CSS, ads, browser chrome,
  responsive breakpoints, or current DOM changes.
- They mock Trace auth/API responses.
- They cannot prove production API migrations, rate limits, auth expiry, or free
  cap behavior.
- They do not cover Safari extension packaging, permission prompts, app wrapper
  behavior, or iOS bottom browser UI.

## Release Blockers Not Resolved By Fixtures

- Production `POST /api/extension/work-preferences` unavailable or missing its
  persistence/migration.
- Production `PATCH /api/library/:entryId` rejects the five exact statuses or
  chapter progress payload.
- Installed Chrome or Safari extension does not inject on real AO3/FFN pages.
- Safari packaging/build uses stale resources after code changes.
- AO3 or FFN live DOM causes title/date/metadata placement regressions.
- Mobile browser chrome clips management sheets or hides actions.
- Signed-out/reconnect/free-cap states differ from mocked fixture behavior.
- Password/login page guard fails on real AO3/FFN auth pages.

## Final-Chapter Lifecycle Release Gate

This matrix is mandatory for every release that changes collector, background,
projection, auto-track, status, or finish-qualification code. Automated DOM and
kernel tests are necessary but do not replace the signed iOS run.

Use disposable public test works or QA fixtures and record the before/after
Trace status. Do not capture private notes, tags, account identifiers, or story
text in evidence.

- AO3 complete multi-chapter work, normal chapter view:
  - Begin on the penultimate chapter in `Reading` and advance normally.
  - Pass: progress advances, crossing the final chapter end marks `Finished`,
    and refresh shows the same authoritative status.
- AO3 ongoing multi-chapter work, normal chapter view:
  - Pass: crossing the last posted chapter end marks `Caught up`, not
    `Finished`, and the work-status display remains ongoing rather than unknown.
- AO3 one-chapter work:
  - Pass: opening an initially short/fully visible page does not finish it.
  - Interact with the story, satisfy the visible dwell, and cross/reach its end.
    Pass: the authoritative status becomes `Finished` or `Caught up` according
    to source state.
- AO3 Entire Work (`view_full_work=true`):
  - Pass: opening or restoring the page does not immediately finish it and does
    not infer final-chapter progress merely because every chapter is rendered.
    A newly saved work may intentionally remain at the safe chapter-1 baseline
    until the reader provides end-of-work evidence.
  - Read/scroll through the rendered chapters to the final work end. Pass: only
    that crossing qualifies the exact published chapter count.
- AO3 deep links and restoration:
  - Open `#comments`, `#work_endnotes`, and another target below the story.
    Pass: none auto-finishes a story that began above the viewport.
  - Restore a genuinely read final-chapter position. Pass only when the
    extension has explicit restoration/reading evidence; initial geometry
    alone is not accepted.
- Unknown source state:
  - Pass: the qualification band remains available after a suspended worker,
    source-resolution failure, or temporary network failure and exposes a
    retry/Open Trace recovery path instead of disappearing.
- Retry and ordering:
  - Force one response-loss/retry after a finish write. Pass: there is one
    lifecycle/history transition and the acknowledgement reconciles.
  - Finish, change the entry back to `Reading` as a reread, then reach the same
    final chapter again. Pass: the new intent can finish while the old receipt
    cannot overwrite a later status.
- Projection and account fencing:
  - Finish a work, then make a newer manual status change. Pass: the newer
    account projection wins immediately and after refresh.
  - Disconnect account A and connect account B where the work is absent. Pass:
    no entry status, notes, tags, rating, or saved state from A appears for B.
- FFN desktop/mobile:
  - Repeat complete/ongoing-or-unknown final-chapter behavior on both desktop
    and mobile hosts. Pass: no initial-load false finish and failure recovery is
    visible.
- Cold/suspended iOS worker:
  - With Safari cold, open a final chapter and complete it; repeat after the app
    has been suspended. Pass: credential hydration succeeds before the command,
    authoritative projection updates, and reconnect guidance is truthful on a
    real credential failure.

For the release record capture: extension version/build SHA, API deployment
SHA, migration version, device model, iOS version, Safari extension permission
state, account type, scenario result, resulting Trace status, Admin finish
funnel counts, and any Sentry issue. A signed TestFlight/internal-distribution
physical-device pass is a hard gate; simulator or source-injected pages cannot
waive it.
