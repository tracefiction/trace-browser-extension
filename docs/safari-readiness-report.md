# Safari readiness report

On iPhone and iPad, the extension's background tells the Trace app beside it
whether Trace in Safari is ready to save by itself. This document is the
contract between the two: the messages, the stored records, and what each
value means.

The report sits beside the run receipt, the permission snapshot, the
automatic-saving preference and the save confirmation. It uses the same
native-message transport and the same provider binding, and changes none of
them. Nothing in it is sent to a server.

## What it says, and what it never says

Four things are answered separately. Each is `positive`, `blocker` (known to
be in the way) or `unknown`, with a reason and the time it was read.

| Component | `positive` | `blocker` | `unknown` |
| --- | --- | --- | --- |
| `websiteAccess` | `allowed`: every story site read as allowed just now | `not_allowed`, `partly_allowed`: read as incomplete twice, two seconds apart, with Safari listing what is allowed both times | `unreadable`: Safari did not answer. `unconfirmed`: read as incomplete without those two agreeing readings |
| `scriptRegistration` | `registered`: every page script present, registered by this build's generation. `declared`: a build that declares its page scripts in its manifest | `not_registered`: a registration that has finished found them not in, or two readings two seconds apart both found them absent with no registration under way. `registration_failed`: the story sites are allowed and a registration that has finished failed | `pending`: a registration is under way, or has not finished in six seconds. `unconfirmed`: read as absent without that confirmation. `unreadable` |
| `account` | `connected`: the extension is using the provider the app issued, and Trace's service accepted it when the extension took it up. It is not checked with the service again for each report | `no_account`, `reconnect_required` (the service has since refused it) | `pending`, `unreachable`, `changed` (the account changed while the report was read), `mismatch` (the account in use is not the one the app's cycle is for) |
| `automaticSaving` | `on`: read as on, or absent after a successful read | `off` | `unreadable` |

The result:

- `ready`: all four positive, read in one cycle under one account session.
  It says these four things held when they were read. It is not a check that
  a save will go through.
- `not_ready`: at least one blocker. Every blocker stays on the report.
- `unknown`: anything else. A report whose account is `changed` is `unknown`
  whatever else it found.

`unknown` is never rounded to either side. A missing report is `unknown`.

A report never says how long the reader's website access lasts (Safari
reports a one-day grant and a lasting one the same way), that a story was
saved, that the next save will work, that a page already open was taken over,
or anything about Private Browsing. It holds no credential, address, story or
page data: only the fields below.

`no_account` is worked out but cannot be delivered, because a report is bound
to a provider and there is none. The app knows it issued none.

The moment after the reader allows the story sites is never reported as "no
scripts". A report set off by a grant waits for the registration the grant
sets off; if that outlasts the wait, the scripts are `pending`, and another
report follows when it ends.

The fields of each registered script are not compared with the build's. Only
their ids and the generation recorded when they were registered are.

## A cycle

The app opens a cycle before it sends the reader to Safari. The extension
answers; the app reads the answer to its own cycle.

1. **The app** calls `TraceSafariReadinessReport.startCycle(defaults:accountID:apiOrigin:provider:now:)`.
   It writes `traceSafariReadinessCycleV1` to the shared container: a new
   UUID, the account, the API origin, the provider binding and the start
   time. A report already stored answers an earlier cycle and becomes
   history.
2. **The extension** sends `TRACE_IOS_SAFARI_READINESS_PREPARE` with its API
   origin. The handler replies with the provider binding it reads now and,
   if a cycle is open for that provider and origin, the cycle's id and
   account. With no provider the reply is `{ "ok": false }` and the extension
   reads and sends nothing.
3. The extension reads the four components.
4. The extension sends `TRACE_IOS_SAFARI_READINESS_REPORT` carrying the
   provider and cycle id exactly as it was given them.
5. **The handler** stores the report under `traceSafariReadinessReportV1`
   only if the provider is still the one it reads now, the API origin is the
   paired one, the result follows from the components, no time is in the
   future or (with a cycle open) before the cycle began, and the cycle id is
   the one open now. If the app has opened another cycle since, it replies
   `{ "ok": false, "error": "stale_cycle" }` and the extension reads again.
6. **The app** calls `TraceSafariReadinessReport.state(defaults:cycle:provider:now:)`:
   - `.answered(report)`: the report answers that cycle, for that provider,
     origin and account.
   - `.waiting`: the cycle is open and unanswered. This is `unknown`.
   - `.ended(reason)`: the cycle is no longer open and no answer will come.
     **Open a new cycle.**

   `read(...)` is the same lookup returning the report or nil.

### When a cycle ends

A cycle belongs to the provider it was opened under. It ends when:

- **the provider changes** (`provider_changed`): the app replaced or
  refreshed the credential it issued to Safari. The provider record names no
  account, so the handler cannot tell a refresh for the same account from
  another account's provider, and a cycle is not carried across. The handler
  also records the end under `traceSafariReadinessCycleEndedV1` the next time
  the extension asks. An app that refreshes its provider must open a new
  cycle afterwards if it still wants an answer;
- **the app opens another cycle** (`replaced`);
- **no cycle is stored** (`missing`).

After a cycle ends, reports are still stored, with no `cycleID`. They are
history.

### What a report's age means

Nothing expires by age on the extension's side, and no time-to-live is
defined here. A report says what held at `observedAt`. The app decides what
that is worth.

- **Access can end with no event.** A grant for one day runs out and Safari
  tells no one, so a stored `ready` can outlive the access it describes. The
  extension reads again when its popup opens, on every change it hears of,
  and about once a day on the alarm the access reading already keeps. If
  Safari does not wake the background for that alarm, the next reading is the
  next event.
- **An app may conclude** from `.answered(report)` that the four things held
  at `report.observedAt`, after the cycle began.
- **An app may not conclude** that they hold now. How old an answer may be
  before the app asks again (by opening a new cycle and sending the reader
  back to Safari) is the app's decision, made from `observedAt`.
- **`latest(...)` is never current.** It reads the last report whatever cycle
  it answered, or none. It is what was observed then. An app must never treat
  it as the answer to a cycle, or show it as the present state.

The extension answers when Trace's popup opens, when Safari reports website
access added or removed, when the page scripts are registered, removed or
fail to register, when the automatic-saving preference changes, when the
account session changes, and about once a day. A background that merely
starts sends nothing.

## Messages

`TRACE_IOS_SAFARI_READINESS_PREPARE`

```json
{ "type": "TRACE_IOS_SAFARI_READINESS_PREPARE", "apiOrigin": "https://api.tracefiction.com" }
```

Reply: `{ "ok": true, "provider": { "sessionID": "…", "recordDigest": "…" }, "cycle": { "id": "…", "accountID": "…" } }`.
`cycle` is absent when none is open.

`TRACE_IOS_SAFARI_READINESS_REPORT`, version 1. A complete example is
[`test/fixtures/safari-readiness-report-v1.json`](../test/fixtures/safari-readiness-report-v1.json);
the extension's tests assert it is what the background sends and the Swift
contract test asserts the codec accepts it.

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `apiOrigin` | The extension's API origin. Must be the handler's paired origin |
| `provider` | The binding from the prepare reply, unchanged |
| `cycleID` | The cycle from the prepare reply. Absent when none was open |
| `accountID` | Present only when `account` is `positive` |
| `observedAt` | When the report was made, epoch milliseconds |
| `result` | `ready`, `not_ready` or `unknown` |
| `components` | `websiteAccess`, `scriptRegistration`, `account`, `automaticSaving`, each `{ answer, reason, observedAt }` |

A reason is a short lowercase token. A reader of the report should act on
`answer` and treat a reason it does not recognise as detail.

## The save confirmation's `mode`

`TRACE_IOS_SAVE_CONFIRMED` may carry `mode`: `bounded_manual` (the reader
opened Trace on the story before the story sites were allowed) or
`normal_automatic` (the sites were allowed and the page scripts registered).
It is absent when the background established neither, which is every save in
a build without the first-tap save. The stored save record gains an optional
`mode`; a reader of that record built before the field decodes it unchanged.
