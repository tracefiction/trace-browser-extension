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
- One library work in `Planning` with chapter progress `0` and a known chapter total.
- One hidden-only work preference that is not in the library.
- One account at, or near, the free library cap.
- One signed-out/reconnect scenario.

## Setup

### Build And Load

For a production-origin release build:

```bash
TRACE_API_BASE=https://api.tracefiction.com TRACE_WEB_ORIGIN=https://tracefiction.com npm run build:release
```

Chrome or Edge:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `dist/chrome`.
5. After code changes, rerun the build and click the extension card's reload
   button in `chrome://extensions`.
6. Reload every AO3/FFN tab under test.

Safari:

1. Open `Trace.xcodeproj`.
2. Select the macOS or iOS app target and a local signing team.
3. Build and run the app target.
4. Enable the Trace extension in Safari Settings -> Extensions.
5. After code changes, rebuild/rerun the app target, then disable/enable the
   Safari extension if Safari keeps an old copy.
6. Reload every AO3/FFN tab under test.

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
- Status values: `PLANNING`, `READING`, `PAUSED`, `COMPLETED`, `DROPPED`
- Optional chapter progress payload for Planning -> Reading:
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
- Planning -> Reading from `0` persists/displays `1/N` or `1/?`, never `0/N`.
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
  - Pass: row updates inline to saved/planning state; no full management surface
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
  - Change status through `Planning`, `Reading`, `Paused`, `Finished`,
    `Dropped`.
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

- Planning -> Reading progress:
  - Use a work seeded as `Planning` with chapter progress `0`.
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
  - Change through all five statuses.
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
  - Connected account: shows connected state and current toggles.
  - Signed out: shows connection guidance.
  - Reconnect/error: shows recovery/error state.
  - Pass: popup state matches auth state and controls are not misleading.

## Screenshots To Capture

Capture PNG screenshots for the release QA record:

- Chrome AO3 listing desktop: unknown Add/Hide visible.
- Chrome AO3 listing desktop: hidden collapsed row with Undo.
- Chrome AO3 listing desktop: known lens under date.
- Chrome AO3 listing desktop: opened management surface with all statuses.
- Chrome AO3 listing mobile: date/metadata placement.
- Chrome AO3 story page: quick Add after success.
- Chrome AO3 story page: opened sheet.
- Chrome AO3 story page: Planning -> Reading result showing `1/N` or `1/?`.
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
