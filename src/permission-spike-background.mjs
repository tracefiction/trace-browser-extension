import {
  AO3_PERMISSION_REGISTRATION_SCRIPT_IDS,
  permissionBundleCoverage,
  registeredTraceScripts,
} from "../Shared (Extension)/Resources/permission-spike-core.mjs";

export const TRACE_PERMISSION_RECONCILE_MESSAGE =
  "TRACE_IOS_PERMISSION_SPIKE_RECONCILE";

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
    (message, _sender, sendResponse) => {
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
