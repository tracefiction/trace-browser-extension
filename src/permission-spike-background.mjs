import {
  AO3_PERMISSION_BUNDLE,
  AO3_PERMISSION_REGISTRATION_SCRIPT_IDS,
  permissionBundleCoverage,
  registeredTraceScripts,
} from "../Shared (Extension)/Resources/permission-spike-core.mjs";

export const TRACE_PERMISSION_RECONCILE_MESSAGE =
  "TRACE_IOS_PERMISSION_SPIKE_RECONCILE";
export const TRACE_AO3_PERMISSION_REQUEST_MESSAGE =
  "TRACE_AO3_PERMISSION_REQUEST";

const EMPTY_PERMISSION_RESULT = Object.freeze({
  ok: false,
  requestAttempted: false,
  granted: false,
  coverageComplete: false,
  missingCount: AO3_PERMISSION_BUNDLE.length,
  scriptsRegistered: false,
});

function senderOrigin(sender) {
  const value = sender?.url ?? sender?.tab?.url;
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function unregisterKnownScripts(extensionApi) {
  if (!extensionApi?.scripting?.unregisterContentScripts) return;
  for (const id of AO3_PERMISSION_REGISTRATION_SCRIPT_IDS) {
    try {
      await extensionApi.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      // Fresh installs and updates can have only a subset of the known IDs.
    }
  }
}

export async function reconcileTraceAo3Scripts(extensionApi) {
  if (!extensionApi?.permissions?.getAll) {
    throw new Error("permissions.getAll is unavailable");
  }
  if (!extensionApi?.scripting?.registerContentScripts) {
    throw new Error("scripting.registerContentScripts is unavailable");
  }

  const snapshot = await extensionApi.permissions.getAll();
  const origins = Array.isArray(snapshot?.origins) ? snapshot.origins : [];
  const coverage = permissionBundleCoverage(origins);

  await unregisterKnownScripts(extensionApi);
  if (!coverage.complete) {
    return {
      ok: true,
      coverage,
      registeredScriptIds: [],
    };
  }

  const scripts = registeredTraceScripts();
  await extensionApi.scripting.registerContentScripts(scripts);
  return {
    ok: true,
    coverage,
    registeredScriptIds: scripts.map((script) => script.id),
  };
}

export async function requestTraceAo3Permission(
  extensionApi,
  sender,
  allowedWebOrigin,
  reconcile = () => reconcileTraceAo3Scripts(extensionApi),
) {
  if (
    typeof allowedWebOrigin !== "string" ||
    senderOrigin(sender) !== allowedWebOrigin
  ) {
    return { ...EMPTY_PERMISSION_RESULT, outcome: "untrusted_sender" };
  }
  if (!extensionApi?.permissions?.request) {
    return { ...EMPTY_PERMISSION_RESULT, outcome: "unsupported" };
  }

  let granted = false;
  try {
    granted =
      (await extensionApi.permissions.request({
        origins: [...AO3_PERMISSION_BUNDLE],
      })) === true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_PERMISSION_RESULT,
      outcome: /gesture|user activation|must be called/i.test(message)
        ? "gesture_required"
        : "error",
      requestAttempted: true,
    };
  }

  let reconciliation;
  try {
    reconciliation = await reconcile();
  } catch {
    return {
      ...EMPTY_PERMISSION_RESULT,
      outcome: "error",
      requestAttempted: true,
      granted,
    };
  }

  const coverageComplete = reconciliation.coverage.complete === true;
  const scriptsRegistered =
    coverageComplete && reconciliation.registeredScriptIds.length > 0;
  return {
    ok: coverageComplete && scriptsRegistered,
    outcome: coverageComplete
      ? "granted_complete"
      : granted
        ? "granted_incomplete"
        : "denied",
    requestAttempted: true,
    granted,
    coverageComplete,
    missingCount: reconciliation.coverage.missing.length,
    scriptsRegistered,
  };
}

export function installPermissionSpikeBackground(extensionApi) {
  if (!extensionApi?.runtime) return;

  let pending = Promise.resolve();
  const scheduleReconciliation = () => {
    pending = pending
      .catch(() => undefined)
      .then(() => reconcileTraceAo3Scripts(extensionApi));
    return pending;
  };

  extensionApi.runtime.onInstalled?.addListener?.(() => {
    void scheduleReconciliation();
  });
  extensionApi.runtime.onStartup?.addListener?.(() => {
    void scheduleReconciliation();
  });
  extensionApi.permissions?.onAdded?.addListener?.(() => {
    void scheduleReconciliation();
  });
  extensionApi.permissions?.onRemoved?.addListener?.(() => {
    void scheduleReconciliation();
  });
  extensionApi.runtime.onMessage?.addListener?.(
    (message, sender, sendResponse) => {
      if (message?.type === TRACE_AO3_PERMISSION_REQUEST_MESSAGE) {
        if (
          message.protocolVersion !== 1 ||
          typeof message.requestId !== "string" ||
          !message.requestId.trim() ||
          message.requestId.length > 128
        ) {
          return undefined;
        }
        requestTraceAo3Permission(
          extensionApi,
          sender,
          globalThis.TRACE_PERMISSION_WEB_ORIGIN,
          scheduleReconciliation,
        ).then(
          (result) => sendResponse({
            protocolVersion: 1,
            requestId: message.requestId,
            ...result,
          }),
          () =>
            sendResponse({
              protocolVersion: 1,
              requestId: message.requestId,
              ...EMPTY_PERMISSION_RESULT,
              outcome: "error",
              requestAttempted: true,
            }),
        );
        return true;
      }
      if (message?.type !== TRACE_PERMISSION_RECONCILE_MESSAGE) return undefined;
      scheduleReconciliation().then(
        (result) => sendResponse(result),
        (error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return true;
    },
  );

  void scheduleReconciliation();
}

installPermissionSpikeBackground(globalThis.browser ?? globalThis.chrome);
