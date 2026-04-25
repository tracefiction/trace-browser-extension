const ext = typeof browser !== "undefined" ? browser : chrome;
const STATUS_KEY = "traceAuthState";
const PREF_AUTO_TRACK_KEY = "prefAutoTrackEnabled";
const PREF_LIBRARY_INLAY_KEY = "prefLibraryInlayEnabled";
const PREF_METADATA_IMPROVE_KEY = "prefMetadataImproveEnabled";
const TRACE_USER_PRO_KEY = "traceUserPro";

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
    ? "Open tracefiction.com in Safari and sign in with your Trace account, then try again. If you are already signed in there, Safari may still be blocking the extension: tap aA or … → Manage Extensions → Trace, and Allow on tracefiction.com, archiveofourown.org, and fanfiction.net when each site asks."
    : "Open Trace and sign in once to connect the extension. Then refresh an AO3 or FFN tab to see your library status and keep progress synced.",
  helpUrl: isLikelyIosExtensionUi
    ? "https://tracefiction.com/apps#safari-ios-setup"
    : "https://tracefiction.com/apps",
};

function statusHeading(state) {
  switch (state) {
    case "connected":
      return "Connected";
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

function ctaLabel(state) {
  switch (state) {
    case "connected":
      return "Extension help & FAQ";
    case "upgrade_required":
      return "Open Trace to upgrade";
    case "reconnect_required":
      return "Open Trace to reconnect";
    case "error":
      return "Open Trace for help";
    case "signed_out":
      return "Open Trace to connect";
    default:
      return "Open Trace";
  }
}

function renderStatus(status) {
  const next = status || fallbackStatus;
  const statusEl = document.getElementById("popup-status");
  const leadEl = document.getElementById("popup-lead");
  const ctaEl = document.getElementById("popup-cta");
  const st = next.state || fallbackStatus.state;

  if (statusEl) {
    statusEl.dataset.state = st;
    statusEl.textContent = statusHeading(st);
  }

  if (leadEl) {
    leadEl.textContent = next.message || fallbackStatus.message;
  }

  if (ctaEl && next.helpUrl) {
    ctaEl.href = next.helpUrl;
    ctaEl.textContent = ctaLabel(st);
  }
}

function applyProUi(pro, autoTrack, libraryInlay, metadataImprove) {
  const section = document.getElementById("popup-pro-settings");
  const autoEl = document.getElementById("pref-auto-track");
  const inlayEl = document.getElementById("pref-library-inlay");
  const metadataEl = document.getElementById("pref-metadata-improve");
  if (!section || !autoEl || !inlayEl || !metadataEl) return;
  section.classList.remove("hidden");
  autoEl.checked = Boolean(autoTrack);
  inlayEl.checked = Boolean(libraryInlay);
  metadataEl.checked = metadataImprove !== false;
}

function fetchPopupProState() {
  ext.runtime.sendMessage({ type: "TRACE_POPUP_GET_STATE" }, (s) => {
    if (ext.runtime.lastError || !s) return;
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
  ext.storage.local.get(STATUS_KEY, (result) => {
    renderStatus(result?.[STATUS_KEY] || fallbackStatus);
  });
}

readAndRender();

try {
  ext.runtime.sendMessage({ type: "TRACE_POPUP_OPEN" }, () => {
    if (ext.runtime.lastError) {
      /* ignore */
    }
    readAndRender();
    fetchPopupProState();
  });
} catch {
  /* ignore */
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY]) {
    renderStatus(changes[STATUS_KEY].newValue || fallbackStatus);
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
  importBtn.addEventListener("click", () => {
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";

    ext.runtime.sendMessage({ type: "TRACE_IMPORT_TRIGGER" }, (res) => {
      if (res?.ok) {
        importBtn.textContent = "Opened import tab";
        importBtn.title = "";
        setTimeout(() => window.close(), 600);
      } else {
        importBtn.textContent = "Import failed — try again";
        importBtn.title =
          res?.error ||
          "Open an AO3 or FanFiction.net tab and refresh it after updating the extension.";
        importBtn.disabled = false;
      }
    });
  });
}
