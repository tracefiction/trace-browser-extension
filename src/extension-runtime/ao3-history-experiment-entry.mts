/**
 * The background of the AO3 History experiment build only: the ordinary
 * background (index.mts), then the experiment. scripts/build.mjs bundles this
 * file instead of index.mts when TRACE_AO3_HISTORY_EXPERIMENT=1, so no other
 * build contains any of the experiment.
 */

import "./index.mjs";
import { installAo3HistoryExperiment } from "./ao3-history-experiment.mjs";
import type { AlarmsPort, PermissionsPort, RuntimePort, ScriptingPort, StorageArea, TabsPort } from "./browser-platform.mjs";
import { storySaveActivity } from "./story-save-activity.mjs";

declare const __TRACE_SESSION_MODE__: string;

interface ExperimentGlobal {
  readonly browser?: ExperimentApi;
  readonly chrome?: ExperimentApi;
  __traceAo3HistoryExperimentBootFailed?: true;
}

interface ExperimentApi {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly alarms: AlarmsPort;
  readonly storage: { readonly local: StorageArea };
  readonly permissions?: PermissionsPort;
  readonly scripting?: ScriptingPort;
}

const experimentScope = globalThis as unknown as ExperimentGlobal;

try {
  const extension = experimentScope.browser ?? experimentScope.chrome;
  if (extension && __TRACE_SESSION_MODE__ === "kernel") {
    installAo3HistoryExperiment({
      runtime: extension.runtime,
      tabs: extension.tabs,
      ...(extension.scripting === undefined ? {} : { scripting: extension.scripting }),
      ...(extension.permissions === undefined ? {} : { permissions: extension.permissions }),
      alarms: extension.alarms,
      storageArea: extension.storage.local,
      storageMode: experimentScope.browser ? "promise" : "callback",
      // Requests to AO3 itself, never to Trace.
      fetch: globalThis.fetch.bind(globalThis),
      saveActivity: storySaveActivity,
    });
  }
} catch {
  experimentScope.__traceAo3HistoryExperimentBootFailed = true;
}
