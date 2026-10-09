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
let kernelPopupInitialized = false;
let nativeImportContinuation = null;
let nativeImportGeneration = 0;
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

function renderStatus(patch) {
  setImportRecoveryHelp();
  mergePopupModel(patch);
  const ui = buildPopupUi(popupModel);
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
    importEl.hidden = ui.importHidden;
    importEl.disabled = ui.importDisabled;
    importEl.textContent = ui.importLabel;
    importEl.title = ui.importTitle || "";
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
  return buildPopupUi(popupModel).importLabel || "Import from this page";
}

function currentImportTitle() {
  return buildPopupUi(popupModel).importTitle || "";
}

function isImportCurrentlyAvailable() {
  const ui = buildPopupUi(popupModel);
  return !ui.importHidden && !ui.importDisabled;
}

function restoreImportButton(button) {
  setImportRecoveryHelp();
  const ui = buildPopupUi(popupModel);
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
    if (ao3Host && /^\/works\/[1-9][0-9]*(?:\/chapters\/[1-9][0-9]*)?\/?$/.test(url.pathname)) {
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

function earnedAnnouncementForState(code, heading, detail) {
  const title = document.getElementById("popup-earned-heading")?.textContent?.trim() || "Your story";
  const byline = document.getElementById("popup-earned-record-byline")?.textContent?.trim() || "";
  const author = byline.includes(" · ") ? byline.split(" · ")[0].trim() : "the author";
  switch (code) {
    case "P1": return "Trace is on this story. Saving your story. Keep reading; a note appears on the page when it’s saved.";
    case "P2": return `${heading.startsWith("Already") ? "Already in your Library" : "Saved to your Library"}: ${title} by ${author}.${heading.startsWith("Already") ? "" : " Your chapter fills in as you read."}`;
    case "P3": return "Allowed on this site only. Next, tap Always Allow, not the blue button. Safari will list all 5 story-site addresses.";
    case "P3-lapse": return "Trace can’t save here right now. Next, tap Always Allow, not the blue button.";
    case "P4": return "Waiting for Safari. Tap Always Allow, not the blue button.";
    case "P5": return "Still confirming your story. Nothing to redo.";
    case "P6": return "Finish setup in the Trace app.";
    case "P7": return "Nothing was saved. When Safari asks again, tap Always Allow.";
    case "P8": return "Open any story to save it.";
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
  const pinHeight = pin.getBoundingClientRect().height;
  const textAx = bodySize >= 28;
  const ax = textAx || pinHeight > window.innerHeight * 0.3;
  section.classList.toggle("popup-earned-ax", ax);
  section.classList.toggle("popup-earned-text-ax", textAx);
  const scroll = section.querySelector(".popup-earned-scroll");
  const needsPin = !ax && !pin.hidden && scroll &&
    scroll.scrollHeight + pinHeight > window.innerHeight + 1;
  section.style.setProperty("--trace-pin-height", `${Math.ceil(pinHeight)}px`);
  section.classList.toggle("popup-earned-fixed-pin", Boolean(needsPin));
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
}) {
  const previouslyFocused = document.activeElement;
  document.body.dataset.tracePopupStateCode = stateCode;
  // Only the reader view's settled states show the plan line; they turn it
  // back on after their copy is set.
  freePlanSlots.reader = false;
  renderFreePlanLines();
  setEarnedRecord(record);
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
  if (extrasEl) extrasEl.hidden = !returning;
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
    const lead = document.getElementById("popup-earned-lead");
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
      heading: "Reload this page to keep going",
      lead: "Trace couldn’t reload this tab. Reload the page, then return to the Trace app. Nothing was saved yet.",
    });
    setEarnedResult(
      "failure",
      "Reload this page to keep going.",
      "Nothing was saved yet.",
    );
    configureEarnedActions({
      label: "Try again",
      action: "reload_to_verify",
    });
  }
}

function renderEarnedPermissionInvitation(story, hasGrant, coverage = null, lapse = false) {
  const onStory = story.kind === "story";
  const partial = !hasGrant && ((coverage && coverage.granted > 0) || isLikelyIosExtensionUi);
  if (partial) {
    setEarnedCopy({
      stateCode: lapse ? "P3-lapse" : "P3",
      kicker: lapse ? "Trace can’t save here right now" : "Allowed on this site only",
      kickerIcon: lapse ? "alert" : "globe",
      headingMarkup: "Next, tap <b>Always Allow</b>.",
      lead: lapse
        ? "Trace needs its story sites again. Safari will list AO3 and FanFiction.net’s 5 addresses."
        : "Trace needs AO3 and FanFiction.net’s other addresses too. Safari will list all 5.",
      ruleMarkup: "Then tap <b>Always Allow</b>, not the blue button. The blue one stops Trace tomorrow.",
    });
  } else {
    setEarnedCopy({
      kicker: story.site + (onStory ? " story" : " site"),
      heading: hasGrant ? (onStory ? "Save this story" : "Open any story to save it")
        : "Let Trace work on AO3 and FanFiction.net",
      lead: hasGrant ? "Website access is already allowed." : "Nothing has been saved yet.",
    });
  }
  setEarnedCheck("popup-earned-story", onStory ? "pass" : "waiting", onStory ? story.site : "Open a story", "Story page");
  setEarnedCheck("popup-earned-access", hasGrant ? "pass" : "waiting", hasGrant ? "Allowed" : "Needed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "After access", "Saved to Trace");
  setEarnedResult(hasGrant ? "checking" : "failure", hasGrant ? "Website access found." : "One permission remains.", "");
  configureEarnedActions({
    label: hasGrant ? (onStory ? "Save this story" : "Finish setup") : partial ? "Allow story sites" : "Continue",
    action: "allow_and_add", emphasis: "primary",
  });
  if (partial) void recordEarnedEvent("website_access_partial_seen");
}

function renderEarnedSiteReady() {
  setEarnedCopy({
    stateCode: "P8",
    heading: "Open any story to save it",
    lead: "Tap a title on this page. Trace saves it when it opens.",
  });
  setEarnedCheck("popup-earned-story", "waiting", "Open a story", "Story page");
  setEarnedCheck("popup-earned-access", "pass", "Allowed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "Not saved", "Saved to Trace");
  setEarnedResult("success", "Open any story to save it.", "");
  configureEarnedActions({ hidden: true });
}

function renderEarnedAccessPending(story) {
  setEarnedCopy({
    stateCode: "P1",
    kicker: "Trace is on this story",
    kickerIcon: "check",
    heading: "Saving your story…",
    lead: "Keep reading. A note appears on the page when it’s saved.",
  });
  setEarnedCheck("popup-earned-story", "pass", story.site, "Story page");
  setEarnedCheck("popup-earned-access", "pass", "Allowed", "Website access");
  setEarnedCheck("popup-earned-save", "checking", "Reloading", "Saved to Trace");
  setEarnedResult("checking", "Saving your story.", "Keep reading; a note appears on the page when it’s saved.");
  configureEarnedActions({ label: "Keep reading", action: "close", emphasis: "secondary" });
}

function renderEarnedPermissionDeclined(story) {
  const onStory = story.kind === "story";
  setEarnedCopy({
    stateCode: "P7",
    heading: "Nothing was saved",
    leadMarkup: "Trace needs AO3 and FanFiction.net’s addresses to save stories. When Safari asks again, tap <b>Always Allow</b>, not the blue button.",
  });
  setEarnedCheck("popup-earned-story", onStory ? "pass" : "waiting", onStory ? story.site : "Open a story", "Story page");
  setEarnedCheck("popup-earned-access", "fail", "Not allowed", "Website access");
  setEarnedCheck("popup-earned-save", "waiting", "Not added", "Saved to Trace");
  setEarnedResult("failure", "Nothing was saved.", "When Safari asks again, tap Always Allow.");
  configureEarnedActions(
    { label: "Try again", action: "allow_and_add", emphasis: "primary" },
    { label: "Not now", action: "close", emphasis: "tertiary" },
  );
}

function renderEarnedRegistrationFailure(story) {
  const onStory = story.kind === "story";
  setEarnedCopy({
    stateCode: "registration-failure",
    glyph: "alert",
    glyphTone: "warning",
    heading: "Trace couldn’t finish setting up",
    lead: "Website access is allowed. Trying again won’t ask for it again.",
    helpLabel: "Still not working?",
    disclosure:
      onStory ? "Restart Safari, reopen this story, and open Trace again." : "Restart Safari, reopen this site, and open Trace again.",
  });
  setEarnedCheck("popup-earned-story", onStory ? "pass" : "waiting", onStory ? story.site : "Open a story", "Story page");
  setEarnedCheck(
    "popup-earned-access",
    "pass",
    "Allowed",
    "Website access",
  );
  setEarnedCheck(
    "popup-earned-save",
    "fail",
    "Not added",
    "Saved to Trace",
  );
  setEarnedResult(
    "failure",
    "Nothing was saved.",
    "Retrying will not ask for website access again.",
  );
  configureEarnedActions({ label: "Try again", action: "allow_and_add" });
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

function renderEarnedSaved(story, work, identity, alreadyInLibrary = false) {
  void deliverFirstStoryConfirmation();
  const line = recordLine(work?.entry);
  setEarnedCopy({
    stateCode: "P2",
    kicker: alreadyInLibrary ? "Already in your Library" : "Saved to your Library",
    kickerIcon: "check",
    heading: identity?.title || "Your story",
    record: { heading: true, byline: storyByline(identity, story), label: line.label, status: line.key },
    lead: "Your chapter fills in as you read. Your story is waiting in Trace whenever you open it.",
  });
  setEarnedCheck("popup-earned-save", "pass", "Saved", "Saved to Trace");
  setEarnedResult("success", alreadyInLibrary ? "Already in your Library:" : "Saved to your Library:",
    (identity?.title || "Your story") + " by " + (identity?.author || "the author") + ". Your chapter fills in as you read.");
  configureEarnedActions({ label: "Keep reading", action: "close", emphasis: "secondary" });
}

function renderEarnedDelayed(story) {
  setEarnedCopy({
    stateCode: "P5",
    heading: "Still confirming your story",
    lead: "Nothing to redo. Keep reading; it’ll appear in Trace.",
  });
  setEarnedResult("checking", "Still confirming your story.", "Nothing to redo.");
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
    watch.render.connect();
    return;
  }
  if (state.activeWork && state.activeWork.status === "saved") {
    const identity = watch.identity || (await readActiveStoryIdentity());
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
function watchForConfirmedStory(story, render) {
  stopStoryConfirmation();
  storyConfirmation = { story, render, identity: null, timer: null, firstCheck: true };
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
    connect: () => {
      stopStoryConfirmation();
      renderEarnedConnectAccount(story);
    },
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
 * only chooses between "Saving your story…" and a neutral "Checking your
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

async function prepareEarnedPermissionFlow() {
  resetEarnedLedger();
  const [{ onboarding, readiness }, grantedOrigins] = await Promise.all([
    readEarnedState(),
    readGrantedOrigins(),
  ]);
  const hasGrant = await readCompleteEarnedGrant(grantedOrigins);
  const tab = await probeQueryActiveTab().catch(() => null);
  const story = classifyEarnedPage(tab?.url);
  earnedCurrentPage = story.ok ? story : null;
  if (earnedCurrentPage?.kind === "story") {
    earnedCurrentPage = { ...earnedCurrentPage, knownInLibrary: await readKnownInLibrary(tab?.url) };
  }
  if (onboarding.completedAt && story.ok && !hasGrant) {
    earnedPreparedContext = Object.freeze({ story, hasGrant: false });
    stopStoryConfirmation();
    renderEarnedPermissionInvitation(story, false, earnedGrantCoverage(grantedOrigins), true);
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
    }
    if (earnedAwaitingStory) {
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
      renderEarnedRegistrationFailure(story);
      return;
    }
    void recordEarnedEvent("website_access_registration_ready");
    if (story.kind === "archive") {
      await writeEarnedState({ completedAt: Date.now() });
      renderEarnedSiteReady();
      return;
    }
    // Access is complete (for example, Safari's Every Website choice). There
    // is no permission decision left, so continue without an extra tap.
    earnedAwaitingStory = story;
    renderEarnedAccessPending(story);
    await reloadEarnedStory();
    return;
  }
  renderEarnedPermissionInvitation(story, hasGrant, earnedGrantCoverage(grantedOrigins));
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
  configureEarnedActions({
    label: "Waiting for Safari…",
    action: "",
    disabled: true,
    emphasis: "secondary",
  });
  setEarnedCopy({
    stateCode: "P4",
    headingMarkup: "Tap <b>Always Allow</b>, not the blue button.",
    lead: "It lists 5 addresses. They’re all AO3 or FanFiction.net.",
    ruleMarkup: "Tap <b>Always Allow</b>, not the blue button.",
    duplicateRule: true,
  });
  setEarnedResult("checking", "", "");
  const story = prepared.story;
  void recordEarnedEvent("website_access_action_started");
  try {
    if (permissionRequest) {
      void recordEarnedEvent("website_access_requested");
    }
    const granted = permissionRequest ? await permissionRequest : true;
    const grantedOrigins = await readGrantedOrigins();
    if (
      granted !== true ||
      !(await readCompleteEarnedGrant(grantedOrigins))
    ) {
      await writeEarnedState({ promptResult: "declined" });
      const coverage = earnedGrantCoverage(grantedOrigins);
      if (coverage.granted > 0 && granted === true) {
        void recordEarnedEvent("website_access_partial");
        renderEarnedPermissionInvitation(story, false, coverage);
      } else {
        void recordEarnedEvent("website_access_not_allowed");
        renderEarnedPermissionDeclined(story);
      }
      return;
    }
    earnedPreparedContext = Object.freeze({ story, hasGrant: true });
    earnedAwaitingStory = story;
    const registration = await reconcileEarnedRegistration();
    if (registration?.ok !== true || registration?.registered !== true) {
      throw new Error("registration_failed");
    }
    void recordEarnedEvent("website_access_registered");
    if (story.kind === "archive") {
      await writeEarnedState({ completedAt: Date.now() });
      renderEarnedSiteReady();
      return;
    }
    renderEarnedAccessPending(story);
    await reloadEarnedStory();
  } catch {
    void recordEarnedEvent("website_access_setup_failed");
    const grantedOrigins = await readGrantedOrigins();
    if (await readCompleteEarnedGrant(grantedOrigins)) {
      renderEarnedRegistrationFailure(story);
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
    if (!changes[ARCHIVE_READINESS_KEY]) return;
    void prepareEarnedPermissionFlow();
  });
  void recordEarnedEvent("popup_opened");
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

function renderNativeImportContinuation(snapshot) {
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
  if (!nativeImportContinuation) event.preventDefault();
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
  help.textContent = visible
    ? "Reload this story. If importing still fails, restart Safari and reopen the story."
    : "";
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
    renderAwaitingAppLink(reason);
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

/**
 * iOS: the extension is on but not yet linked to the account in the Trace app.
 * One step, one action: finish setup in the app, then come back.
 */
function renderAwaitingAppLink(reason = "none") {
  const section = document.getElementById("popup-earned-permission");
  if (!section) return;
  document.body.dataset.traceReaderView = "link";
  section.hidden = false;
  for (const id of ["popup-import", "popup-cta", "popup-session-help", "popup-session-secondary", "popup-preferences"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  if (reason === "identity_conflict") renderEarnedOtherAccount();
  else renderEarnedConnectAccount({ kind: "story" });
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
let kernelSnapshotAttempt = 0;
let kernelSnapshotTransientAttempt = 0;
// The worker can't tell an app with no account from one it couldn't read,
// so this stays short: a signed-out reader waits about a second longer.
const KERNEL_SNAPSHOT_PROVIDER_RETRY_LIMIT = 2;
const KERNEL_SNAPSHOT_PROVIDER_RETRY_MS = 600;
let kernelSnapshotProviderAttempt = 0;

function requestKernelSnapshot() {
  sendKernelRuntimeMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" }, (response) => {
    if (!response) {
      const retryDelay = KERNEL_SNAPSHOT_RETRY_DELAYS_MS[kernelSnapshotAttempt];
      kernelSnapshotAttempt += 1;
      if (retryDelay !== undefined) {
        setTimeout(requestKernelSnapshot, retryDelay);
        return;
      }
      renderKernelSnapshot({ state: "degraded", reason: "runtime_unavailable" });
      return;
    }
    kernelSnapshotAttempt = 0;
    const state = response?.snapshot?.state;
    // The app's account couldn't be read just now (Safari can still be
    // starting the extension). Signed out isn't confirmed, so keep checking
    // briefly instead of asking a signed-in reader to sign in.
    if (
      response?.action?.kind === "unavailable" &&
      (state === "signed_out" || state === "reconnect_required") &&
      kernelSnapshotProviderAttempt < KERNEL_SNAPSHOT_PROVIDER_RETRY_LIMIT
    ) {
      kernelSnapshotProviderAttempt += 1;
      renderKernelSnapshot({ state: "initializing", reason: "none" });
      setTimeout(requestKernelSnapshot, KERNEL_SNAPSHOT_PROVIDER_RETRY_MS);
      return;
    }
    kernelSnapshotProviderAttempt = 0;
    renderKernelSnapshot(response?.snapshot);
    if (state === "initializing" || state === "connecting" || state === "verifying") {
      if (kernelSnapshotTransientAttempt < KERNEL_SNAPSHOT_TRANSIENT_RETRY_LIMIT) {
        kernelSnapshotTransientAttempt += 1;
        setTimeout(requestKernelSnapshot, kernelSnapshotTransientAttempt === 1 ? 250 : 1000);
      }
      return;
    }
    kernelSnapshotTransientAttempt = 0;
    if (state === "connected") requestKernelPopupState();
  });
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
    if (state.activeWork?.status === "saved") {
      const line = recordLine(state.activeWork.entry);
      setEarnedCopy({
        stateCode: "P11",
        heading: identity?.title || "This story",
        // Status appears once, in the control; the record keeps the byline.
        record: { heading: true, byline: storyByline(identity, story), label: "", status: line.key },
        returning: true,
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
      if (importButton) importButton.hidden = true;
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
        saved: (work, found, already) => renderEarnedSaved(story, work, found || identity, already),
        delayed: () => renderEarnedDelayed(story),
        unavailable: () => renderEarnedUnavailable(story),
        connect: () => { stopStoryConfirmation(); renderEarnedConnectAccount({ kind: "story" }); },
      });
      return;
    }
    renderPopupSaveStory({ identity, story }, "ready");
    return;
  }
  const onArchive = activeTab.kind === "supported_archive" || activeTab.kind === "blocked_archive";
  const awaitingFirstStory = activeTab.kind === "supported_archive" && state.firstSaveSeen !== true;
  const heading = awaitingFirstStory
    ? "Open any story to save it"
    : onArchive ? "Trace is on here" : "Trace works on AO3 and FanFiction.net";
  const lead = awaitingFirstStory
    ? "Tap a title on this page. Trace saves it when it opens."
    : onArchive
      ? "Stories you open join your Library. Lists show what you’ve read."
      : "Open a story there and Trace keeps your place as you read.";
  // Nothing here is the task, so there is no primary action. A list page
  // keeps the Settings row; another site needs only Safari's Done.
  setEarnedCopy({
    stateCode: awaitingFirstStory ? "P8" : onArchive ? "on-list" : "other-site",
    heading,
    lead,
    returning: onArchive && !awaitingFirstStory,
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
  if (importButton && !onArchive) importButton.hidden = true;
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
      connect: () => { popupStorySavePending = false; renderEarnedConnectAccount(story); },
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
    button.addEventListener("click", () => {
      const action = button.dataset.earnedAction;
      if (action === "prepare") void prepareEarnedPermissionFlow();
      if (action === "allow_and_add") void allowAccessAndAddEarnedStory();
      if (action === "reconnect_page") void reloadDisconnectedPage();
      if (action === "reload_to_verify") void reloadEarnedStory();
      if (action === "close") window.close();
      if (action === "check_story") void checkConfirmedStory();
      if (action === "save_story") void saveStoryFromPopup();
      if (action === "enable_auto_track") void enableAutomaticSavingFromPopup();
      if (action === "open_app") openTraceApp(isLikelyIosExtensionUi ? TRACE_IOS_APP_LIBRARY_URL : TRACE_HOME_URL);
      if (action === "open_upgrade") void openUnlimited();
      if (action === "open_connect") openTraceApp(TRACE_IOS_APP_CONNECT_URL);
      if (action === "check_link") {
        sendKernelRuntimeMessage({ type: "TRACE_SESSION_ACTION", action: "connect" }, (response) => {
          if (response?.snapshot) renderKernelSnapshot(response.snapshot);
          if (response?.snapshot?.state === "connected") requestKernelPopupState();
        });
      }
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
      sendKernelRuntimeMessage(
        { type: "TRACE_SESSION_ACTION", action },
        (response) => {
          actionControl.removeAttribute("aria-disabled");
          if (!response) return;
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

function openTraceApp(url) {
  try {
    if (ext.tabs?.create) {
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
