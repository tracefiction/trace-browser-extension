# Paired native Library Import transport

This transport is disabled in ordinary public packages. Enabling it requires all
of the following in a reviewed containing-app and extension package:

- Generate the kernel worker with `TRACE_NATIVE_IMPORT_CONTRACT=trace-native-library-import-v1`
  and its exact HTTPS `TRACE_API_BASE` (no port, path, credentials, query or fragment).
- Compile the iOS extension with `TRACE_NATIVE_IMPORT_HANDOFF`.
- Include immutable extension Info.plist values `TraceNativeImportContract` equal
  to `trace-native-library-import-v1` and `TraceNativeImportAPIOrigin` equal to that
  generated API origin. Neither value comes from UserDefaults or a message.
- Compile `TraceSafariProviderCodec.swift` and `TraceSafariImportInbox.swift` into
  both participating native targets and implement the containing-app consumer.

The flag selects native Import on iOS. Confirmed desktop platforms preserve the
existing web fragment flow. An opted-in package with unknown platform detection
returns a recoverable Import failure, including a desktop-style iPad user agent
with an absent, failed or unrecognized platform API. A later attempt can retry
unknown detection. A selected native candidate never falls back to web Import
when preparation, collection or staging fails. The handler returns `unsupported`
when the native compile/configuration gate is absent.

## Private producer and native messages

Only the admitted popup Import controller starts this flow. It synchronizes the
native provider, captures the private session capability, then sends PREPARE
before collecting archive data. Same-account provider replacement revokes that
capability even if the public account epoch stays unchanged. Popup and content
surfaces receive no account identifier, provider record, fingerprint or credential.

All messages use `protocolVersion: 1` and canonical lowercase UUID identifiers.

| Message type | Exact additional fields | Success state |
| --- | --- | --- |
| `TRACE_IOS_IMPORT_PREPARE` | `requestID`, `requestIssuedAtMs`, `accountID`, `accountEpoch`, `apiOrigin` | `prepared`, `handoffID`, `expiresAtMs`, `maximumPayloadBytes:524288`, `maximumItems:250` |
| `TRACE_IOS_IMPORT_STAGE` | `requestID`, `handoffID`, `payloadBase64` | `ready_to_open`, same `handoffID` and `expiresAtMs` |
| `TRACE_IOS_IMPORT_CANCEL` | `requestID`, `handoffID` | `cancelled` |

The adapter's alternate native-call signatures retain identical IDs and bytes.
PREPARE and STAGE each allow two transport attempts of at most 2.5 seconds,
checking the initiating capability and lifetime before each attempt. A timeout
retry keeps the original request timestamp, identity and body without collecting
again. The background retains PREPARE ownership before its acknowledgement;
after two ambiguous attempts, a new click must recover that same request under
its original capability and cancel it before reserving a new item. If authority
has departed, it cannot retry PREPARE. A late acknowledgement can still identify
and cancel the abandoned reservation; it never publishes a late continuation.

The background owner cancels its exact prepared item on collection failure or
stale capability, and cancels its earlier unclaimed item on a fresh Import
intent. Cancellation also has two bounded attempts. Unacknowledged cancellation
retains its exact identity until a later cancellation is confirmed, is already
terminal, or expires. An unknown reservation is conservatively retained for at
most twenty minutes from request issue: the request can first arrive near its
ten-minute admission deadline, then the native reservation lasts ten minutes.
A valid PREPARE acknowledgement narrows this to its actual native expiry.
A worker restart can lose that local cancellation identity; an unclaimed
reservation then remains unavailable until its bounded expiry. There is no
wildcard cancellation message or ambient handoff discovery by JavaScript.

STAGE carries standard Base64 of exact UTF-8 JSON `{s,at,items}`, at most 512 KiB,
1–250 items, source-consistent HTTPS AO3/FFN work URLs. The native handler allows
at most 704 KiB for the complete normalized JSON message. There is no compression
or chunking. Additional metadata and private reader choices stay inside the
bounded payload; the native Import DTO performs the consumer's detailed field
validation before review/save.

The popup displays a direct `Open in Trace` anchor only after a valid STAGE ack:

```
traceauth://open?destination=library-import&handoff=<canonical-lowercase-UUID>
```

It requires a fresh user click. `ready_to_open` does not mean the app opened or a
story saved. The link is removed on expiry or observed session refresh/departure.
The containing app must reject stale account/provider binding even when a later
account switch has the same public connected appearance.

## Shared inbox and native consumer seam

`TraceSafariImportInbox(containerURL:)` uses the existing
`group.com.tracefiction.trace` container and one `TraceNativeImportInboxV1.json`
file. `NSFileCoordinator` coordinates every access across processes; mutations
atomically replace the bounded file with complete file protection and backup
exclusion. No `NSFilePresenter`, UserDefaults read/remove pair, app-to-JavaScript
port, credential persistence or private metadata logging is introduced.

The Safari handler obtains the profile UUID exclusively from the platform's
`SFExtensionProfileKey` (or supported legacy userInfo key). Nil remains a distinct
profile value. The handler re-reads the existing v2 shared Keychain provider inside
the coordinated transaction. `TraceSafariProviderCodec.importBinding(session:now:)`
validates its future expiry and returns only `ImportBinding(sessionID,recordDigest)`.
The SHA256 digest covers one shared domain-prefixed JSON-array record; it is an
equality fence, not account authentication.

The inbox holds one prepared/staged entry and at most 64 terminal request/handoff
IDs. It never overwrites another request. Identical retries retain original IDs,
expiry and bytes; changed bytes conflict. Payloads expire after ten minutes. New
PREPARE accepts a request issued within the previous ten minutes, with at most
30 seconds of future clock skew. Tombstones remain through both payload expiry
and the request's replay-admission window (up to 30 seconds longer), so permitted
clock skew cannot revive an already consumed request. Coordination wait time is
included in expiry checks.

Native methods:

- `peek(handoffID:now:) throws -> Pending?` returns staged binding metadata only.
  `Pending` includes handoffID, accountID, accountEpoch, apiOrigin, profileID,
  providerBinding and expiresAt. It does not write the file or expose payload.
- `claim(handoffID:expecting:now:currentProviderBinding:) throws -> Data` consumes
  once before delivering bytes. `Expectation` contains accountID, accountEpoch,
  apiOrigin, profileID and providerBinding. The synchronous `(Date) -> ImportBinding?`
  closure rechecks the native owner's current lease/provider inside coordination.
  The helper rechecks expiry, exact binding, payload bounds, byte count and digest.
- `captureCleanup(accountID:apiOrigin:createdNoLaterThan:now:) throws -> CleanupIdentity?` reads the
  exact account/origin's prepared **or staged** handoff ID without payload or
  file mutation, filtering native `Entry.createdAt` against the caller's cutoff.
  Freeze that cutoff **before the first** sign-out/deletion/account-departure
  cleanup attempt and retain it through failed capture retries. Once an ID is
  captured, retain only that exact ID through purge retries. A no-match leaves a
  later replacement intact. The cutoff uses the native wall clock, never the
  JavaScript request timestamp; this bound is not monotonic across clock rollback.
- `purge(handoffID:now:)` terminally deletes only the exact captured ID. An old
  lifecycle attempt cannot erase a replacement handoff. Do not rediscover an ID
  after lifecycle awaits or use broad invalidation to clean up an old generation.

The containing app owns a positive HTTP 200 `/api/extension/account` account match
with its ready native subject. Ordinary provider recovery verification is not
sufficient. It owns strict typed URL parsing, cold/warm routing, native lease
checks around asynchronous work, draft/pending/uncertain/presentation guards,
final provider checks after claim, review UI and explicit submission. A blocked
ready route must purge the exact request and never queue surprise navigation.
Claim is not a save. A crash after consumption requires a new Import.

Focused checks: `npm run build:core`, `npm run test:swift-import-inbox`, the
`native-import`/`first-story-initiation`/`session-kernel`/popup test files, and
`npm run test:native-import-package`. The package test restores the ordinary
production-origin earned-permission resources; it performs no deployment.

Installed iOS proof is still required for near-limit Safari native-message
transport, file protection in the real app-group container, the fresh direct
link, cold/warm review presentation and account/draft/replay rejection. Local
Swift/JavaScript contracts and source typechecks do not prove those behaviors.
