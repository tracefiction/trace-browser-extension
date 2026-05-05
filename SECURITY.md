# Security

If Trace ever asks for your AO3 or FanFiction.net password, it is not legitimate.

This repository is published so users can inspect the extension's actual permission model and data flow. The key security boundary is that Trace reads story metadata and reading progress from supported pages; it does not need AO3/FFN credentials or browser cookies or story text.

## Reporting

Please report security or privacy issues using the public support contact listed on Trace (`support@tracefiction.com`). Do not include passwords, tokens, cookies, or private account data in your message.

## Permission Model

The extension requests access to supported AO3 and FanFiction.net pages so it can read story metadata and show Trace library status. It requests access to Trace web/API origins so it can receive your Trace auth token from Trace and send authenticated Trace API requests.

The extension does not request browser cookie permission. It does not need AO3 or FanFiction.net credentials.

Content scripts are excluded from obvious AO3/FFN login and signup paths where the manifest supports it, and collection/overlay logic also disables itself at runtime on login/signup/password pages and pages that contain unknown password fields. AO3's known header login form can appear on normal story/listing pages; Trace ignores only that header form so supported reading pages still work.

## Data Sent to Trace

Trace may send story URL, title, author, fandoms/tags, chapter and word counts, reading-progress metadata, reader-status changes you explicitly choose in Trace UI, hidden-work browsing preferences you explicitly choose in Trace UI, and your Trace auth token for Trace API requests.

Hidden-work preferences are keyed by supported AO3/FFN work id and affect Trace browsing overlays only. They are separate from library reader status and do not hide or change the source site itself.

Trace does not send AO3/FFN passwords, browser cookies, private messages, drafts, comments, account settings, or full page HTML.

## Limitations

Browser extensions run with page access granted by the browser, so users should review each release's manifest permissions before installing or updating. Public source review improves transparency, but it does not replace store review, release-tag verification, etc.
