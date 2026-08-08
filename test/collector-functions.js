/**
 * Loads collector logic in Node for tests: runs the content script core in a vm
 * with JSDOM's window as document/location and a stub chrome.runtime.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const COLLECTOR_PATH = path.join(
  __dirname,
  "..",
  "Shared (Extension)",
  "Resources",
  "collector.js"
);

const LISTENER_MARKER = "\n// Listen for background requests";

function getCollectorCoreSource() {
  const src = fs.readFileSync(COLLECTOR_PATH, "utf8");
  const i = src.indexOf(LISTENER_MARKER);
  if (i < 0) {
    throw new Error(
      `Expected ${JSON.stringify(LISTENER_MARKER.trim())} in collector.js`
    );
  }
  return src.slice(0, i);
}

function createChromeMock() {
  return {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
      lastError: null,
    },
  };
}

function withDefaultScopedStorageContext(chrome, options = {}) {
  if (options.scopeStorageContext === false) return chrome;
  const local = chrome && chrome.storage && chrome.storage.local;
  if (!local || typeof local.get !== "function") return chrome;
  const originalGet = local.get.bind(local);
  local.get = (keys, cb) => {
    originalGet(keys, (res) => {
      const out = res && typeof res === "object" ? res : {};
      if (out.authToken) {
        if (out.traceApiBase == null) out.traceApiBase = "https://trace.test";
        if (out.traceAccountId == null) out.traceAccountId = "acct-test";
        const cache = out.libraryOverlayCache;
        if (cache && typeof cache === "object") {
          if (cache.apiBase == null) cache.apiBase = out.traceApiBase;
          if (cache.accountId == null) cache.accountId = out.traceAccountId;
          if (cache.contextVersion == null) cache.contextVersion = 1;
        }
      }
      if (typeof cb === "function") cb(out);
    });
  };
  return chrome;
}

/**
 * @param {import("jsdom").JSDOM} dom
 * @param {{ chrome?: any, sessionMode?: "legacy" | "kernel" }} [options]
 */
function createCollectorBindings(dom, options = {}) {
  const { window } = dom;
  const browser = options.browser
    ? withDefaultScopedStorageContext(options.browser, options)
    : undefined;
  const globalScope = {
    console,
    document: window.document,
    location: window.location,
    window,
    self: window,
    globalThis: null,
    TRACE_SESSION_MODE: options.sessionMode,
    chrome: browser
      ? undefined
      : withDefaultScopedStorageContext(options.chrome || createChromeMock(), options),
    browser,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    // collector `canonicalFFN` uses `new URL(...)`; Node's vm context has no URL by default
    URL: global.URL,
  };
  globalScope.globalThis = globalScope;
  vm.createContext(globalScope);
  vm.runInContext(getCollectorCoreSource(), globalScope);
  return {
    collect: globalScope.collect,
    sendCollectorMessage: globalScope.sendCollectorMessage,
    shouldDisableTraceContentScript: globalScope.shouldDisableTraceContentScript,
    collectAO3Work: globalScope.collectAO3Work,
    collectAO3Listings: globalScope.collectAO3Listings,
    detectAo3CurrentChapterNumber: globalScope.detectAo3CurrentChapterNumber,
    hasStableAo3ChapterSignal: globalScope.hasStableAo3ChapterSignal,
    shouldDelayAutoTrackUntilVisible: globalScope.shouldDelayAutoTrackUntilVisible,
    storyMetadataFingerprint: globalScope.storyMetadataFingerprint,
    shouldBroadcastMetadata: globalScope.shouldBroadcastMetadata,
    rememberMetadataBroadcast: globalScope.rememberMetadataBroadcast,
    listingMetadataRefreshItemFromImportItem: globalScope.listingMetadataRefreshItemFromImportItem,
    collectTrackedListingMetadataRefreshItems: globalScope.collectTrackedListingMetadataRefreshItems,
    sendListingMetadataRefreshForTrackedItems: globalScope.sendListingMetadataRefreshForTrackedItems,
    shouldSkipRecentAutoTrack: globalScope.shouldSkipRecentAutoTrack,
    rememberRecentAutoTrack: globalScope.rememberRecentAutoTrack,
    forgetRecentAutoTrack: globalScope.forgetRecentAutoTrack,
    sendAutoTrackForStory: globalScope.sendAutoTrackForStory,
    applyConfirmedOverlayUpdateForStory: globalScope.applyConfirmedOverlayUpdateForStory,
    clearStoryOverlayTransientState: globalScope.clearStoryOverlayTransientState,
    mergeStoryOverlayEntries: globalScope.mergeStoryOverlayEntries,
    quickAddStatusDisplay: globalScope.quickAddStatusDisplay,
    collectFFNStory: globalScope.collectFFNStory,
    collectFFNListings: globalScope.collectFFNListings,
    collectFFNStoryMobile: globalScope.collectFFNStoryMobile,
    collectFFNListingsMobile: globalScope.collectFFNListingsMobile,
    parseFFNMeta: globalScope.parseFFNMeta,
    parseFFNMetaMobile: globalScope.parseFFNMetaMobile,
    parseFFNMobileListingMeta: globalScope.parseFFNMobileListingMeta,
    extractFFNDesktopCharacters: globalScope.extractFFNDesktopCharacters,
  };
}

module.exports = {
  createCollectorBindings,
  getCollectorCoreSource,
  withDefaultScopedStorageContext,
  COLLECTOR_PATH,
};
