import {
  AO3_PERMISSION_BUNDLE,
  AO3_PERMISSION_REGISTRATION_SCRIPT_IDS,
  permissionBundleCoverage,
  registeredTraceScripts,
} from "./permission-spike-core.mjs";

const TRACE_PERMISSION_RECONCILE_MESSAGE =
  "TRACE_IOS_PERMISSION_SPIKE_RECONCILE";

const ext = globalThis.browser ?? globalThis.chrome;
const state = {
  before: null,
  after: null,
  requestGranted: null,
  registeredScripts: [],
  nativeAcknowledged: null,
  error: null,
};

function element(id) {
  return document.getElementById(id);
}

function setStatus(kind, message) {
  const status = element("spike-status");
  status.dataset.kind = kind;
  status.textContent = message;
}

function renderEvidence() {
  const currentOrigins = state.after?.origins ?? state.before?.origins ?? [];
  const coverage = permissionBundleCoverage(currentOrigins);
  element("spike-evidence").textContent = JSON.stringify(
    {
      requestedOrigins: AO3_PERMISSION_BUNDLE,
      requestGranted: state.requestGranted,
      before: state.before,
      after: state.after,
      coverage,
      registeredScripts: state.registeredScripts,
      nativeAcknowledged: state.nativeAcknowledged,
      error: state.error,
    },
    null,
    2,
  );
  element("spike-result").textContent = coverage.complete
    ? "Complete AO3 bundle detected"
    : `Missing ${coverage.missing.length} required pattern${coverage.missing.length === 1 ? "" : "s"}`;
  element("spike-result").dataset.complete = String(coverage.complete);
}

async function permissionsSnapshot() {
  if (!ext?.permissions?.getAll) {
    throw new Error("permissions.getAll is unavailable");
  }
  const snapshot = await ext.permissions.getAll();
  return {
    origins: Array.isArray(snapshot?.origins) ? snapshot.origins : [],
    permissions: Array.isArray(snapshot?.permissions)
      ? snapshot.permissions
      : [],
  };
}

async function readRegisteredScripts() {
  if (!ext?.scripting?.getRegisteredContentScripts) return [];
  const scripts = await ext.scripting.getRegisteredContentScripts({
    ids: [...AO3_PERMISSION_REGISTRATION_SCRIPT_IDS],
  });
  return Array.isArray(scripts) ? scripts : [];
}

async function registerTraceScripts() {
  if (!ext?.scripting?.registerContentScripts) {
    throw new Error("scripting.registerContentScripts is unavailable");
  }
  if (ext.scripting.unregisterContentScripts) {
    for (const id of AO3_PERMISSION_REGISTRATION_SCRIPT_IDS) {
      try {
        await ext.scripting.unregisterContentScripts({ ids: [id] });
      } catch {
        // A fresh install can have only a subset of the known IDs.
      }
    }
  }
  await ext.scripting.registerContentScripts(registeredTraceScripts());
  return readRegisteredScripts();
}

async function reconcileThroughBackground() {
  if (!ext?.runtime?.sendMessage) return registerTraceScripts();
  try {
    const response = await ext.runtime.sendMessage({
      type: TRACE_PERMISSION_RECONCILE_MESSAGE,
    });
    if (response?.ok === true) return readRegisteredScripts();
  } catch {
    // Fall through to direct registration if the spike worker was restarted.
  }
  return registerTraceScripts();
}

async function publishNativeSnapshot(origins) {
  if (!ext?.runtime?.sendNativeMessage) return false;
  const message = {
    type: "TRACE_IOS_EXTENSION_HEARTBEAT",
    hostKind: "ao3",
    at: Date.now(),
    permissionSnapshot: true,
    grantedOrigins: origins,
  };
  const attempts = [
    [message],
    ["com.tracefiction.trace", message],
  ];
  for (const args of attempts) {
    try {
      const response = await ext.runtime.sendNativeMessage(...args);
      if (response?.ok === true) return true;
    } catch {
      // Safari and Chromium use different native-message call signatures.
    }
  }
  return false;
}

async function recheck() {
  state.error = null;
  try {
    state.after = await permissionsSnapshot();
    state.registeredScripts = await readRegisteredScripts();
    state.nativeAcknowledged = await publishNativeSnapshot(
      state.after.origins,
    );
    const coverage = permissionBundleCoverage(state.after.origins);
    setStatus(
      coverage.complete ? "success" : "neutral",
      coverage.complete
        ? "Safari currently reports the complete AO3 bundle."
        : "Safari does not currently report the complete AO3 bundle.",
    );
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    setStatus("error", "The permission state could not be read.");
  }
  renderEvidence();
}

async function requestBundle() {
  const button = element("spike-request");
  button.disabled = true;
  state.error = null;
  setStatus("working", "Waiting for Safari’s permission decision…");
  try {
    // Keep the permission request directly inside the click turn. Awaiting any
    // other API first can consume Safari's required user gesture.
    state.requestGranted = await ext.permissions.request({
      origins: [...AO3_PERMISSION_BUNDLE],
    });
    state.after = await permissionsSnapshot();
    const coverage = permissionBundleCoverage(state.after.origins);
    state.registeredScripts = coverage.complete
      ? await reconcileThroughBackground()
      : await readRegisteredScripts();
    state.nativeAcknowledged = await publishNativeSnapshot(
      state.after.origins,
    );
    setStatus(
      state.requestGranted && coverage.complete ? "success" : "error",
      state.requestGranted && coverage.complete
        ? "Pass: Safari granted AO3 and Trace’s real scripts are registered."
        : "Fail: Safari did not return the complete AO3 bundle.",
    );
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    setStatus("error", "The runtime permission request failed.");
  } finally {
    button.disabled = false;
    renderEvidence();
  }
}

element("spike-request").addEventListener("click", () => {
  void requestBundle();
});
element("spike-recheck").addEventListener("click", () => {
  void recheck();
});

void (async () => {
  try {
    state.before = await permissionsSnapshot();
    state.registeredScripts = await readRegisteredScripts();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
  renderEvidence();
})();
