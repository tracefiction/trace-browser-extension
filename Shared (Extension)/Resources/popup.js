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

async function probeSendTabMessage(tabId, message) {
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

function earnedRegistrations() {
  return Array.isArray(EARNED_PERMISSION_ONBOARDING?.registrations)
    ? EARNED_PERMISSION_ONBOARDING.registrations.filter(
        (registration) =>
          registration &&
          typeof registration.id === "string" &&
          Array.isArray(registration.matches) &&
          Array.isArray(registration.js),
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

async function readRegisteredScriptIds() {
  try {
    const registrations = await extensionPromiseCall(
      ext.scripting,
      "getRegisteredContentScripts",
    );
    return new Set(
      Array.isArray(registrations)
        ? registrations
            .map((registration) => registration?.id)
            .filter((id) => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function hasCompleteEarnedRegistration(registeredIds) {
  const required = earnedRegistrations();
  return (
    required.length > 0 &&
    required.every((registration) => registeredIds.has(registration.id))
  );
}

async function ensureEarnedRegistrations() {
  const registrations = earnedRegistrations();
  if (registrations.length === 0) throw new Error("registration_config_missing");
  const currentIds = await readRegisteredScriptIds();
  const staleIds = registrations
    .map((registration) => registration.id)
    .filter((id) => currentIds.has(id));
  if (staleIds.length > 0) {
    await extensionPromiseCall(ext.scripting, "unregisterContentScripts", [
      { ids: staleIds },
    ]);
  }
  await extensionPromiseCall(ext.scripting, "registerContentScripts", [
    registrations,
  ]);
  const confirmedIds = await readRegisteredScriptIds();
  if (!hasCompleteEarnedRegistration(confirmedIds)) {
    throw new Error("registration_not_confirmed");
  }
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

function setEarnedResult(state, heading, detail) {
  const result = document.getElementById("popup-earned-result");
  const headingEl = document.getElementById("popup-earned-result-heading");
  const detailEl = document.getElementById("popup-earned-result-detail");
  if (result) result.dataset.state = state;
  if (headingEl) headingEl.textContent = heading;
  if (detailEl) detailEl.textContent = detail;
}

function setEarnedCopy({ kicker, heading, lead, disclosure }) {
  const kickerEl = document.getElementById("popup-earned-kicker");
  const headingEl = document.getElementById("popup-earned-heading");
  const leadEl = document.getElementById("popup-earned-lead");
  const disclosureEl = document.getElementById("popup-earned-disclosure");
  if (kickerEl) kickerEl.textContent = kicker;
  if (headingEl) headingEl.textContent = heading;
  if (leadEl) leadEl.textContent = lead;
  if (disclosureEl) disclosureEl.textContent = disclosure;
}

function setEarnedConnection(state, label) {
  const connection = document.getElementById("popup-connection");
  if (!connection) return;
  connection.dataset.state = state;
  const labelEl = connection.querySelector(".popup-connection-label");
  if (labelEl) labelEl.textContent = label;
}

function setEarnedAction(button, { hidden = false, disabled = false, label, action }) {
  if (!button) return;
  button.hidden = hidden;
  button.disabled = disabled;
  button.textContent = label;
  button.dataset.earnedAction = action || "";
}

function configureEarnedActions(primary, secondary = null) {
  setEarnedAction(document.getElementById("popup-earned-primary"), primary);
  setEarnedAction(
    document.getElementById("popup-earned-secondary"),
    secondary || { hidden: true, label: "Not now", action: "" },
  );
}

function resetEarnedLedger() {
  setEarnedCheck("popup-earned-story", "checking", "Checking", "Story page");
  setEarnedCheck("popup-earned-access", "waiting", "Waiting", "This story only");
  setEarnedCheck("popup-earned-save", "waiting", "Waiting", "Saved to Trace");
}

function renderEarnedAutomationInvitation() {
  setEarnedConnection("connected", "Saved");
  setEarnedCopy({
    kicker: "Story saved",
    heading: "Want Trace to work automatically?",
    lead:
      "Allow Trace on AO3 and FanFiction.net once, and future stories can save as they open.",
    disclosure:
      "Safari will list five supported AO3 and FanFiction.net addresses. Trace does not request access to other websites.",
  });
  setEarnedCheck("popup-earned-story", "pass", "Confirmed");
  setEarnedCheck("popup-earned-access", "pass", "This tab");
  setEarnedCheck("popup-earned-save", "pass", "Server confirmed");
  setEarnedResult(
    "success",
    "Your story is in your library.",
    "Automatic tracking is optional. You can keep using the Safari toolbar one story at a time.",
  );
  configureEarnedActions(
    { label: "Turn on automatic tracking", action: "request_automation" },
    { label: "Not now", action: "decline_automation" },
  );
}

function renderEarnedVerificationPending() {
  setEarnedConnection("warn", "Checking");
  setEarnedCopy({
    kicker: "Automatic tracking",
    heading: "One quick check.",
    lead:
      "Reload this story. Trace should appear without another toolbar tap.",
    disclosure:
      "Trace will call setup complete only after its archive script actually runs.",
  });
  setEarnedCheck("popup-earned-story", "pass", "Saved");
  setEarnedCheck(
    "popup-earned-access",
    "pass",
    "Five sites allowed",
    "Website access",
  );
  setEarnedCheck(
    "popup-earned-save",
    "checking",
    "Verify next load",
    "Automatic tracking",
  );
  setEarnedResult(
    "checking",
    "Safari access is allowed.",
    "The tracking scripts are registered. Reload once to prove they run.",
  );
  configureEarnedActions(
    { label: "Reload story to verify", action: "reload_to_verify" },
    { label: "Do this later", action: "close" },
  );
}

function renderEarnedAutomationConfirmed() {
  setEarnedConnection("connected", "Ready");
  setEarnedCopy({
    kicker: "Setup complete",
    heading: "Automatic tracking is on.",
    lead: "Trace ran automatically after website access was enabled.",
    disclosure:
      "If you later change Safari access, open Trace from the toolbar to recover or save one story manually.",
  });
  setEarnedCheck("popup-earned-story", "pass", "Saved");
  setEarnedCheck(
    "popup-earned-access",
    "pass",
    "Five sites allowed",
    "Website access",
  );
  setEarnedCheck(
    "popup-earned-save",
    "pass",
    "Run confirmed",
    "Automatic tracking",
  );
  setEarnedResult(
    "success",
    "You’re ready.",
    "Future supported story pages can save and update while you read.",
  );
  configureEarnedActions(
    { label: "Done", action: "close" },
    { hidden: true, label: "", action: "" },
  );
}

function renderEarnedAutomationDeclined() {
  setEarnedConnection("connected", "Manual");
  setEarnedCopy({
    kicker: "Story saved",
    heading: "Use Trace when you need it.",
    lead: "Open Trace from Safari’s toolbar on each story you want to save.",
    disclosure:
      "Nothing else was allowed. You can turn on automatic tracking from this panel later.",
  });
  setEarnedCheck("popup-earned-story", "pass", "Confirmed");
  setEarnedCheck("popup-earned-access", "pass", "This tab");
  setEarnedCheck("popup-earned-save", "pass", "Server confirmed");
  setEarnedResult(
    "success",
    "Your story is safe.",
    "Trace will keep working one story at a time from the toolbar.",
  );
  configureEarnedActions(
    { label: "Turn on automatic tracking", action: "request_automation" },
    { label: "Done", action: "close" },
  );
}

function renderEarnedAutomationPaused() {
  setEarnedConnection("error", "Paused");
  setEarnedCopy({
    kicker: "Automatic tracking paused",
    heading: "Safari access changed.",
    lead:
      "Your saved stories are untouched. Allow the supported sites again to restore automatic tracking.",
    disclosure:
      "You can also keep saving the current story from the Safari toolbar without enabling automation.",
  });
  setEarnedCheck("popup-earned-story", "pass", "Library safe");
  setEarnedCheck("popup-earned-access", "fail", "Needs access");
  setEarnedCheck("popup-earned-save", "waiting", "Paused");
  setEarnedResult(
    "failure",
    "Automatic tracking needs access.",
    "Safari will show the same five supported addresses.",
  );
  configureEarnedActions(
    { label: "Allow automatic tracking again", action: "request_automation" },
    { label: "Not now", action: "close" },
  );
}

function earnedAutomationVerified(onboarding, readiness) {
  return Boolean(
    onboarding.grantAt &&
      typeof readiness?.lastArchiveSeenAt === "number" &&
      readiness.lastArchiveSeenAt > onboarding.grantAt,
  );
}

async function renderEarnedSavedState() {
  const [{ onboarding, readiness }, grantedOrigins, registeredIds] =
    await Promise.all([
      readEarnedState(),
      readGrantedOrigins(),
      readRegisteredScriptIds(),
    ]);
  const hasGrant = hasCompleteEarnedGrant(grantedOrigins);
  const hasRegistration =
    hasCompleteEarnedRegistration(registeredIds) &&
    onboarding.registrationVersion ===
      (EARNED_PERMISSION_ONBOARDING.version || 1);
  if (onboarding.grantAt && !hasGrant) {
    renderEarnedAutomationPaused();
    return;
  }
  if (
    hasGrant &&
    hasRegistration &&
    earnedAutomationVerified(onboarding, readiness)
  ) {
    renderEarnedAutomationConfirmed();
    return;
  }
  if (hasGrant) {
    if (!hasRegistration) {
      try {
        await ensureEarnedRegistrations();
        await writeEarnedState({
          grantAt: Date.now(),
          registrationVersion: EARNED_PERMISSION_ONBOARDING.version || 1,
          promptResult: "granted",
        });
        void recordEarnedEvent("automation_registration_recovered");
      } catch {
        renderEarnedAutomationPaused();
        return;
      }
    }
    if (!onboarding.grantAt) {
      await writeEarnedState({
        grantAt: Date.now(),
        registrationVersion: EARNED_PERMISSION_ONBOARDING.version || 1,
        promptResult: "granted",
      });
    }
    renderEarnedVerificationPending();
    return;
  }
  if (onboarding.promptResult === "declined") {
    renderEarnedAutomationDeclined();
    return;
  }
  renderEarnedAutomationInvitation();
}

async function requestEarnedAutomation() {
  configureEarnedActions(
    { label: "Waiting for Safari…", action: "", disabled: true },
    { hidden: true, label: "", action: "" },
  );
  setEarnedResult(
    "checking",
    "Choose Always Allow in Safari.",
    "The next prompt covers only the supported AO3 and FanFiction.net addresses.",
  );
  void recordEarnedEvent("automation_permission_requested");
  try {
    const granted = await extensionPromiseCall(ext.permissions, "request", [
      { origins: earnedOrigins() },
    ]);
    if (granted !== true) {
      await writeEarnedState({ promptResult: "declined" });
      void recordEarnedEvent("automation_permission_declined");
      renderEarnedAutomationDeclined();
      return;
    }
    const grantedOrigins = await readGrantedOrigins();
    if (!hasCompleteEarnedGrant(grantedOrigins)) {
      throw new Error("permission_not_confirmed");
    }
    await ensureEarnedRegistrations();
    await writeEarnedState({
      grantAt: Date.now(),
      registrationVersion: EARNED_PERMISSION_ONBOARDING.version || 1,
      promptResult: "granted",
    });
    void recordEarnedEvent("automation_registered");
    renderEarnedVerificationPending();
    await reloadEarnedStory();
  } catch {
    void recordEarnedEvent("automation_setup_failed");
    renderEarnedAutomationPaused();
  }
}

async function reloadEarnedStory() {
  try {
    const tab = await probeQueryActiveTab();
    if (!tab || !Number.isInteger(tab.id)) throw new Error("no_active_tab");
    await extensionPromiseCall(ext.tabs, "reload", [tab.id]);
    void recordEarnedEvent("automation_verification_reload");
  } catch {
    setEarnedResult(
      "failure",
      "Reload this story manually.",
      "Then reopen Trace. The panel will confirm whether automatic tracking ran.",
    );
  }
}

async function runEarnedFirstSave() {
  setEarnedConnection("warn", "Saving");
  resetEarnedLedger();
  setEarnedCopy({
    kicker: "Your first story",
    heading: "Saving this story…",
    lead: "Trace is using access to this tab only.",
    disclosure:
      "Trace cannot see other tabs or websites from this one-time action.",
  });
  setEarnedResult(
    "checking",
    "Connecting to your library…",
    "Keep this panel open for a moment.",
  );
  configureEarnedActions(
    { label: "Saving…", action: "", disabled: true },
    { hidden: true, label: "", action: "" },
  );
  void recordEarnedEvent("first_story_save_started");
  try {
    const tab = await probeQueryActiveTab();
    const story = classifyProbeStory(tab?.url);
    if (!tab || !Number.isInteger(tab.id) || !story.ok) {
      setEarnedCheck("popup-earned-story", "fail", "Not a story");
      throw new Error("unsupported_page");
    }
    setEarnedCheck("popup-earned-story", "pass", story.site);

    let ping = null;
    try {
      ping = await probeSendTabMessage(tab.id, {
        type: "TRACE_ACTIVE_TAB_PROBE_PING",
      });
    } catch {
      // Expected on the first toolbar action for this tab.
    }
    if (ping?.ok !== true || ping?.probe !== true) {
      await probeInject(tab.id);
      ping = await probeSendTabMessage(tab.id, {
        type: "TRACE_ACTIVE_TAB_PROBE_PING",
      });
    }
    if (ping?.ok !== true || ping?.probe !== true) {
      throw new Error("current_tab_denied");
    }
    setEarnedCheck("popup-earned-access", "pass", "Allowed by tap");

    const response = await probeSendTabMessage(tab.id, {
      type: "TRACE_ACTIVE_TAB_PROBE_SAVE",
    });
    if (
      response?.ok !== true ||
      !["saved", "already_saved"].includes(response?.state) ||
      response?.serverConfirmed !== true
    ) {
      throw new Error(response?.error || "save_failed");
    }
    setEarnedCheck("popup-earned-save", "pass", "Server confirmed");
    await writeEarnedState({ firstSaveAt: Date.now() });
    void recordEarnedEvent("first_story_save_confirmed");
    await renderEarnedSavedState();
  } catch (error) {
    setEarnedConnection("error", "Issue");
    const reason = typeof error?.message === "string" ? error.message : "save_failed";
    const accessPassed =
      document.getElementById("popup-earned-access")?.dataset.state === "pass";
    if (reason !== "unsupported_page") {
      setEarnedCheck(
        accessPassed ? "popup-earned-save" : "popup-earned-access",
        "fail",
        "Needs attention",
      );
    }
    const [heading, detail] = probeFailureCopy(reason);
    setEarnedCopy({
      kicker: "First story",
      heading,
      lead: detail,
      disclosure:
        reason === "not_authenticated" || reason === "auth_expired"
          ? "Signing in to the Trace app connects the Safari extension; a Safari website login does not."
          : "No automatic website access was requested.",
    });
    setEarnedResult("failure", heading, detail);
    configureEarnedActions(
      { label: "Try again", action: "retry_save" },
      { hidden: true, label: "", action: "" },
    );
    void recordEarnedEvent("first_story_save_failed");
  }
}

async function initializeEarnedPermissionFlow() {
  document.body.dataset.traceEarnedPermission = "true";
  const section = document.getElementById("popup-earned-permission");
  const connection = document.getElementById("popup-connection");
  if (section) section.hidden = false;
  if (connection) {
    connection.dataset.state = "warn";
    const label = connection.querySelector(".popup-connection-label");
    if (label) label.textContent = "First story";
  }
  for (const button of [
    document.getElementById("popup-earned-primary"),
    document.getElementById("popup-earned-secondary"),
  ]) {
    button?.addEventListener("click", () => {
      const action = button.dataset.earnedAction;
      if (action === "retry_save") void runEarnedFirstSave();
      if (action === "request_automation") void requestEarnedAutomation();
      if (action === "decline_automation") {
        void writeEarnedState({ promptResult: "declined" });
        void recordEarnedEvent("automation_offer_declined");
        renderEarnedAutomationDeclined();
      }
      if (action === "reload_to_verify") void reloadEarnedStory();
      if (action === "close") window.close();
    });
  }
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[ARCHIVE_READINESS_KEY]) return;
    void renderEarnedSavedState();
  });
  void recordEarnedEvent("popup_opened");
  const { onboarding } = await readEarnedState();
  if (onboarding.firstSaveAt) {
    const grantedOrigins = await readGrantedOrigins();
    if (hasCompleteEarnedGrant(grantedOrigins)) {
      await renderEarnedSavedState();
      return;
    }
  }
  await runEarnedFirstSave();
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
  const connection = document.getElementById("popup-connection");
  if (section) section.hidden = false;
  if (connection) {
    connection.dataset.state = "warn";
    const label = connection.querySelector(".popup-connection-label");
    if (label) label.textContent = "Probe 1A";
  }
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
if (importBtn && !ACTIVE_TAB_PROBE) {
  setImportInitial(importBtn);
  importBtn.addEventListener("click", () => {
    runImport(importBtn);
  });
}

if (!ACTIVE_TAB_PROBE) bindPreferenceControls();
