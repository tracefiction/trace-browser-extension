# Security

If Trace ever asks for your AO3 or FanFiction.net password, it is not legitimate.

This repository is published so users can inspect the extension's actual permission model and data flow. The key security boundary is that Trace reads story metadata and reading progress from supported pages; it does not need AO3/FFN credentials or browser cookies or story text.

## Reporting

Please report security or privacy issues using the public support contact listed on Trace (`support@tracefiction.com`). Do not include passwords, tokens, cookies, or private account data in your message.

## Permission Model

The extension requests access to supported AO3 and FanFiction.net pages so it can read story metadata and show Trace library status. It requests access to the configured Trace web origin for token sync. Safari sends authenticated API requests from its background worker through the Trace API's extension-origin CORS policy, without requesting page access to that API host; Chrome and Firefox packages retain the API host permission their cross-origin request model requires.

The extension does not request browser cookie permission. It does not need AO3 or FanFiction.net credentials.
The Safari extension uses native messaging only to communicate with its
bundled Trace containing app for setup actions, app-auth token sharing, and
first-story handoff. The extension-side handler and credential codec remain in
this public repository; the containing app implementation is private and pins
an exact public extension commit.

The developer-only iOS active-tab first-value probe declares no website
origins. It can inspect only the active story tab after the user explicitly
opens Trace from Safari, injects only the bounded collector needed for that
save, and uses the existing authenticated story-command path. It adds no new
data type or token path and does not run automatic tracking, overlays, saved
filters, Trace-site sync, or archive heartbeats. Normal builds retain the
release permission model described above.

The iOS earned-permission build uses `activeTab` only to identify the current
supported story during recovery; it does not inject or save before Website
Access. One explicit action requests exactly five optional supported-origin
patterns. Only after Safari reports the complete grant does the background
worker register the production archive scripts and reload the story. Login,
signup, password, authentication, and logout paths remain excluded. The fresh
post-registration content-script run and current-account server confirmation
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

Content scripts are excluded from obvious AO3/FFN login and signup paths where the manifest supports it, and collection/overlay logic also disables itself at runtime on login/signup/password pages and pages that contain unknown password fields. AO3's known header login form can appear on normal story/listing pages; Trace ignores only that header form so supported reading pages still work.

## Data Sent to Trace

Trace may send story URL, title, author, fandoms/tags, chapter and word counts, reading-progress metadata, reading-status changes you explicitly choose in Trace UI, finish/caught-up decisions you explicitly choose at the end of a supported story, last-posted-chapter finish-qualification signals for stories already in your Trace library, hidden-work browsing preferences you explicitly choose in Trace UI, AO3 saved filter presets you explicitly create, and your Trace auth token for Trace API requests.

On iOS Safari, the app stores an opaque device credential in the shared
Keychain after you sign in inside the app. The credential is limited to Trace
extension API routes; the Safari extension does not receive the app's Auth0
access token.
The iOS shell exposes its app version, build number, and release channel to the
Trace web app for authenticated onboarding diagnostics. This diagnostic does
not include story URLs, archive browsing history, or account email.

Hidden-work preferences are keyed by supported AO3/FFN work id and affect Trace browsing overlays only. They are separate from library reading status and do not hide or change the source site itself.

AO3 saved filters are stored in extension storage so the extension can reapply user-created AO3 filter query states. When you are signed in, they sync to your Trace account as normalized AO3 filter query parameters plus the preset name/scope. They do not include AO3 credentials, cookies, page HTML, or story text.

Trace does not send AO3/FFN passwords, browser cookies, private messages, drafts, comments, account settings, or full page HTML.

## Limitations

Browser extensions run with page access granted by the browser, so users should review each release's manifest permissions before installing or updating. Public source review improves transparency, but it does not replace store review, release-tag verification, etc.

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

On iOS, the popup may ask the open story page for its visible title, author
and site so it can name the story it is confirming. That reply goes only to
the extension's own popup, is shown locally, and is never stored or sent. The
one-time saved note keeps a tab-scoped `sessionStorage` marker holding only
the work key and times, so a replaced page can finish the same note. Popup
state includes the current account's confirmed record for the active tab's
story from the local projection; no URL leaves the runtime.

### Optional native setup attribution

When the Apple app explicitly enables its setup funnel, a save may include an
opaque setup attempt UUID received through the existing native receipt channel.
It expires with that account/provider/API-bound attempt. The background save owner
checks current account scope and expiry before each request, never accepts a page's
claimed attempt, and never logs the UUID with story URLs. No page access, host
permissions, credentials, story text collection, or success UI rules are added.

Popup story commands use a content-script-opened runtime port through the
background worker, so an existing Safari tab can reconnect after the extension
reloads. The worker selects the active tab and accepts only its own supported
top-frame page port. Connections and request identifiers remain in memory;
title replies are bounded and are neither stored nor sent to a server. A tab
change, navigation, disconnect, or account transition invalidates a pending
reply. Relayed saves and status changes retain the existing page validation,
current-account scope, and authoritative library-entry checks. Missing ports
keep the popup's existing unavailable/fallback state.

## Update recovery

The scripting capability restores existing archive content scripts after an
update or background start. Recovery uses only manifest-matched top-frame
archive URLs with a positive current host-grant check, respects excluded
credential paths, and never requests permissions or persists the tab list.
It adds no collection or credential route. Page reload remains a user action.


### Trace's setup page

On Trace's setup page (`/safari-setup` on Trace's own site), in Safari on
iPhone and iPad, and nowhere else, the page script (`sync.js`) answers a small
fixed set of questions from the page, so that page can tell a reader what to
do next. Page and script talk with `window.postMessage` on the page's own
origin; the script hears only the top-level page itself (it checks
`event.source === window`, `event.origin`, that it is not inside a frame, and
that the path is exactly the setup page's), and the background checks again
that the request came from a top-level page at that path on Trace's origin.
Every other page on Trace's site (the signed-in app included), a story site,
any other site and any frame get no answer. Neither does any page in Chrome,
Firefox or Safari on a Mac: the page script forwards nothing there. The Chrome
and Firefox packages do not contain the background half at all; `sync.js` and
`popup.js` are shared files, so those packages carry their halves, inert.

What the page can learn:

- whether the five story-site addresses are allowed, and how broadly: every
  site, the story sites, or only Trace's own page. It is told again when that
  changes;
- the open story tabs in its own window: for up to five tabs that are story
  pages on AO3 or FanFiction.net, a tab id, the tab's title (one line, at most
  120 characters) and which site it is on. Nothing is listed while the story
  sites are not allowed. A tab in Private Browsing or in another window is
  never listed, and a setup page that is itself in Private Browsing is given
  no tabs. A title that is the tab's address, contains it, or is shaped like
  an address, is sent as no title, and characters that hide or reorder text
  are removed.

What the page can do: ask for one of those tabs to be brought to the front. It
must be a tab from the most recent list given to that same tab, no more than
two minutes earlier; the list is dropped if that tab is seen anywhere but the
setup page. The story tab is checked again at that moment to still be a story
page, in the same window, and not in Private Browsing.

What the page cannot do or learn: any address; anything about a tab that is
not a story page; open, close, reload or navigate a tab; make the browser ask
for access (there is no such message). Requests are limited to 20 in any 10
seconds per page, in the page script and again in the background. Nothing here
is sent to a server, and it adds no permission. The popup shown over that page
uses the same list and the same switch, under the same rules, for the window
of the tab it is open over.

What the path check is, and is not. It keeps the signed-in app and every other
Trace page from using these questions by accident. It is not a defence against
hostile script already running on Trace's own origin: such a script can move
its page to `/safari-setup` without loading it and then ask. The limits above
are therefore what count. The most such a script could learn is whether the
story sites are allowed and the titles of up to five story tabs in that
window; the most it could do is bring one of those story tabs to the front. It
could learn nothing about any other tab and no address, and it could not make
the browser ask for access.

### Local Safari automatic-saving preference

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

### Local Safari story-site access reading

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

## Aggregate release and browser diagnostics

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

**Release dependency:** requires a Trace API version that accepts these headers.
Deploy the compatible API BEFORE releasing or pinning any extension build
containing this change into the Apple app. Older allow-lists reject these
headers during preflight; they do not silently ignore them. The compatibility
fallback is defensive, not permission to reverse deployment order. Owner privacy
review is required before merge or release; no merge, pin update or store
submission is authorized here.

## Browser installation credentials

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
