# Paired native History handoff

Import your whole AO3 History reads every History page in the reader's AO3
tab and keeps the works on the device (`src/extension-runtime/ao3-history-import.mts`).
**Review in Trace** hands them to the Trace app, which shows the review and
imports the stories the reader chooses. This is that handoff.

It is the import handoff's sibling ([native-import-handoff.md](native-import-handoff.md))
with the same gates and fences, for a payload far larger than one page: a
History can hold thousands of works, so it travels in parts. The import
handoff is unchanged.

## Gates

The same paired package as native Import: the kernel worker generated with
`TRACE_NATIVE_IMPORT_CONTRACT=trace-native-library-import-v1`, the iOS
extension compiled with `TRACE_NATIVE_IMPORT_HANDOFF`, and the immutable
Info.plist values `TraceNativeImportContract` and `TraceNativeImportAPIOrigin`.
Without them the handler answers `unsupported`. Only iOS hands over; the
controller refuses on a desktop or unknown platform.

Only the sheet's **Review in Trace** starts it, through the History runtime
and the controller's `handOffHistory`, which synchronizes the native provider
and captures the account scope exactly as native Import does. The sheet and
pages never see an account identifier, provider record or credential.

## Messages

All use `protocolVersion: 1` and canonical lowercase UUIDs.

| Message type | Exact additional fields | Success state |
| --- | --- | --- |
| `TRACE_IOS_HISTORY_PREPARE` | `requestID`, `requestIssuedAtMs`, `accountID`, `accountEpoch`, `apiOrigin`, `partCount`, `byteCount`, `itemCount`, `sha256` | `prepared`, `handoffID`, `expiresAtMs`, `receivedParts:0`, `maximumPartBytes:393216`, `maximumParts:128`, `maximumItems:25000` |
| `TRACE_IOS_HISTORY_STAGE` | `requestID`, `handoffID`, `partIndex`, `partBase64` | `staging`, then `ready_to_open` once every part is in, with `receivedParts` |
| `TRACE_IOS_HISTORY_CANCEL` | `requestID`, `handoffID` | `cancelled` |

PREPARE declares the whole History: how many parts, their total bytes, the
works they hold and the SHA-256 of the parts concatenated in order. A part is
standard Base64 of one UTF-8 JSON document `{s:"ao3-history", at, items}` of
at most 393,216 bytes and 1,000 items, each an AO3 listing item
(`src:"ao3"`, `ctx:"listing"`, `u` an `https://archiveofourown.org/works/<id>`
address, a title `t`, and the History fields `lv` (day), `vc` (visits) or
`ml:true` (marked for later, never with `lv`)). The inbox checks each part as
it arrives. Parts may arrive in any order; the same part again is accepted,
other bytes for it conflict. When the last part is in, the parts must add up
to the declared bytes, works and digest, or the History is ended and its
parts removed.

The producer sends each message at most twice with the same identity and
bytes, rechecks the account scope before each, and cancels its own
reservation when anything fails or the account changes. A History staged for
an account that then left is cancelled too.

## Inbox and consumer

`TraceSafariHistoryInbox(containerURL:)` keeps `TraceNativeHistoryInboxV1/state.json`
(one entry, at most 64 tombstones) and the entry's part files beside it, in the
shared `group.com.tracefiction.trace` container, under `NSFileCoordinator`,
with complete file protection and backup exclusion. A History lasts 30
minutes from PREPARE. Expiry, cancel, claim and purge remove its parts; part
files no entry owns are removed on the next coordinated write.

The app consumes it as it does an import:

- `peek(handoffID:now:)` returns the binding and work count of a staged History, never bytes.
- `claim(handoffID:expecting:now:currentProviderBinding:)` checks the account,
  epoch, origin, profile and current provider, reads every part and checks it
  against its recorded digest and the whole against the declared digest,
  consumes the History once, and returns the parts in order.
- `captureCleanup` and `purge` follow the import inbox's account-departure rules.

The popup shows **Open in Trace** only after `ready_to_open`, and a fresh tap
opens:

```
traceauth://open?destination=history-import&handoff=<canonical-lowercase-UUID>
```

## On a computer

There is no app, so Review in Trace offers the History to Trace's review page
instead (`src/extension-runtime/web-history-handoff.mts`) and the sheet opens
`<web origin>/import/history#handoff=<uuid>`. The page asks for the
declaration and then each part through `sync.js`:

- page → `sync.js`: `TRACE_WEB_HISTORY_REQUEST {requestId, handoffID, part}`,
  where `part` is `"declaration"` or a part index; `TRACE_WEB_HISTORY_RECEIVED
  {requestId, handoffID}` once every part is kept.
- `sync.js` → page: `TRACE_WEB_HISTORY_RESPONSE {requestId, answer}`.
- The declaration carries the account id, part count, bytes, items, the
  SHA-256 of the whole and the expiry; a part is the same JSON text as an
  inbox part.

The background answers only a content script on Trace's own site, only for
the account that started the handoff, only before it expires (30 minutes),
and not after `RECEIVED`. Nothing is sent to Trace's server until
the reader imports. A package that doesn't run on Trace's site offers nothing.

## Tests

- `npm run test:swift-history-inbox`: the inbox contract (declarations,
  parts in any order and twice, conflicts, the whole checked at the end, claim
  once in order, account, profile and provider fences, cancel, expiry and
  departure removing parts).
- `test/extension-runtime/native-history-handoff.test.mjs`: items, parts and
  digest, the producer's order, checks and cancellation.
- `test/extension-runtime/ao3-history-import*.test.mjs`: Review in Trace in the
  runtime and the sheet, on iPhone and on a computer.
- `test/extension-runtime/web-history-handoff.test.mjs` and `test/sync.test.js`:
  the computer handoff and its relay.
