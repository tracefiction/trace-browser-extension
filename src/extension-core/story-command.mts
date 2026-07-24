import {
  sameAccountScope,
  type AccountScope,
} from "./session-model.mjs";
import type {
  AuthenticatedEffectResult,
  AuthenticatedExecutionResult,
} from "./session-service.mjs";
import type { LibraryOverlayEntry } from "./account-data.mjs";

export type StoryHostKind = "ao3" | "ffn";
export type StoryTrackIntent = "ensure_saved" | "record_progress";

export interface StoryTrackCommand {
  readonly intent: StoryTrackIntent;
  readonly hostKind: StoryHostKind;
  readonly workKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly progress?: Readonly<{
    readonly current: number;
    readonly total: number | null;
  }>;
  readonly handoffId?: string;
}

export interface ConfirmedStorySave {
  readonly workKey: string;
  readonly entryId: string;
  readonly entry: LibraryOverlayEntry;
  readonly syncVersion: string;
}

export type StoryCommandFailure =
  | "not_authenticated"
  | "auth_expired"
  | "free_limit_reached"
  | "rate_limited"
  | "invalid_request"
  | "invalid_response"
  | "confirmation_missing"
  | "unavailable"
  | "stale";

export type StoryCommandResult =
  | {
      readonly kind: "confirmed";
      readonly intent: StoryTrackIntent;
      readonly confirmation: ConfirmedStorySave;
      readonly source: "preflight" | "mutation" | "reconciliation";
      readonly projection: "published" | "unavailable";
      readonly receipt: "published" | "unavailable" | "not_applicable";
      readonly handoff: "cleared" | "unavailable" | "not_present";
    }
  | { readonly kind: "failed"; readonly reason: StoryCommandFailure };

export type StoryLookupOutcome =
  | { readonly kind: "found"; readonly confirmation: ConfirmedStorySave }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "unavailable" };

export type StoryMutationOutcome =
  | { readonly kind: "confirmed"; readonly confirmation: ConfirmedStorySave }
  | {
      readonly kind: "rejected";
      readonly reason: "free_limit_reached" | "rate_limited" | "invalid_request";
    }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "uncertain" };

export interface StoryCommandApiPort {
  lookup(
    credential: string,
    workKey: string,
  ): Promise<AuthenticatedEffectResult<StoryLookupOutcome>>;
  track(
    credential: string,
    command: StoryTrackCommand,
  ): Promise<AuthenticatedEffectResult<StoryMutationOutcome>>;
}

export interface AuthenticatedStoryCommandPort {
  publicationScope(): AccountScope | null;
  executeAuthenticated<T>(
    effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>,
  ): Promise<AuthenticatedExecutionResult<T>>;
}

export type StoryProjectionResult =
  | { readonly kind: "published" }
  | {
      readonly kind:
        | "rejected_scope"
        | "invalid_model"
        | "stale_write"
        | "unavailable";
    };

export interface StoryProjectionPort {
  publishConfirmed(
    scope: AccountScope,
    confirmation: ConfirmedStorySave,
  ): Promise<StoryProjectionResult>;
}

export interface StorySaveReceiptPort {
  publishSaveReceipt(receipt: Readonly<{
    hostKind: StoryHostKind;
    action: "quick_add";
    at: number;
    handoffId?: string;
  }>): Promise<boolean>;
}

export interface PendingStoryHandoffPort {
  clearExpected(handoffId: string): Promise<boolean>;
}

export interface StoryCommandClock {
  now(): number;
}

interface StoryCommandPorts {
  readonly session: AuthenticatedStoryCommandPort;
  readonly api: StoryCommandApiPort;
  readonly projection: StoryProjectionPort;
  readonly receipt: StorySaveReceiptPort;
  readonly handoff: PendingStoryHandoffPort;
  readonly clock: StoryCommandClock;
}

function failure(reason: StoryCommandFailure): StoryCommandResult {
  return Object.freeze({ kind: "failed", reason });
}

function executionFailure<T>(
  result: Exclude<AuthenticatedExecutionResult<T>, { readonly kind: "published" }>,
): StoryCommandResult {
  if (result.kind === "stale") return failure("stale");
  if (result.kind === "auth_rejected") return failure("auth_expired");
  return failure("not_authenticated");
}

export function confirmationSatisfiesStoryCommand(
  command: StoryTrackCommand,
  confirmation: ConfirmedStorySave,
): boolean {
  if (confirmation.workKey !== command.workKey) return false;
  if (command.intent === "ensure_saved") return true;
  const target = command.progress;
  const chapters = confirmation.entry.chapters;
  if (target === undefined || chapters === undefined) return false;
  if (chapters.current < target.current) return false;
  return (
    target.total === null ||
    (chapters.total !== null && chapters.total >= target.total)
  );
}

export class StoryCommandService {
  readonly #ports: StoryCommandPorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: StoryCommandPorts) {
    this.#ports = ports;
  }

  execute(command: StoryTrackCommand): Promise<StoryCommandResult> {
    return this.#withLock(() => this.#execute(command));
  }

  async #execute(command: StoryTrackCommand): Promise<StoryCommandResult> {
    const scope = this.#ports.session.publicationScope();
    if (scope === null) return failure("not_authenticated");

    // Lookup is deliberately first. Besides avoiding needless updates for an
    // already-saved work, it is the restart recovery path when the server
    // committed a prior POST but the worker died before acknowledging it.
    let lookup = await this.#lookup(command.workKey, true);
    if (lookup.kind !== "published") return executionFailure(lookup);
    if (
      lookup.value.kind === "found" &&
      confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)
    ) {
      return this.#finalize(scope, command, lookup.value.confirmation, "preflight");
    }
    if (lookup.value.kind === "invalid_response") return failure("invalid_response");
    if (lookup.value.kind === "unavailable") return failure("unavailable");

    let mutation = await this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.track(credential, command)
    );
    if (
      mutation.kind === "auth_rejected" &&
      mutation.recovery === "connected"
    ) {
      // A 401 is a definitive non-write, so it is safe to use the refreshed
      // capability. Re-check first in case another actor saved meanwhile.
      lookup = await this.#lookup(command.workKey, false);
      if (lookup.kind !== "published") return executionFailure(lookup);
      if (
        lookup.value.kind === "found" &&
        confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)
      ) {
        return this.#finalize(scope, command, lookup.value.confirmation, "preflight");
      }
      if (lookup.value.kind === "invalid_response") return failure("invalid_response");
      if (lookup.value.kind === "unavailable") return failure("unavailable");
      mutation = await this.#ports.session.executeAuthenticated((credential) =>
        this.#ports.api.track(credential, command)
      );
    }
    if (mutation.kind !== "published") return executionFailure(mutation);
    if (mutation.value.kind === "confirmed") {
      if (!confirmationSatisfiesStoryCommand(command, mutation.value.confirmation)) {
        return failure("confirmation_missing");
      }
      return this.#finalize(scope, command, mutation.value.confirmation, "mutation");
    }
    if (mutation.value.kind === "rejected") return failure(mutation.value.reason);
    if (mutation.value.kind === "invalid_response") return failure("invalid_response");

    // A timeout/network failure is not evidence that POST did not commit.
    // Reconcile with the authoritative account projection; never blindly POST.
    lookup = await this.#lookup(command.workKey, false);
    if (lookup.kind !== "published") return executionFailure(lookup);
    if (
      lookup.value.kind === "found" &&
      confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)
    ) {
      return this.#finalize(scope, command, lookup.value.confirmation, "reconciliation");
    }
    if (lookup.value.kind === "invalid_response") return failure("invalid_response");
    return failure(
      lookup.value.kind === "unavailable" ? "unavailable" : "confirmation_missing",
    );
  }

  async #lookup(
    workKey: string,
    allowAuthRecovery: boolean,
  ): Promise<AuthenticatedExecutionResult<StoryLookupOutcome>> {
    let result = await this.#ports.session.executeAuthenticated((credential) =>
      this.#ports.api.lookup(credential, workKey)
    );
    if (
      allowAuthRecovery &&
      result.kind === "auth_rejected" &&
      result.recovery === "connected"
    ) {
      result = await this.#ports.session.executeAuthenticated((credential) =>
        this.#ports.api.lookup(credential, workKey)
      );
    }
    return result;
  }

  async #finalize(
    scope: AccountScope,
    command: StoryTrackCommand,
    confirmation: ConfirmedStorySave,
    source: "preflight" | "mutation" | "reconciliation",
  ): Promise<StoryCommandResult> {
    if (
      confirmation.workKey !== command.workKey ||
      !sameAccountScope(this.#ports.session.publicationScope(), scope)
    ) {
      return failure("stale");
    }

    let projection: StoryProjectionResult;
    try {
      projection = await this.#ports.projection.publishConfirmed(scope, confirmation);
    } catch {
      projection = { kind: "unavailable" };
    }
    if (projection.kind === "rejected_scope") return failure("stale");
    if (projection.kind === "stale_write") return failure("stale");
    if (projection.kind === "invalid_model") return failure("invalid_response");
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) {
      return failure("stale");
    }

    let receipt: "published" | "unavailable" | "not_applicable" = "not_applicable";
    if (command.intent === "ensure_saved") {
      try {
        receipt = await this.#ports.receipt.publishSaveReceipt({
          hostKind: command.hostKind,
          action: "quick_add",
          at: this.#ports.clock.now(),
          ...(command.handoffId === undefined ? {} : { handoffId: command.handoffId }),
        })
          ? "published"
          : "unavailable";
      } catch {
        receipt = "unavailable";
      }
    }

    let handoff: "cleared" | "unavailable" | "not_present" = "not_present";
    if (command.intent === "ensure_saved" && command.handoffId !== undefined) {
      try {
        handoff = await this.#ports.handoff.clearExpected(command.handoffId)
          ? "cleared"
          : "unavailable";
      } catch {
        handoff = "unavailable";
      }
    }

    return Object.freeze({
      kind: "confirmed",
      intent: command.intent,
      confirmation,
      source,
      projection: projection.kind === "published" ? "published" : "unavailable",
      receipt,
      handoff,
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
