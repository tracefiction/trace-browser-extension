const USES_BROWSER_PROMISE_API = typeof browser !== "undefined";
const ext = USES_BROWSER_PROMISE_API ? browser : chrome;
const STATUS_KEY = "traceAuthState";
const PREF_AUTO_TRACK_KEY = "prefAutoTrackEnabled";
const PREF_LIBRARY_INLAY_KEY = "prefLibraryInlayEnabled";
const PREF_AO3_SAVED_FILTERS_KEY = "prefAo3SavedFiltersEnabled";
const PREF_METADATA_IMPROVE_KEY = "prefMetadataImproveEnabled";
const TRACE_USER_PRO_KEY = "traceUserPro";
const TRACE_FIRST_SAVE_SEEN_KEY = "traceFirstSaveSeen";
const TRACE_LIBRARY_COUNT_KEY = "traceLibraryCount";
const DEFAULT_TRACE_WEB_ORIGIN = "https://tracefiction.com";
const TRACE_WEB_ORIGIN = configuredTraceWebOrigin();
const TRACE_SESSION_MODE = globalThis.TRACE_SESSION_MODE || "legacy";
const KERNEL_SESSION_ACTIVE = TRACE_SESSION_MODE === "kernel";
const SESSION_DISABLED = TRACE_SESSION_MODE === "disabled";
const TRACE_HOME_URL = `${TRACE_WEB_ORIGIN}/`;
const TRACE_UPGRADE_URL = `${TRACE_HOME_URL}?upgrade=1&source=extension_cap`;
const TRACE_IOS_SETUP_URL = `${DEFAULT_TRACE_WEB_ORIGIN}/apps#safari-ios-setup`;
const TRACE_IOS_APP_CONNECT_URL = "traceauth://open?destination=extension-connect";
// Content-free link that only brings the Trace app forward; the app reconciles
// any confirmed first story itself. It carries no account, story, or URL.
const TRACE_IOS_APP_LIBRARY_URL = "traceauth://open?destination=library";
// On iPhone and iPad, Unlimited is offered only inside the Trace app: this
// fixed link opens its Unlimited sheet and carries no account or page data.
const TRACE_IOS_APP_UNLIMITED_URL = "traceauth://open?destination=unlimited";
const FREE_LIMIT_HEADS_UP_KEY = "traceFreeLimitHeadsUpV1";
const FREE_LIMIT_HEADS_UP_SHARE = 0.8;
const FREE_LIMIT_HEADS_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_PROJECTION_REVISION_KEY = "traceAccountProjectionRevisionV1";
const STORY_CONFIRMATION_PATIENCE_MS = 20000;
const AO3_WORKS_URL = "https://archiveofourown.org/works";
const FFN_HOME_URL = "https://www.fanfiction.net/";
const IOS_SIGN_IN_GUIDANCE =
  "In Safari, enable Trace in Extensions, allow it on tracefiction.com, AO3, and FFN, then sign in on tracefiction.com. Return to a supported story page to use Add to Trace or import.";
const IOS_PERMISSION_GUIDANCE =
  "If Safari still blocks Trace, enable the extension and allow it on tracefiction.com, AO3, and FFN. Then refresh the supported story page and use Add to Trace or import.";

function configuredTraceWebOrigin() {
  const configured =
    typeof globalThis !== "undefined" &&
    typeof globalThis.TRACE_EXTENSION_WEB_ORIGIN === "string"
      ? globalThis.TRACE_EXTENSION_WEB_ORIGIN.trim()
      : "";
  try {
    const URLCtor =
      typeof URL !== "undefined"
        ? URL
        : typeof window !== "undefined"
          ? window.URL
          : null;
    if (!URLCtor) return DEFAULT_TRACE_WEB_ORIGIN;
    return new URLCtor(configured || DEFAULT_TRACE_WEB_ORIGIN).origin;
  } catch {
    return DEFAULT_TRACE_WEB_ORIGIN;
  }
}

const isLikelyIosExtensionUi = (() => {
  try {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  } catch {
    return false;
  }
})();

if (isLikelyIosExtensionUi) {
  document.body.dataset.tracePlatform = "ios";
  document.documentElement.dataset.tracePlatform = "ios";
}

// Where "See Trace Unlimited" goes. iPadOS can report a Mac user agent, so
// touch and Safari's own platform report decide too; a desktop browser keeps
// the web plan page. Every Unlimited action waits for `upgradePlatformReady`
// before it opens anything.
function isSafariExtensionUi() {
  try {
    if (typeof location !== "undefined" && location.protocol === "safari-web-extension:") return true;
    const ua = navigator.userAgent || "";
    return /AppleWebKit/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
  } catch {
    return false;
  }
}

let upgradeOpensTraceApp = (() => {
  if (isLikelyIosExtensionUi) return true;
  try {
    return /Macintosh/i.test(navigator.userAgent || "") && (navigator.maxTouchPoints || 0) > 1;
  } catch {
    return false;
  }
})();
const upgradePlatformReady = (async () => {
  if (upgradeOpensTraceApp) return;
  let os = null;
  if (typeof ext?.runtime?.getPlatformInfo === "function") {
    try {
      const info = await extensionPromiseCall(ext.runtime, "getPlatformInfo");
      os = typeof info?.os === "string" ? info.os : null;
    } catch {
      os = null;
    }
  }
  // Safari without a platform report never falls back to the web plan page.
  if (os === "ios" || (os === null && isSafariExtensionUi())) upgradeOpensTraceApp = true;
})();

/** Opens an Unlimited action once the platform is known. */
function openUnlimited(webUrl = TRACE_UPGRADE_URL) {
  return upgradePlatformReady.then(() =>
    openTraceApp(upgradeOpensTraceApp ? TRACE_IOS_APP_UNLIMITED_URL : webUrl));
}

function upgradeDestinationUrl() {
  return upgradeOpensTraceApp ? TRACE_IOS_APP_UNLIMITED_URL : TRACE_UPGRADE_URL;
}

/** The Free Library size the account reports, or null while it is unknown. */
function accountLibraryLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * What follows the "Your Library is full" heading, in the Trace app's words.
 * The size is named only when the account has reported it.
 */
function libraryFullLead(limit) {
  const size = accountLibraryLimit(limit);
  return `${size === null ? "" : `${size} stories on Free. `}Everything saved stays. See Trace Unlimited, or remove a story to make room.`;
}

/**
 * The Free plan line: the Library count, and once at 80% a calm heads-up.
 * The heads-up shows for a day from first sight, then the plain count
 * returns; it can show again only after the Library drops back below 80%.
 * The Library size comes from the account. Nothing shows for Unlimited, or
 * while the plan, the count or the size is unknown.
 */
function freePlanLine({ pro, libraryCount, limit, headsUpShownAt = null, now = Date.now() }) {
  if (pro !== false || !Number.isSafeInteger(libraryCount) || libraryCount < 0) return null;
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  const nearLimit = libraryCount >= Math.ceil(limit * FREE_LIMIT_HEADS_UP_SHARE) && libraryCount < limit;
  const headsUp = nearLimit &&
    (headsUpShownAt == null || (now >= headsUpShownAt && now - headsUpShownAt < FREE_LIMIT_HEADS_UP_WINDOW_MS));
  return {
    text: headsUp
      ? `You’re at ${libraryCount} of ${limit} stories. Unlimited keeps every story.`
      : `${libraryCount} of ${limit} stories kept`,
    headsUp,
    nearLimit,
  };
}

// `undefined` until the stored heads-up record has been read.
let freeLimitHeadsUpShownAt;
// Which surfaces may show the plan line: the "Trace is on" sheet, and the
// reader view's settled states (a saved story, a list or another site).
const freePlanSlots = { sheet: false, reader: false };

/** Resolves the line for this popup opening and records the heads-up once. */
function currentFreePlanLine(model) {
  if (freeLimitHeadsUpShownAt === undefined) return null;
  const line = freePlanLine({
    pro: model.pro,
    libraryCount: model.libraryCount,
    limit: model.libraryLimit,
    headsUpShownAt: freeLimitHeadsUpShownAt,
  });
  if (!line) return null;
  if (line.headsUp && freeLimitHeadsUpShownAt === null) {
    freeLimitHeadsUpShownAt = Date.now();
    void extensionPromiseCall(ext.storage?.local, "set",
      [{ [FREE_LIMIT_HEADS_UP_KEY]: { shownAt: freeLimitHeadsUpShownAt } }]).catch(() => {});
  } else if (!line.nearLimit && freeLimitHeadsUpShownAt !== null && model.libraryCount < model.libraryLimit) {
    freeLimitHeadsUpShownAt = null;
    void extensionPromiseCall(ext.storage?.local, "set", [{ [FREE_LIMIT_HEADS_UP_KEY]: null }]).catch(() => {});
  }
  return line;
}

function renderFreePlanLines() {
  const visible = freePlanSlots.sheet || freePlanSlots.reader;
  const line = visible ? currentFreePlanLine(popupModel) : null;
  for (const [id, slot] of [["popup-plan", "sheet"], ["popup-earned-plan", "reader"]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const shown = Boolean(line && freePlanSlots[slot]);
    el.hidden = !shown;
    el.textContent = shown ? line.text : "";
    if (shown) el.dataset.headsUp = String(line.headsUp);
    else delete el.dataset.headsUp;
  }
}

void (async () => {
  try {
    const stored = await extensionPromiseCall(ext.storage?.local, "get", [[FREE_LIMIT_HEADS_UP_KEY]]);
    const shownAt = stored?.[FREE_LIMIT_HEADS_UP_KEY]?.shownAt;
    freeLimitHeadsUpShownAt = Number.isSafeInteger(shownAt) ? shownAt : null;
  } catch {
    freeLimitHeadsUpShownAt = null;
  }
  renderFreePlanLines();
})();

const ACTIVE_TAB_PROBE = globalThis.TRACE_IOS_ACTIVE_TAB_PROBE === true;
const EARNED_PERMISSION_ONBOARDING =
  globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING &&
  typeof globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING === "object"
    ? globalThis.TRACE_IOS_EARNED_PERMISSION_ONBOARDING
    : null;
const EARNED_PERMISSION_STATE_KEY = "traceEarnedPermissionOnboardingV1";
const EARNED_PERMISSION_FUNNEL_KEY = "traceEarnedPermissionFunnelV1";
const ARCHIVE_READINESS_KEY = "traceArchiveReadiness";
const MAX_EARNED_FUNNEL_EVENTS = 32;
const ACTIVE_TAB_PROBE_FILES = Object.freeze([
  "popup-config.js",
  "trace-finish-qualify.js",
  "collector.js",
]);
let earnedPreparedContext = null;
let earnedAwaitingStory = null;
let earnedCurrentPage = null;
// True in the popup that finished setup on a story page. That story's save
// is confirmed here even when it landed before this popup first looked.
let earnedSetupFinishedOnStory = false;
let kernelPopupInitialized = false;
let nativeImportContinuation = null;
let openTabsBusy = false;
let nativeImportGeneration = 0;
// Reader view only: whether the state on screen offers Import. Null in the
// ordinary popup, where the kind of page alone decides.
let readerImportOffered = null;
let popupStorySavePending = false;

const fallbackStatus = {
  state: "signed_out",
  message: isLikelyIosExtensionUi
    ? IOS_SIGN_IN_GUIDANCE
    : "Open Trace in this browser and sign in. Then return to an AO3 or FFN story page to save your first story.",
  helpUrl: isLikelyIosExtensionUi
    ? TRACE_IOS_SETUP_URL
    : TRACE_HOME_URL,
};

const popupModel = {
  authState: fallbackStatus,
  firstSaveSeen: false,
  libraryCount: null,
  libraryLimit: null,
  pro: null,
  activeTab: { kind: "unknown" },
  capacity: null,
  // True only in a package paired with the Trace app for Import.
  nativeImport: false,
};

function usefulActionUrl(rawUrl) {
  try {
    const URLCtor = typeof URL !== "undefined" ? URL : window.URL;
    const url = new URLCtor(rawUrl || TRACE_HOME_URL, TRACE_HOME_URL);
    if (url.pathname === "/apps" && url.hash === "#safari-ios-setup") {
      return url.href;
    }
    if (url.pathname === "/apps" || url.pathname === "/apps/") {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
    }
    return url.href;
  } catch {
    return TRACE_HOME_URL;
  }
}

function mergePopupModel(patch) {
  if (!patch || typeof patch !== "object") return;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) popupModel[key] = value;
  }
}

function recoveryHeading(state) {
  switch (state) {
    case "unknown":
      return "Checking Trace…";
    case "upgrade_required":
      return "Your Library is full";
    case "reconnect_required":
      return "Sign in again";
    case "error":
      return "Check Trace connection";
    case "signed_out":
      return "Connect Trace";
    default:
      return "Connect Trace";
  }
}

function recoveryCtaLabel(state) {
  if (
    isLikelyIosExtensionUi &&
    (state === "signed_out" ||
      state === "reconnect_required" ||
      state === "error")
  ) {
    return "Safari setup help";
  }
  switch (state) {
    case "unknown":
      return "Open Trace";
    case "upgrade_required":
      return "See Trace Unlimited";
    case "reconnect_required":
      return "Open Trace to reconnect";
    case "error":
      return "Open Trace for help";
    case "signed_out":
      return isLikelyIosExtensionUi ? "Safari setup help" : "Open Trace to sign in";
    default:
      return "Open Trace";
  }
}

function recoveryLead(auth, message) {
  if (!isLikelyIosExtensionUi) return message || fallbackStatus.message;
  if (auth === "signed_out") return IOS_SIGN_IN_GUIDANCE;
  if (auth === "reconnect_required" || auth === "error") {
    return message
      ? `${message} ${IOS_PERMISSION_GUIDANCE}`
      : IOS_PERMISSION_GUIDANCE;
  }
  return message || fallbackStatus.message;
}

function recoveryCtaUrl(auth, helpUrl) {
  if (auth === "upgrade_required" && upgradeOpensTraceApp) return TRACE_IOS_APP_UNLIMITED_URL;
  if (
    isLikelyIosExtensionUi &&
    (auth === "signed_out" ||
      auth === "reconnect_required" ||
      auth === "error")
  ) {
    return TRACE_IOS_SETUP_URL;
  }
  return helpUrl || fallbackStatus.helpUrl;
}

function activeTabSiteName(activeTab) {
  if (!activeTab || activeTab.site === "ao3") return "AO3";
  if (activeTab.site === "ffn") return "FFN";
  return "AO3/FFN";
}

function hasFirstSaveSignal(model) {
  const authState = model.authState || {};
  return Boolean(
    model.firstSaveSeen === true ||
      authState.firstSaveSeen === true ||
      authState.lastQuickAddAt ||
      authState.lastTrackSuccessAt ||
      authState.lastReaderStatusAt ||
      (typeof model.libraryCount === "number" && model.libraryCount > 0),
  );
}

function connectedImportLabel(activeTab) {
  if (!activeTab) return "Import from this page";
  if (activeTab.kind === "supported_story") return "Import this story";
  if (activeTab.kind === "supported_archive") return "Import this page";
  return "Import from this page";
}

function firstRunStoryLead(site) {
  const base = `Use Add to Trace on this ${site} page, or import it into Trace.`;
  return isLikelyIosExtensionUi
    ? `${base} If Add to Trace is missing in Safari, allow Trace for this site and refresh.`
    : base;
}

function firstRunArchiveLead(site) {
  const base = `Import this ${site} page, then save one story in Trace.`;
  return isLikelyIosExtensionUi
    ? `${base} If Safari prompts, allow Trace for this site.`
    : base;
}

function firstRunOpenArchiveLead() {
  return isLikelyIosExtensionUi
    ? "In Safari, allow Trace on AO3 and FFN, then open a supported story page and use Add to Trace or import from this popup."
    : "Open a supported story page, then use Add to Trace or import from this popup.";
}

function buildPopupUi(model) {
  const authState = model.authState || fallbackStatus;
  const auth = authState.state || fallbackStatus.state;
  const activeTab = model.activeTab || { kind: "unknown" };

  if (auth === "connected" && model.capacity?.blocked === true) {
    return {
      visualState: "upgrade_required",
      statusState: "connected",
      eyebrow: "",
      heading: "Your Library is full",
      glyph: "tray",
      lead: libraryFullLead(model.libraryLimit),
      leadHidden: false,
      ctaHidden: false,
      ctaLabel: "See Trace Unlimited",
      ctaUrl: upgradeDestinationUrl(),
      ctaUnlimited: true,
      ctaEmphasis: "primary",
      archiveLinksHidden: true,
      importHidden: true,
      importDisabled: true,
      importLabel: "Import from this page",
      importTitle: `Your Library is full. ${libraryFullLead(model.libraryLimit)}`,
    };
  }

  if (auth !== "connected") {
    return {
      visualState: auth,
      statusState: auth,
      eyebrow: "",
      heading: recoveryHeading(auth),
      glyph: auth === "unknown" ? "" : auth === "upgrade_required" ? "tray" : "person",
      lead: auth === "upgrade_required"
        ? libraryFullLead(model.libraryLimit)
        : recoveryLead(auth, authState.message),
      leadHidden: false,
      ctaHidden: false,
      ctaLabel: recoveryCtaLabel(auth),
      ctaUrl: recoveryCtaUrl(auth, authState.helpUrl),
      ctaUnlimited: auth === "upgrade_required",
      ctaEmphasis: "primary",
      archiveLinksHidden: true,
      importHidden: true,
      importDisabled: true,
      importLabel: "Import from this page",
      importTitle: "Sign in to Trace before importing from AO3 or FFN.",
    };
  }

  const firstSaveSeen = hasFirstSaveSignal(model);
  if (!firstSaveSeen) {
    if (activeTab.kind === "supported_story") {
      const site = activeTabSiteName(activeTab);
      return {
        visualState: "connected_first_run",
        statusState: "connected",
        eyebrow: "",
        heading: "Save this story",
        lead: firstRunStoryLead(site),
        leadHidden: false,
        ctaHidden: false,
        ctaLabel: "Open Library",
        ctaUrl: TRACE_HOME_URL,
        ctaEmphasis: "secondary",
        archiveLinksHidden: true,
        importHidden: false,
        importDisabled: false,
        importLabel: "Import this story",
        importTitle: "Open Trace import for this story page.",
      };
    }
    if (activeTab.kind === "supported_archive") {
      const site = activeTabSiteName(activeTab);
      return {
        visualState: "connected_first_run",
        statusState: "connected",
        eyebrow: "",
        heading: "Import this page",
        lead: firstRunArchiveLead(site),
        leadHidden: false,
        ctaHidden: false,
        ctaLabel: "Open Library",
        ctaUrl: TRACE_HOME_URL,
        ctaEmphasis: "secondary",
        archiveLinksHidden: true,
        importHidden: false,
        importDisabled: false,
        importLabel: "Import this page",
        importTitle: "Open Trace import for this supported archive page.",
      };
    }
    if (activeTab.kind === "blocked_archive") {
      return {
        visualState: "connected_first_run",
        statusState: "connected",
        eyebrow: "",
        heading: "Open a story page",
        lead: "Trace saves from supported AO3/FFN story and listing pages, not sign-in pages.",
        leadHidden: false,
        ctaHidden: true,
        ctaLabel: "Open Library",
        ctaUrl: TRACE_HOME_URL,
        ctaEmphasis: "secondary",
        archiveLinksHidden: false,
        importHidden: true,
        importDisabled: true,
        importLabel: "Import from this page",
        importTitle: "Open a supported AO3 or FFN story page before importing.",
      };
    }
    return {
      visualState: "connected_first_run",
      statusState: "connected",
      eyebrow: "",
      heading: "Open AO3 or FFN",
      lead: firstRunOpenArchiveLead(),
      leadHidden: false,
      ctaHidden: true,
      ctaLabel: "Open Library",
      ctaUrl: TRACE_HOME_URL,
      ctaEmphasis: "secondary",
      archiveLinksHidden: false,
      importHidden: true,
      importDisabled: true,
      importLabel: "Import from this page",
      importTitle: "Open a supported AO3 or FFN story page before importing.",
    };
  }

  const canImport =
    activeTab.kind === "supported_story" ||
    activeTab.kind === "supported_archive" ||
    activeTab.kind === "unknown";

  return {
    visualState: "connected_saved",
    statusState: "connected",
    eyebrow: "",
    heading: "Trace is on",
    lead: "",
    leadHidden: true,
    ctaHidden: false,
    ctaLabel: "Open Library",
    ctaUrl: TRACE_HOME_URL,
    ctaEmphasis: "secondary",
    archiveLinksHidden: true,
    importHidden: !canImport,
    importDisabled: false,
    importLabel: connectedImportLabel(activeTab),
    importTitle: canImport
      ? "Open Trace import for this page."
      : "Open a supported AO3 or FFN page before importing.",
  };
}

/**
 * The Import control for the view on screen. The ordinary popup follows the
 * kind of page. The reader view also needs its current state to offer Import,
 * and always uses the label the Trace app points readers to.
 */
function importUiFor(model) {
  const ui = buildPopupUi(model);
  if (readerImportOffered === null) return ui;
  return {
    ...ui,
    importHidden: ui.importHidden || readerImportOffered !== true,
    importLabel: "Import from this page",
  };
}

function renderStatus(patch) {
  setImportRecoveryHelp();
  mergePopupModel(patch);
  const ui = buildPopupUi(popupModel);
  const importUi = importUiFor(popupModel);
  const statusEl = document.getElementById("popup-status");
  const leadEl = document.getElementById("popup-lead");
  const ctaEl = document.getElementById("popup-cta");
  const importEl = document.getElementById("popup-import");
  const archiveLinksEl = document.getElementById("popup-archive-links");
  const settingsEl = document.getElementById("popup-pro-settings");
  const preferencesEl = document.getElementById("popup-preferences");
  const eyebrowEl = document.querySelector(".popup-eyebrow");
  document.body.dataset.tracePopupState = ui.visualState;

  if (statusEl) {
    statusEl.dataset.state = ui.statusState;
    statusEl.textContent = ui.heading;
  }
  setStatusGlyph(ui.glyph || "", ui.glyphTone || "");

  if (eyebrowEl) {
    eyebrowEl.hidden = !ui.eyebrow;
    eyebrowEl.textContent = ui.eyebrow || "";
  }

  if (leadEl) {
    leadEl.hidden = ui.leadHidden;
    leadEl.textContent = ui.leadHidden ? "" : ui.lead;
  }

  if (ctaEl) {
    ctaEl.hidden = ui.ctaHidden;
    ctaEl.dataset.externalUrl = usefulActionUrl(ui.ctaUrl);
    if (ui.ctaUnlimited) ctaEl.dataset.unlimited = "1";
    else delete ctaEl.dataset.unlimited;
    delete ctaEl.dataset.sessionAction;
    ctaEl.textContent = ui.ctaLabel;
    ctaEl.dataset.emphasis = ui.ctaEmphasis;
  }

  if (archiveLinksEl) {
    archiveLinksEl.hidden = ui.archiveLinksHidden;
  }

  if (importEl) {
    importEl.hidden = importUi.importHidden;
    importEl.disabled = importUi.importDisabled;
    importEl.textContent = importUi.importLabel;
    importEl.title = importUi.importTitle || "";
  }

  if (settingsEl && ui.statusState !== "connected") {
    settingsEl.classList.add("hidden");
  }
  freePlanSlots.sheet = ui.visualState === "connected_saved";
  renderFreePlanLines();
  if (preferencesEl) preferencesEl.hidden = ui.statusState !== "connected";
  renderNativeImportContinuation(popupModel.authState);
}

function updatePreferenceSummary() {
  const countEl = document.getElementById("popup-preferences-count");
  if (!countEl) return;
  const inputs = Array.from(
    document.querySelectorAll("#popup-preferences input[type='checkbox']"),
  );
  const enabled = inputs.filter((input) => input.checked).length;
  countEl.textContent = `${enabled} of ${inputs.length} on`;
}

function applyLocalUi(ao3SavedFilters) {
  const ao3SavedFiltersEl = document.getElementById("pref-ao3-saved-filters");
  if (!ao3SavedFiltersEl) return;
  ao3SavedFiltersEl.checked = ao3SavedFilters !== false;
  updatePreferenceSummary();
}

function applyProUi(pro, autoTrack, libraryInlay, metadataImprove) {
  const section = document.getElementById("popup-pro-settings");
  const autoEl = document.getElementById("pref-auto-track");
  const inlayEl = document.getElementById("pref-library-inlay");
  const metadataEl = document.getElementById("pref-metadata-improve");
  if (!section || !autoEl || !inlayEl || !metadataEl) return;
  if ((popupModel.authState || {}).state === "connected") {
    section.classList.remove("hidden");
  } else {
    section.classList.add("hidden");
  }
  autoEl.checked = Boolean(autoTrack);
  inlayEl.checked = Boolean(libraryInlay);
  metadataEl.checked = metadataImprove !== false;
  updatePreferenceSummary();
}

function fetchPopupState() {
  ext.runtime.sendMessage({ type: "TRACE_POPUP_GET_STATE" }, (s) => {
    if (ext.runtime.lastError || !s) return;
    renderStatus({
      authState: s.authState || undefined,
      firstSaveSeen: s.firstSaveSeen === true,
      libraryCount:
        typeof s.libraryCount === "number" ? s.libraryCount : undefined,
      libraryLimit: accountLibraryLimit(s.libraryLimit),
      pro: typeof s.pro === "boolean" ? s.pro : undefined,
      activeTab: s.activeTab || undefined,
      capacity: s.capacity ?? null,
    });
    applyLocalUi(s.ao3SavedFiltersEnabled);
    applyProUi(
      s.pro,
      s.autoTrackEnabled,
      s.libraryInlayEnabled,
      s.metadataImproveEnabled,
    );
  });
}

function applyProUiFromStorage() {
  ext.storage.local.get(
    [
      TRACE_USER_PRO_KEY,
      PREF_AUTO_TRACK_KEY,
      PREF_LIBRARY_INLAY_KEY,
      PREF_AO3_SAVED_FILTERS_KEY,
      PREF_METADATA_IMPROVE_KEY,
    ],
    (r) => {
      if (ext.runtime.lastError) return;
      const pro = r[TRACE_USER_PRO_KEY] === true;
      applyLocalUi(r[PREF_AO3_SAVED_FILTERS_KEY] !== false);
      applyProUi(
        pro,
        r[PREF_AUTO_TRACK_KEY] !== false,
        r[PREF_LIBRARY_INLAY_KEY] !== false,
        r[PREF_METADATA_IMPROVE_KEY] !== false,
      );
    },
  );
}

function readAndRender() {
  ext.storage.local.get(
    [STATUS_KEY, TRACE_FIRST_SAVE_SEEN_KEY, TRACE_LIBRARY_COUNT_KEY],
    (result) => {
      renderStatus({
        authState: result?.[STATUS_KEY] || fallbackStatus,
        firstSaveSeen: result?.[TRACE_FIRST_SAVE_SEEN_KEY] === true,
        libraryCount:
          typeof result?.[TRACE_LIBRARY_COUNT_KEY] === "number"
            ? result[TRACE_LIBRARY_COUNT_KEY]
            : null,
      });
    },
  );
}

function resetImportButtonAfterFailure(button, error) {
  renderStatus();
  button.title =
    error ||
    "Open an AO3 or FanFiction.net tab and refresh it after updating the extension.";
}

function currentImportLabel() {
  return importUiFor(popupModel).importLabel || "Import from this page";
}

function currentImportTitle() {
  return importUiFor(popupModel).importTitle || "";
}

function isImportCurrentlyAvailable() {
  const ui = importUiFor(popupModel);
  return !ui.importHidden && !ui.importDisabled;
}

function restoreImportButton(button) {
  setImportRecoveryHelp();
  const ui = importUiFor(popupModel);
  button.hidden = ui.importHidden;
  button.disabled = ui.importDisabled;
  button.textContent = ui.importLabel;
  button.title = ui.importTitle || "";
}

function classifyProbeStory(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const ao3Host =
      host === "archiveofourown.org" ||
      host.endsWith(".archiveofourown.org") ||
      host === "archiveofourown.gay" ||
      host.endsWith(".archiveofourown.gay") ||
      host === "archive.transformativeworks.org";
    // AO3 also serves a work through a collection, at
    // /collections/<name>/works/<id>. That one prefix is removed, as the
    // background removes it, and the work path is judged as it always was.
    const ao3Path = url.pathname.replace(/^\/collections\/[A-Za-z0-9_]{1,255}(?=\/works\/)/, "");
    if (ao3Host && /^\/works\/[1-9][0-9]*(?:\/chapters\/[1-9][0-9]*)?\/?$/.test(ao3Path)) {
      return { ok: true, site: "AO3" };
    }
    const ffnHost = host === "www.fanfiction.net" || host === "m.fanfiction.net";
    if (ffnHost && /^\/s\/[1-9][0-9]*(?:\/[1-9][0-9]*)?(?:\/[^/]+)?\/?$/.test(url.pathname)) {
      return { ok: true, site: "FanFiction.net" };
    }
  } catch {
    // A missing or hidden URL is a failed activeTab capability signal.
  }
  return { ok: false, site: null };
}

function classifyEarnedPage(rawUrl) {
  const story = classifyProbeStory(rawUrl);
  if (story.ok) return { ...story, kind: "story" };
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return { ok: false, site: null };
    const host = url.hostname.toLowerCase();
    const ao3Host =
      host === "archiveofourown.org" ||
      host.endsWith(".archiveofourown.org") ||
      host === "archiveofourown.gay" ||
      host.endsWith(".archiveofourown.gay") ||
      host === "archive.transformativeworks.org";
    if (ao3Host && !/^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(url.pathname)) {
      return { ok: true, kind: "archive", site: "AO3" };
    }
    if (
      (host === "www.fanfiction.net" || host === "m.fanfiction.net") &&
      !/^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(url.pathname)
    ) {
      return { ok: true, kind: "archive", site: "FanFiction.net" };
    }
  } catch {
    // A missing or hidden URL is not a supported-site capability signal.
  }
  return { ok: false, site: null };
}

async function probeQueryActiveTab() {
  if (!ext?.tabs?.query) throw new Error("active_tab_unavailable");
  if (USES_BROWSER_PROMISE_API) {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return Array.isArray(tabs) ? tabs[0] : null;
  }
  return await new Promise((resolve, reject) => {
    ext.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (ext.runtime.lastError) reject(new Error("active_tab_unavailable"));
      else resolve(Array.isArray(tabs) ? tabs[0] : null);
    });
  });
}

function isDirectProbeMessage(message) {
  return ACTIVE_TAB_PROBE && ["TRACE_ACTIVE_TAB_PROBE_PING", "TRACE_ACTIVE_TAB_PROBE_SAVE"].includes(message.type);
}

async function probeSendTabMessage(tabId, message) {
  if (KERNEL_SESSION_ACTIVE && !isDirectProbeMessage(message)) {
    return extensionPromiseCall(ext.runtime, "sendMessage", [{
      type: "TRACE_POPUP_PAGE_RELAY", tabId, command: message,
    }]);
  }
  if (!ext?.tabs?.sendMessage) throw new Error("message_unavailable");
  if (USES_BROWSER_PROMISE_API) return await ext.tabs.sendMessage(tabId, message);
  return await new Promise((resolve, reject) => {
    ext.tabs.sendMessage(tabId, message, (response) => {
      if (ext.runtime.lastError) reject(new Error("message_unavailable"));
      else resolve(response);
    });
  });
}

async function probeInject(tabId) {
  if (!ext?.scripting?.executeScript) throw new Error("scripting_unavailable");
  const injection = { target: { tabId }, files: [...ACTIVE_TAB_PROBE_FILES] };
  if (USES_BROWSER_PROMISE_API) return await ext.scripting.executeScript(injection);
  return await new Promise((resolve, reject) => {
    ext.scripting.executeScript(injection, (result) => {
      if (ext.runtime.lastError) reject(new Error("injection_failed"));
      else resolve(result);
    });
  });
}

function setProbeCheck(id, state, label) {
  const row = document.getElementById(id);
  if (!row) return;
  row.dataset.state = state;
  const value = row.querySelector(".popup-probe-check-value");
  if (value) value.textContent = label;
}

function setProbeResult(state, heading, detail) {
  const result = document.getElementById("popup-probe-result");
  const headingEl = document.getElementById("popup-probe-result-heading");
  const detailEl = document.getElementById("popup-probe-result-detail");
  if (result) result.dataset.state = state;
  if (headingEl) headingEl.textContent = heading;
  if (detailEl) detailEl.textContent = detail;
}

function resetProbeUi() {
  setProbeCheck("popup-probe-opened", "pass", "Confirmed");
  setProbeCheck("popup-probe-story", "checking", "Checking");
  setProbeCheck("popup-probe-access", "waiting", "Waiting");
  setProbeCheck("popup-probe-save", "waiting", "Waiting");
  setProbeResult("checking", "Running capability test…", "Keep this popup open for a moment.");
}

function probeFailureCopy(reason) {
  if (reason === "unsupported_page") {
    return ["Open a supported story", "Open an AO3 or FanFiction.net story page, then open Trace from Safari’s toolbar."];
  }
  if (reason === "not_authenticated" || reason === "auth_expired") {
    return ["Trace is not connected", "Open the Trace app, sign in, then return to this story and retry."];
  }
  if (reason === "free_limit_reached") {
    return ["Library limit reached", "Make room in your Trace library, then retry this test."];
  }
  if (reason === "rate_limited") {
    return ["Trace needs a moment", "Wait briefly, then retry the test."];
  }
  if (reason === "injection_failed" || reason === "current_tab_denied") {
    return ["Current-tab access failed", "Safari did not let Trace run on this tab without website access."];
  }
  return ["Save could not be confirmed", "Check your connection and retry. Record this probe as failed if it repeats."];
}

function extensionPromiseCall(target, method, args = []) {
  if (!target || typeof target[method] !== "function") {
    return Promise.reject(new Error(`${method}_unavailable`));
  }
  if (USES_BROWSER_PROMISE_API) {
    try {
      return Promise.resolve(target[method](...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    try {
      target[method](...args, (value) => {
        const message = ext.runtime.lastError?.message;
        if (message) reject(new Error(message));
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function earnedStorageGet(keys) {
  return extensionPromiseCall(ext.storage?.local, "get", [keys]);
}

function earnedStorageSet(patch) {
  return extensionPromiseCall(ext.storage?.local, "set", [patch]);
}

async function recordEarnedEvent(event) {
  try {
    const values = await earnedStorageGet(EARNED_PERMISSION_FUNNEL_KEY);
    const previous = Array.isArray(values?.[EARNED_PERMISSION_FUNNEL_KEY])
      ? values[EARNED_PERMISSION_FUNNEL_KEY]
      : [];
    const next = [
      ...previous.filter(
        (entry) =>
          entry &&
          typeof entry.event === "string" &&
          typeof entry.at === "number",
      ),
      { event, at: Date.now() },
    ].slice(-MAX_EARNED_FUNNEL_EVENTS);
    await earnedStorageSet({ [EARNED_PERMISSION_FUNNEL_KEY]: next });
  } catch {
    // Probe evidence is best effort and never blocks a save or permission action.
  }
}

function normalizedEarnedState(value) {
  if (!value || typeof value !== "object") return {};
  return {
    firstSaveAt:
      typeof value.firstSaveAt === "number" && value.firstSaveAt > 0
        ? value.firstSaveAt
        : null,
    grantAt:
      typeof value.grantAt === "number" && value.grantAt > 0
        ? value.grantAt
        : null,
    registrationVersion:
      Number.isInteger(value.registrationVersion) && value.registrationVersion > 0
        ? value.registrationVersion
        : null,
    promptResult:
      value.promptResult === "granted" || value.promptResult === "declined"
        ? value.promptResult
        : null,
    completedAt:
      typeof value.completedAt === "number" && value.completedAt > 0
        ? value.completedAt
        : null,
  };
}

async function readEarnedState() {
  const values = await earnedStorageGet([
    EARNED_PERMISSION_STATE_KEY,
    ARCHIVE_READINESS_KEY,
  ]);
  return {
    onboarding: normalizedEarnedState(values?.[EARNED_PERMISSION_STATE_KEY]),
    readiness:
      values?.[ARCHIVE_READINESS_KEY] &&
      typeof values[ARCHIVE_READINESS_KEY] === "object"
        ? values[ARCHIVE_READINESS_KEY]
        : {},
  };
}

async function writeEarnedState(patch) {
  const current = await readEarnedState();
  const next = { ...current.onboarding, ...patch };
  await earnedStorageSet({ [EARNED_PERMISSION_STATE_KEY]: next });
  return next;
}

function earnedOrigins() {
  return Array.isArray(EARNED_PERMISSION_ONBOARDING?.origins)
    ? EARNED_PERMISSION_ONBOARDING.origins.filter(
        (origin) => typeof origin === "string" && origin.length > 0,
      )
    : [];
}

async function readGrantedOrigins() {
  try {
    const response = await extensionPromiseCall(ext.permissions, "getAll");
    return Array.isArray(response?.origins)
      ? response.origins.filter((origin) => typeof origin === "string")
      : [];
  } catch {
    return [];
  }
}

function hasCompleteEarnedGrant(grantedOrigins) {
  const granted = new Set(grantedOrigins);
  const required = earnedOrigins();
  return required.length > 0 && required.every((origin) => granted.has(origin));
}

async function readCompleteEarnedGrant(grantedOrigins = null) {
  const required = earnedOrigins();
  if (required.length === 0) return false;
  if (typeof ext.permissions?.contains === "function") {
    try {
      return (
        (await extensionPromiseCall(ext.permissions, "contains", [
          { origins: required },
        ])) === true
      );
    } catch {
      // Fall through to exact snapshots on engines without a usable contains().
    }
  }
  const snapshot = Array.isArray(grantedOrigins)
    ? grantedOrigins
    : await readGrantedOrigins();
  return hasCompleteEarnedGrant(snapshot);
}

function setEarnedCheck(id, state, label, rowLabel = null) {
  setProbeCheck(id, state, label);
  if (rowLabel) {
    const labelEl = document
      .getElementById(id)
      ?.querySelector(".popup-probe-check-label");
    if (labelEl) labelEl.textContent = rowLabel;
  }
}

const POPUP_GLYPHS = Object.freeze({
  check: { viewBox: "0 0 15 12", width: "2.2", path: ["M1.5 6.5 5.5 10.5 13.5 1.5"] },
  globe: { viewBox: "0 0 16 16", width: "1.4", circle: ["8", "8", "6.5"],
    path: ["M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13"] },
  alert: { viewBox: "0 0 20 18", width: "1.6", path: [
    "M8.7 1.8a1.5 1.5 0 0 1 2.6 0l7.4 13a1.5 1.5 0 0 1-1.3 2.2H2.6a1.5 1.5 0 0 1-1.3-2.2z",
    "M10 6.3v4.6",
  ], dot: ["10", "13.4", ".6"] },
  info: { viewBox: "0 0 16 16", width: "1.5", circle: ["8", "8", "6.3"], path: ["M8 7.2v4"], dot: ["8", "4.9", ".7"] },
  person: { viewBox: "0 0 16 16", width: "1.5", circle: ["8", "5.3", "2.7"],
    path: ["M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3"] },
  tray: { viewBox: "0 0 16 16", width: "1.5", path: ["M2 9.5l1.8-6h8.4l1.8 6v3.5H2z", "M2 9.5h3.5l1 1.5h3l1-1.5H14"] },
  wifiOff: { viewBox: "0 0 16 16", width: "1.5", path: [
    "M1.5 6a9.5 9.5 0 0 1 13 0M4 8.7a6 6 0 0 1 8 0M6.4 11.2a2.5 2.5 0 0 1 3.2 0", "M2 2l12 12",
  ] },
  menuCheck: { viewBox: "0 0 16 16", width: "2", path: ["M3 8.5l3.2 3.2L13 4.8"] },
  progress: { viewBox: "0 0 16 16", width: "1.8", path: ["M8 1.8a6.2 6.2 0 1 1-6.2 6.2"] },
});

/**
 * State glyphs sit inline with a headline, one em square and hidden from
 * assistive technology. Warning ink marks failures only.
 */
function setGlyphSlot(slot, name, tone) {
  if (!slot) return;
  slot.hidden = !name;
  if (tone) slot.dataset.tone = tone;
  else delete slot.dataset.tone;
  slot.replaceChildren(...(name ? [popupGlyph(name)] : []));
}

function setStatusGlyph(name, tone) {
  setGlyphSlot(document.getElementById("popup-status-glyph"), name, tone);
}

function popupSvg(viewBox, width = "1.8") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", width);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function popupSvgShape(svg, name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  svg.appendChild(node);
}

function popupGlyph(name) {
  const definition = POPUP_GLYPHS[name] || POPUP_GLYPHS.check;
  const svg = popupSvg(definition.viewBox, definition.width);
  if (definition.circle) {
    const [cx, cy, r] = definition.circle;
    popupSvgShape(svg, "circle", { cx, cy, r });
  }
  for (const d of definition.path) popupSvgShape(svg, "path", { d });
  if (definition.dot) {
    const [cx, cy, r] = definition.dot;
    popupSvgShape(svg, "circle", { cx, cy, r, fill: "currentColor" });
  }
  return svg;
}

function setEarnedEmphasizedCopy(element, markup) {
  element.replaceChildren();
  const parts = String(markup).split(/(<b>[^<]*<\/b>)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("<b>") && part.endsWith("</b>")) {
      const bold = document.createElement("b");
      bold.textContent = part.slice(3, -4);
      element.appendChild(bold);
    } else {
      element.appendChild(document.createTextNode(part));
    }
  }
}

let lastEarnedAnnouncement = "";
let earnedAnnouncementTimer = null;

/** "Title by Author", either part alone, or nothing: never a stand-in. */
function storyNameForAnnouncement() {
  const headingEl = document.getElementById("popup-earned-heading");
  const title = headingEl?.dataset.recordTitle === "true" ? headingEl.textContent?.trim() || "" : "";
  const byline = document.getElementById("popup-earned-record-byline")?.textContent?.trim() || "";
  const author = byline.includes(" · ") ? byline.split(" · ")[0].trim() : "";
  if (!title) return "";
  return author ? `${title} by ${author}` : title;
}

function earnedAnnouncementForState(code, heading, detail) {
  switch (code) {
    case "P1": return "Saving this story. Keep reading. You’ll see a note on the page once it’s saved.";
    case "P2": {
      const already = heading.startsWith("Already");
      const name = storyNameForAnnouncement();
      const said = `${already ? "Already in your Library" : "Saved to your Library"}${name ? `: ${name}` : ""}.`;
      return already ? said : `${said} Trace keeps your place as you read.`;
    }
    case "P5": return "Still saving. Keep reading. If it’s not in your Library in a minute, reload this page.";
    case "P6": return "Finish setup in the Trace app. Create an account or sign in, then come back.";
    case "connecting-account": return "Connecting to your account.";
    case "account-unreachable": return "Trace couldn’t connect to your account. Open Trace, then come back.";
    case "P8": return [heading, detail].filter(Boolean).join(" ");
    case "P9": return "This story isn’t available. Nothing was saved.";
    case "P10": return `Automatic saving is off. ${document.getElementById("popup-earned-record-title")?.textContent?.trim() || "This story"} is not in your Library.`;
    case "P11": return "";
    default: return [heading, detail].filter(Boolean).join(" ");
  }
}

function setEarnedResult(state, heading, detail) {
  const result = document.getElementById("popup-earned-result");
  if (!result) return;
  result.dataset.state = state;
  const code = document.body.dataset.tracePopupStateCode || "";
  const announcement = earnedAnnouncementForState(code, heading || "", detail || "");
  const signature = `${code}\u0000${announcement}`;
  if (signature === lastEarnedAnnouncement) return;
  lastEarnedAnnouncement = signature;
  if (earnedAnnouncementTimer !== null) clearTimeout(earnedAnnouncementTimer);
  result.textContent = "";
  if (announcement) {
    earnedAnnouncementTimer = setTimeout(() => {
      earnedAnnouncementTimer = null;
      result.textContent = announcement;
    }, 0);
  }
}

function focusEarnedHeadingIfLost(element) {
  if (!element || element === document.body) return;
  if (element.isConnected && !element.hidden && !element.disabled && !element.closest("[hidden]")) return;
  document.getElementById("popup-earned-heading")?.focus({ preventScroll: true });
}

function refreshEarnedLayout() {
  const section = document.getElementById("popup-earned-permission");
  const pin = document.getElementById("popup-earned-pin");
  if (!section || section.hidden || !pin) return;
  section.classList.remove("popup-earned-fixed-pin");
  const bodySize = parseFloat(window.getComputedStyle(document.body).fontSize) || 17;
  const textAx = bodySize >= 28;
  const scroll = section.querySelector(".popup-earned-scroll");
  // The first-tap sheet on a sheet too short for it keeps only the rule line
  // and the main button in reach; see placeFirstTapSecondary.
  const shortSheet = Boolean(document.body.dataset.traceFirstTapState) &&
    placeFirstTapSecondary(scroll, pin, textAx);
  const pinHeight = pin.getBoundingClientRect().height;
  const ax = !shortSheet && (textAx || pinHeight > window.innerHeight * 0.3);
  section.classList.toggle("popup-earned-ax", ax);
  section.classList.toggle("popup-earned-text-ax", textAx);
  const needsPin = shortSheet || (!ax && !pin.hidden && scroll &&
    scroll.scrollHeight + pinHeight > window.innerHeight + 1);
  section.style.setProperty("--trace-pin-height", `${Math.ceil(pinHeight)}px`);
  section.classList.toggle("popup-earned-fixed-pin", Boolean(needsPin));
}

/**
 * The reader view replaces the ordinary popup's action area, so Import moves
 * into it: one control and one set of handlers, shown above Settings.
 */
function placeImportInReaderView() {
  const extras = document.getElementById("popup-earned-extras");
  const settings = document.getElementById("popup-earned-settings-row");
  if (!extras || !settings || settings.parentNode !== extras) return;
  for (const id of ["popup-import", "popup-import-recovery-help", "popup-import-open-tabs", "popup-open-tabs-help", "popup-import-open-native"]) {
    const element = document.getElementById(id);
    if (element && element.parentNode !== extras) extras.insertBefore(element, settings);
  }
}

/**
 * Says whether the reader view's current state offers Import, and returns
 * whether anything of Import is showing. It is offered only on a settled,
 * importable page, in a package paired with the Trace app.
 */
function setReaderImport(offered) {
  placeImportInReaderView();
  const next = offered === true && popupModel.nativeImport === true;
  const changed = readerImportOffered !== next;
  readerImportOffered = next;
  const button = document.getElementById("popup-import");
  const link = document.getElementById("popup-import-open-native");
  if (!button) return false;
  if (!next) {
    setImportRecoveryHelp();
    button.hidden = true;
  } else if (changed || (button.hidden && (!link || link.hidden))) {
    // Rendering the same state again leaves the control as it is, so a
    // request in flight or its outcome stays on screen.
    restoreImportButton(button);
  }
  renderNativeImportContinuation(popupModel.authState);
  return !button.hidden || Boolean(link && !link.hidden) || !document.getElementById("popup-import-open-tabs")?.hidden;
}

/**
 * What holds the body: the body itself, and beside it, where the ask shows
 * it, the picture of Safari's question. Whatever comes after the body goes
 * after this.
 */
function earnedLeadRow() {
  return document.getElementById("popup-earned-lead-row") || document.getElementById("popup-earned-lead");
}

/** The record sits under the headline, or after the body where a state asks. */
function placeEarnedRecord(afterBody) {
  const record = document.getElementById("popup-earned-record");
  const anchor = afterBody ? earnedLeadRow() : document.getElementById("popup-earned-heading-row");
  if (record && anchor && anchor.nextElementSibling !== record) anchor.after(record);
}

/** Puts back what only some states change, so no state inherits another's. */
function resetEarnedSheetExtras() {
  placeEarnedRecord(false);
  for (const id of ["popup-earned-ask", "popup-earned-note", "popup-earned-prompt"]) {
    const box = document.getElementById(id);
    if (box) box.hidden = true;
  }
  document.getElementById("popup-earned-primary")?.removeAttribute("aria-describedby");
}

function setEarnedCopy({
  stateCode = "",
  kicker = "",
  kickerIcon = "",
  glyph = "",
  glyphTone = "",
  failure = null,
  heading = "",
  headingMarkup = "",
  lead = "",
  leadMarkup = "",
  record = null,
  ruleMarkup = "",
  duplicateRule = false,
  helpLabel = "Need another way?",
  disclosure = "",
  returning = false,
  importable = false,
}) {
  const previouslyFocused = document.activeElement;
  document.body.dataset.tracePopupStateCode = stateCode;
  // Only the reader view's settled states show the plan line; they turn it
  // back on after their copy is set.
  freePlanSlots.reader = false;
  renderFreePlanLines();
  setEarnedRecord(record);
  resetEarnedSheetExtras();
  const section = document.getElementById("popup-earned-permission");
  const kickerEl = document.getElementById("popup-earned-kicker");
  const kickerText = document.getElementById("popup-earned-kicker-text");
  const kickerGlyph = document.getElementById("popup-earned-kicker-icon");
  const headingEl = document.getElementById("popup-earned-heading");
  const leadEl = document.getElementById("popup-earned-lead");
  const ruleEl = document.getElementById("popup-earned-rule");
  const helpEl = document.getElementById("popup-earned-help");
  const extrasEl = document.getElementById("popup-earned-extras");
  if (kickerEl) kickerEl.hidden = !kicker;
  if (kickerText) kickerText.textContent = kicker;
  if (kickerGlyph) kickerGlyph.replaceChildren(...(kickerIcon ? [popupGlyph(kickerIcon)] : []));
  setGlyphSlot(document.getElementById("popup-earned-heading-glyph"), glyph, glyphTone);
  const headingRow = document.getElementById("popup-earned-heading-row");
  if (headingRow) headingRow.dataset.recordTitle = record && record.heading ? "true" : "false";
  if (headingEl) {
    if (headingMarkup) setEarnedEmphasizedCopy(headingEl, headingMarkup);
    else headingEl.textContent = heading;
    headingEl.dataset.recordTitle = record && record.heading ? "true" : "false";
  }
  setEarnedFailure(failure);
  if (leadEl) {
    leadEl.hidden = !(lead || leadMarkup);
    if (leadMarkup) setEarnedEmphasizedCopy(leadEl, leadMarkup);
    else leadEl.textContent = lead;
  }
  if (ruleEl) {
    ruleEl.hidden = !ruleMarkup;
    setEarnedEmphasizedCopy(ruleEl, ruleMarkup);
    if (duplicateRule) ruleEl.setAttribute("aria-hidden", "true");
    else ruleEl.removeAttribute("aria-hidden");
  }
  const importShowing = setReaderImport(importable);
  if (extrasEl) extrasEl.hidden = !(returning || importShowing);
  const helpSummaryEl = document.getElementById("popup-earned-help-summary");
  const disclosureEl = document.getElementById("popup-earned-disclosure");
  if (helpSummaryEl) helpSummaryEl.textContent = helpLabel;
  if (disclosureEl) disclosureEl.textContent = disclosure;
  if (helpEl) {
    helpEl.hidden = !disclosure;
    if (!disclosure) helpEl.open = false;
  }
  if (section) section.hidden = false;
  refreshEarnedLayout();
  focusEarnedHeadingIfLost(previouslyFocused);
}

const POPUP_STATUS_CHOICES = Object.freeze(["SAVED", "READING", "CAUGHT_UP", "PAUSED", "FINISHED", "DROPPED"]);
let popupStatusPending = false;

const RECORD_STATUS_LABELS = Object.freeze({
  PLANNING: "Saved",
  SAVED: "Saved",
  READING: "Reading",
  CAUGHT_UP: "Caught up",
  PAUSED: "Paused",
  COMPLETED: "Finished",
  FINISHED: "Finished",
  DROPPED: "Dropped",
});

function recordStatusKey(entry) {
  const raw =
    entry?.canonicalReaderStatus || entry?.readerStatus || entry?.status || "SAVED";
  const canonical = raw === "PLANNING" ? "SAVED" : raw === "COMPLETED" ? "FINISHED" : raw;
  return RECORD_STATUS_LABELS[canonical] ? canonical : "SAVED";
}

/** The popup spells confirmed chapter progress out, while Saved has no suffix. */
function recordLine(entry) {
  const key = recordStatusKey(entry);
  const label = RECORD_STATUS_LABELS[key];
  const current = entry?.chapters?.current;
  const total = entry?.chapters?.total;
  if (!Number.isInteger(current) || current <= 0) return { key, label, place: "" };
  const place = Number.isInteger(total) && total > 0
    ? `Chapter ${current} of ${total}`
    : `Chapter ${current}`;
  return { key, label: `${label} · ${place}`, place };
}

function setEarnedRecord(record) {
  const box = document.getElementById("popup-earned-record");
  if (!box) return;
  box.hidden = !record;
  if (!record) return;
  const title = document.getElementById("popup-earned-record-title");
  const byline = document.getElementById("popup-earned-record-byline");
  const label = document.getElementById("popup-earned-record-label");
  const dot = document.getElementById("popup-earned-record-dot");
  const stateLine = box.querySelector(".popup-earned-record-state");
  if (title) {
    title.hidden = !record.title;
    title.textContent = record.title || "";
  }
  if (byline) {
    byline.textContent = record.byline || "";
    byline.hidden = !record.byline;
  }
  if (label) label.textContent = record.label || "";
  if (dot) dot.dataset.status = record.status || "SAVED";
  if (stateLine) {
    // P11 carries its status once, in the status control.
    stateLine.hidden = !record.label;
    if (record.tone) stateLine.dataset.tone = record.tone;
    else delete stateLine.dataset.tone;
  }
}

/** One inline failure under the record: a warning glyph and ink text. */
function setEarnedFailure(failure) {
  const section = document.getElementById("popup-earned-permission");
  const scroll = section?.querySelector(".popup-earned-scroll");
  let box = document.getElementById("popup-earned-failure");
  if (!failure) {
    if (box) box.hidden = true;
    return;
  }
  if (!box && scroll) {
    box = document.createElement("p");
    box.id = "popup-earned-failure";
    box.className = "popup-earned-failure";
    const lead = earnedLeadRow();
    scroll.insertBefore(box, lead ? lead.nextSibling : null);
  }
  if (!box) return;
  const glyph = document.createElement("span");
  glyph.className = "popup-earned-failure-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.appendChild(popupGlyph("alert"));
  const text = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = failure.title || "";
  text.appendChild(title);
  if (failure.detail) {
    const detail = document.createElement("span");
    detail.textContent = failure.detail;
    text.appendChild(detail);
  }
  box.replaceChildren(glyph, text);
  box.hidden = false;
}

function earnedGrantCoverage(grantedOrigins) {
  const granted = new Set(grantedOrigins || []);
  const required = earnedOrigins();
  const grantedCount = required.filter((origin) => granted.has(origin)).length;
  return {
    required: required.length,
    granted: grantedCount,
    complete: required.length > 0 && grantedCount === required.length,
  };
}

async function readActiveStoryIdentity() {
  let timer;
  try {
    const response = await Promise.race([
      (async () => {
        const tab = await probeQueryActiveTab();
        if (!tab || !Number.isInteger(tab.id)) return { error: "page_unavailable" };
        return probeSendTabMessage(tab.id, { type: "TRACE_STORY_IDENTITY_GET" });
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ error: "page_unavailable" }), 1500); }),
    ]);
    if (!response || response.error === "page_unavailable") return { pageUnavailable: true };
    if (response.ok !== true || typeof response.title !== "string") return null;
    return {
      title: response.title,
      author: typeof response.author === "string" ? response.author : null,
      site: typeof response.site === "string" ? response.site : null,
    };
  } catch {
    return { pageUnavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

function storyByline(identity, story) {
  const rawSite = identity?.site || story?.site || "";
  const site = rawSite === "ffn" || rawSite === "FFN" ? "FanFiction.net" : rawSite === "ao3" ? "AO3" : rawSite;
  return identity?.author ? `${identity.author} · ${site}` : site;
}

function setEarnedAction(button, { hidden = false, disabled = false, label = "", action = "", emphasis = "primary" }) {
  if (!button) return;
  const hadFocus = document.activeElement === button;
  button.hidden = hidden;
  button.disabled = disabled;
  if (hadFocus && (hidden || disabled)) focusEarnedHeadingIfLost(button);
  button.textContent = label;
  button.dataset.earnedAction = action;
  button.dataset.emphasis = emphasis;
  refreshEarnedLayout();
}

function configureEarnedActions(primary, secondary = null) {
  setEarnedAction(document.getElementById("popup-earned-primary"), primary);
  setEarnedAction(
    document.getElementById("popup-earned-secondary"),
    secondary || { hidden: true },
  );
  const pin = document.getElementById("popup-earned-pin");
  const rule = document.getElementById("popup-earned-rule");
  if (pin) pin.hidden = Boolean(primary.hidden && (!secondary || secondary.hidden) && (!rule || rule.hidden));
  refreshEarnedLayout();
}

function resetEarnedLedger() {
  setEarnedCheck("popup-earned-story", "checking", "Checking", "Story page");
  setEarnedCheck("popup-earned-access", "waiting", "Waiting", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "Waiting", "Saved to Trace");
}

async function reloadEarnedStory() {
  try {
    const tab = await probeQueryActiveTab();
    if (!tab || !Number.isInteger(tab.id)) throw new Error("no_active_tab");
    await extensionPromiseCall(ext.tabs, "reload", [tab.id]);
    void recordEarnedEvent("automation_verification_reload");
  } catch {
    setEarnedCopy({
      stateCode: "reload",
      glyph: "alert",
      glyphTone: "warning",
      heading: "Reload this page",
      lead: "Trace couldn’t reload it for you. Reload the page to save this story. Nothing is saved yet.",
    });
    setEarnedResult(
      "failure",
      "Reload this page.",
      "Trace couldn’t reload it for you. Reload the page to save this story. Nothing is saved yet.",
    );
    configureEarnedActions({
      label: "Try again",
      action: "reload_to_verify",
    });
  }
}

/**
 * A small still picture of Safari's question with Always Allow marked, so the
 * reader knows what comes after Allow. Safari's own button words; its title
 * and message are drawn as lines, not words. Hidden from VoiceOver: the ask's
 * body says the same. Made once, and moved to sit under the words of the ask
 * that is on show.
 */
function showSafariPrompt(after) {
  let picture = document.getElementById("popup-earned-prompt");
  if (!picture) {
    picture = document.createElement("div");
    picture.id = "popup-earned-prompt";
    picture.className = "popup-earned-prompt";
    picture.setAttribute("aria-hidden", "true");
    const sheet = document.createElement("div");
    sheet.className = "popup-earned-prompt-sheet";
    for (const kind of ["title", "line", "line short"]) {
      const bar = document.createElement("span");
      bar.className = `popup-earned-prompt-bar ${kind}`;
      sheet.append(bar);
    }
    // Drawn as this Safari draws it: where every button is blue, so are these.
    const allBlue = safariQuestionButtonsAreAllBlue();
    for (const [label, kind] of [
      ["Allow for One Day", "blue"],
      ["Always Allow", allBlue ? "chosen blue" : "chosen"],
      ["Don’t Allow", allBlue ? "blue" : "plain"],
    ]) {
      const button = document.createElement("span");
      button.className = `popup-earned-prompt-button ${kind}`;
      button.textContent = label;
      sheet.append(button);
    }
    picture.append(sheet);
  }
  if (!after) return;
  if (after.nextElementSibling !== picture) after.after(picture);
  picture.hidden = false;
}

/**
 * The ask for lasting access where the first-tap sheet does not draw it: a
 * list or a site's home page, a page the sheet stood aside on, or a build
 * without the sheet. It has the sheet's words, rule line and buttons, and its
 * tap asks Safari directly.
 */
function drawEarnedAsk(stateCode, {
  kicker = "", kickerIcon = "", heading, body = "", bodyMarkup = "", spokenBody = "", rule = false, prompt = false,
  primary, secondary = null, result = "checking",
}) {
  leaveFirstTapSheet();
  setEarnedCopy({
    stateCode,
    kicker,
    kickerIcon,
    heading,
    lead: body,
    leadMarkup: bodyMarkup,
    ruleMarkup: rule
      ? (safariQuestionButtonsAreAllBlue() ? FIRST_TAP_WORDS.ruleEveryButtonBlue : FIRST_TAP_WORDS.rule)
      : "",
  });
  if (rule) {
    // The colour is no use to a reader who is not looking at it.
    setSpokenAlternative(document.getElementById("popup-earned-rule"), FIRST_TAP_WORDS.ruleSpoken);
    document.getElementById("popup-earned-primary")?.setAttribute("aria-describedby", "popup-earned-rule");
  }
  if (prompt) {
    showSafariPrompt(document.getElementById("popup-earned-lead"));
    document.getElementById("popup-earned-primary")?.setAttribute("aria-describedby", "popup-earned-lead");
  }
  setEarnedResult(result, [kicker, heading, spokenBody || body].map(firstTapSpoken).filter(Boolean).join(" "), "");
  configureEarnedActions(primary, secondary);
}

function earnedAllow() {
  return { label: FIRST_TAP_WORDS.allow, action: "allow_and_add", emphasis: "primary" };
}

function setEarnedAskLedger(story, access) {
  const onStory = story?.kind === "story";
  setEarnedCheck("popup-earned-story", onStory ? "pass" : "waiting", onStory ? story.site : "Open a story", "Story page");
  setEarnedCheck("popup-earned-access", access === "fail" ? "fail" : "waiting", access === "fail" ? "Not allowed" : "Needed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", access === "fail" ? "Not added" : "After access", "Saved to Trace");
}

function renderEarnedPermissionInvitation(story) {
  setEarnedAskLedger(story, "waiting");
  const onStory = story.kind === "story";
  // On a story the body says what to tap and the picture shows it; on a list
  // the rule line says it.
  drawEarnedAsk(onStory ? "ask-on-story" : "ask-on-list", {
    // On a story, the sheet's own heading for the ask.
    heading: onStory ? FIRST_TAP_WORDS.askHeading : FIRST_TAP_WORDS.listAskHeading,
    ...(onStory
      ? { bodyMarkup: FIRST_TAP_WORDS.askBody, spokenBody: FIRST_TAP_WORDS.askBodySpoken, prompt: true }
      : { body: FIRST_TAP_WORDS.listAskBody, rule: true }),
    primary: earnedAllow(),
    secondary: firstTapButton.notNow,
  });
}

/** The story sites are allowed from a list or a site's home page. */
function renderEarnedSiteReady({ allowed = false } = {}) {
  leaveFirstTapSheet();
  setEarnedCopy({
    stateCode: "P8",
    ...(allowed ? { kicker: FIRST_TAP_WORDS.allowedKicker, kickerIcon: "check" } : {}),
    heading: FIRST_TAP_WORDS.listReadyHeading,
    lead: FIRST_TAP_WORDS.listReadyBody,
  });
  setEarnedCheck("popup-earned-story", "waiting", "Open a story", "Story page");
  setEarnedCheck("popup-earned-access", "pass", "Allowed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "Not saved", "Saved to Trace");
  setEarnedResult("success", FIRST_TAP_WORDS.listReadyHeading, FIRST_TAP_WORDS.listReadyBody);
  configureEarnedActions({ hidden: true });
}

function renderEarnedAccessPending(story) {
  leaveFirstTapSheet();
  setEarnedCopy({
    stateCode: "P1",
    kicker: FIRST_TAP_WORDS.allowedKicker,
    kickerIcon: "check",
    heading: "Saving this story…",
    lead: "Keep reading. You’ll see a note on the page once it’s saved.",
  });
  setEarnedCheck("popup-earned-story", "pass", story.site, "Story page");
  setEarnedCheck("popup-earned-access", "pass", "Allowed", "Website access");
  setEarnedCheck("popup-earned-save", "checking", "Reloading", "Saved to Trace");
  setEarnedResult("checking", "Saving this story.", "Keep reading. You’ll see a note on the page once it’s saved.");
  configureEarnedActions({ label: "Keep reading", action: "close", emphasis: "secondary" });
}

/** Safari's question is up: what is shown stays, and its button waits. */
function renderEarnedAskWaiting() {
  configureEarnedActions(firstTapButton.waiting, firstTapButton.notNow);
  setEarnedResult("checking", firstTapSpoken(FIRST_TAP_WORDS.waitingForSafari), "");
}

/** Some of the story sites, not all: never drawn as allowed. */
function renderEarnedPartialAccess() {
  drawEarnedAsk("access-partial", {
    heading: FIRST_TAP_WORDS.partialHeading,
    body: FIRST_TAP_WORDS.partialBody,
    rule: true,
    primary: earnedAllow(),
    secondary: firstTapButton.notNow,
  });
}

/**
 * Not allowed, or Safari could not ask. Nothing was saved by this ask; the
 * reader is told how saving goes from here, and can go back to the ask.
 */
function renderEarnedPermissionDeclined(story) {
  setEarnedAskLedger(story, "fail");
  const onRequest = !FIRST_TAP_SAVES_ON_OPEN;
  drawEarnedAsk("access-not-allowed", {
    heading: onRequest ? FIRST_TAP_WORDS.notAllowedOnRequestHeading : FIRST_TAP_WORDS.notAllowedHeading,
    body: onRequest ? FIRST_TAP_WORDS.notAllowedOnRequestBody : FIRST_TAP_WORDS.notAllowedBody,
    primary: firstTapButton.keepReading,
    // Back to the ask; the request is made by the reader's tap there.
    secondary: { label: FIRST_TAP_WORDS.tryAgain, action: "prepare", emphasis: "tertiary" },
  });
}

/** Safari allows the story sites; Trace's page scripts are not in place. */
function renderEarnedRegistrationFailure() {
  drawEarnedAsk("access-registration-failed", {
    kicker: FIRST_TAP_WORDS.allowedKicker,
    kickerIcon: "check",
    heading: FIRST_TAP_WORDS.registrationFailedHeading,
    body: FIRST_TAP_WORDS.registrationFailedBody,
    // Trying again asks Safari for nothing: access is already allowed.
    primary: { label: FIRST_TAP_WORDS.tryAgain, action: "allow_and_add", emphasis: "primary" },
    result: "failure",
  });
}

function renderEarnedUnsupportedStory() {
  setEarnedCopy({
    stateCode: "no-story",
    glyph: "info",
    heading: "Open a story to finish",
    lead: "Go to any story on AO3 or FanFiction.net, then tap Trace in Safari’s page menu again.",
  });
  setEarnedCheck("popup-earned-story", "fail", "Not found", "Story page");
  setEarnedCheck(
    "popup-earned-access",
    "waiting",
    "Not requested",
    "Website access",
  );
  setEarnedCheck(
    "popup-earned-save",
    "waiting",
    "Not added",
    "Saved to Trace",
  );
  setEarnedResult(
    "failure",
    "This isn’t a supported story page.",
    "AO3 and FanFiction.net stories are supported.",
  );
  configureEarnedActions({ label: "Close", action: "close", emphasis: "tertiary" });
}

/**
 * The popup just confirmed the reader's first story, so the page note would
 * only repeat it (often hidden behind this sheet). Mark the one-time note as
 * delivered and ask the page to drop any note already showing.
 */
async function deliverFirstStoryConfirmation() {
  try {
    await earnedStorageSet({ traceSavedNoteFirstStoryShownV1: true });
  } catch {
    // Best effort; the note is optional feedback.
  }
  try {
    const tab = await probeQueryActiveTab();
    if (tab && Number.isInteger(tab.id)) {
      await probeSendTabMessage(tab.id, { type: "TRACE_SAVED_NOTE_DISMISS" });
    }
  } catch {
    // The page may have no receiver yet; the stored flag still applies.
  }
}

// A page that has just reloaded can take a moment to name its story.
const SAVED_TITLE_RETRY_DELAYS_MS = Object.freeze([400, 1200, 2500]);
let savedTitleLookup = null;

function stopSavedTitleLookup() {
  if (savedTitleLookup?.timer) clearTimeout(savedTitleLookup.timer);
  savedTitleLookup = null;
}

/**
 * The saved confirmation is on screen without the story's name. Ask the page
 * for it a few more times and fill it in; until then nothing stands in.
 */
function lookUpSavedTitle(story, work, alreadyInLibrary, attempt = 0) {
  const delay = SAVED_TITLE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  const lookup = { timer: null };
  savedTitleLookup = lookup;
  lookup.timer = setTimeout(() => {
    void readActiveStoryIdentity().then((identity) => {
      if (savedTitleLookup !== lookup || document.body.dataset.tracePopupStateCode !== "P2") return;
      // A blank title is no title: it counts against the same few tries.
      if (storyTitle(identity)) renderEarnedSaved(story, work, identity, alreadyInLibrary);
      else lookUpSavedTitle(story, work, alreadyInLibrary, attempt + 1);
    });
  }, delay);
}

function storyTitle(identity) {
  return typeof identity?.title === "string" ? identity.title.trim() : "";
}

function renderEarnedSaved(story, work, identity, alreadyInLibrary = false, confirmationText = null) {
  stopSavedTitleLookup();
  void deliverFirstStoryConfirmation();
  const line = recordLine(work?.entry);
  const confirmation = confirmationText ??
    (alreadyInLibrary ? "Already in your Library" : "Saved to your Library");
  const title = storyTitle(identity);
  const lead = "Trace keeps your place as you read. Find it in your Library in the Trace app.";
  if (title) {
    setEarnedCopy({
      stateCode: "P2",
      kicker: confirmation,
      // "Already in your Library" carries no tick: nothing was added just now.
      kickerIcon: alreadyInLibrary ? "" : "check",
      heading: title,
      record: { heading: true, byline: storyByline(identity, story), label: line.label, status: line.key },
      lead,
    });
  } else {
    // The page has not named the story yet. The confirmation stands on its
    // own, as the headline, rather than over a made-up title.
    setEarnedCopy({
      stateCode: "P2",
      glyph: "check",
      heading: confirmation,
      record: { byline: storyByline(null, story), label: line.label, status: line.key },
      lead,
    });
    lookUpSavedTitle(story, work, alreadyInLibrary);
  }
  setEarnedCheck("popup-earned-save", "pass", "Saved", "Saved to Trace");
  setEarnedResult("success", `${confirmation}.`, "Trace keeps your place as you read.");
  configureEarnedActions({ label: "Keep reading", action: "close", emphasis: "secondary" });
}

function renderEarnedDelayed(story) {
  setEarnedCopy({
    stateCode: "P5",
    heading: "Still saving…",
    lead: "Keep reading. If it’s not in your Library in a minute, reload this page.",
  });
  setEarnedResult("checking", "Still saving.",
    "Keep reading. If it’s not in your Library in a minute, reload this page.");
  configureEarnedActions(
    { label: "Keep reading", action: "close", emphasis: "secondary" },
    { label: "Check again", action: "check_story", emphasis: "tertiary" },
  );
}

function renderEarnedUnavailable(story) {
  setEarnedCopy({
    stateCode: "P9",
    heading: "This story isn’t available",
    lead: "It may be deleted or locked. Nothing was saved.",
  });
  setEarnedCheck("popup-earned-story", "fail", "Unavailable", "Story page");
  setEarnedCheck("popup-earned-access", "pass", "Allowed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "Not saved", "Saved to Trace");
  setEarnedResult("failure", "This story isn’t available.", "Nothing was saved.");
  configureEarnedActions({ label: "Close", action: "close", emphasis: "tertiary" });
}

/** Only for a reader the Trace app has no account for. */
function renderEarnedConnectAccount(story) {
  setEarnedCopy({
    stateCode: "P6",
    heading: "Finish setup in the Trace app",
    lead: `Create an account or sign in, then come back to ${story?.kind === "archive" ? "any story" : "this story"}. Trace saves it as you read.`,
  });
  setEarnedResult("failure", "Finish setup in the Trace app.", "");
  configureEarnedActions({ label: "Open Trace", action: "open_connect", emphasis: "primary" });
}

/**
 * The Trace app's account has not been read yet, so it is not known whether
 * the reader has one. Say only that Trace is connecting.
 */
function renderEarnedConnectingAccount() {
  setEarnedCopy({
    stateCode: "connecting-account",
    heading: "Connecting to your account…",
    lead: "Checking the Trace app for your account.",
  });
  setEarnedResult("checking", "Connecting to your account.", "");
  configureEarnedActions({ hidden: true });
}

/**
 * The account still could not be read, or Trace refused the one the app
 * holds. That is not the same as having no account, so nothing here asks the
 * reader to create one.
 */
function renderEarnedAccountUnreachable(story) {
  setEarnedCopy({
    stateCode: "account-unreachable",
    glyph: "alert",
    glyphTone: "warning",
    heading: "Trace couldn’t connect to your account",
    lead: `Your Library is safe. Open Trace and check you’re signed in, then come back to ${story?.kind === "archive" ? "any story" : "this story"}.`,
  });
  setEarnedResult("failure", "Trace couldn’t connect to your account.", "");
  configureEarnedActions(
    { label: "Open Trace", action: "open_connect", emphasis: "primary" },
    { label: "Try again", action: "connect_account", emphasis: "tertiary" },
  );
}

/**
 * Safari's session verified a different Trace identity (identity_conflict),
 * so the extension cleared its credential. No endpoint names the other
 * account; say what happened and offer the one route out.
 */
function renderEarnedOtherAccount() {
  setEarnedCopy({
    stateCode: "other-account",
    glyph: "person",
    heading: "Safari was signed in to another account",
    lead: "Trace signed it out so nothing mixes. Open Trace to link Safari to the account you use there. Nothing was saved.",
  });
  setEarnedResult("failure", "Safari was signed in to another account.", "Nothing was saved.");
  configureEarnedActions({ label: "Open Trace", action: "open_connect", emphasis: "primary" });
}

/**
 * The session is still handing over, and this story was already in the
 * Library when the page last synced. Say only that Trace is checking; the
 * saving state belongs to stories that are not confirmed yet.
 */
function renderEarnedCheckingLibrary() {
  setEarnedCopy({
    stateCode: "checking",
    heading: "This story",
    record: { heading: true, label: "Checking your Library…", status: "CHECKING", tone: "secondary" },
  });
  const heading = document.getElementById("popup-earned-heading");
  void readActiveStoryIdentity().then((identity) => {
    if (document.body.dataset.tracePopupStateCode !== "checking" || !identity?.title || !heading) return;
    heading.textContent = identity.title;
    const byline = document.getElementById("popup-earned-record-byline");
    if (byline) {
      byline.textContent = storyByline(identity, earnedCurrentPage);
      byline.hidden = !byline.textContent;
    }
  });
  setEarnedResult("checking", "Checking your Library.", "");
  configureEarnedActions({ hidden: true });
}

/** The account's Library is at its free limit. Saving is the task here. */
function renderEarnedLibraryFull(onUnsavedStory) {
  setEarnedCopy({
    stateCode: "library-full",
    glyph: "tray",
    heading: "Your Library is full",
    lead: onUnsavedStory
      ? `${libraryFullLead(popupModel.libraryLimit)} This story wasn’t added.`
      : libraryFullLead(popupModel.libraryLimit),
  });
  setEarnedResult("failure", "Your Library is full.", onUnsavedStory ? "This story wasn’t added." : "");
  configureEarnedActions(
    { label: "See Trace Unlimited", action: "open_upgrade", emphasis: "primary" },
    { label: "Manage library", action: "open_app", emphasis: "tertiary" },
  );
}

// On iPhone and iPad the Trace app holds the account. The background reads
// it when the popup asks for a session snapshot, and the answer is one of:
// the app has no account, the account is connected, or it could not be read
// just now. Only the first of those may ask the reader to create an account.
const APP_ACCOUNT_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
// "No account" is read once more, quietly: a reader who has just signed up
// can be a moment ahead of the app storing their account.
const APP_ACCOUNT_RECHECK_MS = 1200;
// However long each read takes, "Connecting…" gives way to an answer, and to
// something the reader can tap, by this long after the wait began.
const APP_ACCOUNT_WAIT_LIMIT_MS = 10000;

/** What a session snapshot says about the account behind this extension. */
function appAccountAnswer(snapshot) {
  const state = snapshot?.state;
  const reason = snapshot?.reason || "none";
  if (state === "connected") return "connected";
  if (state === "initializing" || state === "connecting" || state === "verifying") return "pending";
  if (state === "signed_out") return reason === "credential_absent" ? "none" : "unknown";
  if (state === "reconnect_required") {
    if (reason === "identity_conflict") return "other_account";
    if (reason === "credential_absent" || reason === "credential_rejected") return "refused";
  }
  // No answer at all is unknown too. Storage and account-response problems
  // keep the copy they already have.
  return state ? "other" : "unknown";
}

// The one wait for the account this popup has, from the first question
// until an account connects. It outlives its timers: a view that has settled
// on "no account" or "couldn't connect" still moves on when one connects.
let accountWait = null;

function accountWaitSettled(wait) {
  return wait.view === "none" || wait.view === "unreachable" || wait.view === "other_account";
}

function clearAccountWaitTimers(wait) {
  if (wait.timer !== null) clearTimeout(wait.timer);
  if (wait.limit !== null) clearTimeout(wait.limit);
  wait.timer = null;
  wait.limit = null;
}

function endAccountWait() {
  if (accountWait) clearAccountWaitTimers(accountWait);
  accountWait = null;
}

function showAccountWaitView(wait, view) {
  wait.view = view;
  if (wait.generalView && !showAppLinkView()) return;
  if (view === "connecting") renderEarnedConnectingAccount();
  else if (view === "none") renderEarnedConnectAccount(wait.story);
  else if (view === "other_account") renderEarnedOtherAccount();
  else renderEarnedAccountUnreachable(wait.story);
}

/** A definite answer, or the end of the wait: nothing more is scheduled. */
function settleAccountWait(wait, view) {
  clearAccountWaitTimers(wait);
  showAccountWaitView(wait, view);
}

function armAccountWaitLimit(wait) {
  if (wait.limit !== null) clearTimeout(wait.limit);
  wait.limit = setTimeout(() => {
    wait.limit = null;
    if (accountWait !== wait) return;
    // A read still in flight is left to finish; its answer is still taken.
    if (!accountWaitSettled(wait)) settleAccountWait(wait, "unreachable");
  }, APP_ACCOUNT_WAIT_LIMIT_MS);
}

/**
 * Starts this popup's wait for the app's account, or joins the one under
 * way. While the answer is unknown it shows "Connecting…" and asks again
 * after each delay; the whole wait is capped in time. `connected` runs once
 * an account is there, however late. `firstReply` is a snapshot reply the
 * caller already has, so it is not asked for twice.
 */
function waitForAppAccount(story, { connected, other = null, generalView = false, settled = null }, firstReply) {
  // The wait under way already knows how to carry on; a joiner changes nothing.
  if (accountWait) return;
  const wait = {
    story, connected, other, generalView,
    attempt: 0, timer: null, limit: null, asking: false, recheckedNone: false, view: null,
  };
  accountWait = wait;
  if (settled) {
    settleAccountWait(wait, settled);
    return;
  }
  armAccountWaitLimit(wait);
  if (firstReply !== undefined) takeAccountAnswer(wait, firstReply);
  else askForAppAccount(wait);
}

/**
 * One read of the account. While one is out no other is sent, unless the
 * reader taps Try again: Safari may have stopped the background under the
 * read and never answer it, and a new read wakes a background. An earlier
 * read that answers late is still taken where its answer settles the wait.
 */
function askForAppAccount(wait, { again = false } = {}) {
  if (accountWait !== wait || (wait.asking && !again)) return;
  if (wait.timer !== null) clearTimeout(wait.timer);
  wait.timer = null;
  wait.asking = true;
  wait.reads = (wait.reads ?? 0) + 1;
  const read = wait.reads;
  const sequence = nextSessionSequence();
  sendKernelRuntimeMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" }, (response) => {
    if (accountWait !== wait) return;
    const latest = read === wait.reads;
    if (!latest && ["unknown", "pending"].includes(appAccountAnswer(response?.snapshot))) return;
    wait.asking = false;
    sessionReplyTaken(sequence, response);
    takeAccountAnswer(wait, response);
  });
}

function takeAccountAnswer(wait, response) {
  const answer = appAccountAnswer(response?.snapshot);
  if (answer === "connected") {
    endAccountWait();
    wait.connected(response);
    return;
  }
  if (answer === "other" && wait.other) {
    endAccountWait();
    wait.other(response);
    return;
  }
  if (answer === "unknown" || answer === "pending") {
    // Not an answer. A view that already says something definite keeps it,
    // which includes "couldn't connect" once the wait has run out of time.
    if (accountWaitSettled(wait)) return;
    const delay = APP_ACCOUNT_RETRY_DELAYS_MS[wait.attempt];
    if (delay === undefined) {
      settleAccountWait(wait, "unreachable");
      return;
    }
    wait.attempt += 1;
    showAccountWaitView(wait, "connecting");
    wait.timer = setTimeout(() => askForAppAccount(wait), delay);
    return;
  }
  if (answer === "none") {
    settleAccountWait(wait, "none");
    if (!wait.recheckedNone) {
      wait.recheckedNone = true;
      wait.timer = setTimeout(() => askForAppAccount(wait), APP_ACCOUNT_RECHECK_MS);
    }
    return;
  }
  settleAccountWait(wait, answer === "other_account" ? "other_account" : "unreachable");
}

/**
 * The background published that an account connected. Whatever the wait is
 * showing, ask now; this is an event, not a poll.
 */
function accountMayHaveConnected() {
  // A publish is not one of the wait's own attempts, so it uses none up.
  if (accountWait && !accountWait.asking && !accountWaitSettled(accountWait) && accountWait.attempt > 0) accountWait.attempt -= 1;
  if (accountWait) askForAppAccount(accountWait);
}

// A wait that ends connected can be followed by the story still reporting
// no account. A popup starts over a couple of times at most, then says so.
const ACCOUNT_RESOLUTION_LIMIT = 2;
let accountResolutions = 0;

/**
 * A story is waiting on an account that is not connected. Find out what is
 * known before saying anything about signing in. Called again while a wait
 * is under way, it joins that wait and spends nothing.
 */
function resolveAccountForStory(story, onConnected) {
  stopStoryConfirmation();
  if (accountWait) return;
  const general = kernelPopupInitialized;
  const handlers = general
    ? { connected: kernelAccountConnected, other: kernelAccountOther, generalView: true }
    : { connected: onConnected };
  accountResolutions += 1;
  if (accountResolutions > ACCOUNT_RESOLUTION_LIMIT) {
    waitForAppAccount(story, { ...handlers, settled: "unreachable" });
    return;
  }
  if (general) {
    // The general view already follows the session; let it ask.
    kernelSnapshotProviderAttempt = 0;
    requestKernelSnapshot();
    return;
  }
  waitForAppAccount(story, handlers);
}

/** "Try again" on the couldn't-connect state: one more bounded wait. */
function retryAppAccount() {
  accountResolutions = 0;
  const wait = accountWait;
  if (!wait) {
    renderEarnedConnectingAccount();
    kernelSnapshotProviderAttempt = 0;
    requestKernelSnapshot();
    return;
  }
  clearAccountWaitTimers(wait);
  wait.attempt = 0;
  wait.recheckedNone = false;
  showAccountWaitView(wait, "connecting");
  armAccountWaitLimit(wait);
  askForAppAccount(wait, { again: true });
}

let storyConfirmation = null;

function stopStoryConfirmation() {
  if (storyConfirmation?.timer) clearTimeout(storyConfirmation.timer);
  storyConfirmation = null;
}

async function checkConfirmedStory() {
  const watch = storyConfirmation;
  if (!watch) return;
  const state = await new Promise((resolve) =>
    sendKernelRuntimeMessage({ type: "TRACE_POPUP_GET_STATE" }, resolve),
  );
  if (storyConfirmation !== watch) return;
  if (!state || state.ok !== true) return;
  if (state.authState?.state && state.authState.state !== "connected" && state.authState.state !== "connecting" && state.authState.state !== "verifying") {
    // Not connected is not yet "no account": this reply never reads the
    // Trace app's account. The account check does, and decides what to say.
    watch.render.connect();
    return;
  }
  if (state.activeWork && state.activeWork.status === "saved") {
    // An identity read while the page was still reloading has no title; ask
    // again now that the page has saved the story.
    const identity = watch.identity?.title ? watch.identity : await readActiveStoryIdentity();
    if (storyConfirmation !== watch) return;
    stopStoryConfirmation();
    void recordEarnedEvent("story_confirmed_in_popup");
    watch.render.saved(state.activeWork, identity, watch.firstCheck);
    return;
  }
  if (state.activeStoryUnavailable === true) {
    stopStoryConfirmation();
    watch.render.unavailable();
    return;
  }
  watch.firstCheck = false;
}

/**
 * Watches the account projection for the active story. Only a confirmed
 * current-account entry for this exact tab's story ends the wait; a timeout
 * shows a calm delayed state and never re-sends a save.
 */
function watchForConfirmedStory(story, render, { firstCheck = true } = {}) {
  stopStoryConfirmation();
  storyConfirmation = { story, render, identity: null, timer: null, firstCheck };
  const watch = storyConfirmation;
  void readActiveStoryIdentity().then((identity) => {
    if (storyConfirmation === watch) watch.identity = identity;
  });
  watch.timer = setTimeout(() => {
    if (storyConfirmation !== watch) return;
    void checkConfirmedStory().then(() => {
      if (storyConfirmation !== watch) return;
      void recordEarnedEvent("story_confirmation_delayed");
      render.delayed();
    });
  }, STORY_CONFIRMATION_PATIENCE_MS);
  void checkConfirmedStory();
}

function earnedStoryRender(story) {
  return {
    saved: (work, identity, already) => renderEarnedSaved(story, work, identity, already),
    delayed: () => renderEarnedDelayed(story),
    unavailable: () => renderEarnedUnavailable(story),
    connect: () => resolveAccountForStory(story, () => {
      // The account connected while this popup waited, so a story found
      // saved now was saved now, not already there.
      renderEarnedAccessPending(story);
      watchForConfirmedStory(story, earnedStoryRender(story), { firstCheck: false });
    }),
  };
}

function earnedRunVerified(onboarding, readiness) {
  const lastArchiveSeenAt = readiness?.lastArchiveSeenAt;
  if (typeof lastArchiveSeenAt !== "number" || lastArchiveSeenAt <= 0) {
    return false;
  }

  // A content-script heartbeat is direct proof that Trace ran on an archive
  // page. Older installs and Safari process restarts can retain that proof
  // without retaining (or promptly reporting) the permission grant timestamp.
  // When both timestamps exist, keep the stricter post-grant ordering check.
  return !onboarding.grantAt || lastArchiveSeenAt > onboarding.grantAt;
}

async function reconcileEarnedRegistration() {
  return extensionPromiseCall(ext.runtime, "sendMessage", [
    { type: "TRACE_EARNED_PERMISSION_RECONCILE" },
  ]);
}

/** The archive work key for a story URL, matching the page's overlay cache. */
function earnedWorkKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const ao3 = url.pathname.match(/\/works\/(\d+)/);
    if (ao3 && !/fanfiction\.net$/i.test(url.hostname)) return `ao3:${ao3[1]}`;
    const ffn = url.pathname.match(/\/s\/(\d+)/);
    if (ffn && /fanfiction\.net$/i.test(url.hostname)) return `ffn:${ffn[1]}`;
  } catch {
    // Not a story URL.
  }
  return null;
}

/**
 * Whether the last page sync already listed this story in the Library. It
 * only chooses between "Saving this story…" and a neutral "Checking your
 * Library…" during session handover; it is never described as a save.
 */
async function readKnownInLibrary(rawUrl) {
  const workKey = earnedWorkKey(rawUrl);
  if (!workKey) return false;
  try {
    const stored = await earnedStorageGet(["libraryOverlayCache"]);
    const entry = stored?.libraryOverlayCache?.entries?.[workKey];
    return Boolean(entry && typeof entry.entryId === "string" && entry.entryId);
  } catch {
    return false;
  }
}

// ── First-tap save: what the popup draws ───────────────────────────────────────
//
// The background owns the save and the ask for lasting access, and sends this
// popup one machine state of each at a time. Each is drawn here as one popup
// state, named in `data-trace-first-tap-state`, in the words of
// FIRST_TAP_WORDS. Nothing here decides what happened; it only says it.
// Every build with optional story sites draws this sheet, release builds
// included. Only whether opening it saves the story differs: a development
// build may save on opening, and every other build opens on "Save this story"
// and saves on the reader's tap.
const FIRST_TAP_SHEET = EARNED_PERMISSION_ONBOARDING?.registrationMode === "dynamic";
const FIRST_TAP_SAVES_ON_OPEN = FIRST_TAP_SHEET && EARNED_PERMISSION_ONBOARDING?.firstTapSave === true;
const FIRST_TAP_POPUP_PORT = "trace-first-tap-popup-v1";
// Two steps of setting up Trace in Safari, told to the background, which
// reports them only while the Trace app has a setup under way: the sheet was
// opened (on a story or not; never which page), and the answer to Safari's
// question asked from this popup without the first-tap port.
const SETUP_STEP_MESSAGE = "TRACE_SETUP_STEP";
let setupSheetOpenedSent = false;
let firstTapPort = null;
let firstTapStory = null;
let firstTapTab = null;
// The save being waited on, by when it began, and whether that wait has
// outrun the popup's patience. One save has one wait, however often its
// state is drawn again.
let firstTapPatience = null;
// A button the reader tapped whose answer is not in yet. It cannot be tapped
// again until that answer comes, and the answer is said aloud even when
// nothing has changed. Each such tap has a number, which its answer carries.
let firstTapBusy = null;
let firstTapLooks = 0;
// The reader's save on its way to the background, and how long it waits for
// word that the background has it before it is sent again over a new port.
// The background answers as soon as it starts the save, well inside this.
let firstTapSaveDelivery = null;
const FIRST_TAP_SAVE_ANSWER_MS = 4_000;
// A little longer than the slowest of those answers: a read of the Library
// that is refused, reconnects and is made again. Past it the button is given
// back; a look asked for then joins one that is still out.
const FIRST_TAP_BUSY_LIMIT_MS = 30_000;
// On a sheet too short for all of it, the rule line and the main button stay
// pinned while they take no more than this share of the sheet's height.
const FIRST_TAP_PIN_SHARE = 0.6;
// The sheet's own spacing, as its styles set it: under the content, and
// above buttons that are not pinned.
const FIRST_TAP_SCROLL_FOOT = 8;
const FIRST_TAP_UNPINNED_GAP = 16;
let firstTapButtonGap = 0;
let firstTapSetAside = false;
// What the background last sent: the save's state, and the state of the ask
// for lasting access. Both are drawn from these and from nothing else.
let firstTapLastView = null;
let firstTapAccess = null;
// The request now out, if any. A wait on it ends when the background says
// what holds, never because the request's own promise is trusted to settle.
let firstTapAsk = null;
let firstTapAccessWatched = false;
// While a request is out, what Safari allows is read again this often.
const FIRST_TAP_ASK_REREAD_MS = 2_000;
// Safari said yes, and the background could not yet see it: it is looked at
// again after each of these, while it is still not known. A yes can only turn
// out allowed, so looking never risks a no.
const FIRST_TAP_YES_LOOKS_MS = Object.freeze([1_000, 2_000, 4_000]);
// Messages from the background about the ask, counted, so that a word sent
// with no word back can be told from one that was answered.
let firstTapAccessHeard = 0;
// Every request on the port goes out under a number, one higher each time,
// and the background's word on the ask comes back under the number of the
// request it answers. Word older than the newest already taken is let go, so
// a slow answer to an earlier request never stands over a later one.
let firstTapOrder = 0;
let firstTapAccessTaken = 0;
// Looks made while a request is out do not wait for the page scripts to go
// in, so their word is taken without holding back an earlier, fuller answer.
const firstTapPassingLooks = new Set();
// The newest request the background has said it has and is still checking.
let firstTapAccessChecking = 0;
// After that word, how much longer the answer to Safari's question is waited
// on before it goes once more over a new port: past the background's slowest
// check, which reads again for about a second, waits up to two for the page
// scripts, reads again, then reads the account.
const FIRST_TAP_ACCESS_CHECKING_MS = 12_000;
let firstTapAnswerWait = null;
// How long the popup waits on a request before saying it does not know. A
// reader answers Safari's question in seconds; a minute is past any reading
// of it. Nothing is lost at the deadline: a request that comes back later, a
// permission change, and the popup coming back into view are each still read.
const FIRST_TAP_ASK_DEADLINE_MS = 60_000;
// Whether this confirmed save has been drawn yet, so that its arrival plays
// once: not again when Safari's question goes up, nor on coming back to it.
let firstTapSavedDrawn = false;
// What was last drawn, so that an arrival plays once and not on every redraw.
let firstTapDrawn = null;
let firstTapConfirmationDelivered = false;

// Every word the first-tap sheet shows. Nothing here says how long access
// lasts, and nothing sends the reader to Safari's settings to check it.
const FIRST_TAP_WORDS = Object.freeze({
  storyStandIn: "This story",
  connecting: "Connecting to your account…",
  accountMissingHeading: "Open the Trace app first",
  accountMissingBody: "Safari doesn’t have your Trace sign-in yet. Open the Trace app, then come back and tap Trace again.",
  accountUnreachableHeading: "Trace can’t reach your account right now",
  accountUnreachableBody: "Check your connection, then try again.",
  reconnectHeading: "Sign in again in the Trace app",
  reconnectBody: "Your Trace sign-in in Safari has expired. Open the Trace app, then come back and tap Trace again.",
  saveThisStory: "Save this story",
  automaticSavingOffHeading: "Automatic saving is off",
  turnAutomaticSavingOn: "Turn automatic saving on",
  saving: "Saving to your Library…",
  stillConfirmingHeading: "Still confirming your story",
  stillConfirmingBody: "Trace hasn’t heard back yet. It may already be saved.",
  savedKicker: "Saved to your Library",
  alreadyKicker: "Already in your Library",
  inLibraryKicker: "In your Library",
  askHeading: "Let Trace save stories automatically",
  // The ask's body carries the instruction itself, so no rule line goes with it.
  askBody: "Tap Allow below, then <b>Always Allow</b>. Safari needs your permission before Trace can save as you read.",
  askBodySpoken: "Tap Allow below, then Always Allow. Safari needs your permission before Trace can save as you read.",
  rule: "Tap <b>Always Allow</b>, not the blue <b>Allow for One Day</b>.",
  ruleEveryButtonBlue: "Tap <b>Always Allow</b>, not <b>Allow for One Day</b>.",
  ruleSpoken: "Tap Always Allow, not Allow for One Day.",
  allow: "Allow AO3 and FanFiction.net",
  notNow: "Not now",
  waitingForSafari: "Waiting for Safari…",
  keepReading: "Keep reading",
  tryAgain: "Try again",
  checkAgain: "Check again",
  checking: "Checking…",
  close: "Close",
  unconfirmedHeading: "Trace couldn’t confirm this save",
  unconfirmedBody: "It may have saved anyway. Check again to find out.",
  stillUnknownHeading: "Trace still couldn’t check",
  stillUnknownBody: "Look for it in your Library in the Trace app, or check again later.",
  unavailableHeading: "This story isn’t available",
  unavailableBody: "It may be deleted or locked, so Trace can’t read it.",
  notSentHeading: "The save wasn’t sent",
  notSentBody: "This tap added nothing to your Library.",
  notInLibraryHeading: "This story isn’t in your Library",
  notInLibraryBody: "Trace checked and didn’t find it.",
  refusedHeading: "Trace couldn’t save this story",
  refusedBody: "It wasn’t added to your Library. Try again in a moment.",
  allowedKicker: "AO3 and FanFiction.net allowed",
  allowedHeading: "Trace now saves as you read",
  allowedBody: "Any story you open on AO3 or FanFiction.net is saved, with the chapter you’re on. Find them in the Trace app.",
  allowedOffHeading: "Automatic saving is off",
  allowedOffBody: "Right now Trace only saves a story when you tap Save this story.",
  registrationFailedHeading: "Automatic saving didn’t start",
  registrationFailedBody: "Safari said yes, but Trace couldn’t start saving. Try again.",
  notAllowedHeading: "Trace will save when you tap it",
  notAllowedBody: "To save another story, open Trace from the Page Menu on it. You can let it save by itself any time.",
  // With automatic saving off, opening Trace on a story does not save it.
  notAllowedOnRequestHeading: "Trace saves when you ask",
  notAllowedOnRequestBody: "To save another story, open Trace from the Page Menu on it and tap Save this story.",
  // Opened on a list or a site's home page, before the story sites are allowed.
  listAskHeading: "Let Trace save stories as you read",
  listAskBody: "This page isn’t a story. Allow AO3 and FanFiction.net, then open any story and Trace saves it.",
  listReadyHeading: "Open a story to save it",
  listReadyBody: "Trace saves any story you open on AO3 or FanFiction.net.",
  partialHeading: "Safari didn’t allow every page",
  partialBody: "Tap Allow again and choose Always Allow, so Trace can save on every AO3 and FanFiction.net page.",
  notKnownHeading: "Trace couldn’t tell what you chose",
  notKnownBody: "You may have allowed AO3 and FanFiction.net already. Tap Check again, or Allow to ask again.",
});

/** Sends a request over the port. False when there is no port, or it would not take it. */
function firstTapSend(command, detail = {}) {
  if (!firstTapPort) return false;
  try {
    // The tab this popup was opened on goes with every request: its id, its
    // address and whether it is private, as read when the reader opened Trace.
    const order = firstTapOrder + 1;
    firstTapPort.postMessage({ command, ...firstTapTab, ...detail, order });
    firstTapOrder = order;
    if (command === "access_waiting") firstTapPassingLooks.add(order);
    return true;
  } catch {
    firstTapPort = null;
    return false;
  }
}

/** Whether the tab is a private one; null when the browser does not say. */
function firstTapTabIsPrivate(tab) {
  const said = [tab?.incognito, ext.extension?.inIncognitoContext].filter(
    (value) => typeof value === "boolean",
  );
  return said.length === 0 ? null : said.includes(true);
}

function setFirstTapState(name) {
  document.body.dataset.traceFirstTapState = name;
}

/** A line as it is read aloud: a full stop, and no trailing ellipsis. */
function firstTapSpoken(words) {
  const said = String(words || "").replace(/…$/, "").trim();
  return !said || /[.!?]$/.test(said) ? said : `${said}.`;
}

/**
 * Before iOS 26 every button in Safari's question is blue, so the colour
 * tells the reader nothing. Safari's own version says which it is; the
 * system version in the user agent stopped changing and is trusted only
 * where it is older than that.
 */
function safariQuestionButtonsAreAllBlue() {
  const agent = navigator.userAgent || "";
  const safari = agent.match(/\bVersion\/(\d+)/);
  if (safari) return Number(safari[1]) < 26;
  const system = agent.match(/\bOS (\d+)_/);
  return Boolean(system) && Number(system[1]) < 18;
}

/** Shows an element's text as it is and has it read aloud as `spoken`. */
function setSpokenAlternative(element, spoken) {
  if (!element || !spoken) return;
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.append(...element.childNodes);
  const said = document.createElement("span");
  said.className = "popup-earned-internal";
  said.textContent = spoken;
  element.replaceChildren(shown, said);
}

/** A headline and body under the record. `name` is "note" or "ask". */
function firstTapTextBox(name) {
  const box = document.createElement("div");
  box.id = `popup-earned-${name}`;
  box.className = `popup-earned-${name}`;
  const heading = document.createElement("h2");
  heading.id = `popup-earned-${name}-heading`;
  heading.className = `popup-earned-${name}-heading`;
  const body = document.createElement("p");
  body.id = `popup-earned-${name}-body`;
  body.className = `popup-earned-${name}-body`;
  box.append(heading, body);
  return box;
}

/** The second headline and body, under the record. Made when first needed. */
function firstTapAskBox(create) {
  let box = document.getElementById("popup-earned-ask");
  if (box || !create) return box;
  const before = document.getElementById("popup-earned-note") || earnedLeadRow();
  if (!before) return null;
  box = firstTapTextBox("ask");
  // Focus is put here when the reader comes back to the ask.
  box.firstElementChild.tabIndex = -1;
  before.after(box);
  return box;
}

/**
 * News of the save that stands between the record and the ask, with one quiet
 * button of its own. Made when first needed.
 */
function firstTapNoteBox(create) {
  let box = document.getElementById("popup-earned-note");
  if (box || !create) return box;
  const lead = earnedLeadRow();
  if (!lead) return null;
  box = firstTapTextBox("note");
  const action = document.createElement("button");
  action.id = "popup-earned-note-action";
  action.type = "button";
  action.addEventListener("click", () => runEarnedAction(action));
  box.append(action);
  lead.after(box);
  return box;
}

/** Where the quieter button goes when it scrolls with the sheet's content. */
function firstTapScrollActions(scroll, create) {
  let holder = document.getElementById("popup-earned-scroll-actions");
  if (holder || !create || !scroll) return holder;
  holder = document.createElement("div");
  holder.id = "popup-earned-scroll-actions";
  holder.className = "popup-earned-actions";
  scroll.append(holder);
  return holder;
}

function moveKeepingFocus(element, parent) {
  if (!element || !parent || element.parentNode === parent) return;
  const focused = document.activeElement === element;
  parent.append(element);
  if (focused) element.focus({ preventScroll: true });
}

/** Puts the second button back beside the main one. */
function returnFirstTapSecondary() {
  const pin = document.getElementById("popup-earned-pin");
  moveKeepingFocus(document.getElementById("popup-earned-secondary"), pin?.querySelector(".popup-earned-actions"));
  const holder = document.getElementById("popup-earned-scroll-actions");
  if (holder) holder.hidden = true;
}

/**
 * On a sheet too short to show a state whole, the rule line and the main
 * button stay pinned and in reach, and the quieter button joins what scrolls
 * beneath them. Returns whether the sheet is laid out that way.
 *
 * Whether it is too short is worked out for the ordinary arrangement, both
 * buttons together, wherever the second button is at the moment: the answer
 * is then the same before and after it is moved. At the largest text sizes,
 * and where even the main button alone would take most of the sheet, nothing
 * is pinned and everything flows in reading order.
 */
function placeFirstTapSecondary(scroll, pin, textAx) {
  const primary = document.getElementById("popup-earned-primary");
  const secondary = document.getElementById("popup-earned-secondary");
  const home = pin.querySelector(".popup-earned-actions");
  if (!scroll || !primary || !secondary || !home) return false;
  const away = secondary.parentNode !== home;
  const shown = (element) => !element.hidden && !element.closest("[hidden]");
  let short = false;
  if (!textAx && !pin.hidden && !primary.hidden) {
    // Sizes and places as laid out, so that an arrival still moving into
    // place is measured where it will come to rest.
    const second = shown(secondary) ? secondary.offsetHeight : 0;
    // The space between the two buttons when they sit together, kept from
    // when they last did.
    if (!away && second > 0) {
      firstTapButtonGap = Math.max(0, secondary.offsetTop - (primary.offsetTop + primary.offsetHeight));
    }
    const between = second > 0 ? firstTapButtonGap : 0;
    // The pin with only the rule line and the main button in it.
    const pinned = pin.offsetHeight - (away ? 0 : second + between);
    const together = pinned + between + second;
    const content = [...scroll.children].filter((child) => child.id !== "popup-earned-scroll-actions" && shown(child)).at(-1);
    const contentHeight = content ? content.offsetTop + content.offsetHeight - scroll.offsetTop : 0;
    // The ordinary arrangement: the content, the space the sheet leaves
    // under it, and both buttons, set a little apart from the content when
    // they are too tall to pin as they are.
    const ordinary = contentHeight + FIRST_TAP_SCROLL_FOOT +
      (together > window.innerHeight * 0.3 ? FIRST_TAP_UNPINNED_GAP : 0) + together;
    short = ordinary > window.innerHeight + 1 && pinned <= window.innerHeight * FIRST_TAP_PIN_SHARE;
  }
  if (!short) {
    if (away) returnFirstTapSecondary();
    return false;
  }
  const holder = firstTapScrollActions(scroll, true);
  if (secondary.hidden) {
    if (holder) holder.hidden = true;
    return true;
  }
  if (holder) {
    holder.hidden = false;
    moveKeepingFocus(secondary, holder);
  }
  return true;
}

const FIRST_TAP_MOTIONS = Object.freeze(["popup-first-tap-fade", "popup-first-tap-rise"]);

function clearFirstTapMotion() {
  for (const element of document.querySelectorAll(FIRST_TAP_MOTIONS.map((name) => `.${name}`).join(","))) {
    element.classList.remove(...FIRST_TAP_MOTIONS);
  }
}

function playFirstTapMotion(motion, elements) {
  for (const element of elements) {
    if (!element) continue;
    // Reading the width makes a class put back on the same element play again.
    void element.offsetWidth;
    element.classList.add(motion);
  }
}

/** The story as the sheet's record shows it and reads it aloud. */
function firstTapRecord(view) {
  const identity = view?.story ? { ok: true, ...view.story } : null;
  const title = storyTitle(identity) || FIRST_TAP_WORDS.storyStandIn;
  const author = typeof identity?.author === "string" ? identity.author.trim() : "";
  const site = storyByline(null, { site: identity?.site || firstTapStory?.site || "" });
  const byline = author ? `${author} · ${site}` : site;
  const record = {
    title,
    byline,
    spokenByline: site ? (author ? `by ${author}, on ${site}.` : `on ${site}.`) : "",
    spokenName: [title, author ? `by ${author}` : "", site ? `on ${site}` : ""].filter(Boolean).join(", "),
  };
  if (view?.state !== "confirmed") return record;
  const line = recordLine(view.entry);
  const status = RECORD_STATUS_LABELS[line.key];
  return {
    ...record,
    label: line.label,
    status: line.key,
    spokenLabel: line.place ? `${status}. ${line.place}.` : `${status}.`,
  };
}

/** The confirmation that stands over a confirmed save, by where it came from. */
function firstTapSaveKicker(view) {
  if (view?.state !== "confirmed") return {};
  if (view.provenance === "saved_now") return { kicker: FIRST_TAP_WORDS.savedKicker, kickerIcon: "check" };
  if (view.provenance === "already") return { kicker: FIRST_TAP_WORDS.alreadyKicker };
  // In the Library; whether this reader's tap put it there is not known.
  return { kicker: FIRST_TAP_WORDS.inLibraryKicker, kickerIcon: "check" };
}

/**
 * Draws one state of the sheet: a kicker, the headline, the body, the story's
 * record, news of the save with a quiet button of its own (`note`), a second
 * headline and body, the rule line for a tap that leads to Safari's question,
 * and up to two buttons. `record.heading` makes the story's title the
 * headline. `bodyMarkup` is a body with words in bold, and `prompt` puts the
 * picture of Safari's question beside it, or under it on a narrow sheet. What is read aloud is `announce`,
 * or the headline and body.
 */
function drawFirstTapSheet(name, {
  kicker = "",
  kickerIcon = "",
  heading,
  glyph = "",
  glyphTone = "",
  body = "",
  bodyMarkup = "",
  prompt = false,
  record = null,
  recordAfterBody = false,
  note = null,
  ask = null,
  rule = false,
  primary = { hidden: true },
  secondary = null,
  result = "checking",
  announce = null,
  motion = "",
}) {
  const drawn = `${name}${ask ? "+ask" : ""}`;
  const changed = firstTapDrawn !== drawn;
  firstTapDrawn = drawn;
  setFirstTapState(name);
  setEarnedCopy({
    stateCode: `first-tap-${name}`,
    kicker,
    kickerIcon,
    glyph,
    glyphTone,
    heading,
    lead: body,
    leadMarkup: bodyMarkup,
    record,
    ruleMarkup: rule
      ? (safariQuestionButtonsAreAllBlue() ? FIRST_TAP_WORDS.ruleEveryButtonBlue : FIRST_TAP_WORDS.rule)
      : "",
  });
  placeEarnedRecord(recordAfterBody);
  if (record) {
    setSpokenAlternative(document.getElementById("popup-earned-record-byline"), record.spokenByline);
    setSpokenAlternative(document.getElementById("popup-earned-record-label"), record.spokenLabel);
  }
  const noteBox = firstTapNoteBox(Boolean(note));
  if (noteBox) {
    noteBox.hidden = !note;
    document.getElementById("popup-earned-note-heading").textContent = note?.heading || "";
    document.getElementById("popup-earned-note-body").textContent = note?.body || "";
    setEarnedAction(document.getElementById("popup-earned-note-action"), note?.action || { hidden: true });
  }
  const askBox = firstTapAskBox(Boolean(ask));
  if (askBox) {
    askBox.hidden = !ask;
    document.getElementById("popup-earned-ask-heading").textContent = ask?.heading || "";
    const askBody = document.getElementById("popup-earned-ask-body");
    setEarnedEmphasizedCopy(askBody, ask?.body || "");
    // The ask's body says what to tap, under it the picture shows it, and
    // the main button is described by it.
    if (ask) {
      showSafariPrompt(askBody);
      document.getElementById("popup-earned-primary")?.setAttribute("aria-describedby", "popup-earned-ask-body");
    }
  }
  if (prompt) {
    // The body says what to tap, the picture beside it shows it, and the main
    // button is described by it.
    showSafariPrompt(document.getElementById("popup-earned-lead"));
    document.getElementById("popup-earned-primary")?.setAttribute("aria-describedby", "popup-earned-lead");
  }
  const ruleEl = document.getElementById("popup-earned-rule");
  const primaryButton = document.getElementById("popup-earned-primary");
  if (rule) {
    // The colour is no use to a reader who is not looking at it.
    setSpokenAlternative(ruleEl, FIRST_TAP_WORDS.ruleSpoken);
    primaryButton?.setAttribute("aria-describedby", "popup-earned-rule");
  }
  setEarnedResult(result, announce ?? [heading, body].map(firstTapSpoken).filter(Boolean).join(" "), "");
  configureEarnedActions(primary, secondary);
  // A button still waiting on its answer goes on waiting through a redraw.
  showFirstTapBusy();
  if (!changed) return;
  clearFirstTapMotion();
  const section = document.getElementById("popup-earned-permission");
  const pin = document.getElementById("popup-earned-pin");
  if (motion === "settled") {
    playFirstTapMotion("popup-first-tap-fade", [section?.querySelector(".popup-earned-scroll"), pin]);
  }
}

/** Leaves nothing of the first-tap sheet on a popup that has moved on from it. */
function leaveFirstTapSheet() {
  firstTapDrawn = null;
  endFirstTapBusy();
  clearFirstTapMotion();
  resetEarnedSheetExtras();
  returnFirstTapSecondary();
  delete document.body.dataset.traceFirstTapState;
}

/**
 * The reader tapped a button whose answer comes from the background. Until
 * that answer comes the button waits and cannot be tapped again, so one tap
 * is one request. `work` is given the tap's number to send with the request;
 * only a message carrying it back ends the wait. `label` is what the button
 * reads meanwhile; with none it reads as it did.
 */
function holdFirstTapButton(button, work, label = "", resend = null) {
  if (firstTapBusy || !button) return;
  firstTapLooks += 1;
  const busy = {
    look: firstTapLooks, timer: null, resendTimer: null, button: button.id, action: button.dataset.earnedAction, label,
  };
  firstTapBusy = busy;
  busy.timer = setTimeout(() => {
    busy.timer = null;
    // No answer came. The sheet is drawn as it stood, and its button given back.
    if (firstTapBusy === busy && !firstTapSetAside) redrawFirstTapAloud();
  }, FIRST_TAP_BUSY_LIMIT_MS);
  // Safari may have stopped the background under the sheet, and the port to
  // it then carries nothing, with or without word that it closed. A look with
  // no word back in a few seconds is sent once more over a new port, which
  // wakes a background. A look is read only, so sending it twice asks nothing
  // twice that matters, and its answer still carries the tap's number.
  if (resend) {
    busy.resendTimer = setTimeout(() => {
      busy.resendTimer = null;
      if (firstTapBusy === busy && !firstTapSetAside) resend(busy.look);
    }, FIRST_TAP_SAVE_ANSWER_MS);
  }
  showFirstTapBusy();
  if (label) setEarnedResult("checking", firstTapSpoken(label), "");
  work(busy.look);
}

/** Shows the wait on the button that is waiting, where the sheet still has that button. */
function showFirstTapBusy() {
  const busy = firstTapBusy;
  const button = busy ? document.getElementById(busy.button) : null;
  if (!button || button.hidden || button.dataset.earnedAction !== busy.action) return;
  setEarnedAction(button, {
    label: busy.label || button.textContent, action: "", disabled: true, emphasis: button.dataset.emphasis,
  });
}

/** Ends a wait on a button. True when there was one. */
function endFirstTapBusy() {
  const busy = firstTapBusy;
  if (!busy) return false;
  if (busy.timer !== null) clearTimeout(busy.timer);
  if (busy.resendTimer) clearTimeout(busy.resendTimer);
  firstTapBusy = null;
  return true;
}

/**
 * Draws what the background last said, and says it aloud again even when it
 * is word for word what was there: the reader asked, and silence would read
 * as nothing having been looked at.
 */
function redrawFirstTapAloud() {
  endFirstTapBusy();
  lastEarnedAnnouncement = "";
  drawFirstTap();
}

/** Sends a look the reader asked for, over a port opened again if it has gone. */
function firstTapLook(command, look) {
  if (!firstTapPort && firstTapStory && firstTapTab) {
    // The background was restarted under the sheet. Opening on the story
    // again is itself the look, and what it shows is its answer.
    endFirstTapBusy();
    startFirstTap(firstTapStory, firstTapTab);
    return;
  }
  firstTapSend(command, { look });
}

/**
 * A look the reader asked for, sent again over a new port. The story is
 * opened on first, so that a background woken by it knows which story the
 * look is about; an "open" is itself the look and goes once.
 */
function resendFirstTapLook(command, look) {
  if (!firstTapStory || !firstTapTab) return;
  dropFirstTapPort();
  if (!connectFirstTapPort()) return;
  if (command !== "open") firstTapSend("open");
  firstTapSend(command, { look });
}

/** After the reader goes back to the ask: focus on its headline, not on a button that has changed. */
function focusFirstTapAsk() {
  const ask = document.getElementById("popup-earned-ask");
  const heading = ask && !ask.hidden
    ? document.getElementById("popup-earned-ask-heading")
    : document.getElementById("popup-earned-heading");
  heading?.focus();
}

const firstTapButton = Object.freeze({
  keepReading: Object.freeze({ label: FIRST_TAP_WORDS.keepReading, action: "close", emphasis: "secondary" }),
  notNow: Object.freeze({ label: FIRST_TAP_WORDS.notNow, action: "close", emphasis: "tertiary" }),
  allow: Object.freeze({ label: FIRST_TAP_WORDS.allow, action: "first_tap_allow", emphasis: "primary" }),
  waiting: Object.freeze({ label: FIRST_TAP_WORDS.waitingForSafari, action: "", disabled: true, emphasis: "secondary" }),
});

/**
 * A confirmed save: one line that says so, and under it the ask for lasting
 * access, which is the sheet's headline. Both arrive together, so nothing
 * moves when the ask comes. While Safari's question is up it stays, with its
 * button waiting.
 */
function drawFirstTapConfirmed(view, { waiting = false } = {}) {
  const name = view.provenance === "saved_now" ? "saved"
    : view.provenance === "already" ? "already-in-library" : "in-library";
  const confirmation = firstTapSaveKicker(view);
  const arriving = !firstTapSavedDrawn && !waiting;
  firstTapSavedDrawn = true;
  if (!firstTapConfirmationDelivered) {
    firstTapConfirmationDelivered = true;
    void deliverFirstStoryConfirmation();
  }
  setEarnedCheck("popup-earned-save", "pass", "Saved", "Saved to Trace");
  drawFirstTapSheet(waiting ? "access-waiting" : name, {
    ...confirmation,
    heading: FIRST_TAP_WORDS.askHeading,
    bodyMarkup: FIRST_TAP_WORDS.askBody,
    prompt: true,
    primary: waiting ? firstTapButton.waiting : firstTapButton.allow,
    secondary: firstTapButton.notNow,
    result: "success",
    announce: waiting
      ? firstTapSpoken(FIRST_TAP_WORDS.waitingForSafari)
      : `${firstTapSpoken(confirmation.kicker)} ${firstTapSpoken(FIRST_TAP_WORDS.askHeading)} ${FIRST_TAP_WORDS.askBodySpoken}`,
    // The save lands and the ask comes with it in one cross-fade, in place:
    // nothing slides, so nothing reaches past the sheet's foot as it comes.
    motion: arriving ? "settled" : "",
  });
}

/**
 * The ask for lasting access, as the background reports it. The background
 * reads what Safari allows after the request; nothing here is drawn from what
 * the request itself returned. No state says how long the access lasts:
 * Safari does not tell an extension that.
 */
function renderFirstTapAccess(access, view) {
  const confirmation = firstTapSaveKicker(view);
  const allowedKicker = { kicker: FIRST_TAP_WORDS.allowedKicker, kickerIcon: "check" };
  const savedRecord = view?.state === "confirmed" ? firstTapRecord(view) : null;
  switch (access.state) {
    case "waiting":
      // Safari's question is up. What is shown of the save stays; only the
      // ask's own button changes, and it cannot be tapped again.
      if (view?.state === "confirmed" || view?.state === "saving") {
        renderFirstTapView(view, { waiting: true });
        return;
      }
      setFirstTapState("access-waiting");
      configureEarnedActions(firstTapButton.waiting, firstTapButton.notNow);
      setEarnedResult("checking", firstTapSpoken(FIRST_TAP_WORDS.waitingForSafari), "");
      return;
    case "allowed":
      // Every story site is allowed and the page scripts are registered.
      // Saving by itself also needs an account and the preference on, and
      // the fullest state is drawn only when both were read as so just now.
      if (access.account === "connected" && access.automaticSaving === "on") {
        drawFirstTapSheet("access-allowed", {
          ...allowedKicker,
          heading: FIRST_TAP_WORDS.allowedHeading,
          body: FIRST_TAP_WORDS.allowedBody,
          record: savedRecord,
          recordAfterBody: true,
          primary: firstTapButton.keepReading,
          result: "success",
          announce: [FIRST_TAP_WORDS.allowedKicker, FIRST_TAP_WORDS.allowedHeading, FIRST_TAP_WORDS.allowedBody]
            .map(firstTapSpoken).join(" "),
          motion: "settled",
        });
      } else if (access.account === "missing" || access.account === "reconnect_required") {
        // Allowed, and known to have no account to save to. What to do about
        // the account is said in the words that account state always has;
        // looking again asks Safari for nothing.
        const missing = access.account === "missing";
        const heading = missing ? FIRST_TAP_WORDS.accountMissingHeading : FIRST_TAP_WORDS.reconnectHeading;
        const body = missing ? FIRST_TAP_WORDS.accountMissingBody : FIRST_TAP_WORDS.reconnectBody;
        drawFirstTapSheet(missing ? "access-allowed-account-missing" : "access-allowed-account-reconnect", {
          ...allowedKicker,
          heading,
          body,
          primary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_access_check", emphasis: "primary" },
          secondary: firstTapButton.keepReading,
          result: "failure",
          announce: [FIRST_TAP_WORDS.allowedKicker, heading, body].map(firstTapSpoken).join(" "),
          motion: "settled",
        });
      } else if (access.automaticSaving === "off") {
        drawFirstTapSheet("access-allowed-automatic-saving-off", {
          ...allowedKicker,
          heading: FIRST_TAP_WORDS.allowedOffHeading,
          body: FIRST_TAP_WORDS.allowedOffBody,
          primary: { label: FIRST_TAP_WORDS.turnAutomaticSavingOn, action: "first_tap_automatic_saving_on", emphasis: "primary" },
          secondary: firstTapButton.keepReading,
          announce: [FIRST_TAP_WORDS.allowedKicker, FIRST_TAP_WORDS.allowedOffHeading, FIRST_TAP_WORDS.allowedOffBody]
            .map(firstTapSpoken).join(" "),
          motion: "settled",
        });
      } else {
        // Allowed; the account or the preference could not be read, so
        // nothing more than "allowed" is said.
        drawFirstTapAllowedOnly("access-allowed-unconfirmed", savedRecord, null);
      }
      return;
    case "registration_unknown":
      // Safari allows the story sites; whether Trace's page scripts are in
      // place could not be read. Allowed is all that is said. Looking again
      // asks Safari for nothing.
      drawFirstTapAllowedOnly("access-registration-unknown", savedRecord, {
        label: FIRST_TAP_WORDS.checkAgain, action: "first_tap_access_check", emphasis: "tertiary",
      });
      return;
    case "registration_failed":
      // Safari allows the story sites; Trace's page scripts are not in place.
      // Trying again asks Safari for nothing.
      drawFirstTapSheet("access-registration-failed", {
        ...allowedKicker,
        heading: FIRST_TAP_WORDS.registrationFailedHeading,
        body: FIRST_TAP_WORDS.registrationFailedBody,
        primary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_access_check", emphasis: "primary" },
        result: "failure",
      });
      return;
    case "partial":
      // Some of the story sites, not all: never drawn as allowed.
      drawFirstTapSheet("access-partial", {
        ...confirmation,
        heading: FIRST_TAP_WORDS.partialHeading,
        body: FIRST_TAP_WORDS.partialBody,
        rule: true,
        primary: firstTapButton.allow,
        secondary: firstTapButton.notNow,
      });
      return;
    case "not_allowed":
    case "could_not_ask": {
      // The request came back "no", or could not be made. Whether the reader
      // said no or Safari did without asking is not something Trace can
      // tell, so the reader is shown one thing: saving stays a tap away, and
      // the ask is there to go back to. The save, if there was one, is kept.
      // With automatic saving read as off, or in a build that saves only on
      // the reader's tap, that tap opens Trace and saves nothing by itself,
      // and the words say so.
      const onRequest = access.automaticSaving === "off" || !FIRST_TAP_SAVES_ON_OPEN;
      drawFirstTapSheet("access-not-allowed", {
        ...confirmation,
        heading: onRequest ? FIRST_TAP_WORDS.notAllowedOnRequestHeading : FIRST_TAP_WORDS.notAllowedHeading,
        body: onRequest ? FIRST_TAP_WORDS.notAllowedOnRequestBody : FIRST_TAP_WORDS.notAllowedBody,
        primary: firstTapButton.keepReading,
        // Back to the ask; the request is made by the reader's tap there.
        secondary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_show_ask", emphasis: "tertiary" },
      });
      return;
    }
    default:
      // What came of the ask is not known: Safari's answer could not be
      // read, or never came. Never drawn as not allowed. The reader can ask
      // again, or have Trace look again.
      drawFirstTapSheet("access-not-known", {
        ...confirmation,
        heading: FIRST_TAP_WORDS.notKnownHeading,
        body: FIRST_TAP_WORDS.notKnownBody,
        rule: true,
        primary: firstTapButton.allow,
        secondary: { label: FIRST_TAP_WORDS.checkAgain, action: "first_tap_access_check", emphasis: "tertiary" },
      });
  }
}

/** Allowed, and no more than that: the confirmation and the story's record. */
function drawFirstTapAllowedOnly(name, savedRecord, secondary) {
  drawFirstTapSheet(name, savedRecord
    ? {
        kicker: FIRST_TAP_WORDS.allowedKicker,
        kickerIcon: "check",
        heading: savedRecord.title,
        record: { ...savedRecord, title: "", heading: true },
        primary: firstTapButton.keepReading,
        secondary,
        announce: firstTapSpoken(FIRST_TAP_WORDS.allowedKicker),
        motion: "settled",
      }
    : {
        glyph: "check",
        heading: FIRST_TAP_WORDS.allowedKicker,
        primary: firstTapButton.keepReading,
        secondary,
        motion: "settled",
      });
}

function renderFirstTapView(view, { waiting = false } = {}) {
  const story = firstTapStory;
  if (!view || !story) return;
  if (view.state !== "confirmed") {
    // The ask comes with a confirmed save, and arrives with each one afresh.
    firstTapSavedDrawn = false;
  }
  stopStoryConfirmation();
  const record = firstTapRecord(view);
  const tryAgainAccount = { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_open", emphasis: "primary" };
  const checkAgain = { label: FIRST_TAP_WORDS.checkAgain, action: "first_tap_check", emphasis: "primary" };
  switch (view.state) {
    case "opening":
    case "account_changed":
      drawFirstTapSheet("connecting", {
        glyph: "progress",
        glyphTone: "progress",
        heading: FIRST_TAP_WORDS.connecting,
      });
      // What was shown belonged to another account. Ask again for this one.
      if (view.state === "account_changed") firstTapSend("open");
      return;
    case "account_missing":
      drawFirstTapSheet("account-missing", {
        heading: FIRST_TAP_WORDS.accountMissingHeading,
        body: FIRST_TAP_WORDS.accountMissingBody,
        primary: tryAgainAccount,
        result: "failure",
      });
      return;
    case "account_unknown":
      // Not known is never drawn as signed out.
      drawFirstTapSheet("account-unreachable", {
        heading: FIRST_TAP_WORDS.accountUnreachableHeading,
        body: FIRST_TAP_WORDS.accountUnreachableBody,
        primary: tryAgainAccount,
      });
      return;
    case "account_reconnect_required":
      // Known: Trace refused the account Safari holds.
      drawFirstTapSheet("account-reconnect", {
        heading: FIRST_TAP_WORDS.reconnectHeading,
        body: FIRST_TAP_WORDS.reconnectBody,
        primary: tryAgainAccount,
        result: "failure",
      });
      return;
    case "awaiting_request": {
      const save = { label: FIRST_TAP_WORDS.saveThisStory, action: "first_tap_save", emphasis: "primary" };
      if (view.preference === "off") {
        drawFirstTapSheet("automatic-saving-off", {
          heading: FIRST_TAP_WORDS.automaticSavingOffHeading,
          record,
          primary: save,
          secondary: { label: FIRST_TAP_WORDS.turnAutomaticSavingOn, action: "first_tap_automatic_saving_on", emphasis: "tertiary" },
          announce: `${firstTapSpoken(FIRST_TAP_WORDS.automaticSavingOffHeading)} ${firstTapSpoken(record.spokenName)}`,
        });
      } else {
        // The preference could not be read, so nothing is saved unasked.
        drawFirstTapSheet("save-on-request", {
          heading: record.title,
          record: { ...record, title: "", heading: true },
          primary: save,
          announce: firstTapSpoken(record.spokenName),
        });
      }
      return;
    }
    case "saving":
      // Once a save has outrun the popup's patience it is drawn as still
      // being confirmed, however often its state arrives again.
      if (waiting || firstTapPatienceFor(view.startedAt).spent) {
        // The story, the news that it is not confirmed yet with a look to
        // ask for, and under that the ask for lasting access: the reader
        // need not wait on the save to be asked. The story sites are not
        // allowed here, or the page would be saving by itself.
        drawFirstTapSheet(waiting ? "access-waiting" : "still-confirming", {
          heading: record.title,
          record: { ...record, title: "", heading: true },
          note: {
            heading: FIRST_TAP_WORDS.stillConfirmingHeading,
            body: FIRST_TAP_WORDS.stillConfirmingBody,
            action: { label: FIRST_TAP_WORDS.checkAgain, action: "first_tap_check", emphasis: "tertiary" },
          },
          ask: { heading: FIRST_TAP_WORDS.askHeading, body: FIRST_TAP_WORDS.askBody },
          primary: waiting ? firstTapButton.waiting : firstTapButton.allow,
          secondary: firstTapButton.keepReading,
          announce: waiting
            ? firstTapSpoken(FIRST_TAP_WORDS.waitingForSafari)
            : `${firstTapSpoken(FIRST_TAP_WORDS.stillConfirmingHeading)} ${FIRST_TAP_WORDS.stillConfirmingBody}`,
        });
        return;
      }
      drawFirstTapSheet("saving", {
        heading: record.title,
        record: {
          ...record, title: "", heading: true, label: FIRST_TAP_WORDS.saving, status: "CHECKING", tone: "secondary",
          spokenLabel: firstTapSpoken(FIRST_TAP_WORDS.saving),
        },
        announce: firstTapSpoken(FIRST_TAP_WORDS.saving),
      });
      return;
    case "confirmed":
      drawFirstTapConfirmed(view, { waiting });
      return;
    case "failed": {
      if (view.reason === "story_unavailable") {
        drawFirstTapSheet("story-unavailable", {
          heading: FIRST_TAP_WORDS.unavailableHeading,
          body: FIRST_TAP_WORDS.unavailableBody,
          primary: { label: FIRST_TAP_WORDS.close, action: "close", emphasis: "tertiary" },
          result: "failure",
        });
        return;
      }
      if (view.reason === "free_limit_reached") {
        leaveFirstTapSheet();
        setFirstTapState("library-full");
        renderEarnedLibraryFull(true);
        return;
      }
      if (view.dispatch === "sent_unconfirmed") {
        // Sent, and not heard back from: never drawn as not saved.
        drawFirstTapSheet("save-unconfirmed", {
          heading: FIRST_TAP_WORDS.unconfirmedHeading,
          body: FIRST_TAP_WORDS.unconfirmedBody,
          primary: checkAgain,
        });
        return;
      }
      if (view.reason === "not_authenticated") {
        // Trace turned the account down, so nothing was saved. Trying again
        // is a new save the reader chose.
        drawFirstTapSheet("save-reconnect", {
          heading: FIRST_TAP_WORDS.reconnectHeading,
          body: FIRST_TAP_WORDS.reconnectBody,
          primary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_save", emphasis: "primary" },
          result: "failure",
        });
        return;
      }
      if (view.dispatch === "not_in_library") {
        // The save went out unanswered, and Trace has since said, when the
        // reader asked, that the story is not in the Library. Trying again
        // is a new save the reader chose.
        drawFirstTapSheet("save-not-in-library", {
          heading: FIRST_TAP_WORDS.notInLibraryHeading,
          body: FIRST_TAP_WORDS.notInLibraryBody,
          primary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_save", emphasis: "primary" },
          result: "failure",
        });
        return;
      }
      // `never_sent` is the only failure that may say nothing was sent; a
      // refusal is Trace's answer.
      const added = view.dispatch !== "never_sent";
      drawFirstTapSheet(added ? "save-refused" : "save-not-sent", {
        heading: added ? FIRST_TAP_WORDS.refusedHeading : FIRST_TAP_WORDS.notSentHeading,
        body: added ? FIRST_TAP_WORDS.refusedBody : FIRST_TAP_WORDS.notSentBody,
        primary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_save", emphasis: "primary" },
        secondary: firstTapButton.notNow,
        result: "failure",
      });
      return;
    }
    case "presence_unknown":
      // Looking found nothing it could rely on. The reader may look again,
      // or choose to save again; that choice is theirs, never made for them.
      drawFirstTapSheet("still-unknown", {
        heading: FIRST_TAP_WORDS.stillUnknownHeading,
        body: FIRST_TAP_WORDS.stillUnknownBody,
        primary: checkAgain,
        secondary: { label: FIRST_TAP_WORDS.tryAgain, action: "first_tap_save", emphasis: "tertiary" },
      });
      return;
    default:
      // The story sites are allowed, or this is not a page to save from: the
      // popup's usual flow takes over and the first-tap save stands aside.
      firstTapSetAside = true;
      if (firstTapPatience && firstTapPatience.timer !== null) clearTimeout(firstTapPatience.timer);
      firstTapPatience = null;
      stopWaitOnAnswer();
      leaveFirstTapSheet();
      void prepareEarnedPermissionFlow();
  }
}

/**
 * The wait on one save. It starts when the save is first drawn and is not
 * started again by the same save's state arriving a second time.
 */
function firstTapPatienceFor(startedAt) {
  if (firstTapPatience?.startedAt === startedAt) return firstTapPatience;
  if (firstTapPatience && firstTapPatience.timer !== null) clearTimeout(firstTapPatience.timer);
  const patience = { startedAt, spent: false, timer: null };
  // How long to wait before saying so has not been measured from real
  // saves; until it is, this is the popup's existing patience.
  patience.timer = setTimeout(() => {
    patience.timer = null;
    patience.spent = true;
    const view = firstTapLastView;
    if (
      firstTapPatience === patience && view?.state === "saving" && view.startedAt === startedAt &&
      !firstTapAccess && !firstTapSetAside
    ) {
      drawFirstTap();
    }
  }, STORY_CONFIRMATION_PATIENCE_MS);
  firstTapPatience = patience;
  return patience;
}

/**
 * Automatic saving, turned on from the sheet. The settings control shows
 * what storage then holds, not what was asked for. When it is on, the
 * background reads what holds; opened on a story not yet saved, that saves
 * the story, which is what the reader has just asked for.
 */
async function turnOnAutomaticSavingFromFirstTap(look) {
  try {
    await earnedStorageSet({ [PREF_AUTO_TRACK_KEY]: true, prefAutoTrackSetAt: Date.now() });
  } catch {
    // The read that follows says what the preference now is.
  }
  let stored = null;
  try {
    stored = (await earnedStorageGet([PREF_AUTO_TRACK_KEY]))?.[PREF_AUTO_TRACK_KEY];
  } catch {
    // Not readable either: the control is left showing what it showed.
  }
  const input = document.getElementById("pref-auto-track");
  if (input && typeof stored === "boolean") input.checked = stored;
  if (stored !== true) {
    // It did not take. The sheet is as it was, with its button back.
    if (!firstTapSetAside) redrawFirstTapAloud();
    return;
  }
  if (firstTapAccess) void observeStorySiteAccess("access_check", { look });
  else firstTapLook("open", look);
}
// ── end of the first-tap sheet ─────────────────────────────────────────────────

/** Draws the save's state and, over it, the state of the ask. */
function drawFirstTap() {
  const view = firstTapLastView;
  const access = firstTapAccess;
  // Nothing asked: the save's own state, which offers the ask where there
  // is one to offer.
  if (!access || access.state === "not_asked") {
    firstTapAccess = null;
    if (view) renderFirstTapView(view);
    return;
  }
  // A save that did not land is said, whatever came of an ask made while it
  // was still out: what came of the ask must not stand over it. Only the
  // story sites being allowed is drawn in its place, since from then the
  // page saves the story by itself. What came of the ask is let go; the next
  // open reads what Safari allows afresh. A request still out is still
  // waited on.
  if (firstTapSaveFailed(view) && !FIRST_TAP_ALLOWED_STATES.includes(access.state)) {
    if (access.state !== "waiting") firstTapAccess = null;
    renderFirstTapView(view);
    return;
  }
  renderFirstTapAccess(access, view);
}

const FIRST_TAP_ALLOWED_STATES = Object.freeze(["allowed", "registration_failed", "registration_unknown"]);

/** Whether the background's last word on the save is that it did not land, or may not have. */
function firstTapSaveFailed(view) {
  return view?.state === "failed" || view?.state === "presence_unknown";
}

/** The wait on a request is over. The request itself may still be out. */
function endFirstTapAsk(ask) {
  if (ask.timer !== null) clearTimeout(ask.timer);
  ask.timer = null;
  if (firstTapAsk === ask) firstTapAsk = null;
}

/**
 * The ask for lasting access to the story sites. Safari raises its question
 * only for a request made in the reader's tap itself, so the request is made
 * first, before anything is read or awaited. What it returns is passed to the
 * background as evidence; the background reads what Safari now allows and
 * says what came of it.
 *
 * The wait does not depend on the request ever coming back. While it is out
 * what Safari allows is read again on a schedule, and the wait ends as
 * allowed the moment the story sites are. After the deadline the popup says
 * it does not know, and the reader can ask again. No amount of waiting is
 * ever taken as "no".
 */
function askForStorySites() {
  // One request at a time: a second tap while Safari's question is up does nothing.
  if (firstTapAsk) return;
  const ask = { timer: null, waitedMs: 0 };
  firstTapAsk = ask;
  const request = extensionPromiseCall(ext.permissions, "request", [{ origins: earnedOrigins() }]);
  firstTapSend("access_asking");
  void recordEarnedEvent("website_access_requested");

  const lookAgain = () => {
    ask.timer = null;
    if (firstTapAsk !== ask) return;
    ask.waitedMs += FIRST_TAP_ASK_REREAD_MS;
    if (ask.waitedMs >= FIRST_TAP_ASK_DEADLINE_MS) {
      // Not known, said here so that it does not itself wait on anything;
      // the background's own read can then only improve on it.
      endFirstTapAsk(ask);
      firstTapAccess = { state: "not_known" };
      drawFirstTap();
      void observeStorySiteAccess("access_unanswered");
      return;
    }
    void observeStorySiteAccess("access_waiting", {}, { onlyIfAllowed: true });
    ask.timer = setTimeout(lookAgain, FIRST_TAP_ASK_REREAD_MS);
  };
  ask.timer = setTimeout(lookAgain, FIRST_TAP_ASK_REREAD_MS);

  void request
    .then(
      (returned) => ({ returned }),
      () => ({ threw: true }),
    )
    .then((answer) => {
      // Another request is out by now: this one's word is not about it, and
      // only the sites being allowed ends that wait.
      if (firstTapAsk && firstTapAsk !== ask) {
        return observeStorySiteAccess("access_waiting", {}, { onlyIfAllowed: true });
      }
      // A request that came back with neither yes nor no has told nothing.
      // The background will say it does not know; look once more shortly,
      // which can find the sites allowed and can never find "no".
      if (answer.threw !== true && answer.returned !== true && answer.returned !== false) {
        setTimeout(() => {
          if (!firstTapAsk && firstTapAccess?.state === "not_known") {
            void observeStorySiteAccess("access_unanswered");
          }
        }, FIRST_TAP_ASK_REREAD_MS);
      }
      // Safari said yes. Should the background not see it yet, the popup
      // looks again by itself while it is still not known.
      if (answer.returned === true) lookAgainAfterYes();
      // Passed on even when it comes after this wait ran out: it is still
      // evidence, and the background still reads before it says anything.
      // The wait itself ends when the background answers, or at the deadline.
      return observeStorySiteAccess("access_answered", answer).then((order) => {
        // The background may have been stopped while Safari's question was
        // up, and the port to it carry nothing. With no word back in a few
        // seconds the answer goes once more over a new port.
        waitOnAnswer(order, answer);
      });
    })
    .catch(() => undefined);
}

/**
 * The wait for word on the answer to Safari's question, sent under `order`.
 * With no word in FIRST_TAP_SAVE_ANSWER_MS the answer goes once more over a
 * new port. Word that the background has it and is still checking means it
 * is awake, only slow, and a new port would lose what it finds: from that
 * word it is given FIRST_TAP_ACCESS_CHECKING_MS, and the answer goes once
 * more only if that passes with no word either. Once, never more.
 */
function waitOnAnswer(order, answer) {
  stopWaitOnAnswer();
  const heard = firstTapAccessHeard;
  const port = firstTapPort;
  const wait = { order, timer: null, checking: false };
  wait.unheard = () => firstTapAnswerWait === wait &&
    firstTapAccessHeard === heard && firstTapPort === port && !firstTapSetAside;
  wait.sendAgain = (final) => {
    wait.timer = null;
    if (!wait.unheard()) return;
    // Word that it is checking may still come while the new port is being
    // readied; then this send is let go and the longer wait stands.
    const stillWanted = () => final || (!wait.checking && wait.unheard());
    void observeStorySiteAccess("access_answered", answer, { freshPort: true, stillWanted }).then(() => {
      if (firstTapAnswerWait === wait && (final || !wait.checking)) firstTapAnswerWait = null;
    });
  };
  wait.timer = setTimeout(() => wait.sendAgain(false), FIRST_TAP_SAVE_ANSWER_MS);
  firstTapAnswerWait = wait;
  if (order !== null && firstTapAccessChecking >= order) answerIsBeingChecked(order);
}

/** The background has the answer under `order` and is checking it. */
function answerIsBeingChecked(order) {
  const wait = firstTapAnswerWait;
  if (!wait || wait.checking || wait.order === null || order < wait.order || !wait.unheard()) return;
  wait.checking = true;
  if (wait.timer !== null) clearTimeout(wait.timer);
  wait.timer = setTimeout(() => wait.sendAgain(true), FIRST_TAP_ACCESS_CHECKING_MS);
}

function stopWaitOnAnswer() {
  const wait = firstTapAnswerWait;
  firstTapAnswerWait = null;
  if (wait && wait.timer !== null) clearTimeout(wait.timer);
}

/** After Safari's yes: a few looks, each only while the ask is still not known. */
function lookAgainAfterYes() {
  let at = 0;
  const look = () => {
    if (firstTapSetAside) return;
    const state = firstTapAccess?.state ?? null;
    // Anything but not known (or no word yet) is an answer: nothing to look into.
    if (state !== null && state !== "not_known" && state !== "waiting") return;
    // A request asked again since is waited on as any other.
    if (!firstTapAsk && state === "not_known") void observeStorySiteAccess("access_unanswered");
    at += 1;
    if (at < FIRST_TAP_YES_LOOKS_MS.length) setTimeout(look, FIRST_TAP_YES_LOOKS_MS[at]);
  };
  setTimeout(look, FIRST_TAP_YES_LOOKS_MS[0]);
}

/**
 * Asks the background what Safari allows now. Where the story sites are
 * allowed, Trace's page scripts are registered first, so that the background
 * reads them in place. Nothing here asks Safari for anything.
 */
async function observeStorySiteAccess(
  command, answer = {}, { onlyIfAllowed = false, freshPort = false, stillWanted = null } = {},
) {
  if (await readCompleteEarnedGrant().catch(() => false)) {
    await reconcileEarnedRegistration().catch(() => null);
  } else if (onlyIfAllowed) {
    return null;
  }
  if (stillWanted && !stillWanted()) return null;
  // Sent again because nothing came back: over a new port, which wakes a
  // background, opened on the story first as any new port is.
  if (freshPort && firstTapStory && firstTapTab) {
    dropFirstTapPort();
    if (connectFirstTapPort()) firstTapSend("open");
  }
  // The background may have been restarted while Safari's question was up.
  if (!firstTapPort && firstTapStory && firstTapTab) startFirstTap(firstTapStory, firstTapTab);
  // The number it went under, or null when it could not go.
  return firstTapSend(command, answer) ? firstTapOrder : null;
}

/**
 * What Safari allows may have changed under the sheet: a permission was added
 * or removed, or the popup has come back into view. What is shown of the ask
 * is read again, so that "allowed" never outlives the access it describes and
 * a wait does not miss a grant made elsewhere.
 */
function reobserveStorySiteAccess(permissionChanged) {
  if (!firstTapPort || firstTapSetAside) return;
  if (firstTapAsk) {
    void observeStorySiteAccess("access_waiting", {}, { onlyIfAllowed: true });
    return;
  }
  const state = firstTapAccess?.state ?? null;
  // Not known can only improve by looking: it is never looked into "no".
  if (state === "not_known") {
    void observeStorySiteAccess("access_unanswered");
  } else if (state === "allowed" || state === "registration_failed" || state === "registration_unknown") {
    void observeStorySiteAccess("access_check");
  } else if (permissionChanged && (state !== null || firstTapLastView?.state === "confirmed")) {
    void observeStorySiteAccess("access_check");
  }
}

function watchStorySiteAccess() {
  if (firstTapAccessWatched) return;
  firstTapAccessWatched = true;
  try {
    ext.permissions?.onAdded?.addListener(() => reobserveStorySiteAccess(true));
    ext.permissions?.onRemoved?.addListener(() => reobserveStorySiteAccess(true));
  } catch {
    // The popup coming back into view still looks again.
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reobserveStorySiteAccess(false);
  });
  window.addEventListener("focus", () => reobserveStorySiteAccess(false));
}

/** The background's word on the ask. Any word but "waiting" ends the wait. */
function receiveStorySiteAccess(access, order) {
  // Word under a number older than the newest taken came late: what it says
  // has been overtaken. Word with no number is taken as it comes.
  if (Number.isSafeInteger(order)) {
    const passing = firstTapPassingLooks.delete(order);
    if (order < firstTapAccessTaken) return false;
    // A look that finds the sites allowed has nothing fuller behind it.
    if (!passing || access.state === "allowed") {
      firstTapAccessTaken = order;
      for (const look of firstTapPassingLooks) if (look < order) firstTapPassingLooks.delete(look);
    }
  }
  const asked = firstTapAsk;
  // "Waiting" is only ever true of a request this popup still has out.
  if (!asked && access.state === "waiting") return false;
  if (asked && access.state !== "waiting") endFirstTapAsk(asked);
  // A look made for a popup that shows nothing of the ask, finding nothing
  // to show: what is on screen is left as it is.
  if (access.state === "not_asked" && firstTapAccess === null) return false;
  firstTapAccess = access;
  return true;
}

/** Opens the first-tap save for the story on this tab. False when it cannot be reached. */
function startFirstTap(story, tab) {
  firstTapStory = story;
  firstTapTab = Number.isInteger(tab?.tabId)
    ? tab
    : { tabId: tab.id, url: tab.url, private: firstTapTabIsPrivate(tab) };
  if (!firstTapPort) {
    if (!connectFirstTapPort()) return false;
    watchStorySiteAccess();
    renderFirstTapView({ state: "opening" });
  }
  firstTapSend("open");
  return true;
}

/** Opens the port to the background. Only the port now open is listened to. */
function connectFirstTapPort() {
  let port = null;
  try {
    port = ext.runtime.connect({ name: FIRST_TAP_POPUP_PORT });
  } catch {
    port = null;
  }
  if (!port?.postMessage || !port.onMessage) return false;
  firstTapPort = port;
  port.onMessage.addListener((message) => {
    if (message && port === firstTapPort) receiveFirstTapMessage(message);
  });
  port.onDisconnect?.addListener(() => {
    if (firstTapPort === port) firstTapPort = null;
  });
  return true;
}

/** Lets go of the port, so that the next request opens a new one. */
function dropFirstTapPort() {
  const port = firstTapPort;
  firstTapPort = null;
  try {
    port?.disconnect?.();
  } catch {
    // Already gone.
  }
}

function receiveFirstTapMessage(message) {
  // The background has the answer to Safari's question and is still checking.
  // That only keeps the answer from being sent again; nothing is drawn from it.
  if (Number.isSafeInteger(message.checking)) {
    firstTapAccessChecking = Math.max(firstTapAccessChecking, message.checking);
    answerIsBeingChecked(message.checking);
    return;
  }
  const delivery = firstTapSaveDelivery;
  // A save this sheet has seen confirmed is never taken back to the offer to
  // save it by a later open.
  const view = message.view?.state === "awaiting_request" && firstTapLastView?.state === "confirmed" &&
    firstTapLastView.workKey === message.view.workKey
    ? undefined
    : message.view;
  // The background has the reader's save: its answer, or the save's own state.
  if (delivery && (message.answered === delivery.look || (view && view.state !== "awaiting_request"))) {
    endFirstTapSaveDelivery(delivery);
    if (firstTapBusy?.look === delivery.look && message.answered !== delivery.look) endFirstTapBusy();
  }
  if (message.access) firstTapAccessHeard += 1;
  const accessChanged = message.access ? receiveStorySiteAccess(message.access, message.order) : false;
  if (view) firstTapLastView = view;
  // The answer to what the reader asked for, known by the tap's number,
  // ends the wait on its button and is drawn and said aloud even when it
  // is what the sheet already showed. Anything else is drawn as usual,
  // and leaves a waiting button waiting.
  if (firstTapBusy && message.answered === firstTapBusy.look) redrawFirstTapAloud();
  else if (accessChanged || view) drawFirstTap();
}

function endFirstTapSaveDelivery(delivery) {
  if (delivery.timer !== null) clearTimeout(delivery.timer);
  delivery.timer = null;
  if (firstTapSaveDelivery === delivery) firstTapSaveDelivery = null;
}

/**
 * The reader's "Save this story", sent to the background under the tap's
 * number. Safari may have put the background to sleep while the sheet sat
 * open, and a port to it then carries nothing, with or without word that it
 * closed. So a port known to be closed is opened again before the save goes,
 * and a save with no word back in FIRST_TAP_SAVE_ANSWER_MS goes once more
 * over a new port, which wakes the background. That is still one save: the
 * background starts one at a time for a story and answers a second request
 * with the one under way. With still no word the sheet says the save could
 * not be confirmed, and offers to check; it is never left as it was.
 */
function sendFirstTapSave(look) {
  if (firstTapSaveDelivery) endFirstTapSaveDelivery(firstTapSaveDelivery);
  const delivery = { look, timer: null, sends: 0 };
  firstTapSaveDelivery = delivery;
  const send = () => {
    if (!firstTapPort) connectFirstTapPort();
    if (firstTapPort && firstTapSend("save", { look })) {
      delivery.sends += 1;
      return true;
    }
    // The port would not take it: a new one, once.
    dropFirstTapPort();
    if (connectFirstTapPort() && firstTapSend("save", { look })) {
      delivery.sends += 1;
      return true;
    }
    return false;
  };
  const unanswered = () => {
    endFirstTapSaveDelivery(delivery);
    if (firstTapBusy?.look !== look) return;
    endFirstTapBusy();
    dropFirstTapPort();
    const last = firstTapLastView;
    // Nothing reached a background: nothing was sent. Otherwise a save may
    // have gone out, so it is never said not to have.
    firstTapLastView = Object.freeze({
      state: "failed",
      workKey: last?.workKey ?? "",
      reason: "unavailable",
      dispatch: delivery.sends === 0 ? "never_sent" : "sent_unconfirmed",
      story: last?.story ?? null,
    });
    lastEarnedAnnouncement = "";
    if (!firstTapSetAside) drawFirstTap();
  };
  if (!send()) {
    unanswered();
    return;
  }
  const wait = () => {
    delivery.timer = setTimeout(() => {
      delivery.timer = null;
      if (firstTapSaveDelivery !== delivery) return;
      if (firstTapBusy?.look !== look) {
        endFirstTapSaveDelivery(delivery);
        return;
      }
      if (delivery.sends < 2) {
        dropFirstTapPort();
        if (send()) {
          wait();
          return;
        }
      }
      unanswered();
    }, FIRST_TAP_SAVE_ANSWER_MS);
  };
  wait();
}

/**
 * After the reload, "Saving this story…" waits for the page to report in.
 * A page that never does (Safari did not run Trace on it, or the background
 * missed it) does not hold the sheet: after the popup's usual patience it
 * says the story is still being confirmed, and Check again looks.
 */
function boundEarnedRunWait(story) {
  setTimeout(() => {
    if (earnedAwaitingStory !== story || storyConfirmation || accountWait) return;
    if (document.body.dataset.tracePopupStateCode !== "P1") return;
    // A save found now may have been made by the reload, so it is never "already".
    watchForConfirmedStory(story, earnedStoryRender(story), { firstCheck: false });
    renderEarnedDelayed(story);
  }, STORY_CONFIRMATION_PATIENCE_MS);
}

async function prepareEarnedPermissionFlow() {
  resetEarnedLedger();
  const [{ onboarding, readiness }, grantedOrigins] = await Promise.all([
    readEarnedState(),
    readGrantedOrigins(),
  ]);
  const hasGrant = await readCompleteEarnedGrant(grantedOrigins);
  const tab = await probeQueryActiveTab().catch(() => null);
  const story = classifyEarnedPage(tab?.url);
  sendSetupSheetOpened(story);
  earnedCurrentPage = story.ok ? story : null;
  if (earnedCurrentPage?.kind === "story") {
    earnedCurrentPage = { ...earnedCurrentPage, knownInLibrary: await readKnownInLibrary(tab?.url) };
  }
  // Opened on a story before the story sites are allowed: the background
  // saves this one story now, and the ask follows the save. Opened on one
  // with the sites allowed but no page yet seen running under them (allowed
  // in Safari's settings, or from a sheet that closed before it heard): the
  // background says what holds. Neither reloads the page.
  if (
    FIRST_TAP_SHEET && !firstTapSetAside && story.ok && story.kind === "story" &&
    (!hasGrant || (!onboarding.completedAt && !earnedRunVerified(onboarding, readiness)))
  ) {
    earnedPreparedContext = Object.freeze({ story, hasGrant });
    endAccountWait();
    if (hasGrant) await reconcileEarnedRegistration().catch(() => null);
    if (Number.isInteger(tab?.id) && typeof tab?.url === "string" && startFirstTap(story, tab)) return;
  }
  if (onboarding.completedAt && story.ok && !hasGrant) {
    earnedPreparedContext = Object.freeze({ story, hasGrant: false });
    stopStoryConfirmation();
    endAccountWait();
    renderEarnedPermissionInvitation(story);
    return;
  }

  // Completion stays sticky. Supported story sites still verify their earned
  // grant above because a One Day Safari grant can expire after onboarding.
  if (onboarding.completedAt && !earnedAwaitingStory) {
    activateKernelPopupAfterEarnedPermission();
    return;
  }
  // A successful archive heartbeat is stronger proof than a permission API
  // snapshot: it means the installed content script actually executed. It is
  // still not a save, so a popup that just granted access keeps waiting for
  // the confirmed story instead of switching to the general view.
  if (onboarding.completedAt || earnedRunVerified(onboarding, readiness)) {
    if (!onboarding.completedAt) {
      await writeEarnedState({ completedAt: Date.now() });
      if (story.ok && story.kind === "story") earnedSetupFinishedOnStory = true;
    }
    if (earnedAwaitingStory) {
      // The page reports in several times per load. While this popup is
      // waiting on the account, that wait owns the screen and resumes the
      // story itself; starting the watch again would only ask it twice.
      if (accountWait) return;
      if (!storyConfirmation) {
        watchForConfirmedStory(earnedAwaitingStory, earnedStoryRender(earnedAwaitingStory));
      } else {
        void checkConfirmedStory();
      }
      return;
    }
    activateKernelPopupAfterEarnedPermission();
    return;
  }

  if (!tab || !Number.isInteger(tab.id) || !story.ok) {
    earnedPreparedContext = null;
    renderEarnedUnsupportedStory();
    return;
  }
  earnedPreparedContext = Object.freeze({ story, hasGrant });
  if (hasGrant) {
    if (earnedAwaitingStory) {
      // This popup already asked for the reload; keep waiting for the run.
      renderEarnedAccessPending(story);
      return;
    }
    const registration = await reconcileEarnedRegistration().catch(() => null);
    if (registration?.ok !== true || registration?.registered !== true) {
      renderEarnedRegistrationFailure();
      return;
    }
    void recordEarnedEvent("website_access_registration_ready");
    if (story.kind === "archive") {
      await writeEarnedState({ completedAt: Date.now() });
      renderEarnedSiteReady({ allowed: true });
      return;
    }
    // Access is complete (for example, Safari's Every Website choice). There
    // is no permission decision left, so continue without an extra tap.
    earnedAwaitingStory = story;
    renderEarnedAccessPending(story);
    boundEarnedRunWait(story);
    await reloadEarnedStory();
    return;
  }
  renderEarnedPermissionInvitation(story);
}

function sendSetupStep(detail) {
  if (!FIRST_TAP_SHEET) return;
  sendKernelRuntimeMessage({ type: SETUP_STEP_MESSAGE, ...detail }, () => {});
}

/** Once for each popup, on the kind of page it was opened on. */
function sendSetupSheetOpened(page) {
  if (setupSheetOpenedSent) return;
  setupSheetOpenedSent = true;
  sendSetupStep({ step: "sheet_opened", page: page?.ok && page.kind === "story" ? "story" : "other" });
}

/**
 * The answer to Safari's question, read as the background reads it: every
 * story site allowed is allowed, whatever the request returned; some of them
 * is partial; only a request that came back false, with none allowed, is no.
 */
function earnedSetupAnswer(returned, complete, coverage) {
  if (complete) return "granted";
  if (coverage.granted > 0) return "partial";
  if (returned === false) return "declined";
  return "unanswered";
}

async function allowAccessAndAddEarnedStory() {
  const prepared = earnedPreparedContext;
  if (!prepared?.story?.ok) {
    await prepareEarnedPermissionFlow();
    return;
  }
  // Safari requires permissions.request to be invoked directly from the user
  // gesture. Start it before any awaited tab, storage, or permission reads.
  const permissionRequest = prepared.hasGrant
    ? null
    : extensionPromiseCall(ext.permissions, "request", [
        { origins: earnedOrigins() },
      ]);
  if (permissionRequest) renderEarnedAskWaiting();
  const story = prepared.story;
  void recordEarnedEvent("website_access_action_started");
  let answered = false;
  try {
    if (permissionRequest) {
      void recordEarnedEvent("website_access_requested");
    }
    const granted = permissionRequest ? await permissionRequest : true;
    const grantedOrigins = await readGrantedOrigins();
    const complete = await readCompleteEarnedGrant(grantedOrigins);
    if (permissionRequest) {
      answered = true;
      sendSetupStep({
        step: "access_answered",
        answer: earnedSetupAnswer(granted, complete, earnedGrantCoverage(grantedOrigins)),
      });
    }
    if (granted !== true || !complete) {
      await writeEarnedState({ promptResult: "declined" });
      const coverage = earnedGrantCoverage(grantedOrigins);
      if (coverage.granted > 0 && granted === true) {
        void recordEarnedEvent("website_access_partial");
        renderEarnedPartialAccess();
      } else {
        void recordEarnedEvent("website_access_not_allowed");
        renderEarnedPermissionDeclined(story);
      }
      return;
    }
    earnedPreparedContext = Object.freeze({ story, hasGrant: true });
    // Only a story page has a story to wait for. A list or the site's home
    // page keeps its open-any-story prompt.
    earnedAwaitingStory = story.kind === "story" ? story : null;
    const registration = await reconcileEarnedRegistration();
    if (registration?.ok !== true || registration?.registered !== true) {
      throw new Error("registration_failed");
    }
    void recordEarnedEvent("website_access_registered");
    if (story.kind === "archive") {
      await writeEarnedState({ completedAt: Date.now() });
      renderEarnedSiteReady({ allowed: true });
      return;
    }
    renderEarnedAccessPending(story);
    boundEarnedRunWait(story);
    await reloadEarnedStory();
  } catch {
    void recordEarnedEvent("website_access_setup_failed");
    const grantedOrigins = await readGrantedOrigins();
    // The request itself failed, so Safari asked nothing: no answer.
    if (permissionRequest && !answered) sendSetupStep({ step: "access_answered", answer: "unanswered" });
    if (await readCompleteEarnedGrant(grantedOrigins)) {
      renderEarnedRegistrationFailure();
    } else {
      renderEarnedPermissionDeclined(story);
    }
  }
}

async function initializeEarnedPermissionFlow() {
  document.body.dataset.traceEarnedPermission = "true";
  const section = document.getElementById("popup-earned-permission");
  if (section) section.hidden = true;
  bindEarnedActionButtons();
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[ACCOUNT_PROJECTION_REVISION_KEY] && storyConfirmation) {
      void checkConfirmedStory();
    }
    // The background publishes this when an account connects. A popup that is
    // waiting on the account, or has settled on "no account" or "couldn't
    // connect", asks again now and moves on by itself.
    if (changes[ACCOUNT_PROJECTION_REVISION_KEY]) {
      // A first-tap sheet that is waiting on the account asks again by itself.
      if (firstTapPort && ["connecting", "account-missing", "account-unreachable", "account-reconnect"].includes(document.body.dataset.traceFirstTapState)) {
        firstTapSend("open");
      }
      if (accountWait) accountMayHaveConnected();
      else if (kernelSnapshotTimer !== null && kernelSnapshotProviderAttempt > 0) requestKernelSnapshot();
    }
    if (!changes[ARCHIVE_READINESS_KEY]) return;
    // A first-tap sheet draws what the background sends it. A page reporting
    // in, as one does once it saves by itself, does not start setup over
    // under what the sheet is showing.
    if (firstTapPort && !firstTapSetAside) return;
    void prepareEarnedPermissionFlow();
  });
  void recordEarnedEvent("popup_opened");
  // Tell the Trace app what story-site access Safari grants right now. Once
  // a one-day grant runs out no page script runs to say so; an open popup can.
  sendKernelRuntimeMessage({ type: "TRACE_ARCHIVE_ACCESS_REPORT" }, () => {});
  await prepareEarnedPermissionFlow();
}

async function runActiveTabProbe() {
  const retry = document.getElementById("popup-probe-retry");
  if (retry) retry.disabled = true;
  resetProbeUi();
  try {
    const tab = await probeQueryActiveTab();
    const story = classifyProbeStory(tab?.url);
    if (!tab || !Number.isInteger(tab.id) || !story.ok) {
      setProbeCheck("popup-probe-story", "fail", "Not found");
      throw new Error("unsupported_page");
    }
    setProbeCheck("popup-probe-story", "pass", story.site);

    let ping = null;
    try {
      ping = await probeSendTabMessage(tab.id, { type: "TRACE_ACTIVE_TAB_PROBE_PING" });
    } catch {
      // Expected when this click is the first time Trace has touched the tab.
    }
    if (ping?.ok !== true || ping?.probe !== true) {
      try {
        await probeInject(tab.id);
        ping = await probeSendTabMessage(tab.id, { type: "TRACE_ACTIVE_TAB_PROBE_PING" });
      } catch {
        throw new Error("injection_failed");
      }
    }
    if (ping?.ok !== true || ping?.probe !== true) throw new Error("current_tab_denied");
    setProbeCheck("popup-probe-access", "pass", "Granted by click");

    const response = await probeSendTabMessage(tab.id, { type: "TRACE_ACTIVE_TAB_PROBE_SAVE" });
    if (
      response?.ok !== true ||
      response?.state !== "saved" ||
      response?.serverConfirmed !== true
    ) {
      throw new Error(response?.error || "save_failed");
    }
    setProbeCheck("popup-probe-save", "pass", "Confirmed");
    setProbeResult("success", "Saved to your Trace library.", "The server confirmed this story. No website-permission API was called.");
  } catch (error) {
    const reason = typeof error?.message === "string" ? error.message : "save_failed";
    if (reason !== "unsupported_page") {
      const accessPassed = document.getElementById("popup-probe-access")?.dataset.state === "pass";
      setProbeCheck(accessPassed ? "popup-probe-save" : "popup-probe-access", "fail", "Failed");
    }
    const [heading, detail] = probeFailureCopy(reason);
    setProbeResult("failure", heading, detail);
  } finally {
    if (retry) retry.disabled = false;
  }
}

function initializeActiveTabProbe() {
  document.body.dataset.traceActiveTabProbe = "true";
  const section = document.getElementById("popup-active-tab-probe");
  if (section) section.hidden = false;
  document.getElementById("popup-probe-retry")?.addEventListener("click", () => {
    void runActiveTabProbe();
  });
  void runActiveTabProbe();
}

function setArchiveLinks() {
  const ao3 = document.getElementById("popup-open-ao3");
  const ffn = document.getElementById("popup-open-ffn");
  if (ao3) ao3.href = AO3_WORKS_URL;
  if (ffn) ffn.href = FFN_HOME_URL;
}

setArchiveLinks();
window.addEventListener("resize", refreshEarnedLayout);
window.visualViewport?.addEventListener("resize", refreshEarnedLayout);
if (typeof ResizeObserver !== "undefined") {
  const earnedLayoutObserver = new ResizeObserver(refreshEarnedLayout);
  for (const id of ["popup-earned-pin", "popup-earned-scroll"]) {
    const element = document.getElementById(id);
    if (element) earnedLayoutObserver.observe(element);
  }
}

const OPEN_TABS_HELP = "Trace reads your open AO3 and FanFiction.net tabs. Nothing is added until you choose in Trace. Your tabs stay open.";

/** "Found 28 stories in 30 tabs." */
function openTabsFoundLine(found) {
  if (!Number.isSafeInteger(found?.stories) || !Number.isSafeInteger(found?.tabs)) return null;
  const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;
  return `Found ${count(found.stories, "story", "stories")} in ${count(found.tabs, "tab", "tabs")}.`;
}

function renderOpenTabsImport(snapshot) {
  const button = document.getElementById("popup-import-open-tabs");
  const help = document.getElementById("popup-open-tabs-help");
  if (!button || !help) return;
  const available = (!ACTIVE_TAB_PROBE || Boolean(EARNED_PERMISSION_ONBOARDING)) && popupModel.nativeImport === true && snapshot?.state === "connected";
  button.hidden = !available;
  help.hidden = !available;
  button.disabled = openTabsBusy;
  if (!available) {
    help.textContent = OPEN_TABS_HELP;
  }
}

function runOpenTabsImport() {
  if (openTabsBusy || popupModel.nativeImport !== true || popupModel.authState?.state !== "connected") return;
  const button = document.getElementById("popup-import-open-tabs");
  const help = document.getElementById("popup-open-tabs-help");
  const generation = nativeImportGeneration;
  openTabsBusy = true;
  nativeImportContinuation = null;
  renderNativeImportContinuation(popupModel.authState);
  button.textContent = "Reading your tabs…";
  help.textContent = "Keep this open while Trace reads your tabs.";
  renderOpenTabsImport(popupModel.authState);
  sendKernelRuntimeMessage({ type: "TRACE_IMPORT_OPEN_TABS" }, (response) => {
    openTabsBusy = false;
    button.textContent = "Import open tabs";
    renderOpenTabsImport(popupModel.authState);
    if (generation !== nativeImportGeneration) return;
    if (response?.ok && showNativeImportContinuation(response, generation)) {
      help.textContent = openTabsFoundLine(response.found) ?? OPEN_TABS_HELP;
      document.getElementById("popup-import-open-native").textContent = "Review in Trace";
    } else {
      const pageImport = document.getElementById("popup-import");
      if (pageImport) restoreImportButton(pageImport);
      help.textContent = response?.error === "no_readable_tabs"
        ? "No story pages could be read. Allow Trace on your story sites, open any sleeping story tabs, then try again."
        : "Trace couldn’t prepare these stories. Return to Trace to check your connection, then try again.";
    }
  });
}

document.getElementById("popup-import-open-tabs")?.addEventListener("click", runOpenTabsImport);

function renderNativeImportContinuation(snapshot) {
  renderOpenTabsImport(snapshot);
  const link = document.getElementById("popup-import-open-native");
  const button = document.getElementById("popup-import");
  if (!link) return;
  if (!nativeImportContinuation || snapshot?.state !== "connected" ||
      Date.now() >= nativeImportContinuation.expiresAtMs) {
    nativeImportContinuation = null;
    link.hidden = true;
    link.removeAttribute("href");
    return;
  }
  link.href = `traceauth://open?destination=library-import&handoff=${nativeImportContinuation.handoffID}`;
  link.hidden = false;
  if (button) button.hidden = true;
}

function showNativeImportContinuation(response, generation) {
  if (response?.state !== "ready_to_open" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(response.handoffID || "") ||
      !Number.isSafeInteger(response.expiresAtMs) || response.expiresAtMs <= Date.now() ||
      response.expiresAtMs > Date.now() + 630000 ||
      response.snapshot?.state !== "connected" || popupModel.authState?.state !== "connected" ||
      generation !== nativeImportGeneration) return false;
  nativeImportContinuation = { handoffID: response.handoffID,
    expiresAtMs: response.expiresAtMs };
  renderNativeImportContinuation(popupModel.authState);
  setTimeout(() => {
    renderNativeImportContinuation(popupModel.authState);
    if (!nativeImportContinuation) restoreImportButton(document.getElementById("popup-import"));
  }, Math.max(0, response.expiresAtMs - Date.now()));
  return true;
}

document.getElementById("popup-import-open-native")?.addEventListener("click", (event) => {
  renderNativeImportContinuation(popupModel.authState);
  event.preventDefault();
  if (!nativeImportContinuation) return;
  // Each tap opens the Trace app the way this popup's other app links do.
  // Following the link inside the popup itself is not something Safari on
  // iPhone is known to hand to the app.
  openTraceApp(event.currentTarget.href);
});

function setImportBusy(button) {
  setImportRecoveryHelp();
  button.disabled = true;
  button.textContent = "Opening import…";
  button.title = currentImportTitle();
}

function setImportSuccess(button, response) {
  setImportRecoveryHelp();
  button.textContent =
    response?.state === "saved" || response?.state === "already_saved"
      ? "Saved to your Library"
      : "Opened import tab";
  button.title = "";
}

function importFailureCopy(error) {
  if (error === "native_import_unavailable") {
    return { label: "Import unavailable. Try again.",
      title: "Return to Trace to check your connection, then start a new Import." };
  }
  if (error === "permission_required") {
    return {
      label: "Allow site access, then try again",
      title:
        "Allow Trace on this AO3 or FanFiction.net site in your browser’s extension settings, refresh the page, then retry.",
    };
  }
  if (error === "not_authenticated" || error === "auth_expired") {
    return {
      label: "Reconnect Trace, then try again",
      title: "Reconnect this extension session before importing.",
    };
  }
  if (error === "unsupported_page" || error === "no_active_tab") {
    return {
      label: "Open a supported page",
      title: "Open a supported AO3 or FanFiction.net story or listing page, then retry.",
    };
  }
  return {
    label: "Import failed. Try again.",
    title:
      error ||
      "Open an AO3 or FanFiction.net tab and refresh it after updating the extension.",
  };
}

function setImportRecoveryHelp(error) {
  const help = document.getElementById("popup-import-recovery-help");
  const button = document.getElementById("popup-import");
  if (!help || !button) return;
  const visible = error === "collect_failed" &&
    (isLikelyIosExtensionUi || window.location.protocol === "safari-web-extension:");
  help.hidden = !visible;
  const onStory = (popupModel.activeTab || {}).kind !== "supported_archive";
  help.textContent = !visible
    ? ""
    : onStory
      ? "Reload this story. If importing still fails, restart Safari and reopen the story."
      : "Reload this page. If importing still fails, restart Safari and reopen the page.";
  if (visible) button.setAttribute("aria-describedby", help.id);
  else button.removeAttribute("aria-describedby");
}

function setImportFailure(button, error) {
  const copy = importFailureCopy(error);
  button.textContent = copy.label;
  button.disabled = false;
  resetImportButtonAfterFailure(button, copy.title);
  if (!isImportCurrentlyAvailable()) {
    restoreImportButton(button);
  } else {
    button.textContent = copy.label;
    button.title = copy.title;
    setImportRecoveryHelp(error);
  }
}

function setImportUnavailable(button) {
  setImportRecoveryHelp();
  button.disabled = true;
  button.textContent = currentImportLabel();
  button.title = currentImportTitle();
}

function setImportInitial(button) {
  restoreImportButton(button);
}

function runImport(button) {
  if (openTabsBusy) return;
  if (!isImportCurrentlyAvailable()) {
    setImportUnavailable(button);
    return;
  }

  const generation = nativeImportGeneration;
  setImportBusy(button);

  sendKernelRuntimeMessage({ type: "TRACE_IMPORT_TRIGGER" }, (res) => {
    if (res?.ok && res.state === "ready_to_open") {
      if (!showNativeImportContinuation(res, generation)) setImportFailure(button, "native_import_unavailable");
    } else if (res?.ok) {
      setImportSuccess(button, res);
      setTimeout(() => window.close(), 600);
    } else {
      setImportFailure(
        button,
        res?.error ||
          "Open an AO3 or FanFiction.net tab and refresh it after updating the extension.",
      );
    }
  });
}

function kernelActionsForState(state) {
  if (state === "signed_out") return { primary: "connect", secondary: null };
  if (state === "connecting" || state === "verifying") {
    return { primary: "cancel", secondary: null };
  }
  if (state === "connected") return { primary: null, secondary: "disconnect" };
  if (state === "degraded") return { primary: "retry", secondary: "disconnect" };
  if (state === "reconnect_required") {
    return { primary: "reconnect", secondary: "disconnect" };
  }
  return { primary: null, secondary: null };
}

let kernelSessionState = "initializing";

function renderKernelSnapshot(snapshot) {
  kernelSessionState = snapshot?.state || "initializing";
  setImportRecoveryHelp();
  nativeImportGeneration += 1;
  nativeImportContinuation = null;
  const state = snapshot?.state || "initializing";
  const reason = snapshot?.reason || "none";
  if (EARNED_PERMISSION_ONBOARDING && isLikelyIosExtensionUi && earnedCurrentPage?.ok &&
      ["initializing", "connecting", "verifying"].includes(state)) {
    document.body.dataset.traceEarnedPermission = "true";
    document.body.dataset.tracePopupState = state;
    const section = document.getElementById("popup-earned-permission");
    if (section) section.hidden = false;
    if (earnedCurrentPage.kind === "story" && earnedCurrentPage.knownInLibrary) renderEarnedCheckingLibrary();
    else if (earnedCurrentPage.kind === "story") renderEarnedAccessPending(earnedCurrentPage);
    else renderEarnedSiteReady();
    return;
  }
  if (EARNED_PERMISSION_ONBOARDING && state === "connected") delete document.body.dataset.traceEarnedPermission;
  const statusEl = document.getElementById("popup-status");
  const leadEl = document.getElementById("popup-lead");
  const ctaEl = document.getElementById("popup-cta");
  const secondaryActionEl = document.getElementById("popup-session-secondary");
  const sessionHelpEl = document.getElementById("popup-session-help");
  const localSettingsEl = document.getElementById("popup-local-settings");
  const proSettingsEl = document.getElementById("popup-pro-settings");
  const preferencesEl = document.getElementById("popup-preferences");
  const importEl = document.getElementById("popup-import");
  const archiveLinksEl = document.getElementById("popup-archive-links");
  const actions = SESSION_DISABLED
    ? { primary: null, secondary: null }
    : kernelActionsForState(state);
  const credentialRecovery =
    state === "signed_out" ||
    (state === "reconnect_required" &&
      ["credential_absent", "credential_rejected", "identity_conflict"].includes(reason));
  // A reader who has never connected is connecting, not reconnecting, even
  // when a first attempt left the session needing another go.
  const connectVerb = snapshot?.neverConnected === true ? "Connect" : "Reconnect";
  const labels = {
    connect: "Connect",
    cancel: "Cancel",
    disconnect: "Disconnect",
    retry: "Try again",
    reconnect: connectVerb,
  };
  const otherAccount = state === "reconnect_required" && reason === "identity_conflict";
  const headings = {
    initializing: "Checking Trace…",
    signed_out: "Connect Trace",
    connecting: "Checking Trace…",
    verifying: "Checking Trace…",
    connected: "Trace is on",
    degraded: "Trace is temporarily offline",
    reconnect_required: otherAccount ? "This browser was signed in to another account" : `${connectVerb} Trace`,
  };
  const glyphs = {
    signed_out: ["person", ""],
    degraded: ["wifiOff", ""],
    reconnect_required: ["person", ""],
  };
  let lead = "";
  if (SESSION_DISABLED) {
    lead = "Authenticated extension features are temporarily unavailable.";
  } else if (state === "signed_out" && isLikelyIosExtensionUi) {
    lead =
      "Open the Trace app and sign in there. Signing in on tracefiction.com in Safari does not connect this extension. Return to Safari and press Connect.";
  } else if (otherAccount) {
    lead = `Trace signed it out so nothing mixes. Sign in to Trace in this browser with the account you use, then press ${connectVerb}. Nothing was saved.`;
  } else if (state === "reconnect_required" && isLikelyIosExtensionUi && credentialRecovery) {
    lead =
      `Open the Trace app and sign in there. Signing in on tracefiction.com in Safari does not connect this extension. Return to Safari and press ${connectVerb}.`;
  } else if (state === "signed_out") {
    lead =
      "Open Trace in this browser and sign in, then return here and press Connect.";
  } else if (state === "reconnect_required") {
    if (reason === "storage_write_failed" || reason === "storage_unavailable") {
      lead = `Trace could not update extension storage. Press ${connectVerb} after local storage recovers.`;
    } else if (reason === "account_unavailable" || reason === "invalid_account_response") {
      lead = `Trace could not safely verify this account. Press ${connectVerb} to try again.`;
    } else if (reason === "malformed_envelope" || reason === "unsupported_envelope") {
      lead = `Trace found unsupported local session data. Pressing ${connectVerb} will safely replace it.`;
    } else {
      lead = `Sign in to Trace in this browser if needed, then press ${connectVerb}.`;
    }
  } else if (state === "degraded") {
    if (reason === "storage_unavailable") {
      lead = "Trace could not read extension storage. Retry after local storage recovers.";
    } else if (reason === "runtime_unavailable") {
      lead = "Trace could not reach its extension session. Retry in a moment.";
    } else {
      lead = "Your Library is safe. Check your connection and try again.";
    }
  } else if (state === "connected") {
    lead = "Trace keeps your place on AO3 and FanFiction.net in this browser.";
  } else if (state === "connecting" || state === "verifying") {
    lead = "Keep this popup open while Trace checks your account.";
  } else {
    lead = reason === "storage_unavailable"
      ? "Trace could not read extension storage. Retry in a moment."
      : "Checking the extension session.";
  }

  document.body.dataset.tracePopupState = state;
  if (
    EARNED_PERMISSION_ONBOARDING &&
    isLikelyIosExtensionUi &&
    !SESSION_DISABLED &&
    (state === "signed_out" || (state === "reconnect_required" && credentialRecovery))
  ) {
    renderAwaitingAppLink(snapshot);
    return;
  }
  if (document.body.dataset.traceReaderView === "link") {
    delete document.body.dataset.traceReaderView;
    const section = document.getElementById("popup-earned-permission");
    if (section) section.hidden = true;
  }
  if (statusEl) statusEl.textContent = SESSION_DISABLED ? "Trace unavailable" : headings[state] || "Trace";
  const [glyphName, glyphTone] = SESSION_DISABLED ? ["", ""] : glyphs[state] || ["", ""];
  setStatusGlyph(glyphName, glyphTone);
  if (leadEl) {
    leadEl.hidden = false;
    leadEl.textContent = lead;
  }
  if (ctaEl) {
    ctaEl.hidden = actions.primary == null;
    delete ctaEl.dataset.externalUrl;
    delete ctaEl.dataset.unlimited;
    ctaEl.textContent = actions.primary ? labels[actions.primary] : "";
    ctaEl.dataset.sessionAction = actions.primary || "";
    // A retry or a cancel is never the task; only connecting is.
    ctaEl.dataset.emphasis = actions.primary === "cancel" || actions.primary === "retry" ? "tertiary" : "primary";
  }
  if (secondaryActionEl) {
    secondaryActionEl.hidden = actions.secondary == null;
    secondaryActionEl.textContent = actions.secondary ? labels[actions.secondary] : "";
    secondaryActionEl.dataset.sessionAction = actions.secondary || "";
    secondaryActionEl.dataset.emphasis = "secondary";
  }
  if (sessionHelpEl) {
    sessionHelpEl.hidden =
      SESSION_DISABLED || !credentialRecovery;
    sessionHelpEl.dataset.externalUrl = isLikelyIosExtensionUi
      ? TRACE_IOS_APP_CONNECT_URL
      : TRACE_HOME_URL;
    sessionHelpEl.textContent = isLikelyIosExtensionUi
      ? "Open Trace app"
      : "Open Trace to sign in";
  }
  if (localSettingsEl) localSettingsEl.hidden = true;
  if (proSettingsEl) proSettingsEl.hidden = true;
  if (preferencesEl) preferencesEl.hidden = true;
  if (importEl) importEl.hidden = true;
  if (archiveLinksEl) archiveLinksEl.hidden = true;
  renderNativeImportContinuation(snapshot);
}

/** Shows the one-step account view in place of the general popup. */
function showAppLinkView() {
  const section = document.getElementById("popup-earned-permission");
  if (!section) return false;
  document.body.dataset.traceReaderView = "link";
  section.hidden = false;
  for (const id of ["popup-import", "popup-cta", "popup-session-help", "popup-session-secondary", "popup-preferences"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  return true;
}

/**
 * iOS: the extension is on but not linked to the account in the Trace app.
 * One step, one action. "Create an account or sign in" is only for a reader
 * the app has no account for; any other answer says Trace couldn't connect.
 */
function renderAwaitingAppLink(snapshot) {
  if (!showAppLinkView()) return;
  const answer = appAccountAnswer(snapshot);
  // Only a story page can be told to come back to "this story".
  const story = { kind: earnedCurrentPage?.kind === "story" ? "story" : "archive" };
  if (answer === "other_account") renderEarnedOtherAccount();
  else if (answer === "none") renderEarnedConnectAccount(story);
  else renderEarnedAccountUnreachable(story);
}

function sendKernelRuntimeMessage(message, onResponse) {
  if (USES_BROWSER_PROMISE_API) {
    try {
      Promise.resolve(ext.runtime.sendMessage(message)).then(
        (response) => onResponse(response),
        () => onResponse(null),
      );
    } catch {
      onResponse(null);
    }
    return;
  }
  try {
    ext.runtime.sendMessage(message, (response) => {
      const failed = Boolean(ext.runtime.lastError);
      onResponse(failed ? null : response);
    });
  } catch {
    onResponse(null);
  }
}

const KERNEL_SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([180, 650]);
const KERNEL_SNAPSHOT_TRANSIENT_RETRY_LIMIT = 31;
// Safari can stop the background while the popup opens and then never
// deliver its reply. A reply not in by then is taken as none, so the popup
// asks again (which wakes the background) instead of waiting for ever.
const KERNEL_SNAPSHOT_REPLY_MS = 4_000;
let kernelSnapshotAttempt = 0;
let kernelSnapshotTransientAttempt = 0;
let kernelSnapshotProviderAttempt = 0;
let kernelSnapshotTimer = null;
let kernelSnapshotRequest = 0;
// Every read of the session and every action on it goes out under one
// running number, whichever part of the popup sends it. `sessionTaken` is
// the number of the newest whose reply has said where the session stands
// and been taken; `sessionTakenAt` is the running number when that happened.
let sessionSequence = 0;
let sessionTaken = 0;
let sessionTakenAt = 0;

function nextSessionSequence() {
  sessionSequence += 1;
  return sessionSequence;
}

/** A reply sent under `sequence` is taken. Only one that settles where the session stands counts. */
function sessionReplyTaken(sequence, response) {
  if (!kernelSnapshotSettles(response)) return;
  sessionTaken = Math.max(sessionTaken, sequence);
  sessionTakenAt = sessionSequence;
}

/**
 * On iPhone and iPad the story's handover state is drawn while the session is
 * read. Where that read gives no settled answer within its bounds, the popup
 * says it could not connect and offers Try again; it never stays on the
 * handover state.
 */
function settleKernelHandover() {
  if (!(EARNED_PERMISSION_ONBOARDING && isLikelyIosExtensionUi && earnedCurrentPage?.ok)) return false;
  kernelSnapshotTransientAttempt = 0;
  kernelSnapshotAttempt = 0;
  const story = { kind: earnedCurrentPage.kind === "story" ? "story" : "archive" };
  waitForAppAccount(story,
    { connected: kernelAccountConnected, other: kernelAccountOther, generalView: true, settled: "unreachable" });
  return true;
}

function requestKernelSnapshotAfter(delayMs) {
  if (kernelSnapshotTimer !== null) clearTimeout(kernelSnapshotTimer);
  kernelSnapshotTimer = setTimeout(() => {
    kernelSnapshotTimer = null;
    requestKernelSnapshot();
  }, delayMs);
}

/** The account wait ended in the general view: carry on from its reply. */
function kernelAccountConnected(response) {
  kernelSnapshotProviderAttempt = 0;
  renderKernelSnapshot(response?.snapshot);
  requestKernelPopupState();
}

function kernelAccountOther(response) {
  kernelSnapshotProviderAttempt = 0;
  renderKernelSnapshot(response?.snapshot);
}

function requestKernelSnapshot() {
  if (kernelSnapshotTimer !== null) clearTimeout(kernelSnapshotTimer);
  kernelSnapshotTimer = null;
  kernelSnapshotRequest += 1;
  const request = kernelSnapshotRequest;
  const sequence = nextSessionSequence();
  let answered = false;
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    // No reply in time is taken as none, for the request now out only, and
    // only where no reply that settles has been taken since it went.
    if (!answered && request === kernelSnapshotRequest && sessionTakenAt < sequence) takeKernelSnapshot(null);
  }, KERNEL_SNAPSHOT_REPLY_MS);
  sendKernelRuntimeMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" }, (response) => {
    // One answer per request, and none in time for a request a newer one replaced.
    if (answered || (!late && request !== kernelSnapshotRequest)) return;
    // Never over a reply to a newer read of the session, or an action on
    // it, already taken: whichever part of the popup sent it.
    if (sequence <= sessionTaken) return;
    if (!late) {
      answered = true;
      clearTimeout(deadline);
      sessionReplyTaken(sequence, response);
      takeKernelSnapshot(response);
      return;
    }
    // Past its deadline: the background was slow, not gone. Its reply is
    // still taken where it settles what is shown, as a late read of the
    // account is.
    if (!kernelSnapshotSettles(response)) return;
    answered = true;
    sessionReplyTaken(sequence, response);
    // It decides what follows: an ask waiting to go because it seemed lost
    // is let go. One already out is still taken if its reply is newer.
    if (kernelSnapshotTimer !== null) clearTimeout(kernelSnapshotTimer);
    kernelSnapshotTimer = null;
    kernelSnapshotAttempt = 0;
    if (accountWait) takeAccountAnswer(accountWait, response);
    else takeKernelSnapshot(response);
  });
}

/** A reply that says where the session stands, not that it is still being worked out. */
function kernelSnapshotSettles(response) {
  return Boolean(response) && !["unknown", "pending"].includes(appAccountAnswer(response.snapshot));
}

function takeKernelSnapshot(response) {
  if (!response) {
    const retryDelay = KERNEL_SNAPSHOT_RETRY_DELAYS_MS[kernelSnapshotAttempt];
    kernelSnapshotAttempt += 1;
    if (retryDelay !== undefined) {
      requestKernelSnapshotAfter(retryDelay);
      return;
    }
    if (settleKernelHandover()) return;
    renderKernelSnapshot({ state: "degraded", reason: "runtime_unavailable" });
    return;
  }
  kernelSnapshotAttempt = 0;
  const state = response?.snapshot?.state;
  // On iPhone and iPad this reply follows a read of the Trace app's
  // account. A read that failed (Safari can still be starting the
  // extension) leaves it unknown whether the reader has an account, so
  // say only that Trace is connecting and ask again a few times, further
  // apart each time. Signed out is shown only once the app says so.
  const accountRead = isLikelyIosExtensionUi || response?.action !== undefined;
  const answer = accountRead && !SESSION_DISABLED ? appAccountAnswer(response?.snapshot) : "other";
  if (EARNED_PERMISSION_ONBOARDING && isLikelyIosExtensionUi &&
      ["unknown", "none", "refused", "other_account"].includes(answer)) {
    // The same wait the setup flow uses, started from this reply.
    const story = { kind: earnedCurrentPage?.kind === "story" ? "story" : "archive" };
    waitForAppAccount(story,
      { connected: kernelAccountConnected, other: kernelAccountOther, generalView: true }, response);
    return;
  }
  if (answer === "unknown") {
    // A build without the one-step account view keeps its own copy.
    const retryDelay = APP_ACCOUNT_RETRY_DELAYS_MS[kernelSnapshotProviderAttempt];
    if (retryDelay !== undefined) {
      kernelSnapshotProviderAttempt += 1;
      renderKernelSnapshot({ state: "initializing", reason: "none" });
      requestKernelSnapshotAfter(retryDelay);
      return;
    }
  }
  kernelSnapshotProviderAttempt = 0;
  renderKernelSnapshot(response?.snapshot);
  if (state === "initializing" || state === "connecting" || state === "verifying") {
    if (kernelSnapshotTransientAttempt < KERNEL_SNAPSHOT_TRANSIENT_RETRY_LIMIT) {
      kernelSnapshotTransientAttempt += 1;
      requestKernelSnapshotAfter(kernelSnapshotTransientAttempt === 1 ? 250 : 1000);
      return;
    }
    // Still handing over after every bounded ask: the handover state is not
    // left standing as if it were still under way.
    settleKernelHandover();
    return;
  }
  kernelSnapshotTransientAttempt = 0;
  if (state === "connected") requestKernelPopupState();
}

function requestKernelPopupState() {
  sendKernelRuntimeMessage({ type: "TRACE_POPUP_GET_STATE" }, (state) => {
    if (
      !state ||
      state.ok !== true ||
      state.authState?.state !== "connected" ||
      kernelSessionState !== "connected"
    ) {
      return;
    }
    // The session owner still controls Connect/Disconnect. Once connected,
    // render the account-scoped first-story/import state from its projection.
    renderStatus({
      authState: state.authState,
      firstSaveSeen: state.firstSaveSeen === true,
      libraryCount:
        typeof state.libraryCount === "number" ? state.libraryCount : undefined,
      libraryLimit: accountLibraryLimit(state.libraryLimit),
      pro: typeof state.pro === "boolean" ? state.pro : undefined,
      activeTab: state.activeTab || undefined,
      capacity: state.capacity ?? null,
      nativeImport: state.nativeImport === true,
    });
    applyLocalUi(state.ao3SavedFiltersEnabled);
    applyProUi(
      state.pro,
      state.autoTrackEnabled,
      state.libraryInlayEnabled,
      state.metadataImproveEnabled,
    );
    const localSettings = document.getElementById("popup-local-settings");
    const proSettings = document.getElementById("popup-pro-settings");
    const preferences = document.getElementById("popup-preferences");
    const importButton = document.getElementById("popup-import");
    if (localSettings) localSettings.hidden = false;
    if (proSettings) proSettings.hidden = false;
    if (preferences) preferences.hidden = false;
    if (importButton) restoreImportButton(importButton);
    updatePreferenceSummary();
    if (EARNED_PERMISSION_ONBOARDING) void renderReaderView(state);
  });
}

function closePopupStatusMenu(returnFocus = false) {
  const menu = document.getElementById("popup-earned-status-menu");
  const control = document.getElementById("popup-earned-status-control");
  if (menu) menu.hidden = true;
  if (control) control.setAttribute("aria-expanded", "false");
  if (returnFocus) control?.focus({ preventScroll: true });
}

function popupStatusErrorCopy(error) {
  if (error === "auth_expired" || error === "not_authenticated") return "Status wasn’t changed. Reconnect Trace, then try again.";
  if (error === "rate_limited") return "Status wasn’t changed. Try again soon.";
  if (error === "free_limit_reached") return "Status wasn’t changed. Your Library is full.";
  if (error === "finish_qualification_disabled") return "Automatic finish updates are temporarily unavailable. Open Trace to update this work.";
  return "Status wasn’t changed. Try again.";
}

function setPopupStatusError(copy) {
  const error = document.getElementById("popup-earned-status-error");
  if (!error) return;
  const text = document.getElementById("popup-earned-status-error-text");
  const glyph = document.getElementById("popup-earned-status-error-glyph");
  if (text) text.textContent = copy || "";
  if (glyph) glyph.replaceChildren(...(copy ? [popupGlyph("alert")] : []));
  error.hidden = !copy;
}

function announcePopupStatusChange(message) {
  const result = document.getElementById("popup-earned-result");
  if (!result) return;
  lastEarnedAnnouncement = `P11-status\u0000${message}`;
  if (earnedAnnouncementTimer !== null) clearTimeout(earnedAnnouncementTimer);
  result.textContent = "";
  earnedAnnouncementTimer = setTimeout(() => {
    earnedAnnouncementTimer = null;
    result.textContent = message;
  }, 0);
}

async function choosePopupReaderStatus(state, nextStatus) {
  if (popupStatusPending) return;
  const entry = state.activeWork?.entry || {};
  const control = document.getElementById("popup-earned-status-control");
  const menu = document.getElementById("popup-earned-status-menu");
  setPopupStatusError("");
  popupStatusPending = true;
  if (control) control.disabled = true;
  menu?.querySelectorAll("button").forEach((item) => { item.disabled = true; });
  try {
    const tab = await probeQueryActiveTab();
    if (!tab || !Number.isInteger(tab.id) || !entry.entryId) throw new Error("invalid_status_request");
    const response = await probeSendTabMessage(tab.id, {
      type: "TRACE_POPUP_SET_READER_STATUS",
      status: nextStatus,
      entry: { entryId: entry.entryId, status: entry.status,
        readerStatus: entry.readerStatus, canonicalReaderStatus: entry.canonicalReaderStatus,
        chapters: entry.chapters },
    });
    if (!response || !response.ok) throw new Error(response?.error || "update_failed");
    const chapters = entry.chapters ? { ...entry.chapters } : null;
    if (nextStatus === "READING" && recordStatusKey(entry) === "SAVED" &&
        chapters && (!Number.isInteger(chapters.current) || chapters.current <= 0)) chapters.current = 1;
    state.activeWork = { ...state.activeWork, entry: { ...entry,
      canonicalReaderStatus: nextStatus, readerStatus: nextStatus, status: nextStatus,
      ...(chapters ? { chapters } : {}) } };
    closePopupStatusMenu();
    await renderReaderView(state);
    announcePopupStatusChange(`Status changed to ${RECORD_STATUS_LABELS[nextStatus]}.`);
  } catch (failure) {
    closePopupStatusMenu(true);
    const copy = popupStatusErrorCopy(failure?.message);
    setPopupStatusError(copy);
    announcePopupStatusChange(copy);
  } finally {
    popupStatusPending = false;
    if (control) control.disabled = false;
    menu?.querySelectorAll("button").forEach((item) => { item.disabled = false; });
  }
}

function openPopupStatusMenu(state, focusSelected = true) {
  const menu = document.getElementById("popup-earned-status-menu");
  const control = document.getElementById("popup-earned-status-control");
  if (!menu || !control) return;
  menu.replaceChildren();
  const selected = recordStatusKey(state.activeWork?.entry);
  for (const status of POPUP_STATUS_CHOICES) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(status === selected));
    const choice = document.createElement("span");
    choice.className = "popup-earned-menu-choice";
    const dot = document.createElement("span");
    dot.className = "popup-earned-record-dot";
    dot.dataset.status = status;
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = RECORD_STATUS_LABELS[status];
    choice.append(dot, label);
    item.appendChild(choice);
    item.tabIndex = status === selected ? 0 : -1;
    if (status === selected) {
      const check = document.createElement("span");
      check.className = "popup-earned-menu-check";
      check.setAttribute("aria-hidden", "true");
      check.appendChild(popupGlyph("menuCheck"));
      item.appendChild(check);
    }
    item.addEventListener("click", (event) => {
      if (status === selected) { closePopupStatusMenu(event.detail === 0); return; }
      void choosePopupReaderStatus(state, status);
    });
    menu.appendChild(item);
  }
  menu.onkeydown = (event) => {
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const index = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items.forEach((item, position) => { item.tabIndex = position === next ? 0 : -1; });
    items[next].focus({ preventScroll: true });
  };
  menu.hidden = false;
  control.setAttribute("aria-expanded", "true");
  if (focusSelected) {
    (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild)?.focus({ preventScroll: true });
  }
}

function showPopupSettings() {
  closePopupStatusMenu();
  document.body.dataset.traceReaderView = "settings";
  const section = document.getElementById("popup-earned-permission");
  const header = document.getElementById("popup-earned-settings-header");
  const preferences = document.getElementById("popup-preferences");
  const disconnect = document.getElementById("popup-session-secondary");
  if (section) section.setAttribute("aria-labelledby", "popup-earned-settings-title");
  if (header) header.hidden = false;
  if (preferences) { preferences.hidden = false; preferences.open = true; }
  if (disconnect) { disconnect.hidden = false; disconnect.dataset.sessionAction = "disconnect"; }
  document.getElementById("popup-earned-settings-back")?.focus({ preventScroll: true });
}

function hidePopupSettings() {
  document.body.dataset.traceReaderView = "true";
  const section = document.getElementById("popup-earned-permission");
  const header = document.getElementById("popup-earned-settings-header");
  if (section) section.setAttribute("aria-labelledby", "popup-earned-heading");
  if (header) header.hidden = true;
  document.getElementById("popup-earned-settings-row")?.focus({ preventScroll: true });
}

document.getElementById("popup-earned-settings-back")?.addEventListener("click", hidePopupSettings);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = document.getElementById("popup-earned-status-menu");
  if (menu && !menu.hidden) { event.preventDefault(); closePopupStatusMenu(true); }
  else if (document.body.dataset.traceReaderView === "settings") { event.preventDefault(); hidePopupSettings(); }
});

/**
 * The ordinary popup for a connected reader: what Trace knows about the story
 * in this tab, using the same grammar as setup. Settings stay in their
 * disclosure below. Only a confirmed entry is described as saved.
 */
function renderPageReconnect() {
  stopStoryConfirmation();
  closePopupStatusMenu();
  setEarnedCopy({ stateCode: "P18", glyph: "alert", glyphTone: "warning",
    heading: "Reload this page to keep going",
    lead: "Trace lost its connection to this tab. Reload the page to keep reading with Trace." });
  setEarnedResult("failure", "Reload this page to keep going.", "");
  configureEarnedActions({ label: "Reload page", action: "reconnect_page", emphasis: "primary" });
  const importButton = document.getElementById("popup-import");
  if (importButton) importButton.hidden = true;
  const control = document.getElementById("popup-earned-status-control");
  if (control) control.hidden = true;
  const progress = document.getElementById("popup-earned-progress");
  if (progress) progress.hidden = true;
}

async function reloadDisconnectedPage() {
  configureEarnedActions({ label: "Reloading…", disabled: true });
  try {
    const tab = await probeQueryActiveTab();
    if (!Number.isInteger(tab?.id) || !classifyEarnedPage(tab.url).ok) throw new Error("no_page");
    await extensionPromiseCall(ext.tabs, "reload", [tab.id]);
    requestKernelPopupState();
    // Safari can keep the popup open while the new document connects.
    for (const ms of [500, 1500, 3000]) setTimeout(requestKernelPopupState, ms);
  } catch {
    renderPageReconnect();
    setEarnedResult("failure", "The page couldn’t reload. Try again.", "");
  }
}

async function renderReaderView(state) {
  const section = document.getElementById("popup-earned-permission");
  if (!section) return;
  document.body.dataset.traceReaderView = "true";
  section.hidden = false;
  // The setup announcement region would otherwise keep stale setup text for
  // VoiceOver; the reader view speaks through its visible copy.
  const setupResult = document.getElementById("popup-earned-result");
  if (setupResult) setupResult.hidden = false;
  const activeTab = state.activeTab || { kind: "unknown" };
  const importButton = document.getElementById("popup-import");
  const site = activeTab.site === "ffn" ? "FanFiction.net" : activeTab.site === "ao3" ? "AO3" : null;
  const story = { ok: true, site: site || "AO3" };

  const identity = ["supported_story", "supported_archive"].includes(activeTab.kind)
    ? await readActiveStoryIdentity() : null;
  if (identity?.pageUnavailable) { renderPageReconnect(); return; }
  const storySaved = activeTab.kind === "supported_story" && state.activeWork?.status === "saved";
  if (state.capacity?.blocked === true && !storySaved) {
    // The capacity state renders in the reader view, in the same anatomy.
    stopStoryConfirmation();
    renderEarnedLibraryFull(activeTab.kind === "supported_story");
    if (importButton) importButton.hidden = true;
    return;
  }
  if (activeTab.kind === "supported_story") {
    if (state.activeWork?.status === "saved" && earnedSetupFinishedOnStory) {
      // Setup finished in this popup and the story was saved before the
      // popup first looked: it was already in the Library, whether the page
      // saved it just now or a save on an earlier tap did. It is confirmed as
      // such, on either site, instead of opening on the everyday view.
      stopStoryConfirmation();
      renderEarnedSaved(story, state.activeWork, identity, true);
      return;
    }
    if (state.activeWork?.status === "saved") {
      const line = recordLine(state.activeWork.entry);
      setEarnedCopy({
        stateCode: "P11",
        heading: identity?.title || "This story",
        // Status appears once, in the control; the record keeps the byline.
        record: { heading: true, byline: storyByline(identity, story), label: "", status: line.key },
        returning: true,
        importable: true,
      });
      const progressEl = document.getElementById("popup-earned-progress");
      if (progressEl) {
        progressEl.textContent = line.place || "";
        progressEl.hidden = !line.place;
      }
      setEarnedResult("success", "", "");
      const control = document.getElementById("popup-earned-status-control");
      const settings = document.getElementById("popup-earned-settings-row");
      const status = RECORD_STATUS_LABELS[recordStatusKey(state.activeWork.entry)];
      if (control) {
        control.hidden = false;
        control.setAttribute("aria-label", `Reading status: ${status}`);
        const dot = document.createElement("span");
        dot.className = "popup-earned-record-dot";
        dot.dataset.status = line.key;
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = status;
        const chevron = popupSvg("0 0 10 7");
        popupSvgShape(chevron, "path", { d: "M1 1.5 5 5.5l4-4" });
        control.replaceChildren(dot, label, chevron);
      }
      if (settings) settings.hidden = false;
      const menu = document.getElementById("popup-earned-status-menu");
      if (menu) menu.hidden = true;
      if (control) {
        control.setAttribute("aria-expanded", "false");
        control.onclick = (event) => openPopupStatusMenu(state, event.detail === 0);
      }
      if (settings) settings.onclick = showPopupSettings;
      configureEarnedActions({ hidden: true });
      freePlanSlots.reader = true;
      renderFreePlanLines();
      return;
    }
    if (state.activeStoryUnavailable === true) {
      stopStoryConfirmation();
      renderEarnedUnavailable(story);
      if (importButton) importButton.hidden = true;
      return;
    }
    if (state.autoTrackEnabled !== false) {
      renderEarnedAccessPending(story);
      if (importButton) importButton.hidden = true;
      watchForConfirmedStory(story, {
        saved: (work, found, already) => renderEarnedSaved(story, work, found?.title ? found : identity, already),
        delayed: () => renderEarnedDelayed(story),
        unavailable: () => renderEarnedUnavailable(story),
        connect: () => resolveAccountForStory({ kind: "story" }, requestKernelPopupState),
      });
      return;
    }
    renderPopupSaveStory({ identity, story }, "ready");
    return;
  }
  const onArchive = activeTab.kind === "supported_archive" || activeTab.kind === "blocked_archive";
  const awaitingFirstStory = activeTab.kind === "supported_archive" && state.firstSaveSeen !== true;
  // The page may be a list of stories or the site's home page, which has
  // no titles to tap, so the first-story prompt names neither.
  const heading = awaitingFirstStory
    ? FIRST_TAP_WORDS.listReadyHeading
    : onArchive ? "Trace is on here" : "Trace works on AO3 and FanFiction.net";
  const lead = awaitingFirstStory
    ? FIRST_TAP_WORDS.listReadyBody
    : onArchive
      ? "Stories you open join your Library. Lists show what you’ve read."
      : "Open a story there and Trace keeps your place as you read.";
  // Nothing here is the task, so there is no primary action. A list page
  // keeps the Settings row; another site needs only Safari's Done. A list,
  // History or Bookmarks page can be imported, so it offers Import.
  setEarnedCopy({
    stateCode: awaitingFirstStory ? "P8" : onArchive ? "on-list" : "other-site",
    heading,
    lead,
    returning: onArchive && !awaitingFirstStory,
    importable: activeTab.kind === "supported_archive",
  });
  const listControl = document.getElementById("popup-earned-status-control");
  if (listControl) listControl.hidden = true;
  const listProgress = document.getElementById("popup-earned-progress");
  if (listProgress) listProgress.hidden = true;
  const listSettings = document.getElementById("popup-earned-settings-row");
  if (listSettings) {
    listSettings.hidden = !(onArchive && !awaitingFirstStory);
    listSettings.onclick = showPopupSettings;
  }
  setEarnedResult("success", heading + ".", "");
  configureEarnedActions({ hidden: true });
  // A first-story prompt stays one task; settled pages show the plan line.
  freePlanSlots.reader = !awaitingFirstStory;
  renderFreePlanLines();
}

function bindPreferenceControls() {
  const controls = [
    ["pref-auto-track", PREF_AUTO_TRACK_KEY],
    ["pref-library-inlay", PREF_LIBRARY_INLAY_KEY],
    ["pref-ao3-saved-filters", PREF_AO3_SAVED_FILTERS_KEY],
    ["pref-metadata-improve", PREF_METADATA_IMPROVE_KEY],
  ];
  for (const [id, key] of controls) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.addEventListener("change", () => {
      ext.storage.local.set({ [key]: input.checked,
        ...(key === PREF_AUTO_TRACK_KEY ? { prefAutoTrackSetAt: Date.now() } : {}) });
      updatePreferenceSummary();
    });
  }
}

let popupSaveStoryContext = null;

function popupSaveFailureCopy(error) {
  if (error === "free_limit_reached") return "Your Library is full.";
  if (error === "auth_expired" || error === "not_authenticated") return "Trace needs to reconnect first.";
  if (error === "rate_limited") return "Trace is busy. Try again in a moment.";
  if (error === "page_unavailable" || error === "no_active_tab") return "Trace couldn’t reach this page.";
  return "Trace couldn’t reach your Library.";
}

/**
 * P10: automatic saving is off. "Save this story" shows a pending state while
 * the page's quick add runs and a truthful failure when it doesn't; the
 * button never quietly re-enables as if nothing happened.
 */
function renderPopupSaveStory(context, phase, error = "") {
  popupSaveStoryContext = context;
  const { identity, story } = context;
  const failed = phase === "failed";
  setEarnedCopy({
    stateCode: phase === "saving" ? "P10-saving" : failed ? "P10-failed" : "P10",
    heading: "Automatic saving is off",
    record: { title: identity?.title || "This story", byline: storyByline(identity, story),
      label: "Not in your Library", status: "SAVED" },
    failure: failed ? { title: "Nothing was saved", detail: popupSaveFailureCopy(error) } : null,
  });
  if (phase === "saving") {
    setEarnedResult("checking", "Saving this story.", "");
    configureEarnedActions(
      { label: "Saving…", action: "", disabled: true, emphasis: "primary" },
      { label: "Turn automatic saving on", action: "enable_auto_track", emphasis: "tertiary" },
    );
    return;
  }
  setEarnedResult(failed ? "failure" : "checking", failed ? "Nothing was saved." : "",
    failed ? popupSaveFailureCopy(error) : "");
  configureEarnedActions(
    { label: failed ? "Try again" : "Save this story", action: "save_story", emphasis: "primary" },
    { label: "Turn automatic saving on", action: "enable_auto_track", emphasis: "tertiary" },
  );
}

async function saveStoryFromPopup() {
  if (popupStorySavePending) return;
  popupStorySavePending = true;
  const context = popupSaveStoryContext || { identity: null, story: { ok: true, site: "AO3" } };
  renderPopupSaveStory(context, "saving");
  try {
    const tab = await probeQueryActiveTab();
    if (!tab || !Number.isInteger(tab.id)) throw new Error("no_active_tab");
    const response = await probeSendTabMessage(tab.id, { type: "TRACE_POPUP_QUICK_ADD" });
    if (!response || !response.ok) throw new Error(response?.error || "save_failed");
    const story = classifyEarnedPage(tab.url);
    watchForConfirmedStory(story, {
      saved: () => { popupStorySavePending = false; requestKernelPopupState(); },
      // The save was sent but not confirmed yet: say so rather than offering
      // the same button again.
      delayed: () => { popupStorySavePending = false; renderEarnedDelayed(story); },
      unavailable: () => { popupStorySavePending = false; renderEarnedUnavailable(story); },
      connect: () => { popupStorySavePending = false; resolveAccountForStory(story, requestKernelPopupState); },
    });
  } catch (failure) {
    popupStorySavePending = false;
    renderPopupSaveStory(context, "failed", failure?.message || "save_failed");
  }
}

async function enableAutomaticSavingFromPopup() {
  await earnedStorageSet({ [PREF_AUTO_TRACK_KEY]: true, prefAutoTrackSetAt: Date.now() });
  const input = document.getElementById("pref-auto-track");
  if (input) input.checked = true;
  const tab = await probeQueryActiveTab();
  if (Number.isInteger(tab?.id)) {
    await probeSendTabMessage(tab.id, { type: "TRACE_SCHEDULE_AUTO_TRACK" });
  }
  requestKernelPopupState();
}

function bindEarnedActionButtons() {
  for (const button of [
    document.getElementById("popup-earned-primary"),
    document.getElementById("popup-earned-secondary"),
  ]) {
    if (!button || button.dataset.traceBound === "true") continue;
    button.dataset.traceBound = "true";
    button.addEventListener("click", () => runEarnedAction(button));
  }
}

function runEarnedAction(button) {
  const action = button.dataset.earnedAction;
  if (action === "prepare") void prepareEarnedPermissionFlow();
  if (action === "allow_and_add") void allowAccessAndAddEarnedStory();
  if (action === "reconnect_page") void reloadDisconnectedPage();
  if (action === "reload_to_verify") void reloadEarnedStory();
  if (action === "close") window.close();
  if (action === "check_story") void checkConfirmedStory();
  // A look the reader asked for: the button waits on the answer.
  if (action === "first_tap_open") {
    holdFirstTapButton(button, (look) => firstTapLook("open", look), FIRST_TAP_WORDS.checking,
      (look) => resendFirstTapLook("open", look));
  }
  // The save waits on the background's answer, and reaches a background
  // that has gone to sleep under the sheet; see sendFirstTapSave.
  if (action === "first_tap_save") holdFirstTapButton(button, (look) => sendFirstTapSave(look));
  if (action === "first_tap_check") {
    holdFirstTapButton(button, (look) => firstTapLook("check", look), FIRST_TAP_WORDS.checking,
      (look) => resendFirstTapLook("check", look));
  }
  // The request has to be made in this tap itself; see askForStorySites.
  if (action === "first_tap_allow") askForStorySites();
  if (action === "first_tap_access_check") {
    holdFirstTapButton(button, (look) => void observeStorySiteAccess("access_check", { look }), FIRST_TAP_WORDS.checking,
      (look) => void observeStorySiteAccess("access_check", { look }, { freshPort: true }));
  }
  if (action === "first_tap_show_ask") {
    firstTapAccess = null;
    drawFirstTap();
    // This button is now a different one. Focus goes to what was asked for.
    focusFirstTapAsk();
  }
  // One tap, one change: the button waits, so a second tap sends nothing.
  if (action === "first_tap_automatic_saving_on") {
    holdFirstTapButton(button, (look) => void turnOnAutomaticSavingFromFirstTap(look));
  }
  if (action === "save_story") void saveStoryFromPopup();
  if (action === "enable_auto_track") void enableAutomaticSavingFromPopup();
  if (action === "open_app") openTraceApp(isLikelyIosExtensionUi ? TRACE_IOS_APP_LIBRARY_URL : TRACE_HOME_URL);
  if (action === "open_upgrade") void openUnlimited();
  if (action === "open_connect") openTraceApp(TRACE_IOS_APP_CONNECT_URL);
  if (action === "connect_account") retryAppAccount();
  if (action === "check_link") {
    const sequence = nextSessionSequence();
    sendKernelRuntimeMessage({ type: "TRACE_SESSION_ACTION", action: "connect" }, (response) => {
      sessionReplyTaken(sequence, response);
      if (response?.snapshot) renderKernelSnapshot(response.snapshot);
      if (response?.snapshot?.state === "connected") requestKernelPopupState();
    });
  }
}

function initializeKernelPopup() {
  if (kernelPopupInitialized) return;
  kernelPopupInitialized = true;
  if (EARNED_PERMISSION_ONBOARDING) bindEarnedActionButtons();
  renderKernelSnapshot({ state: "initializing", reason: "none" });
  for (const actionControl of [
    document.getElementById("popup-cta"),
    document.getElementById("popup-session-secondary"),
  ]) {
    actionControl?.addEventListener("click", (event) => {
      const action = actionControl.dataset.sessionAction;
      if (!action) return;
      event.preventDefault();
      if (actionControl.getAttribute("aria-disabled") === "true") return;
      actionControl.setAttribute("aria-disabled", "true");
      const sequence = nextSessionSequence();
      sendKernelRuntimeMessage(
        { type: "TRACE_SESSION_ACTION", action },
        (response) => {
          actionControl.removeAttribute("aria-disabled");
          if (!response) return;
          sessionReplyTaken(sequence, response);
          renderKernelSnapshot(response?.snapshot);
          if (response?.snapshot?.state === "connected") requestKernelPopupState();
        },
      );
    });
  }
  requestKernelSnapshot();
}

for (const id of ["popup-cta", "popup-session-help"]) {
  document.getElementById(id)?.addEventListener("click", (event) => {
    const control = event.currentTarget;
    const url = control.dataset.externalUrl;
    if (!url) return;
    event.preventDefault();
    if (control.dataset.unlimited === "1") void openUnlimited(url);
    else openTraceApp(url);
  });
}

// The background closes the tab an app link leaves behind, once it is done
// (src/extension-runtime/app-link-tabs.mts): left open, Safari can load it
// again later and ask to open the Trace app with no tap. It knows the tab by
// this note, written just before the tab is asked for.
const APP_LINK_PENDING_KEY = "traceAppLinkPendingAt";

function openTraceApp(url) {
  try {
    if (ext.tabs?.create) {
      if (/^traceauth:/i.test(String(url)) && ext.storage?.local) {
        void extensionPromiseCall(ext.storage.local, "set", [{ [APP_LINK_PENDING_KEY]: Date.now() }])
          .catch(() => {});
      }
      void extensionPromiseCall(ext.tabs, "create", [{ url }]).catch(() => {
        window.location.href = url;
      });
    } else {
      window.location.href = url;
    }
  } catch {
    // The app link is optional; the reader can always switch apps themselves.
  }
}

function activateKernelPopupAfterEarnedPermission() {
  earnedPreparedContext = null;
  earnedAwaitingStory = null;
  // Once the general view owns the popup, later page heartbeats must not
  // hide the reader view it renders into the shared section.
  if (kernelPopupInitialized) return;
  delete document.body.dataset.traceEarnedPermission;
  const section = document.getElementById("popup-earned-permission");
  if (section) section.hidden = true;
  initializeKernelPopup();
}

if (EARNED_PERMISSION_ONBOARDING) {
  void initializeEarnedPermissionFlow();
} else if (ACTIVE_TAB_PROBE) {
  initializeActiveTabProbe();
} else if (KERNEL_SESSION_ACTIVE || SESSION_DISABLED) {
  initializeKernelPopup();
} else {
readAndRender();

try {
  ext.runtime.sendMessage({ type: "TRACE_POPUP_OPEN" }, () => {
    if (ext.runtime.lastError) {
      /* ignore */
    }
    readAndRender();
    fetchPopupState();
  });
} catch {
  /* ignore */
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes[STATUS_KEY] ||
    changes[TRACE_FIRST_SAVE_SEEN_KEY] ||
    changes[TRACE_LIBRARY_COUNT_KEY]
  ) {
    readAndRender();
  }
  if (
    changes[TRACE_USER_PRO_KEY] ||
    changes[PREF_AUTO_TRACK_KEY] ||
    changes[PREF_LIBRARY_INLAY_KEY] ||
    changes[PREF_AO3_SAVED_FILTERS_KEY] ||
    changes[PREF_METADATA_IMPROVE_KEY]
  ) {
    applyProUiFromStorage();
  }
});

}

// Import is rendered only when the active session owner has exposed a
// supported archive page, but the same explicit control works in both modes.
const importBtn = document.getElementById("popup-import");
const NORMAL_POPUP_CONTROLS_AVAILABLE =
  !ACTIVE_TAB_PROBE || Boolean(EARNED_PERMISSION_ONBOARDING);
if (importBtn && NORMAL_POPUP_CONTROLS_AVAILABLE) {
  setImportInitial(importBtn);
  importBtn.addEventListener("click", () => {
    runImport(importBtn);
  });
}

if (NORMAL_POPUP_CONTROLS_AVAILABLE) bindPreferenceControls();

// Durable archive access is separate from the Trace account and current-tab access.
if (KERNEL_SESSION_ACTIVE && !isLikelyIosExtensionUi && !EARNED_PERMISSION_ONBOARDING && !ACTIVE_TAB_PROBE && globalThis.TraceArchiveAccess) {
  const section = document.getElementById("popup-host-access");
  const button = document.getElementById("popup-host-access-allow");
  const result = document.getElementById("popup-host-access-result");
  let access = [];
  let selected = null;
  let requesting = false;
  TraceArchiveAccess.watchPopup();
  const renderAccess = items => {
    access = Array.isArray(items) ? items : [];
    const missing = access.filter(item => item.granted === false);
    selected = missing[0] || null;
    section.hidden = !selected;
    if (!selected) {
      delete document.body.dataset.traceHostAccess;
      return;
    }
    document.body.dataset.traceHostAccess = "missing";
    document.getElementById("popup-host-access-lead").textContent = `Allow site access so Trace can save stories and keep your place on ${selected.label} without opening this popup each time.`;
    button.textContent = `Allow Trace on ${selected.label}`;
    button.disabled = requesting;
  };
  TraceArchiveAccess.onChanged(items => renderAccess(items));
  void TraceArchiveAccess.read().then(response => { if (response?.ok) renderAccess(response.access); }, () => {});
  button.addEventListener("click", () => {
    if (!selected || requesting) return;
    const pending = TraceArchiveAccess.request();
    requesting = true;
    button.disabled = true;
    result.textContent = "";
    // Firefox anchors its permission doorhanger behind this popup. Start the
    // request synchronously in the click, then uncover the browser's prompt.
    // onAdded in the background clears the badge/page line and restores pages;
    // a decline leaves access off, so reopening this popup offers Allow again.
    void pending.catch(() => {});
    window.close();
  });
}
