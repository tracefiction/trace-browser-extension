const ext = typeof browser !== "undefined" ? browser : chrome;
const STATUS_KEY = "traceAuthState";
const PREF_AUTO_TRACK_KEY = "prefAutoTrackEnabled";
const PREF_LIBRARY_INLAY_KEY = "prefLibraryInlayEnabled";
const PREF_METADATA_IMPROVE_KEY = "prefMetadataImproveEnabled";
const TRACE_USER_PRO_KEY = "traceUserPro";
const TRACE_FIRST_SAVE_SEEN_KEY = "traceFirstSaveSeen";
const TRACE_LIBRARY_COUNT_KEY = "traceLibraryCount";
const TRACE_HOME_URL = "https://tracefiction.com/";
const TRACE_IOS_SETUP_URL = "https://tracefiction.com/apps#safari-ios-setup";
const AO3_WORKS_URL = "https://archiveofourown.org/works";
const FFN_HOME_URL = "https://www.fanfiction.net/";
const IOS_SIGN_IN_GUIDANCE =
  "In Safari, enable Trace in Extensions, allow it on tracefiction.com, AO3, and FFN, then sign in on tracefiction.com. Return to a supported story page to use + ADD or import.";
const IOS_PERMISSION_GUIDANCE =
  "If Safari still blocks Trace, enable the extension and allow it on tracefiction.com, AO3, and FFN. Then refresh the supported story page and use + ADD or import.";

const isLikelyIosExtensionUi = (() => {
  try {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  } catch {
    return false;
  }
})();

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
  const base = `Use + ADD on this ${site} page, or import it into Trace.`;
  return isLikelyIosExtensionUi
    ? `${base} If + ADD is missing in Safari, allow Trace for this site and refresh.`
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
    ? "In Safari, allow Trace on AO3 and FFN, then open a supported story page and use + ADD or import from this popup."
    : "Open a supported story page, then use + ADD or import from this popup.";
}

function buildPopupUi(model) {
  const authState = model.authState || fallbackStatus;
  const auth = authState.state || fallbackStatus.state;
  const activeTab = model.activeTab || { kind: "unknown" };

  if (auth !== "connected") {
    return {
      visualState: auth,
      statusState: auth,
      eyebrow: "Extension lens",
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
    eyebrow: "Extension lens",
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
  const eyebrowEl = document.querySelector(".popup-eyebrow");
  document.body.dataset.tracePopupState = ui.visualState;

  if (statusEl) {
    statusEl.dataset.state = ui.statusState;
    statusEl.textContent = ui.heading;
  }

  if (eyebrowEl) {
    eyebrowEl.hidden = false;
    eyebrowEl.textContent = ui.eyebrow;
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
    });
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
      PREF_METADATA_IMPROVE_KEY,
    ],
    (r) => {
      if (ext.runtime.lastError) return;
      const pro = r[TRACE_USER_PRO_KEY] === true;
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

function setImportSuccess(button) {
  button.textContent = "Opened import tab";
  button.title = "";
}

function setImportFailure(button, error) {
  button.textContent = "Import failed — try again";
  button.disabled = false;
  resetImportButtonAfterFailure(button, error);
  if (!isImportCurrentlyAvailable()) {
    restoreImportButton(button);
  } else {
    button.textContent = "Import failed — try again";
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
      setImportSuccess(button);
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
    changes[PREF_METADATA_IMPROVE_KEY]
  ) {
    applyProUiFromStorage();
  }
});

const autoTrackInput = document.getElementById("pref-auto-track");
const libraryInlayInput = document.getElementById("pref-library-inlay");
const metadataImproveInput = document.getElementById("pref-metadata-improve");
if (autoTrackInput) {
  autoTrackInput.addEventListener("change", () => {
    ext.storage.local.set({ [PREF_AUTO_TRACK_KEY]: autoTrackInput.checked });
  });
}
if (libraryInlayInput) {
  libraryInlayInput.addEventListener("change", () => {
    ext.storage.local.set({ [PREF_LIBRARY_INLAY_KEY]: libraryInlayInput.checked });
  });
}
if (metadataImproveInput) {
  metadataImproveInput.addEventListener("change", () => {
    ext.storage.local.set({
      [PREF_METADATA_IMPROVE_KEY]: metadataImproveInput.checked,
    });
  });
}

// Import button
const importBtn = document.getElementById("popup-import");
if (importBtn) {
  setImportInitial(importBtn);
  importBtn.addEventListener("click", () => {
    runImport(importBtn);
  });
}
