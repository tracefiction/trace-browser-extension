import type {
  AccountDataV1,
  LibraryOverlayEntry,
} from "./account-data.mjs";
import {
  sameAccountScope,
  type AccountScope,
} from "./session-model.mjs";
import type {
  AuthenticatedEffectResult,
  AuthenticatedExecutionResult,
} from "./session-service.mjs";
import type { StoryHostKind } from "./story-command.mjs";

export type CanonicalReaderStatus =
  | "SAVED"
  | "READING"
  | "CAUGHT_UP"
  | "PAUSED"
  | "FINISHED"
  | "DROPPED";

export interface ChapterProgressPatch {
  readonly unit: "CHAPTER";
  readonly value: number;
  readonly total: number | null;
}

export interface LibraryEntryPatch {
  readonly status?: CanonicalReaderStatus;
  readonly progress?: ChapterProgressPatch;
  readonly rating?: number;
  readonly story_snapshot?: Readonly<{
    readonly work_status_override?:
      | "wip"
      | "complete"
      | "hiatus"
      | "abandoned"
      | null;
  }>;
}

export type LibraryMutationCommand =
  | Readonly<{
      kind: "entry_patch";
      hostKind: StoryHostKind;
      workKey: string;
      entryId: string;
      patch: LibraryEntryPatch;
    }>
  | Readonly<{
      kind: "work_preference";
      hostKind: StoryHostKind;
      workKey: string;
      hidden: boolean;
    }>;

export interface FinishQualificationCommand {
  readonly kind: "finish_qualification";
  readonly hostKind: StoryHostKind;
  readonly workKey: string;
  readonly entryId: string;
  readonly source: StoryHostKind;
  readonly chapter: number;
  readonly total: number;
  readonly state: "open" | "resolved";
  readonly workStatus?: "complete" | "wip" | "hiatus" | "abandoned";
  readonly readerStatus?: CanonicalReaderStatus;
}

export type LibraryCommandFailure =
  | "not_authenticated"
  | "auth_expired"
  | "free_limit_reached"
  | "rate_limited"
  | "invalid_request"
  | "invalid_response"
  | "confirmation_missing"
  | "unavailable"
  | "stale";

export type LibraryMutationResult =
  | Readonly<{
      kind: "confirmed";
      commandKind: LibraryMutationCommand["kind"];
      workKey: string;
      entryId?: string;
      entry?: LibraryOverlayEntry;
      source: "preflight" | "mutation" | "reconciliation";
    }>
  | Readonly<{ kind: "failed"; reason: LibraryCommandFailure }>;

export type FinishQualificationResult =
  | Readonly<{
      kind: "acknowledged";
      state: "open" | "resolved" | "ignored";
      eventId: string | null;
    }>
  | Readonly<{ kind: "failed"; reason: LibraryCommandFailure }>;

export type LibraryMutationOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "free_limit_reached"
        | "rate_limited"
        | "invalid_request";
    }>
  | Readonly<{ kind: "uncertain" }>;

export type FinishQualificationOutcome =
  | Readonly<{
      kind: "acknowledged";
      state: "open" | "resolved" | "ignored";
      eventId: string | null;
    }>
  | Readonly<{
      kind: "rejected";
      reason: "rate_limited" | "invalid_request";
    }>
  | Readonly<{ kind: "uncertain" }>;

export interface LibraryCommandApiPort {
  mutate(
    credential: string,
    command: LibraryMutationCommand,
  ): Promise<AuthenticatedEffectResult<LibraryMutationOutcome>>;
  qualifyFinish(
    credential: string,
    command: FinishQualificationCommand,
  ): Promise<AuthenticatedEffectResult<FinishQualificationOutcome>>;
}

export interface AuthenticatedLibraryCommandPort {
  publicationScope(): AccountScope | null;
  executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>>;
}

export type LibraryProjectionReadResult =
  | Readonly<{ kind: "value"; value: AccountDataV1 }>
  | Readonly<{
      kind: "not_authenticated" | "auth_expired" | "stale" | "unavailable";
    }>;

export interface LibraryCommandProjectionPort {
  refreshAndRead(): Promise<LibraryProjectionReadResult>;
}

interface LibraryCommandPorts {
  readonly session: AuthenticatedLibraryCommandPort;
  readonly api: LibraryCommandApiPort;
  readonly projection: LibraryCommandProjectionPort;
}

function failed(reason: LibraryCommandFailure): Readonly<{
  kind: "failed";
  reason: LibraryCommandFailure;
}> {
  return Object.freeze({ kind: "failed", reason });
}

function executionFailure<T>(
  result: Exclude<AuthenticatedExecutionResult<T>, { readonly kind: "published" }>,
): Readonly<{ kind: "failed"; reason: LibraryCommandFailure }> {
  if (result.kind === "stale") return failed("stale");
  if (result.kind === "auth_rejected") return failed("auth_expired");
  return failed("not_authenticated");
}

function projectionFailure(
  result: Exclude<LibraryProjectionReadResult, { readonly kind: "value" }>,
): Readonly<{ kind: "failed"; reason: LibraryCommandFailure }> {
  return failed(result.kind);
}

function canonicalReaderStatus(entry: LibraryOverlayEntry): CanonicalReaderStatus | null {
  if (entry.canonicalReaderStatus !== undefined) {
    return entry.canonicalReaderStatus as CanonicalReaderStatus;
  }
  const legacy = entry.readerStatus ?? entry.status;
  if (legacy === "PLANNING") return "SAVED";
  if (legacy === "COMPLETED") return "FINISHED";
  return (
    legacy === "READING" ||
    legacy === "PAUSED" ||
    legacy === "DROPPED"
  )
    ? legacy
    : null;
}

function entryForCommand(
  data: AccountDataV1,
  command:
    | Extract<LibraryMutationCommand, { readonly kind: "entry_patch" }>
    | FinishQualificationCommand,
): LibraryOverlayEntry | null {
  const entry = data.overlay?.entries[command.workKey];
  if (entry === undefined || entry.entryId !== command.entryId) return null;
  return entry;
}

function entryPatchSatisfied(entry: LibraryOverlayEntry, patch: LibraryEntryPatch): boolean {
  if (
    patch.status !== undefined &&
    canonicalReaderStatus(entry) !== patch.status
  ) {
    return false;
  }
  if (patch.progress !== undefined) {
    if (
      entry.chapters === undefined ||
      entry.chapters.current !== patch.progress.value ||
      entry.chapters.total !== patch.progress.total
    ) {
      return false;
    }
  }
  if (patch.rating !== undefined && entry.rating !== patch.rating) return false;
  const override = patch.story_snapshot?.work_status_override;
  if (override !== undefined) {
    if (override === null) {
      if (entry.workStatusProvenance === "override") return false;
    } else if (
      entry.workStatus !== override ||
      entry.workStatusProvenance !== "override"
    ) {
      return false;
    }
  }
  return true;
}

function preferenceSatisfied(
  data: AccountDataV1,
  command: Extract<LibraryMutationCommand, { readonly kind: "work_preference" }>,
): boolean {
  const hidden =
    data.overlay?.workPreferences[command.workKey]?.browsePreference.hidden === true;
  return hidden === command.hidden;
}

export function libraryMutationSatisfied(
  data: AccountDataV1,
  command: LibraryMutationCommand,
): boolean {
  if (command.kind === "work_preference") return preferenceSatisfied(data, command);
  const entry = entryForCommand(data, command);
  return entry !== null && entryPatchSatisfied(entry, command.patch);
}

function confirmedMutation(
  data: AccountDataV1,
  command: LibraryMutationCommand,
  source: "preflight" | "mutation" | "reconciliation",
): LibraryMutationResult {
  const entry = command.kind === "entry_patch"
    ? entryForCommand(data, command) ?? undefined
    : data.overlay?.entries[command.workKey];
  return Object.freeze({
    kind: "confirmed",
    commandKind: command.kind,
    workKey: command.workKey,
    ...(command.kind === "entry_patch" ? { entryId: command.entryId } : {}),
    ...(entry === undefined ? {} : { entry }),
    source,
  });
}

export class LibraryMutationService {
  readonly #ports: LibraryCommandPorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: LibraryCommandPorts) {
    this.#ports = ports;
  }

  execute(command: LibraryMutationCommand): Promise<LibraryMutationResult> {
    return this.#withLock(() => this.#execute(command));
  }

  async #execute(command: LibraryMutationCommand): Promise<LibraryMutationResult> {
    const scope = this.#ports.session.publicationScope();
    if (scope === null) return failed("not_authenticated");

    let projection = await this.#ports.projection.refreshAndRead();
    if (projection.kind !== "value") return projectionFailure(projection);
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failed("stale");
    }
    if (command.kind === "entry_patch" && entryForCommand(projection.value, command) === null) {
      return failed("invalid_request");
    }
    if (libraryMutationSatisfied(projection.value, command)) {
      return confirmedMutation(projection.value, command, "preflight");
    }

    let mutation = await this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.mutate(credential, command)
    );
    if (mutation.kind === "auth_rejected" && mutation.recovery === "connected") {
      projection = await this.#ports.projection.refreshAndRead();
      if (projection.kind !== "value") return projectionFailure(projection);
      if (libraryMutationSatisfied(projection.value, command)) {
        return confirmedMutation(projection.value, command, "preflight");
      }
      mutation = await this.#ports.session.executeAuthenticated((credential) =>
        this.#ports.api.mutate(credential, command)
      );
    }
    if (mutation.kind !== "published") return executionFailure(mutation);
    if (mutation.value.kind === "rejected") return failed(mutation.value.reason);

    projection = await this.#ports.projection.refreshAndRead();
    if (projection.kind !== "value") return projectionFailure(projection);
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failed("stale");
    }
    if (!libraryMutationSatisfied(projection.value, command)) {
      return failed("confirmation_missing");
    }
    return confirmedMutation(
      projection.value,
      command,
      mutation.value.kind === "accepted" ? "mutation" : "reconciliation",
    );
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

export class FinishQualificationService {
  readonly #ports: LibraryCommandPorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: LibraryCommandPorts) {
    this.#ports = ports;
  }

  execute(command: FinishQualificationCommand): Promise<FinishQualificationResult> {
    return this.#withLock(() => this.#execute(command));
  }

  async #execute(command: FinishQualificationCommand): Promise<FinishQualificationResult> {
    const scope = this.#ports.session.publicationScope();
    if (scope === null) return failed("not_authenticated");
    const projection = await this.#ports.projection.refreshAndRead();
    if (projection.kind !== "value") return projectionFailure(projection);
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failed("stale");
    }
    if (entryForCommand(projection.value, command) === null) {
      return failed("invalid_request");
    }

    let signal = await this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.qualifyFinish(credential, command)
    );
    if (signal.kind === "auth_rejected" && signal.recovery === "connected") {
      signal = await this.#ports.session.executeAuthenticated((credential) =>
        this.#ports.api.qualifyFinish(credential, command)
      );
    }
    if (signal.kind !== "published") return executionFailure(signal);
    if (signal.value.kind === "rejected") return failed(signal.value.reason);
    if (signal.value.kind === "uncertain") return failed("unavailable");
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failed("stale");
    }
    if (signal.value.state === "resolved") {
      await this.#ports.projection.refreshAndRead();
      if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
        return failed("stale");
      }
    }
    return Object.freeze({
      kind: "acknowledged",
      state: signal.value.state,
      eventId: signal.value.eventId,
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
