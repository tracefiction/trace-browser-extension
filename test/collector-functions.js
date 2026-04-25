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

/**
 * @param {import("jsdom").JSDOM} dom
 * @param {{ chrome?: any }} [options]
 */
function createCollectorBindings(dom, options = {}) {
  const { window } = dom;
  const globalScope = {
    console,
    document: window.document,
    location: window.location,
    window,
    self: window,
    globalThis: null,
    chrome: options.chrome || createChromeMock(),
    browser: undefined,
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
    shouldDisableTraceContentScript: globalScope.shouldDisableTraceContentScript,
    collectAO3Work: globalScope.collectAO3Work,
    collectAO3Listings: globalScope.collectAO3Listings,
    detectAo3CurrentChapterNumber: globalScope.detectAo3CurrentChapterNumber,
    hasStableAo3ChapterSignal: globalScope.hasStableAo3ChapterSignal,
    shouldDelayAutoTrackUntilVisible: globalScope.shouldDelayAutoTrackUntilVisible,
    storyMetadataFingerprint: globalScope.storyMetadataFingerprint,
    shouldBroadcastMetadata: globalScope.shouldBroadcastMetadata,
    rememberMetadataBroadcast: globalScope.rememberMetadataBroadcast,
    shouldSkipRecentAutoTrack: globalScope.shouldSkipRecentAutoTrack,
    rememberRecentAutoTrack: globalScope.rememberRecentAutoTrack,
    forgetRecentAutoTrack: globalScope.forgetRecentAutoTrack,
    sendAutoTrackForStory: globalScope.sendAutoTrackForStory,
    applyConfirmedOverlayUpdateForStory: globalScope.applyConfirmedOverlayUpdateForStory,
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
  COLLECTOR_PATH,
};
