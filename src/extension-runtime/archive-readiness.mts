import {
  ArchiveReadinessService,
  type ArchiveAccessReportResult,
  type ArchiveReadinessClock,
  type ArchiveRunResult,
} from "../extension-core/index.mjs";
import {
  ARCHIVE_ACCESS_REPORT_ALARM,
  BrowserArchivePermissionSnapshotPort,
  NativeArchiveReadinessReceiptPort,
} from "./browser-adapters.mjs";
import {
  extensionCall,
  type AlarmsPort,
  type BrowserStorage,
  type PermissionsPort,
  type RuntimeMessageSender,
  type RuntimePort,
} from "./browser-platform.mjs";
import { archiveHostKindFromSender } from "./archive-sender.mjs";
import type { BrowserArchiveReadinessStatus } from "./archive-readiness-status.mjs";
import { isPopupSender } from "./first-story-initiation.mjs";

export const ARCHIVE_READINESS_MESSAGE_TYPES = Object.freeze({
  archiveSeen: "TRACE_ARCHIVE_SEEN",
  accessReport: "TRACE_ARCHIVE_ACCESS_REPORT",
});

/** When the last access reading reached the Trace app (epoch milliseconds). */
export const ARCHIVE_ACCESS_REPORTED_AT_KEY = "traceArchiveAccessReportedAtV1";
export const ARCHIVE_ACCESS_REPORT_PERIOD_MINUTES = 24 * 60;
/** A background that starts this long after the last reading takes another. */
export const ARCHIVE_ACCESS_REPORT_STALE_MS = 20 * 60 * 60 * 1_000;

interface ArchiveReadinessEnvironment {
  readonly runtime: RuntimePort;
  readonly permissions?: PermissionsPort;
  readonly storageMode: "callback" | "promise";
  readonly clock?: ArchiveReadinessClock;
  readonly status?: BrowserArchiveReadinessStatus;
  readonly publishTrackingPreference?: () => Promise<void>;
  /** The origins automatic saving needs. Access readings need them. */
  readonly requiredOrigins?: readonly string[];
  readonly accessConfirmWait?: (ms: number) => Promise<void>;
}

interface ArchiveAccessReportEnvironment {
  readonly runtime: RuntimePort;
  readonly permissions?: PermissionsPort;
  readonly alarms?: AlarmsPort;
  readonly storage: BrowserStorage;
  readonly storageMode: "callback" | "promise";
  readonly clock?: ArchiveReadinessClock;
}

interface ArchiveReadinessResponse {
  readonly ok: true;
  readonly receipt: ArchiveRunResult["kind"] | "ignored";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHandoffId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export class ArchiveReadinessRuntimeController {
  readonly #publishTrackingPreference: (() => Promise<void>) | undefined;
  readonly #service: ArchiveReadinessService;
  readonly #status: BrowserArchiveReadinessStatus | undefined;

  constructor(environment: ArchiveReadinessEnvironment) {
    this.#status = environment.status;
    this.#publishTrackingPreference = environment.publishTrackingPreference;
    this.#service = new ArchiveReadinessService({
      receipts: new NativeArchiveReadinessReceiptPort(
        environment.runtime,
        environment.storageMode,
      ),
      permissions: new BrowserArchivePermissionSnapshotPort(
        environment.permissions,
        environment.runtime,
        environment.storageMode,
      ),
      ...(environment.clock === undefined ? {} : { clock: environment.clock }),
      ...(environment.requiredOrigins === undefined
        ? {}
        : { requiredOrigins: environment.requiredOrigins }),
      ...(environment.accessConfirmWait === undefined
        ? {}
        : { wait: environment.accessConfirmWait }),
    });
  }

  /** See `ArchiveReadinessService.reportAccess`. */
  reportAccess(): Promise<ArchiveAccessReportResult> {
    return this.#service.reportAccess();
  }

  async handle(
    message: unknown,
    sender?: RuntimeMessageSender,
  ): Promise<ArchiveReadinessResponse | null> {
    if (
      !isRecord(message) ||
      message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen
    ) {
      return null;
    }
    const hostKind = archiveHostKindFromSender(sender);
    if (hostKind === null) return { ok: true, receipt: "ignored" };
    void this.#status?.record({ hostKind }).catch(() => {
      // Web onboarding evidence is best effort and cannot delay or replace the
      // native run receipt used by the iOS permission flow.
    });
    const preference = this.#publishTrackingPreference?.().catch(() => {});
    const handoffId = normalizeHandoffId(message.handoffId);
    const result = await this.#service.recordRun({
      hostKind,
      ...(handoffId === null ? {} : { handoffId }),
    });
    await preference; // Keep the worker alive, after the run receipt is delivered.
    return { ok: true, receipt: result.kind };
  }
}

export function installArchiveReadinessRuntime(
  environment: ArchiveReadinessEnvironment,
): ArchiveReadinessRuntimeController {
  const controller = new ArchiveReadinessRuntimeController(environment);
  environment.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      !isRecord(message) ||
      message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.archiveSeen
    ) {
      return false;
    }
    void controller.handle(message, sender).then(
      (response) => sendResponse(response),
      () => sendResponse({ ok: true, receipt: "unavailable" }),
    );
    // Keep a cold MV3 worker alive until the narrow native receipt attempt
    // completes. Permission snapshots continue independently and are optional.
    return true;
  });
  return controller;
}

async function runsInsideTraceApp(
  runtime: RuntimePort,
  mode: "callback" | "promise",
): Promise<boolean> {
  if (typeof runtime.sendNativeMessage !== "function") return false;
  if (/iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "")) return true;
  if (typeof runtime.getPlatformInfo !== "function") return false;
  try {
    const info = await extensionCall<{ readonly os?: string }>(
      runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
      "getPlatformInfo",
      [],
      runtime,
      mode,
    );
    return info?.os === "ios";
  } catch {
    return false;
  }
}

/**
 * Tells the Trace app what story-site access Safari grants, at moments when
 * no page script can: when the popup opens, when the grant changes, and about
 * once a day. The app already reads these snapshots; without one taken after
 * access ends it cannot tell a reader whose one-day grant ran out from one
 * who simply has not opened a story.
 *
 * iPhone and iPad only. It adds no permission and sends nothing to a server.
 */
export function installArchiveAccessReport(
  controller: ArchiveReadinessRuntimeController,
  environment: ArchiveAccessReportEnvironment,
): { report(): Promise<ArchiveAccessReportResult> } {
  const { alarms, permissions, runtime, storage, storageMode } = environment;
  const now = (): number => environment.clock?.now() ?? Date.now();
  let supported: Promise<boolean> | null = null;
  const report = async (): Promise<ArchiveAccessReportResult> => {
    supported ??= runsInsideTraceApp(runtime, storageMode);
    if (!(await supported)) return { kind: "unknown" };
    const result = await controller.reportAccess();
    if (result.kind === "published") {
      await storage
        .set({ [ARCHIVE_ACCESS_REPORTED_AT_KEY]: now() })
        .catch(() => undefined);
    }
    return result;
  };
  const reportQuietly = (): void => {
    void report().catch(() => undefined);
  };

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      !isRecord(message) ||
      message.type !== ARCHIVE_READINESS_MESSAGE_TYPES.accessReport
    ) {
      return false;
    }
    if (Object.keys(message).length !== 1 || !isPopupSender(sender, runtime.id)) {
      sendResponse({ ok: false });
      return false;
    }
    // Keep the background alive until the reading has been delivered.
    void report().then(
      (result) => sendResponse({ ok: true, report: result.kind }),
      () => sendResponse({ ok: true, report: "unavailable" }),
    );
    return true;
  });
  permissions?.onAdded?.addListener(reportQuietly);
  permissions?.onRemoved?.addListener(reportQuietly);
  alarms?.onAlarm?.addListener((alarm) => {
    if (alarm?.name === ARCHIVE_ACCESS_REPORT_ALARM) reportQuietly();
  });
  try {
    // An existing alarm keeps its schedule; creating it again would push the
    // next reading a full day past every background start.
    const existing = typeof alarms?.get === "function"
      ? extensionCall<unknown>(
          alarms as unknown as Record<string, (...args: unknown[]) => unknown>,
          "get",
          [ARCHIVE_ACCESS_REPORT_ALARM],
          runtime,
          storageMode,
        ).catch(() => undefined)
      : Promise.resolve(undefined);
    void existing.then((alarm) => {
      if (isRecord(alarm)) return;
      const created = alarms?.create?.(ARCHIVE_ACCESS_REPORT_ALARM, {
        periodInMinutes: ARCHIVE_ACCESS_REPORT_PERIOD_MINUTES,
      });
      if (created && typeof (created as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(created).catch(() => undefined);
      }
    }).catch(() => {
      void runtime.lastError;
    });
  } catch {
    void runtime.lastError;
  }
  // Safari may not wake a sleeping background for an alarm. Whatever starts
  // it next takes the overdue reading.
  void storage.get(ARCHIVE_ACCESS_REPORTED_AT_KEY).then((stored) => {
    const reportedAt = stored[ARCHIVE_ACCESS_REPORTED_AT_KEY];
    if (
      typeof reportedAt === "number" &&
      reportedAt <= now() &&
      now() - reportedAt < ARCHIVE_ACCESS_REPORT_STALE_MS
    ) {
      return;
    }
    reportQuietly();
  }).catch(() => undefined);
  return { report };
}
