import type { ArchiveHostKind } from "../extension-core/index.mjs";
import type { BrowserStorage } from "./browser-platform.mjs";

export const ARCHIVE_READINESS_STATUS_KEY = "traceArchiveReadiness" as const;
export const ARCHIVE_READINESS_ERROR_RECENT_MS = 24 * 60 * 60 * 1_000;

export type ArchiveActionKind =
  | "track"
  | "quick_add"
  | "import"
  | "metadata";

export type ArchiveErrorKind =
  | "permission"
  | "unsupported_page"
  | "auth"
  | "parser"
  | "network"
  | "unknown";

export interface ArchiveReadinessEvent {
  readonly hostKind: ArchiveHostKind | "unknown";
  readonly seen?: boolean;
  readonly actionKind?: ArchiveActionKind;
  readonly errorKind?: ArchiveErrorKind;
}

export interface PublicArchiveReadiness {
  readonly lastArchiveSeenAt?: number;
  readonly lastArchiveHostKind?: ArchiveHostKind | "unknown";
  readonly lastArchiveActionAt?: number;
  readonly lastArchiveActionKind?: ArchiveActionKind;
  readonly lastArchiveErrorKind?: ArchiveErrorKind;
}

interface StoredArchiveReadiness extends PublicArchiveReadiness {
  readonly lastArchiveErrorAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function epochMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function hostKind(value: unknown): ArchiveHostKind | "unknown" | null {
  return value === "ao3" || value === "ffn" || value === "unknown" ? value : null;
}

function actionKind(value: unknown): ArchiveActionKind | null {
  return value === "track" ||
    value === "quick_add" ||
    value === "import" ||
    value === "metadata"
    ? value
    : null;
}

function errorKind(value: unknown): ArchiveErrorKind | null {
  return value === "permission" ||
    value === "unsupported_page" ||
    value === "auth" ||
    value === "parser" ||
    value === "network" ||
    value === "unknown"
    ? value
    : null;
}

function storedReadiness(value: unknown): StoredArchiveReadiness {
  if (!isRecord(value)) return Object.freeze({});
  const seenAt = epochMillis(value.lastArchiveSeenAt);
  const seenHost = hostKind(value.lastArchiveHostKind);
  const actionAt = epochMillis(value.lastArchiveActionAt);
  const action = actionKind(value.lastArchiveActionKind);
  const errorAt = epochMillis(value.lastArchiveErrorAt);
  const error = errorKind(value.lastArchiveErrorKind);
  return Object.freeze({
    ...(seenAt === null ? {} : { lastArchiveSeenAt: seenAt }),
    ...(seenHost === null ? {} : { lastArchiveHostKind: seenHost }),
    ...(actionAt === null ? {} : { lastArchiveActionAt: actionAt }),
    ...(action === null ? {} : { lastArchiveActionKind: action }),
    ...(errorAt === null ? {} : { lastArchiveErrorAt: errorAt }),
    ...(error === null ? {} : { lastArchiveErrorKind: error }),
  });
}

export class BrowserArchiveReadinessStatus {
  readonly #storage: BrowserStorage;
  readonly #clock: { now(): number };
  #tail: Promise<void> = Promise.resolve();

  constructor(
    storage: BrowserStorage,
    clock: { now(): number } = { now: () => Date.now() },
  ) {
    this.#storage = storage;
    this.#clock = clock;
  }

  record(event: ArchiveReadinessEvent): Promise<void> {
    return this.#withLock(async () => {
      const at = Math.max(0, Math.trunc(this.#clock.now()));
      const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
      const previous = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
      const next: Record<string, unknown> = { ...previous };
      if (event.seen !== false) {
        next.lastArchiveSeenAt = at;
        next.lastArchiveHostKind = event.hostKind;
      }
      if (event.actionKind !== undefined) {
        next.lastArchiveActionAt = at;
        next.lastArchiveActionKind = event.actionKind;
        delete next.lastArchiveErrorAt;
        delete next.lastArchiveErrorKind;
      }
      if (event.errorKind !== undefined) {
        next.lastArchiveErrorAt = at;
        next.lastArchiveErrorKind = event.errorKind;
      }
      await this.#storage.set({
        [ARCHIVE_READINESS_STATUS_KEY]: Object.freeze(next),
      });
    });
  }

  read(): Promise<PublicArchiveReadiness> {
    return this.#withLock(async () => {
      const values = await this.#storage.get(ARCHIVE_READINESS_STATUS_KEY);
      const stored = storedReadiness(values[ARCHIVE_READINESS_STATUS_KEY]);
      const {
        lastArchiveErrorAt,
        lastArchiveErrorKind,
        ...publicFields
      } = stored;
      const errorIsRecent =
        lastArchiveErrorAt !== undefined &&
        lastArchiveErrorKind !== undefined &&
        this.#clock.now() - lastArchiveErrorAt <= ARCHIVE_READINESS_ERROR_RECENT_MS;
      return Object.freeze({
        ...publicFields,
        ...(errorIsRecent ? { lastArchiveErrorKind } : {}),
      });
    });
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
