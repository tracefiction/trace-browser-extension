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
const TRACE_IOS_SETUP_URL = `${DEFAULT_TRACE_WEB_ORIGIN}/apps#safari-ios-setup`;
const TRACE_IOS_APP_CONNECT_URL = "traceauth://open?destination=extension-connect";
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

const POPUP_PERMISSION_SPIKE_ACTIVE =
  globalThis.TRACE_IOS_POPUP_PERMISSION_SPIKE === true;
const ARCHIVE_PERMISSION_BUNDLE = Object.freeze(
  Array.isArray(globalThis.TRACE_ARCHIVE_PERMISSION_BUNDLE)
    ? globalThis.TRACE_ARCHIVE_PERMISSION_BUNDLE.filter(
        (origin) => typeof origin === "string" && origin.length > 0,
      )
    : [],
);
const ARCHIVE_PERMISSION_CONTENT_SCRIPTS = Object.freeze(
  Array.isArray(globalThis.TRACE_ARCHIVE_PERMISSION_CONTENT_SCRIPTS)
    ? globalThis.TRACE_ARCHIVE_PERMISSION_CONTENT_SCRIPTS.filter(
        (entry) => entry && typeof entry.id === "string",
      )
    : [],
);
const GLOBAL_PERMISSION_PATTERNS = new Set(["<all_urls>", "*://*/*"]);
const popupPermissionState = {
  requestGranted: null,
  origins: [],
  registeredScriptIds: [],
  error: null,
};

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
      return "Checking Trace";
    case "upgrade_required":
      return "Library full";
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
      return "Open Trace to upgrade";
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
      connectionState: "connected",
      connectionLabel: "Connected",
      eyebrow: "Library capacity",
      heading: "Library full",
      lead: "New stories won’t be added until you make room or get Trace Unlimited.",
      leadHidden: false,
      ctaHidden: false,
      ctaLabel: "Manage library",
      ctaUrl: TRACE_HOME_URL,
      ctaEmphasis: "primary",
      archiveLinksHidden: true,
      importHidden: true,
      importDisabled: true,
      importLabel: "Import from this page",
      importTitle: "Make room or get Trace Unlimited before importing new stories.",
    };
  }

  if (auth !== "connected") {
    const connectionState =
      auth === "error" ? "error" : auth === "signed_out" ? "off" : "warn";
    const connectionLabel =
      auth === "error"
        ? "Issue"
        : auth === "unknown"
          ? "Checking"
          : auth === "reconnect_required"
            ? "Reconnect"
            : auth === "upgrade_required"
              ? "Upgrade"
              : "Not linked";
    return {
      visualState: auth,
      statusState: auth,
      connectionState,
      connectionLabel,
      eyebrow: "",
      heading: recoveryHeading(auth),
      lead: recoveryLead(auth, authState.message),
      leadHidden: false,
      ctaHidden: false,
      ctaLabel: recoveryCtaLabel(auth),
      ctaUrl: recoveryCtaUrl(auth, authState.helpUrl),
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
        connectionState: "connected",
        connectionLabel: "Connected",
        eyebrow: "First story",
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
        connectionState: "connected",
        connectionLabel: "Connected",
        eyebrow: "First story",
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
        connectionState: "connected",
        connectionLabel: "Connected",
        eyebrow: "First story",
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
      connectionState: "connected",
      connectionLabel: "Connected",
      eyebrow: "First story",
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
    connectionState: "connected",
    connectionLabel: "Connected",
    eyebrow: "",
    heading: "Connected",
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
  mergePopupModel(patch);
  const ui = buildPopupUi(popupModel);
  const statusEl = document.getElementById("popup-status");
  const leadEl = document.getElementById("popup-lead");
  const ctaEl = document.getElementById("popup-cta");
  const importEl = document.getElementById("popup-import");
  const archiveLinksEl = document.getElementById("popup-archive-links");
  const settingsEl = document.getElementById("popup-pro-settings");
  const connectionEl = document.getElementById("popup-connection");
  const eyebrowEl = document.querySelector(".popup-eyebrow");
  document.body.dataset.tracePopupState = ui.visualState;

  if (statusEl) {
    statusEl.dataset.state = ui.statusState;
    statusEl.textContent = ui.heading;
  }

  if (connectionEl) {
    connectionEl.dataset.state = ui.connectionState || "off";
    const labelEl = connectionEl.querySelector(".popup-connection-label");
    if (labelEl) labelEl.textContent = ui.connectionLabel || "Not linked";
  }

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
    ctaEl.href = usefulActionUrl(ui.ctaUrl);
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
}

function applyLocalUi(ao3SavedFilters) {
  const ao3SavedFiltersEl = document.getElementById("pref-ao3-saved-filters");
  if (!ao3SavedFiltersEl) return;
  ao3SavedFiltersEl.checked = ao3SavedFilters !== false;
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
}

function fetchPopupState() {
  ext.runtime.sendMessage({ type: "TRACE_POPUP_GET_STATE" }, (s) => {
    if (ext.runtime.lastError || !s) return;
    renderStatus({
      authState: s.authState || undefined,
      firstSaveSeen: s.firstSaveSeen === true,
      libraryCount:
        typeof s.libraryCount === "number" ? s.libraryCount : undefined,
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
  const ui = buildPopupUi(popupModel);
  button.hidden = ui.importHidden;
  button.disabled = ui.importDisabled;
  button.textContent = ui.importLabel;
  button.title = ui.importTitle || "";
}

function permissionBundleCoverage(origins) {
  const granted = new Set(
    Array.isArray(origins)
      ? origins.filter((origin) => typeof origin === "string")
      : [],
  );
  const globallyGranted = [...GLOBAL_PERMISSION_PATTERNS].some((origin) =>
    granted.has(origin),
  );
  const missing = globallyGranted
    ? []
    : ARCHIVE_PERMISSION_BUNDLE.filter((origin) => !granted.has(origin));
  return { complete: missing.length === 0, globallyGranted, missing };
}

function permissionSiteCoverage(origins, site) {
  const coverage = permissionBundleCoverage(origins);
  if (coverage.globallyGranted) return true;
  const expected = ARCHIVE_PERMISSION_BUNDLE.filter((origin) =>
    site === "ao3"
      ? origin.includes("archiveofourown") || origin.includes("transformativeworks")
      : origin.includes("fanfiction.net"),
  );
  return expected.length > 0 && expected.every(
    (origin) => !coverage.missing.includes(origin),
  );
}

function setPermissionSiteState(id, allowed, state = "ready") {
  const element = document.getElementById(id);
  if (!element) return;
  if (state === "checking") {
    element.dataset.state = "checking";
    element.textContent = "Checking";
    return;
  }
  if (state === "error") {
    element.dataset.state = "error";
    element.textContent = "Check failed";
    return;
  }
  element.dataset.state = allowed ? "allowed" : "needed";
  element.textContent = allowed ? "Allowed" : "Needed";
}

function permissionErrorMessage(error, fallback) {
  return error && typeof error.message === "string" && error.message.length > 0
    ? error.message
    : fallback;
}

function renderPermissionPromptLead(element) {
  if (!element) return;
  const emphasis = document.createElement("strong");
  emphasis.textContent = "Always Allow";
  element.replaceChildren(
    document.createTextNode(
      "Trace needs access to AO3 and FanFiction.net so it can notice stories you read. When Safari asks, choose ",
    ),
    emphasis,
    document.createTextNode("."),
  );
}

function renderPermissionSpike() {
  const coverage = permissionBundleCoverage(popupPermissionState.origins);
  const registeredIds = new Set(popupPermissionState.registeredScriptIds);
  const registrationsComplete = ARCHIVE_PERMISSION_CONTENT_SCRIPTS.length > 0 &&
    ARCHIVE_PERMISSION_CONTENT_SCRIPTS.every((entry) => registeredIds.has(entry.id));
  const complete = coverage.complete && registrationsComplete;
  const heading = document.getElementById("popup-permission-heading");
  const lead = document.getElementById("popup-permission-lead");
  const status = document.getElementById("popup-permission-status");
  const request = document.getElementById("popup-permission-request");
  const openAo3 = document.getElementById("popup-permission-open-ao3");
  const note = document.getElementById("popup-permission-note");
  const evidence = document.getElementById("popup-permission-evidence");

  setPermissionSiteState(
    "popup-permission-ao3",
    permissionSiteCoverage(popupPermissionState.origins, "ao3"),
    popupPermissionState.error && !coverage.complete ? "error" : "ready",
  );
  setPermissionSiteState(
    "popup-permission-ffn",
    permissionSiteCoverage(popupPermissionState.origins, "ffn"),
    popupPermissionState.error && !coverage.complete ? "error" : "ready",
  );

  if (complete) {
    if (heading) heading.textContent = "Website access allowed";
    if (lead) {
      lead.textContent =
        "Trace can now run on every AO3 and FanFiction.net address it supports.";
    }
    if (status) {
      status.dataset.state = "success";
      status.textContent = "Access and both archive scripts are ready.";
    }
    if (request) {
      request.disabled = true;
      request.textContent = "Access allowed";
      request.hidden = true;
    }
    if (openAo3) openAo3.hidden = false;
    if (note) note.hidden = false;
  } else {
    if (heading) heading.textContent = "Allow story sites";
    renderPermissionPromptLead(lead);
    if (status) {
      status.dataset.state = popupPermissionState.error ? "error" : "neutral";
      if (popupPermissionState.error) {
        status.textContent = popupPermissionState.error;
      } else if (popupPermissionState.requestGranted === false) {
        status.textContent = "Safari did not allow the complete site bundle. Try again.";
      } else if (coverage.complete && !registrationsComplete) {
        status.textContent = "Access was allowed, but Trace could not prepare its archive scripts.";
        status.dataset.state = "error";
      } else {
        status.textContent = "Website access is still needed.";
      }
    }
    if (request) {
      request.disabled = false;
      request.hidden = false;
      request.textContent = coverage.complete
        ? "Retry preparing Trace"
        : popupPermissionState.requestGranted === false
          ? "Try allowing again"
          : "Allow AO3 & FFN";
    }
    if (openAo3) openAo3.hidden = true;
    if (note) note.hidden = true;
  }

  if (evidence) {
    evidence.textContent = JSON.stringify(
      {
        requestedPatternCount: ARCHIVE_PERMISSION_BUNDLE.length,
        grantedPatternCount: ARCHIVE_PERMISSION_BUNDLE.length - coverage.missing.length,
        requestGranted: popupPermissionState.requestGranted,
        completeCoverage: coverage.complete,
        missingPatterns: coverage.missing,
        expectedScriptIds: ARCHIVE_PERMISSION_CONTENT_SCRIPTS.map((entry) => entry.id),
        registeredScriptIds: popupPermissionState.registeredScriptIds,
        registrationsComplete,
        error: popupPermissionState.error,
      },
      null,
      2,
    );
  }
}

async function permissionSnapshot() {
  if (!ext?.permissions?.getAll) {
    throw new Error("Safari did not expose the permission status API.");
  }
  const snapshot = await ext.permissions.getAll();
  return Array.isArray(snapshot?.origins) ? snapshot.origins : [];
}

async function registeredPermissionScripts() {
  if (!ext?.scripting?.getRegisteredContentScripts) {
    throw new Error("Safari did not expose dynamic content scripts.");
  }
  const ids = ARCHIVE_PERMISSION_CONTENT_SCRIPTS.map((entry) => entry.id);
  const scripts = await ext.scripting.getRegisteredContentScripts({ ids });
  return Array.isArray(scripts) ? scripts : [];
}

async function ensurePermissionScripts() {
  const existing = await registeredPermissionScripts();
  const existingIds = new Set(existing.map((entry) => entry?.id).filter(Boolean));
  const missing = ARCHIVE_PERMISSION_CONTENT_SCRIPTS.filter(
    (entry) => !existingIds.has(entry.id),
  );
  if (missing.length > 0) {
    if (!ext?.scripting?.registerContentScripts) {
      throw new Error("Safari could not register Trace on the allowed sites.");
    }
    await ext.scripting.registerContentScripts(missing.map((entry) => ({ ...entry })));
  }
  const registered = await registeredPermissionScripts();
  popupPermissionState.registeredScriptIds = registered
    .map((entry) => entry?.id)
    .filter(Boolean);
}

async function refreshPermissionSpike() {
  popupPermissionState.error = null;
  try {
    popupPermissionState.origins = await permissionSnapshot();
    if (permissionBundleCoverage(popupPermissionState.origins).complete) {
      await ensurePermissionScripts();
    } else {
      popupPermissionState.registeredScriptIds = [];
    }
  } catch (error) {
    popupPermissionState.error = permissionErrorMessage(
      error,
      "Trace could not check Safari website access.",
    );
  }
  renderPermissionSpike();
}

async function requestPermissionBundle() {
  const request = document.getElementById("popup-permission-request");
  popupPermissionState.error = null;
  if (request) {
    request.disabled = true;
    request.textContent = "Waiting for Safari…";
  }
  const status = document.getElementById("popup-permission-status");
  if (status) {
    status.dataset.state = "neutral";
    status.textContent = "Choose Always Allow in Safari’s prompt.";
  }
  try {
    if (!ext?.permissions?.request || ARCHIVE_PERMISSION_BUNDLE.length === 0) {
      throw new Error("This build could not start Safari’s website access request.");
    }
    // Keep this call directly in the button's click turn. Awaiting another API
    // first would consume the user gesture Safari requires for permissions.
    const decision = ext.permissions.request({
      origins: [...ARCHIVE_PERMISSION_BUNDLE],
    });
    popupPermissionState.requestGranted = await decision;
    popupPermissionState.origins = await permissionSnapshot();
    if (permissionBundleCoverage(popupPermissionState.origins).complete) {
      await ensurePermissionScripts();
    }
  } catch (error) {
    popupPermissionState.error = permissionErrorMessage(
      error,
      "Safari’s website access request failed.",
    );
  }
  renderPermissionSpike();
}

async function retryPermissionScripts() {
  const request = document.getElementById("popup-permission-request");
  const status = document.getElementById("popup-permission-status");
  popupPermissionState.error = null;
  if (request) {
    request.disabled = true;
    request.textContent = "Preparing Trace…";
  }
  if (status) {
    status.dataset.state = "neutral";
    status.textContent = "Preparing Trace on the allowed sites…";
  }
  try {
    await ensurePermissionScripts();
  } catch (error) {
    popupPermissionState.error = permissionErrorMessage(
      error,
      "Trace could not prepare its archive scripts.",
    );
  }
  renderPermissionSpike();
}

function initializePermissionSpike() {
  document.body.dataset.tracePermissionSpike = "true";
  const section = document.getElementById("popup-permission-spike");
  const connection = document.getElementById("popup-connection");
  const request = document.getElementById("popup-permission-request");
  if (section) section.hidden = false;
  if (connection) {
    connection.dataset.state = "warn";
    const label = connection.querySelector(".popup-connection-label");
    if (label) label.textContent = "Setup";
  }
  request?.addEventListener("click", () => {
    if (permissionBundleCoverage(popupPermissionState.origins).complete) {
      void retryPermissionScripts();
    } else {
      void requestPermissionBundle();
    }
  });
  void refreshPermissionSpike();
}

function setArchiveLinks() {
  const ao3 = document.getElementById("popup-open-ao3");
  const ffn = document.getElementById("popup-open-ffn");
  if (ao3) ao3.href = AO3_WORKS_URL;
  if (ffn) ffn.href = FFN_HOME_URL;
}

setArchiveLinks();

function setImportBusy(button) {
  button.disabled = true;
  button.textContent = "Opening import…";
  button.title = currentImportTitle();
}

function setImportSuccess(button, response) {
  button.textContent =
    response?.state === "saved" || response?.state === "already_saved"
      ? "Saved to Trace"
      : "Opened import tab";
  button.title = "";
}

function importFailureCopy(error) {
  if (error === "permission_required") {
    return {
      label: "Allow site access, then retry",
      title:
        "Allow Trace on this AO3 or FanFiction.net site in your browser’s extension settings, refresh the page, then retry.",
    };
  }
  if (error === "not_authenticated" || error === "auth_expired") {
    return {
      label: "Reconnect Trace, then retry",
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
    label: "Import failed — try again",
    title:
      error ||
      "Open an AO3 or FanFiction.net tab and refresh it after updating the extension.",
  };
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
  }
}

function setImportUnavailable(button) {
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

  setImportBusy(button);

  ext.runtime.sendMessage({ type: "TRACE_IMPORT_TRIGGER" }, (res) => {
    if (res?.ok) {
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

function renderKernelSnapshot(snapshot) {
  const state = snapshot?.state || "initializing";
  const reason = snapshot?.reason || "none";
  const statusEl = document.getElementById("popup-status");
  const leadEl = document.getElementById("popup-lead");
  const ctaEl = document.getElementById("popup-cta");
  const secondaryActionEl = document.getElementById("popup-session-secondary");
  const sessionHelpEl = document.getElementById("popup-session-help");
  const connectionEl = document.getElementById("popup-connection");
  const localSettingsEl = document.getElementById("popup-local-settings");
  const proSettingsEl = document.getElementById("popup-pro-settings");
  const importEl = document.getElementById("popup-import");
  const archiveLinksEl = document.getElementById("popup-archive-links");
  const actions = SESSION_DISABLED
    ? { primary: null, secondary: null }
    : kernelActionsForState(state);
  const credentialRecovery =
    state === "signed_out" ||
    (state === "reconnect_required" &&
      ["credential_absent", "credential_rejected", "identity_conflict"].includes(reason));
  const labels = {
    connect: "Connect",
    cancel: "Cancel",
    disconnect: "Disconnect",
    retry: "Retry",
    reconnect: "Reconnect",
  };
  const headings = {
    initializing: "Checking Trace",
    signed_out: "Connect Trace",
    connecting: "Connecting…",
    verifying: "Verifying account…",
    connected: "Connected",
    degraded: "Trace is temporarily offline",
    reconnect_required: "Reconnect Trace",
  };
  let lead = "";
  if (SESSION_DISABLED) {
    lead = "Authenticated extension features are temporarily unavailable.";
  } else if (state === "signed_out" && isLikelyIosExtensionUi) {
    lead =
      "Open the Trace app and sign in there. Signing in on tracefiction.com in Safari does not connect this extension. Return to Safari and press Connect.";
  } else if (state === "reconnect_required" && isLikelyIosExtensionUi && credentialRecovery) {
    lead =
      "Open the Trace app and sign in there. Signing in on tracefiction.com in Safari does not connect this extension. Return to Safari and press Reconnect.";
  } else if (state === "signed_out") {
    lead =
      "Open Trace in this browser and sign in, then return here and press Connect.";
  } else if (state === "reconnect_required") {
    if (reason === "storage_write_failed" || reason === "storage_unavailable") {
      lead = "Trace could not update extension storage. Retry Reconnect after local storage recovers.";
    } else if (reason === "account_unavailable" || reason === "invalid_account_response") {
      lead = "Trace could not safely verify this account. Press Reconnect to try again.";
    } else if (reason === "malformed_envelope" || reason === "unsupported_envelope") {
      lead = "Trace found unsupported local session data. Reconnect will safely replace it.";
    } else {
      lead = "Sign in to Trace in this browser if needed, then press Reconnect.";
    }
  } else if (state === "degraded") {
    lead = reason === "storage_unavailable"
      ? "Trace could not read extension storage. Retry after local storage recovers."
      : "Your saved session is protected. Check your connection and retry.";
  } else if (state === "connected") {
    lead = "This extension session was verified for the current browser worker.";
  } else if (state === "connecting" || state === "verifying") {
    lead = "Keep this popup open while Trace verifies your account.";
  } else {
    lead = reason === "storage_unavailable"
      ? "Trace could not read extension storage. Retry in a moment."
      : "Checking the extension session.";
  }

  document.body.dataset.tracePopupState = state;
  if (statusEl) statusEl.textContent = SESSION_DISABLED ? "Trace unavailable" : headings[state] || "Trace";
  if (leadEl) {
    leadEl.hidden = false;
    leadEl.textContent = lead;
  }
  if (connectionEl) {
    connectionEl.dataset.state = state === "connected" ? "connected" : state === "degraded" ? "warn" : "off";
    const label = connectionEl.querySelector(".popup-connection-label");
    if (label) label.textContent = state === "connected" ? "Connected" : state === "initializing" ? "Checking" : "Not linked";
  }
  if (ctaEl) {
    ctaEl.hidden = actions.primary == null;
    ctaEl.href = "#";
    ctaEl.textContent = actions.primary ? labels[actions.primary] : "";
    ctaEl.dataset.sessionAction = actions.primary || "";
    ctaEl.dataset.emphasis = "primary";
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
    sessionHelpEl.href = isLikelyIosExtensionUi
      ? TRACE_IOS_APP_CONNECT_URL
      : TRACE_HOME_URL;
    sessionHelpEl.textContent = isLikelyIosExtensionUi
      ? "Open Trace app"
      : "Open Trace to sign in";
  }
  if (localSettingsEl) localSettingsEl.hidden = true;
  if (proSettingsEl) proSettingsEl.hidden = true;
  if (importEl) importEl.hidden = true;
  if (archiveLinksEl) archiveLinksEl.hidden = true;
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

function requestKernelSnapshot() {
  sendKernelRuntimeMessage({ type: "TRACE_SESSION_GET_SNAPSHOT" }, (response) => {
    if (!response) return;
    renderKernelSnapshot(response?.snapshot);
    if (response?.snapshot?.state === "connected") requestKernelPopupState();
  });
}

function requestKernelPopupState() {
  sendKernelRuntimeMessage({ type: "TRACE_POPUP_GET_STATE" }, (state) => {
    if (
      !state ||
      state.ok !== true ||
      state.authState?.state !== "connected" ||
      document.body.dataset.tracePopupState !== "connected"
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
    const importButton = document.getElementById("popup-import");
    if (localSettings) localSettings.hidden = false;
    if (proSettings) proSettings.hidden = false;
    if (importButton) restoreImportButton(importButton);
  });
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
      ext.storage.local.set({ [key]: input.checked });
    });
  }
}

function initializeKernelPopup() {
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

if (POPUP_PERMISSION_SPIKE_ACTIVE) {
  initializePermissionSpike();
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
if (importBtn && !POPUP_PERMISSION_SPIKE_ACTIVE) {
  setImportInitial(importBtn);
  importBtn.addEventListener("click", () => {
    runImport(importBtn);
  });
}

if (!POPUP_PERMISSION_SPIKE_ACTIVE) bindPreferenceControls();
