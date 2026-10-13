# Test Fixtures

These files are static AO3/FanFiction.net page snapshots used only by automated parser tests.

They are not examples of data Trace sends to its API. At runtime, the extension reads selected metadata fields from the current page DOM and sends only the metadata described in the project README.

Fixtures may include surrounding page markup because real archive pages include navigation, login forms, cookie notices, ads, and other non-story HTML. Keeping realistic snapshots helps catch parser regressions when site structure changes.

`end-of-story/` holds synthetic AO3- and FanFiction.net-shaped pages for the
end-of-story placement tests and design renders. They use public-domain
fandoms, invented titles and original prose; they are not snapshots of live
pages.

`ao3-work-summary/` holds synthetic AO3-shaped work pages (chapter 1, a
chapter 2+ page with a chapter summary, the Entire Work view and a one-shot)
for the work-summary selector tests. They use a public-domain fandom, invented
titles and original prose; they are not snapshots of live pages.

`ao3_adult_content_notice.html` is a synthetic AO3-shaped page for the notice
AO3 shows before a work that may have adult content: the caution, its
choices, and a summary of the work where the story will be. Invented title and
author; not a snapshot of a live page.

`safari-readiness-report-v1.json` is the readiness report message as the
extension's background sends it to the Trace app's side, for a reader with
everything in place. The runtime test asserts the real module produces exactly
it, and the Swift contract test asserts the native codec accepts and reads it,
so the two sides cannot drift apart. Its identifiers are invented.
