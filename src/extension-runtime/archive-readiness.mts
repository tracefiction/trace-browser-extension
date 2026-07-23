import {
  ArchiveReadinessService,
  type ArchiveReadinessClock,
  type ArchiveRunResult,
} from "../extension-core/index.mjs";
import {
  BrowserArchivePermissionSnapshotPort,
  NativeArchiveReadinessReceiptPort,
} from "./browser-adapters.mjs";
import type {
  PermissionsPort,
  RuntimeMessageSender,
  RuntimePort,
} from "./browser-platform.mjs";
import { archiveHostKindFromSender } from "./archive-sender.mjs";
import type { BrowserArchiveReadinessStatus } from "./archive-readiness-status.mjs";

export const ARCHIVE_READINESS_MESSAGE_TYPES = Object.freeze({
  archiveSeen: "TRACE_ARCHIVE_SEEN",
});

interface ArchiveReadinessEnvironment {
  readonly runtime: RuntimePort;
  readonly permissions?: PermissionsPort;
  readonly storageMode: "callback" | "promise";
  readonly clock?: ArchiveReadinessClock;
  readonly status?: BrowserArchiveReadinessStatus;
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
  readonly #service: ArchiveReadinessService;
  readonly #status: BrowserArchiveReadinessStatus | undefined;

  constructor(environment: ArchiveReadinessEnvironment) {
    this.#status = environment.status;
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
    });
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
    const handoffId = normalizeHandoffId(message.handoffId);
    const result = await this.#service.recordRun({
      hostKind,
      ...(handoffId === null ? {} : { handoffId }),
    });
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
