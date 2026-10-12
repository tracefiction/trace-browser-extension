// Injected ahead of the page script when the reader opens Trace on a story
// before Safari has been asked for lasting access. In this mode the page
// script reads the story when Trace asks and shows its mark when told; it
// starts nothing by itself. The page script reads this each time it is about
// to act, and the background turns it off once the story sites are allowed,
// so the same script carries on without a reload.
globalThis.TRACE_PAGE_MANUAL_MODE = true;
