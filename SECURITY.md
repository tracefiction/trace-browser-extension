# Security

If Trace ever asks for your AO3 or FanFiction.net password, it is not legitimate.

This repository is published so users can inspect the extension's actual permission model and data flow. The key security boundary is that Trace reads story metadata and reading progress from supported pages; it does not need AO3/FFN credentials or browser cookies or story text.

## Reporting

Please report security or privacy issues using the public support contact listed on Trace (`support@tracefiction.com`). Do not include passwords, tokens, cookies, or private account data in your message.

## Permission Model

The extension requests access to supported AO3 and FanFiction.net pages so it can read story metadata and show Trace library status. It requests access to the configured Trace web origin for token sync. Safari sends authenticated API requests from its background worker through the Trace API's extension-origin CORS policy, without requesting page access to that API host; Chrome and Firefox packages retain the API host permission their cross-origin request model requires.

The extension does not request browser cookie permission. It does not need AO3 or FanFiction.net credentials.
The Safari build uses native messaging only to communicate with the bundled
Trace app for setup actions, app-auth token sharing, and first-story handoff.

The developer-only iOS active-tab first-value probe declares no website
origins. It can inspect only the active story tab after the user explicitly
opens Trace from Safari, injects only the bounded collector needed for that
save, and uses the existing authenticated story-command path. It adds no new
data type or token path and does not run automatic tracking, overlays, saved
filters, Trace-site sync, or archive heartbeats. Normal builds retain the
release permission model described above.

The iOS earned-permission TestFlight build keeps that active-tab first-save
boundary, then exposes a separate user action that requests exactly five
optional supported-origin patterns. Only after Safari reports the complete
grant does it dynamically register the production archive scripts. Login,
signup, password, authentication, and logout paths remain excluded. A fresh
post-grant archive heartbeat is required before the popup claims automatic
tracking is ready. Refusal or later revocation preserves current-tab toolbar
saves. The build stores at most 32 coarse event-name/timestamp pairs locally
for device diagnosis and sends none of that funnel to Trace.

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
can report the target as saved. Progress commands do not emit first-save
receipts or clear first-story handoffs. On iOS, the command first re-adopts the
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
