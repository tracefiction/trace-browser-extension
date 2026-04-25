# Test Fixtures

These files are static AO3/FanFiction.net page snapshots used only by automated parser tests.

They are not examples of data Trace sends to its API. At runtime, the extension reads selected metadata fields from the current page DOM and sends only the metadata described in the project README.

Fixtures may include surrounding page markup because real archive pages include navigation, login forms, cookie notices, ads, and other non-story HTML. Keeping realistic snapshots helps catch parser regressions when site structure changes.
