import {
  ArchiveReadinessService,
  type ArchiveAccessLedger,
  type ArchiveAccessLedgerPort,
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
/**
 * The rest of the access ledger: whether the grant has ever been seen, a
 * fingerprint of the reading last delivered, and the delivery back-off.
 */
export const ARCHIVE_ACCESS_STATE_KEY = "traceArchiveAccessStateV1";
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
  readonly accessLedger?: ArchiveAccessLedgerPort;
}

interface ArchiveAccessReportEnvironment {
  readonly runtime: RuntimePort;
  readonly permissions?: PermissionsPort;
  readonly alarms?: AlarmsPort;
  readonly accessLedger: ArchiveAccessLedgerPort;
  readonly storageMode: "callback" | "promise";
  readonly clock?: ArchiveReadinessClock;
  /** Defaults to this context's `navigator`. */
  readonly platform?: { readonly userAgent?: string };
}

/** The access ledger in extension storage. It holds no origins and no account. */
export class BrowserArchiveAccessLedger implements ArchiveAccessLedgerPort {
  readonly #storage: BrowserStorage;

  constructor(storage: BrowserStorage) {
    this.#storage = storage;
  }

  async read(): Promise<ArchiveAccessLedger> {
    const stored = await this.#storage.get([
      ARCHIVE_ACCESS_REPORTED_AT_KEY,
      ARCHIVE_ACCESS_STATE_KEY,
    ]);
    const deliveredAt = stored[ARCHIVE_ACCESS_REPORTED_AT_KEY];
    const state = isRecord(stored[ARCHIVE_ACCESS_STATE_KEY])
      ? stored[ARCHIVE_ACCESS_STATE_KEY]
      : {};
    const time = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0;
    return Object.freeze({
      grantSeen: state.grantSeen === true,
      ...(time(deliveredAt) ? { deliveredAt } : {}),
      ...(typeof state.delivered === "string" ? { delivered: state.delivered.slice(0, 64) } : {}),
      ...(Number.isInteger(state.failures) && (state.failures as number) > 0
        ? { failures: state.failures as number }
        : {}),
      ...(time(state.retryAt) ? { retryAt: state.retryAt } : {}),
    });
  }

  async write(ledger: ArchiveAccessLedger): Promise<void> {
    await this.#storage.set({
      ...(ledger.deliveredAt === undefined
        ? {}
        : { [ARCHIVE_ACCESS_REPORTED_AT_KEY]: ledger.deliveredAt }),
      [ARCHIVE_ACCESS_STATE_KEY]: {
        grantSeen: ledger.grantSeen,
        ...(ledger.delivered === undefined ? {} : { delivered: ledger.delivered }),
        ...(ledger.failures === undefined ? {} : { failures: ledger.failures }),
        ...(ledger.retryAt === undefined ? {} : { retryAt: ledger.retryAt }),
      },
    });
  }
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
      ...(environment.accessLedger === undefined
        ? {}
        : { accessLedger: environment.accessLedger }),
    });
  }

  /** See `ArchiveReadinessService.reportAccess`. */
  reportAccess(options: { readonly readerPresent?: boolean } = {}): Promise<ArchiveAccessReportResult> {
    return this.#service.reportAccess(options);
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

/**
 * Whether this background runs beside the Trace app on iPhone or iPad:
 * `true` or `false` when the user agent settles it, otherwise a promise,
 * because an iPad can present itself as a Mac.
 */
function runsBesideTraceApp(
  runtime: RuntimePort,
  mode: "callback" | "promise",
  userAgent: string,
): boolean | Promise<boolean> {
  if (typeof runtime.sendNativeMessage !== "function") return false;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  if (!/Macintosh/i.test(userAgent) || typeof runtime.getPlatformInfo !== "function") {
    return false;
  }
  return extensionCall<{ readonly os?: string }>(
    runtime as unknown as Record<string, (...args: unknown[]) => unknown>,
    "getPlatformInfo",
    [],
    runtime,
    mode,
  ).then((info) => info?.os === "ios", () => false);
}

/**
 * Tells the Trace app what story-site access Safari grants, at moments when
 * no page script can: when the popup opens, when the grant changes, and about
 * once a day. The app already reads these snapshots; without one taken after
 * access ends it cannot tell a reader whose one-day grant ran out from one
 * who simply has not opened a story.
 *
 * iPhone and iPad only. Where the platform is known not to be one, nothing is
 * installed. Where it is not known yet (an iPad can call itself a Mac), the
 * listeners are registered at once, so an event that woke the background is
 * not missed, and each decides when it runs; a Mac then sends nothing and
 * gets no alarm. It adds no permission and sends nothing to a server.
 */
export function installArchiveAccessReport(
  controller: ArchiveReadinessRuntimeController,
  environment: ArchiveAccessReportEnvironment,
): { report(): Promise<ArchiveAccessReportResult> } {
  const { accessLedger, alarms, permissions, runtime, storageMode } = environment;
  const now = (): number => environment.clock?.now() ?? Date.now();
  const beside = runsBesideTraceApp(
    runtime,
    storageMode,
    environment.platform?.userAgent ?? globalThis.navigator?.userAgent ?? "",
  );
  if (beside === false) return { report: async () => ({ kind: "unknown" }) };
  const supported = Promise.resolve(beside);
  const report = async (
    options: { readonly readerPresent?: boolean } = {},
  ): Promise<ArchiveAccessReportResult> =>
    (await supported) ? controller.reportAccess(options) : { kind: "unknown" };
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
    // Keep the background alive until the reading has been delivered. An
    // open popup means the reader is here, so a delivery back-off is skipped.
    void report({ readerPresent: true }).then(
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

  void supported.then(async (yes) => {
    if (!yes) return;
    // An existing alarm keeps its schedule; creating it again would push the
    // next reading a full day past every background start.
    const existing = typeof alarms?.get === "function"
      ? await extensionCall<unknown>(
          alarms as unknown as Record<string, (...args: unknown[]) => unknown>,
          "get",
          [ARCHIVE_ACCESS_REPORT_ALARM],
          runtime,
          storageMode,
        ).catch(() => undefined)
      : undefined;
    if (!isRecord(existing)) {
      try {
        const created = alarms?.create?.(ARCHIVE_ACCESS_REPORT_ALARM, {
          periodInMinutes: ARCHIVE_ACCESS_REPORT_PERIOD_MINUTES,
        });
        if (created && typeof (created as PromiseLike<unknown>).then === "function") {
          await Promise.resolve(created).catch(() => undefined);
        }
      } catch {
        void runtime.lastError;
      }
    }
    // Safari may not wake a sleeping background for an alarm. Whatever starts
    // it next takes the overdue reading.
    const ledger = await accessLedger.read().catch(() => null);
    if (ledger === null) return;
    const deliveredAt = ledger.deliveredAt;
    if (
      typeof deliveredAt === "number" &&
      deliveredAt <= now() &&
      now() - deliveredAt < ARCHIVE_ACCESS_REPORT_STALE_MS
    ) {
      return;
    }
    reportQuietly();
  }).catch(() => undefined);
  return { report };
}
