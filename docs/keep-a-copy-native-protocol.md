# Keep a Copy: Safari hand-off to the Trace app

Safari has no downloads API. On iPhone, iPad and Mac the Trace app downloads
public AO3 works itself, keeps every file, and owns the queue. The Safari
extension reads only the works the app asks it to:

1. **locked** works (AO3 shows them to signed-in readers only), and
2. works AO3 **refused** the app (a 403, a check page, a sign-in page).

It reads them in the reader's own AO3 tab and hands each file to the app in
parts over `browser.runtime.sendNativeMessage`.
The extension side is `src/extension-runtime/keep-a-copy-native.mts` (protocol
and queue ports) and `keep-a-copy-tab.mts` (the requests made in the tab). It
is compiled in only with `TRACE_KEEP_A_COPY=1`.

## Rules the extension keeps

- One request to AO3 at a time, with the queue's own pace and stop rules
  (`keep-a-copy.mts`): 6 to 7 s apart for `pace: "reader"`, 30 s apart and at
  most 30 in six hours for `pace: "check"`; a check page, 403 or 418 stops the
  queue for an hour or more.
- Work and chapter pages are never read signed in.
- A public work's page is read first, in the tab, signed out
  (`credentials: "omit"`), and its file is fetched, signed out, only from the
  Download link on that page, in the same step. No link is taken from the
  app or kept.
- A locked work (its signed-out read lands on the sign-in page with
  `restricted=true`) is read from its Chapter Index (`/works/<id>/navigate`)
  with the tab's sign-in, and its file is copied only right after that read
  for that work, in the same step, when the read is that work's Chapter
  Index shown to the signed-in reader. A request with the tab's sign-in
  follows no redirect. A sign-in page, a redirect, or the index shown
  signed out, is reported `needs_sign_in`.
- A locked work's `updatedAt` is a locked version: its latest chapter's date
  (seconds since 1970) plus its chapter count, plus 100,000,000,000, so it
  has twelve digits and is never confused with a Download link's
  `updated_at`. Compare a locked version only with another locked version.
- Only a real file is handed over: an EPUB must open as one. At most 50 MiB.
- It works only in the tab the reader is on, while that tab is on AO3; no
  other tab is looked up. Nothing runs, and the app is not asked, otherwise.
  A work's page and its file come from the same tab in the same step; if the
  reader has left that tab, the step ends and no other tab is used. A file is
  handed over only from the tab that fetched it.
- The file stays a Blob in the reader's tab, built from the response as it
  arrives and hashed as it goes, so the tab never holds it twice. The
  background reads one part, encodes it as base64, sends it, and drops it. A
  whole file is never held as base64, nor in the background.
- The queue and the open transfer are kept in the extension's IndexedDB.

## Messages

Every message carries `type` and `protocolVersion: 1`, and is answered by one
JSON object. The extension waits 5 s for an answer; no answer is treated as
"not received", never as a refusal. All identifiers are as below; anything
else in an answer makes the extension treat it as no answer.

| Message | Fields sent | Answer |
| --- | --- | --- |
| `KEEP_COPY_QUEUE_GET` | `waiting` (works queued here), `stopped` (`{code, until}` or null) | `{ok: true, enabled, format?, works: [...], stoppedUntil?, stopReason?}` |
| `KEEP_COPY_BEGIN` | `transferId`, `workId`, `updatedAt`, `format`, `byteLength`, `sha256`, `fileName`, `partBytes`, `partCount` | `{ok: true, transferId, nextIndex}` |
| `KEEP_COPY_PART` | `transferId`, `index`, `base64` | `{ok: true, transferId, nextIndex}` |
| `KEEP_COPY_END` | `transferId` | `{ok: true, transferId, saved: true}` |
| `KEEP_COPY_ABORT` | `transferId`, `reason` | `{ok: true}` |
| `KEEP_COPY_SKIPPED` | `workId`, `code` | `{ok: true}` |
| `KEEP_COPY_AO3_LOCK` | `seconds` (the request's time limit, plus a little) | `{ok: true, granted, until?}` |
| `KEEP_COPY_AO3_UNLOCK` | — | `{ok: true}` |

Any message may be refused with `{ok: false, error: "<short code>"}`.

### One request to AO3 at a time, app and extension together

The app and the extension share one lease on AO3 (`AO3Lease.json`). Each
side takes it before a request and gives it back after: the extension with
`KEEP_COPY_AO3_LOCK` (for at most 330 s) and `KEEP_COPY_AO3_UNLOCK`. While
the app holds it, LOCK answers `granted: false` with `until`; the extension
sends nothing and waits its turn, as for any busy fetch, which is never a
step toward a stop. No answer is treated as not granted. A lease ends by
itself at its time (and one ending further off than 330 s from now, after
the clock was set back, has ended). Each Safari profile holds the lease as
itself (`extension:<profile>`), and UNLOCK frees only its own. While Keep a
Copy is off the lease is nobody's. An app that answers LOCK as an unknown
message (`unknown_message_type`) is older than the lease: the extension turns
Keep a Copy off, says so once, and asks no more.

### Off

While Keep a Copy is off in the app, BEGIN, PART and LOCK are refused with
`error: "disabled"`, and END discards the transfer with the same error. The
extension takes `disabled` as `enabled: false` at once: nothing more is
fetched and its list is dropped.

### Queue

`KEEP_COPY_QUEUE_GET` is sent when the reader opens an AO3 page, at most every
five minutes. The answer:

- `enabled`: the app's Keep a Copy switch. `false` empties the extension's
  queue; nothing is fetched.
- `format`: `epub`, the default and the only format handed over; any other
  value makes the answer malformed.
- `works`: at most 100 of `{workId, reason, have?, pace?}`:
  - `workId`: AO3 work id, decimal, no leading zero.
  - `reason`: `"locked"` or `"refused"`.
  - `have`: the `updated_at` of the copy the app holds (the number in the
    Download link's `?updated_at=`), or null. When it matches what the work's
    page shows, only the page is read and no file is fetched.
  - `pace`: `"reader"` for work the reader just asked for, otherwise
    `"check"` (the default). The extension honours `"reader"` only for the
    work open in the reader's tab; every other ask goes at the `"check"`
    pace, under its cap of 30 reads in six hours.

- `stoppedUntil`, `stopReason`: AO3's stop on this device (ms since 1970,
  and one of the stop codes), when the app met one or the extension
  reported one. Only AO3's own answers are shared (`challenge`, `forbidden`,
  `slow_down`, `wrong_host`), never this device's trouble (`save_failed`,
  `unreadable`). There is one stop for both: the extension reads nothing
  from AO3 until it is over (`KeepACopy.holdUntil`, at most a day), and the
  `stopped` it sends here is kept by the app the same way. An unknown
  `stopReason` still stops. A work AO3 refused the app during a stop is
  listed only once the stop is over.

Before the app has written a list (Keep a Copy never on), and whenever it is
off, the answer is `{ok: true, enabled: false, works: []}`.

The list replaces the extension's queue: a work no longer listed is dropped,
unless its file is being handed over. A malformed answer changes nothing.
A work the extension settled for the same `have` within the last 24 hours
(skipped, or found unchanged) is not read again unless it goes at the
reader's pace.

### Transfer

Every message may arrive more than once (the extension retries a message
with no answer). The app must answer a repeat the same way:

- Any message for a `transferId` it has already completed (END answered
  `saved: true`) is answered `{ok: true, transferId, saved: true}`; the
  extension takes that as the transfer done.
- A repeated BEGIN for a transfer it holds open is answered with its
  `nextIndex`, as below. A repeated PART is answered, not stored twice.

`partBytes` is 262,144 (256 KiB); `partCount` is `ceil(byteLength / partBytes)`,
at least 1. A part's base64 is at most 349,528 characters, so every message
stays under the app's 512 KiB inbox. `sha256` is the lowercase hex SHA-256 of
the whole file. `fileName` is the name the queue gives a copy,
`Trace/<Fandom>/<Title> – <Author> (<work id>).<format>`; the app may use its own
layout. `transferId` is a lowercase UUID.

1. **BEGIN.** For a new `transferId` the app answers `nextIndex: 0`. For one it
   already holds parts of, it answers the count of parts it holds in order,
   from 0, so the extension carries on from there. `nextIndex` equal to
   `partCount` means it has them all.
2. **PART.** Sent in order from `nextIndex`. The app keeps a part only if
   `index` is the next one it needs, and answers the next index it needs (a
   repeat is answered, not stored twice). The extension goes on from whatever
   index the app answers, so the app may ask for a part again.
3. **END.** The handler checks the byte count and SHA-256 (streamed from
   disk), moves the whole file to the app in one step, remembers the
   `transferId` as completed, and answers `saved: true`: the file is the
   app's. On a mismatch it answers `{ok: false, error: "checksum_mismatch"}`
   and discards the transfer. The app takes the file into its copy when it
   next runs, only if its `updatedAt` is strictly newer than the copy it
   holds; until then, and if it refuses the file, the old copy stays as it
   is. A refused file (not newer, not an EPUB, too large) takes the work off
   the list, so the extension stops fetching it.
4. **ABORT.** The app discards the transfer's parts. Sent when the app
   refuses a message, when the tab lost the file (closed or reloaded), when
   three messages in a row go unanswered, or when a newer transfer replaces an
   unfinished one.

An unanswered message is sent again on the queue's next look, at most three
times in a row. A transfer is given up when the app has acknowledged no new
part for 15 minutes, however long it has taken in all. The extension keeps the open transfer (id, work, digest and
next index) in local storage. After the background is stopped, it sends BEGIN
again with the same `transferId` and continues from the app's `nextIndex`, as
long as the reader's tab still holds the file (ten minutes from the last part
asked for); otherwise it aborts and the work is fetched again later. The app
should discard a transfer with no message for 30 minutes.

A file that cannot be handed over is tried again with a growing wait, three
times in all, then reported with `KEEP_COPY_SKIPPED`.

### Skipped

`KEEP_COPY_SKIPPED` tells the app a work was not copied, so it can stop asking
or tell the reader. `code` is one of:

| Code | Meaning |
| --- | --- |
| `needs_sign_in` | Locked, and its Chapter Index did not show the reader signed in. |
| `gone` | AO3 answered 404 or 410. |
| `no_download` | The page has no Download link for the format, or AO3 sent the download back to the work. |
| `not_a_file` | AO3 answered with something that is not the file. |
| `too_large` | Over 50 MiB. |
| `http_error` | Any other answer from AO3. |
| `save_failed` | The file could not be handed to the app. |
| `failed` | The request failed three times. |

### The handler

`Shared (Extension)/SafariWebExtensionHandler.swift` routes the six messages
to `TraceKeepACopyMailbox.swift`, which the app builds too. Everything is in
the app group `group.com.tracefiction.trace`, folder `KeepACopy/`:

| Path | Written by | What |
| --- | --- | --- |
| `ExtensionQueue.json` | app | `enabled`, `works`, the app's stop |
| `Stop.json` | both | the one AO3 stop; the later one wins |
| `Transfers/<transferId>/` | handler | `transfer.json` and the file so far, appended part by part |
| `Completed.json` | handler | transfers answered `saved: true` (a week) |
| `Received/<workId>-<updatedAt>.epub` | handler | whole files for the app |
| `Skipped/` | handler | `KEEP_COPY_SKIPPED`, one file per report |
| `AO3Lease.json` | both | who may ask AO3 now, and until when |

Every change is made under one `flock` on `mailbox.lock`, so a message and
the app's off switch never interleave. END reads the file's SHA-256 outside
the lock (the transfer is the handler's alone until the move that ends it),
then checks again under it before the move. While off, SKIPPED and
QUEUE_GET's `stopped` write nothing.

The handler never holds a file whole in memory, nor as base64. It refuses a
message over 512 KiB (its JSON included), a part over 349,528 base64
characters or of the wrong length, unknown fields, and a BEGIN for a work the
app doesn't list (`not_listed`). A part is kept only at `nextIndex`, after
the file is cut back to the parts acknowledged. A transfer with no message
for 30 minutes is discarded (a folder under a minute old never is; BEGIN
writes `transfer.json` before the file); a newer BEGIN for the same work replaces an
unfinished one. Refusals: `invalid_request`, `unsupported`, `too_large`,
`not_listed`, `disabled`, `conflict`, `unknown_transfer`, `invalid_part`, `incomplete`,
`checksum_mismatch`, `storage_unavailable`.

## What only a device can confirm

- Safari's `executeScript` into the reader's AO3 tab, and the Blob it keeps
  there across the transfer.
- Whether a request from the tab to a Download link that redirects to
  `download.archiveofourown.org` is answered with the file.
- Time and memory for a 50 MiB file on iPhone.
