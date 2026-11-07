# How the extension works, in detail

The README covers what the extension reads and sends. This file is the longer version: how sessions, accounts and saves are kept apart inside the extension, what the Safari build tells the Trace app, and why some generated files are committed. I keep it for anyone who wants to check the details against the code, and for me.

## Where the code keeps things apart

Kernel builds distinguish save-if-absent commands from automatic progress
commands and use the account projection as the sole library read owner.
Story/listing content scripts request only validated work keys visible on the
current supported archive page. Existing-entry status, rating, chapter
progress, finish qualification, and visibility actions use typed kernel
commands bound to the sender host, work key, authoritative entry id, and
current account epoch. Popup import is owned by the same controller: it accepts
only the extension popup, collects a bounded payload from the active supported
archive tab, and opens the configured Trace import page. Desktop first-story
handoff accepts only the configured Trace origin and routes the resulting
story-page save through the existing story-command owner. A missing archive
content script is reported as a site-permission problem instead of a generic
import failure.

Replies to AO3 and FanFiction.net pages carry an opaque account-session token:
the session epoch and a short non-cryptographic hash, compared only for
equality. It names no account and is never stored or sent to a server. A page
that sees it change drops its end-of-story evidence, any pending finish and
its unconfirmed state, then reads the current account before it writes. A
finish signal names the token it was gathered under, and the background
refuses it once another account session is current. When the account changes,
open pages are told to read it again.

Kernel metadata contribution keeps page extraction in the AO3/FFN collector
but moves preference enforcement, authenticated API access, account fencing,
and projection invalidation into one background owner. Story metadata must
match the browser-provided top-frame story sender. Batched listing enrichment
is item-count and byte bounded, and every item must match the sender's archive
host. FFN listing pages select tracked rows through a bounded account-projection
read rather than reading legacy token or overlay-cache keys. The normal release
uses the kernel owner after the parity and installed-browser audit; the legacy
owner is available only through the explicit rollback build.

Kernel builds also retain the existing local-first AO3 saved-filter surface.
Local creates, edits, and deletes remain usable while signed out or offline;
the kernel owns only authenticated synchronization. It validates the AO3
top-frame request, drains upserts and tombstones in bounded batches, applies the
server's last-write-wins timestamps without overwriting a newer dirty local
edit, and serializes remote merges against account transitions. A periodic
pull preserves cross-device updates. The content script receives no Trace
credential or account identifier, and disabled builds omit the surface and
remove its local data.

The kernel Trace-page bridge accepts status and first-story requests only from
the exact configured Trace origin and opens only same-origin Trace URLs
requested by supported archive content scripts. Status responses and pushes
contain coarse session and onboarding evidence only: booleans, enums, epoch
timestamps, and a browser kind. They do not expose credentials, account ids,
story ids, URLs, titles, private library fields, or raw errors. Archive
readiness records are serialized in local storage, and a successful action
clears an older coarse issue. Disabled builds inject no content scripts and
delete both private kernel state and extension-local feature/readiness state.
On desktop first install, the activation page's authenticated status handshake
and token-free activation-readiness signal cause one explicit kernel Connect or
Reconnect action; they do not restore the legacy ambient-token path.

On desktop browsers, Connect in an archive page's notice, story sheet, or
listing controls runs the same kernel action as the popup's Connect. If no
signed-in Trace page answers, the extension opens the Trace website and stores
a content-free connect request (an expiry time only, at most 30 minutes) in
extension storage; first install stores the same request. While it is pending,
a Trace page that shows it is signed in triggers one Connect through the
normal request-ID credential grant. `sync.js` learns this by asking the page
once on load for its token and sending the background a token-free hint when
the page posts it; the posted token itself is never forwarded or accepted.
Disconnect withdraws the request. After a connection change the background
bumps the content-free projection revision, so open archive pages update
without a reload. iPhone and iPad keep linking the extension through the Trace
app.

are both required before app onboarding completes. Refusal, expiry, or partial
coverage saves nothing and returns to permission recovery; no toolbar-only mode
is treated as complete. The build stores at most 32 coarse event-name/timestamp
pairs locally for device diagnosis and sends none of that funnel to Trace.

The modular kernel keeps its session envelope, extension-owned credential map,
and account-private read model in one IndexedDB database owned by the extension
origin. AO3/FFN content scripts run against the visited page's origin and
cannot open that database; they receive only bounded values through validated
extension messages. Installation preferences and non-private origin metadata
may remain in extension local storage.

The modular story-command boundary accepts only a bounded story-page payload
whose work identity matches the browser-provided top-frame AO3/FFN sender. Raw
Trace credentials stay inside the authenticated background API adapter. A
kernel build publishes an iOS save receipt only after the Trace API returns an
authoritative entry for that exact work (or an account-scoped overlay lookup
reconciles an uncertain request). A network timeout is never retried as another
write without that reconciliation, and connection alone is not presented as a
saved story.

Automatic tracking is a separate progress command that goes directly to the
server's monotonic update and requires its authoritative chapter confirmation.
An uncertain request is reconciled against the account projection before Trace
can report the target as saved. Progress commands do not emit manual first-save
heartbeats or clear first-story handoffs. During an opt-in native setup attempt,
their exact confirmed entry also participates in the local handover described
below. On iOS, the command first re-adopts the
containing app's current account so restored extension state cannot write to a
stale account.

Account projection reads are account-and-epoch scoped in extension-owned
IndexedDB. Archive content scripts may request at most a bounded set of
canonical work keys for their browser-provided AO3/FFN host, and receive only
those copied entry/preference records plus coarse session state. Requests from
credential paths, subframes, mismatched hosts, or invalid work keys fail closed.
The popup receives only coarse session state, summary booleans/counts, active
tab classification, and non-private local preferences; it never receives an
account identifier or credential.

Kernel library mutations accept only bounded commands from active top-frame
AO3/FFN senders. Status, rating, chapter progress, and work-status patches must
name the exact entry id currently projected for the claimed same-host work key;
hide/unhide remains keyed separately because it does not require a library
entry. For those general entry and preference writes, the worker forces an
authoritative overlay refresh before and after the request. A timeout or
malformed success response is reconciled through that projection and is never
treated as success or blindly repeated. Finish
qualification uses its documented idempotent endpoint, remains account fenced,
and cannot carry arbitrary library patch fields. It does not infer success from
the account projection: the server must return the exact work key and a valid
authoritative entry with the requested entry id. An uncertain resolved request
may retry that same endpoint once; an observational open request is never
retried. After a resolved acknowledgement, projection invalidation and refresh
are detached cache maintenance and cannot delay or replace the server result;
open and ignored results do not churn the cache. A general library mutation is
still never blindly repeated.

Kernel first-story initiation has separate trusted entry points. Popup import
is accepted only from the extension popup and can collect only the current
supported AO3/FFN tab; the returned payload is source-checked, item-count
limited, byte-bounded, and opened only on the configured Trace import origin.
Desktop first-story handoff is accepted only from a top-frame content script on
that configured Trace origin and only for one validated AO3/FFN story URL. Its
save is performed by the existing story-command owner. Failure to reach the
archive content script is surfaced as missing site permission and never causes
an alternate credential or page-data path.

Kernel metadata contribution accepts only active top-frame AO3/FFN senders.
Story-level contribution is bound to the exact sender work, while listing
refresh batches are strict, item-count limited, byte bounded, and restricted to
same-host work identities. The metadata preference is enforced again in the
background before native-account adoption or API access. Raw credentials stay
inside the authenticated adapter, and an account change fences projection
invalidation and Trace-tab notification. Listing pages learn which visible
works are tracked only through the bounded account projection; they do not
receive an account identifier or credential.

Kernel AO3 saved-filter synchronization preserves the local-first browser
storage model needed for signed-out and offline edits, but moves authenticated
API access, batching, conflict resolution, and account fencing into the
background owner. Sync requests are accepted only from active top-frame AO3
pages outside credential paths. Upserts and delete tombstones are strictly
normalized and sent in batches of at most 100; unknown query parameters cannot
enter the API request. A newer dirty local edit wins over an older remote row,
and remote merges are serialized against Connect, Disconnect, and account
recovery. Network-uncertain requests are not immediately repeated. Raw Trace
credentials and account identifiers never enter the saved-filter content
script or extension local storage.

Kernel Trace-page status requests are accepted only from an active top-frame
content script on the exact configured Trace origin. Session actions are
accepted only from that trusted Trace bridge or the extension popup, never
from AO3/FFN senders. Status pushes are serialized and deduplicated so an older
state cannot overtake a newer one. The public status may include only coarse
archive-readiness booleans, enums, and epoch timestamps; its local repository
drops URLs, titles, account fields, and unknown properties. Content-script
requests to open Trace are bound to supported top-frame archive senders and
the exact configured Trace origin.

Saved-filter synchronization remains serialized with account transitions so a
response from one account cannot merge after another account becomes current.
A user-requested session transition cancels the in-flight sync request and
increments the sync generation before waiting on that fence, avoiding a
network-timeout delay without weakening the account boundary.

## Committed build files

For a tagged release, confirm `package.json` version matches the generated manifest version. Safari consumes checked-in files under `Shared (Extension)/Resources`; Chromium and Firefox packages are generated into `dist/`, which is intentionally not committed.

`Shared (Extension)/Resources/background.js` is a committed build artifact.
Kernel builds bundle `src/extension-runtime/index.mts` and its core/runtime
dependency graph; the generated header records the configured API and web
origins for release auditing. Only `build:legacy:release` generates that file
from `src/background.js` by literal substitution. Safari requires the selected
release artifact to be checked in. `Shared (Extension)/Resources/popup-config.js`
and `Shared (Extension)/Resources/content-config.js` are committed for the same
reason: Safari consumes those generated extension constants directly. Native
app configuration is generated and validated in the private Apple client.

The committed resources must be the exact output of
`npm run build:ios-earned-permission-onboarding:release`: the Apple app
rebuilds them and refuses to archive if any file differs. Never edit them by
hand or resolve a merge conflict inside them; rerun that build and commit the
result. `npm run check:safari-resources` (the first step of `npm test`) builds
a temporary copy and fails if the checked-in files differ from it.

## Restoring site access on Chrome, Firefox and Edge

Trace checks all declared host permissions with `permissions.contains` on
install/update, startup, permission changes, and popup opening. This includes
all AO3 origins and mirrors, both FanFiction.net origins, and the configured
Trace web/API origins needed to connect. Firefox, Chrome and Edge show a **!**
toolbar badge and **Site access is off — click to allow** tooltip while any
of those hosts is missing access.

Click the icon, then **Allow Trace on AO3 and FanFiction.net** in the popup.
That direct click requests every declared host together and closes the popup
immediately, leaving Firefox's single permission prompt unobstructed.
Approval restores Trace on supported open archive pages;
the badge clears only when the full host set is granted. Declining leaves
Allow available to try again.

A toolbar click may activate Trace on the current archive page without granting
persistent access. While the popup is closed, that page keeps a non-dismissable
line: **Trace is only on
for this page. Allow it on AO3 to keep it on — click the Trace icon.**
FanFiction.net pages name FanFiction.net instead. The line remains through
Connect-notice dismissal and account-state changes, and disappears when the
full permission grant arrives, without reloading the page. Opening the toolbar
popup hides the line; closing it without granting access shows the line again.
The background handles approval even after the popup closes.

Without even one-page access, content scripts cannot run to show a notice. The
popup requests directly from its own click handler: Firefox's restricted API
set in a web-accessible extension iframe on an HTTP(S) page does not expose
`browser.permissions`, and a background message hop does not preserve the
required user gesture. No additional hosts or collected data are introduced.
Safari keeps its existing Website Access flow.

## The iPhone and iPad build

The iOS earned-permission build declares its five story-site patterns as
optional, declares no required website, and has no `tabs` permission, so
opening Trace from Safari raises no website question; `activeTab` covers only
the tab it was opened on. Its page scripts are registered when all five
patterns are allowed and removed when that access ends. It asks for Website
Access before any first-story write. If access was missed in Settings, an explicit Safari toolbar tap lets the
popup identify the current supported story, request exactly five optional
AO3/FanFiction.net origin patterns, register the production scripts, and reload
the story. The normal content-script handoff then supplies the fresh run and
server-confirmed save. Denial or partial coverage saves nothing; there is no
toolbar-only completion mode. Its diagnostic funnel stays in extension-local
storage and contains only bounded event names and timestamps; it is not network
telemetry and contains no URLs, story or account identity, page content, or
browsing history. See
[`docs/ios-earned-permission-onboarding.md`](docs/ios-earned-permission-onboarding.md).

The developer-only iOS active-tab first-value probe declares no website
origins. It can inspect only the active story tab after the user explicitly
opens Trace from Safari, injects only the bounded collector needed for that
save, and uses the existing authenticated story-command path. It adds no new
data type or token path and does not run automatic tracking, overlays, saved
filters, Trace-site sync, or archive heartbeats. Normal builds retain the
release permission model described above.

The iOS earned-permission build requires no website and has no `tabs`
permission; its five story-site patterns are optional, and Trace's own website
is not among them. It uses `activeTab` only to identify the current
supported story during recovery; it does not inject or save before Website
Access. A development switch, which no release build can turn on, lets the
background inject the page script into the one tab the reader opened Trace on
and save that story first; with it off its background wiring is not in the
package. See
[`docs/ios-earned-permission-onboarding.md`](docs/ios-earned-permission-onboarding.md).
Its background asks Safari for tabs only at story-site addresses and
only once all five patterns are allowed, and removes its registered page
scripts when two readings agree that access has ended. One explicit action requests exactly five optional supported-origin
patterns. Only after Safari reports the complete grant does the background
worker register the production archive scripts and reload the story. Login,
signup, password, authentication, and logout paths remain excluded. The fresh
post-registration content-script run and current-account server confirmation

## Setup records shared with the Trace app

For native first-story setup, an opt-in local save record carries only the
confirmed Library entry ID, canonical AO3/FFN work key, account ID, operation and
attempt IDs, timestamps, API origin and a non-secret provider equality digest.
It is stored in the app/extension shared container, never sent as telemetry.
The containing app must verify the current account/provider and read that exact
entry before displaying it. A bounded batch retains the first and most recent confirmed stories (up to 32),
deduplicated by entry ID; it is not a total-save count. Records expire as current
evidence after 24 hours; no heartbeat or permission-scope claim is implied.
No additional page permission, cookie access, story text or private-site data
is introduced. Receipt failure does not replay or block a confirmed save. This local record
also covers confirmed automatic reading writes, which can create the first
Library entry; it does not label them as manual quick-add actions or establish
later independent use.
Production packages accept only the production API origin. An explicitly paired
native development package uses its immutable Import API-origin metadata for
receipt validation; page messages cannot choose the environment. Production and
development attempts and receipts never mix.

On iOS, the popup may ask the open story page for its visible title, author
and site so it can name the story it is confirming. That reply goes only to
the extension's own popup, is shown locally, and is never stored or sent. The
one-time saved note keeps a tab-scoped `sessionStorage` marker holding only
the work key and times, so a replaced page can finish the same note. Popup
state includes the current account's confirmed record for the active tab's
story from the local projection; no URL leaves the runtime.

Popup story commands use a content-script-opened runtime port through the
background worker, so an existing Safari tab can reconnect after the extension
reloads. The worker selects the active tab and accepts only its own supported
top-frame page port. Connections and request identifiers remain in memory;
title replies are bounded and are neither stored nor sent to a server. A tab
change, navigation, disconnect, or account transition invalidates a pending
reply. Relayed saves and status changes retain the existing page validation,
current-account scope, and authoritative library-entry checks. Missing ports
keep the popup's existing unavailable/fallback state.

For native first-story setup, an opt-in local save record carries only the
confirmed Library entry ID, canonical AO3/FFN work key, account ID, operation and
attempt IDs, timestamps, API origin and a non-secret provider equality digest.
It is stored in the app/extension shared container, never sent as telemetry.
The containing app must verify the current account/provider and read that exact
entry before displaying it. A bounded batch retains the first and most recent confirmed stories (up to 32),
deduplicated by entry ID; it is not a total-save count. Records expire as current
evidence after 24 hours; no heartbeat or permission-scope claim is implied.
No additional page permission, cookie access, story text or private-site data
is introduced. Receipt failure does not replay or block a confirmed save. This local record
also covers confirmed automatic reading writes, which can create the first
Library entry; it does not label them as manual quick-add actions or establish
later independent use.
The native handler selects the receipt environment from paired package metadata,
never from a message. Only the production API and the explicit Trace development
API are supported, with exact matching at preparation, confirmation and readback.
An ordinary production package rejects development receipts and vice versa.

### Optional native setup attribution

When the Apple app explicitly enables its setup funnel, a save may include an
opaque setup attempt UUID received through the existing native receipt channel.
It expires with that account/provider/API-bound attempt. The background save owner
checks current account scope and expiry before each request, never accepts a page's
claimed attempt, and never logs the UUID with story URLs. No page access, host
permissions, credentials, story text collection, or success UI rules are added.

## Reconnecting after an extension update

On background start and installation/update, Trace attempts to reinject its
archive scripts (manifest-declared, or on iPhone and iPad the ones it
registered) into already-open, granted story-site tabs. It asks the browser
for story-site tabs by address, never for every open tab.
The scripting API permission enables this recovery; host permissions are
unchanged and recovery never requests website access. Each tab is checked
individually, credential paths remain excluded, and scripts guard against
duplicate initialization. Failed or denied injections do not reload tabs.

If the popup cannot reach the page, it shows “Trace needs to reconnect to this
page” with “Reload page”. That action reloads the active archive tab and checks
again. A cached library entry alone is not evidence that the page is connected.
[Safari supports the scripting API](https://developer.apple.com/videos/play/wwdc2023/10119/), but recovery after app replacement must be
verified separately on installed iOS Safari; API availability does not prove
that an orphaned script context can be replaced.

The scripting capability restores existing archive content scripts after an
update or background start. Recovery uses only manifest-matched top-frame
archive URLs with a positive current host-grant check, respects excluded
credential paths, and never requests permissions or persists the tab list.
It adds no collection or credential route. Page reload remains a user action.

## What Safari tells the Trace app

The Safari background worker publishes the installation's automatic-saving
setting to the bundled app on preference changes and story-site heartbeats.
This app-group snapshot contains a version, verified account ID, paired API
origin, non-secret provider equality binding, boolean `enabled`, `setAt` and
`observedAt` (epoch milliseconds). It contains no URLs or story data and is
never sent to a server. Existing installations without a change timestamp use
the first observation as `setAt`; later heartbeats preserve it. The preference
remains installation-local; the snapshot is evidence scoped to the currently
verified account, not account preference synchronization.

The existing native provider boundary prepares the equality binding before
account adoption and checks it again when storing. The app accepts only its
current account, API origin and provider. Missing, malformed, future, replaced-
provider or more-than-24-hour-old observations are unknown, never off. A late
snapshot cannot replace a newer change. A preference is not proof of Safari
access, activation or a successful save. Old app/extension versions can ignore
the additive messages; absence leaves existing behavior intact.

On iPhone and iPad the Safari background worker tells the bundled app which
story-site addresses Safari currently lets Trace run on. A page run already
publishes this beside its run receipt. The same message is also sent on its
own when the popup opens, when Safari reports that the grant changed, and
about once a day, because once access ends (for example, when an Allow for One
Day grant runs out) no page script runs to say so. It reuses the existing
`TRACE_IOS_EXTENSION_HEARTBEAT` permission snapshot: a timestamp and a list of
granted origin patterns, stored in the app/extension shared container. It
contains no URLs, story or account data, is never sent to a server, and adds
no permission.

The reading is built to avoid a false alarm. It exists to catch access that
ended, so an install that has never held the full grant sends nothing: not at
first start, and not part-way through setup. After that, missing access is
reported only when `permissions.contains` says so twice, two seconds apart,
and `permissions.getAll` also answered; when Safari confirms the five required
origins they are listed by name, since a broader grant need not spell them
out. If Safari does not answer, nothing is sent.

It is also quiet. A reading equal to the last one delivered is not sent again
within five minutes, and a delivery the app did not take is left alone for
one minute, then five, then thirty at most; opening the popup tries once
straight away. To do this the extension keeps, in its own storage, when a
reading was last delivered, whether the grant has ever been seen, a hash of
the last reading (not the origins themselves) and the delivery back-off.
Chrome and Firefox install none of this. Safari on Mac cannot be told from an
iPad until Safari reports its platform, so its listeners are registered, but
they do nothing: no reading is sent and no alarm is set.

On iPhone and iPad the Safari background worker tells the bundled app whether
Trace in Safari is ready to save by itself: four answers (website access, the
page scripts, the account, the automatic-saving preference), each positive, a
known blocker or unknown, with a reason token and the time it was read. It is
stored in the app/extension shared container, bound to the provider the app
issued and to the cycle the app opened, and is never sent to a server. It
is sent when the popup opens, on the changes it describes, and about once a
day. It
contains no credential, address, story or page data, and says nothing about
how long website access lasts, whether a save happened or will work, or
Private Browsing. It adds no permission, looks up no tab and runs nothing on
a page. The contract is in
[`docs/safari-readiness-report.md`](docs/safari-readiness-report.md).

A reader who allowed the story sites under a build that kept no access ledger
is recognised from that build's setup record, so that access lost since is
reported as ended. Where the access is still there nothing changes.

## Release and browser diagnostics

Safari and Chromium-family clients may attach installed extension version and
coarse mobile/desktop and browser categories to authenticated Trace API calls.
The server uses these for aggregate release adoption and failure diagnostics.
Firefox sends **none** of these optional activity headers: this release does not
request `technicalAndInteraction` consent and does not enable that collection.

Before first adding headers, the extension checks the API URL/header set with a
bodyless, side-effect-free OPTIONS request, bounded to one second. Success is
cached per API origin for one hour, including across worker restarts; concurrent
calls share the probe. Steady-state saves add no compatibility round trip. Only
expiry or an actual request failure causes a new probe on the next call. The
local cache holds just the API-origin key and expiry timestamp, never account,
credential or reading data. If the probe fails (including CORS rejection) or
times out, the actual request is sent once with its original authorization/body
and without the optional headers. Added telemetry remains disabled for that
worker's lifetime. An HTTP error or ambiguous network failure on the actual save
is never replayed by this adapter. Existing save reconciliation/retry ownership
remains unchanged. Firefox sends no probe.

No permission, destination, raw user agent, page content, unrelated browsing
history or installation identifier is added. OPTIONS is additional API traffic,
not an additional activity event. Existing clients remain unattributed.

## Browser connection and credentials

Chrome, Firefox (including Android), and desktop Safari exchange a Trace
website sign-in grant for a scoped installation credential in the background.
It stays in extension-private IndexedDB and authorizes only extension API
routes. Tracking does not require an open Trace tab after connecting. Existing
valid website tokens migrate when next loaded. An already expired connection
may require one reconnect after upgrading. Disconnect clears local authority
and attempts server revocation; offline revocation is best effort. Server idle
and absolute expiry still apply. iOS continues to use the app-owned provider.

When reconnect opens Trace from a story, successful sign-in returns to the
existing reading tab without reloading it. Only browser tab IDs and a bounded
expiry are retained for that return; no reading URL or page content is stored.
If the tab closed or the reader moved away from the sign-in tab, connection
still succeeds without changing the selected tab.

Only the extension background exchanges an explicitly acquired Trace Auth0
grant for a scoped device credential. The credential is never posted back to
Trace web content or archive content scripts. Installation IDs are random
UUIDs, not browser fingerprints. The API stores only credential digests; device
credentials cannot issue other credentials or access general account APIs.
The existing 90-day rolling idle / 365-day absolute session limits also apply
to browser installations. A rejected or revoked scoped credential fails closed.
Disconnect clears extension authority immediately and attempts self-revocation
without retaining the discarded credential for an offline retry queue. Native
iOS provider credentials are never revoked by this browser cleanup path.
The pending reconnect return stores only source/connection tab IDs and expires
with the user's Connect intent; Disconnect withdraws it.
