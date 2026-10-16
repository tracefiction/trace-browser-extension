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

/**
 * How a save came about, as the background established it when it admitted
 * the command: the reader opened Trace on that one page, or a page script
 * running under lasting website access sent it. Never taken from a page.
 */
export type StorySaveMode = "bounded_manual" | "normal_automatic";

/**
 * What is known about a save's write to Trace when the command ends.
 * `never_sent`: the write was not handed to the network at all.
 * `refused`: Trace answered and did not take it.
 * `sent_unconfirmed`: it was handed over and no answer settles whether it
 * landed. Only `never_sent` supports saying that nothing was sent.
 */
export type StoryDispatch =
  | "never_sent"
  | "refused"
  | "sent_unconfirmed"
  | "confirmed";

export interface StoryCommandEvidence {
  readonly result: StoryCommandResult;
  readonly dispatch: StoryDispatch;
}

/** A read of one story's place in the Library that can change nothing. */
export type StoryPresence =
  | { readonly kind: "found"; readonly confirmation: ConfirmedStorySave }
  // Not found is not offered: the Library read this uses is not guaranteed
  // complete, so a missing entry cannot establish absence.
  | { readonly kind: "unknown" };

export interface StoryTrackCommand {
  readonly mode?: StorySaveMode;
  readonly intent: StoryTrackIntent;
  readonly hostKind: StoryHostKind;
  readonly workKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly progress?: Readonly<{
    readonly current: number;
    readonly total: number | null;
  }>;
  readonly handoffId?: string;
  /**
   * The story's author on FanFiction.net, as the story page linked it. Kept
   * in the extension for reading a missing summary; never sent to Trace.
   */
  readonly ffnAuthorId?: string;
}

export interface ConfirmedStorySave {
  readonly workKey: string;
  readonly entryId: string;
  readonly entry: LibraryOverlayEntry;
  readonly syncVersion: string;
  /**
   * Whether the entry has a summary after a save whose page reported none,
   * when Trace said so. Absent when not reported.
   */
  readonly summaryKnown?: boolean;
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
  prepareSaveReceipt?(accountID: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  publishSaveReceipt(receipt: Readonly<{
    hostKind: StoryHostKind;
    action: "quick_add" | "read";
    at: number;
    handoffId?: string;
    accountID: string;
    entryID: string;
    workKey: string;
    source: "preflight" | "mutation" | "reconciliation";
    mode?: StorySaveMode;
    context?: Readonly<Record<string, unknown>>;
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
    return this.executeWithEvidence(command).then(({ result }) => result);
  }

  /**
   * The same save, with what is known about its write to Trace. `beforeWrite`
   * is awaited just before each write is handed to the network, so a caller
   * can record that a write is going out; what it does cannot stop the save.
   */
  executeWithEvidence(
    command: StoryTrackCommand,
    observer?: { beforeWrite?(): Promise<void> | void },
  ): Promise<StoryCommandEvidence> {
    const ownedCommand = { ...command, payload: { ...command.payload } };
    return this.#withLock(async () => {
      // Set the moment the write is handed to the network, and never unset:
      // from then on only an answer from Trace can say what became of it.
      const write = {
        handedOver: false,
        refused: false,
        before: async (): Promise<void> => {
          try { await observer?.beforeWrite?.(); } catch { /* Recording it is best effort. */ }
        },
      };
      const result = await this.#execute(ownedCommand, write);
      const dispatch: StoryDispatch = result.kind === "confirmed"
        ? "confirmed"
        : !write.handedOver
          ? "never_sent"
          : write.refused
            ? "refused"
            : "sent_unconfirmed";
      return Object.freeze({ result, dispatch });
    });
  }

  /**
   * Whether the story is in the current account's Library right now. It reads
   * and nothing else: no save is sent, nothing is published, no receipt goes
   * to the app. An answer for an account that changed meanwhile is unknown.
   */
  async presence(workKey: string): Promise<StoryPresence> {
    const unknown: StoryPresence = Object.freeze({ kind: "unknown" });
    const scope = this.#ports.session.publicationScope();
    if (scope === null) return unknown;
    let lookup: AuthenticatedExecutionResult<StoryLookupOutcome>;
    try {
      lookup = await this.#lookup(workKey, true);
    } catch {
      return unknown;
    }
    if (
      lookup.kind !== "published" ||
      lookup.value.kind !== "found" ||
      lookup.value.confirmation.workKey !== workKey ||
      !sameAccountScope(this.#ports.session.publicationScope(), scope)
    ) {
      return unknown;
    }
    return Object.freeze({ kind: "found", confirmation: lookup.value.confirmation });
  }

  async #execute(
    command: StoryTrackCommand,
    write: { handedOver: boolean; refused: boolean; before(): Promise<void> },
  ): Promise<StoryCommandResult> {
    const scope = this.#ports.session.publicationScope();
    if (scope === null) return failure("not_authenticated");

    let context: Readonly<Record<string, unknown>> | undefined;
    // Automatic reading can create the first Library entry too. Both commands
    // carry exact native evidence only after the same API confirmation checks.
    try { context = await this.#ports.receipt.prepareSaveReceipt?.(scope.accountId); }
    catch { /* Receipt availability must never prevent a real save. */ }
    if (!sameAccountScope(this.#ports.session.publicationScope(), scope)) return failure("stale");
    if (command.intent === "ensure_saved") {
      // Save preflight avoids duplicate first-save work and recovers a prior
      // committed POST after a worker restart. Progress writes are monotonic
      // and return authoritative confirmation, so they should not wait for a
      // whole-library lookup before every chapter update.
      const lookup = await this.#lookup(command.workKey, true);
      if (lookup.kind !== "published") return executionFailure(lookup);
      if (
        lookup.value.kind === "found" &&
        confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)
      ) {
        return this.#finalize(scope, command, lookup.value.confirmation, "preflight", context);
      }
      if (lookup.value.kind === "invalid_response") return failure("invalid_response");
      if (lookup.value.kind === "unavailable") return failure("unavailable");
    }

    // Keep command identity stable for the reading-activity idempotency owner.
    // The mode is this extension's own record of how the save came about; it
    // is not part of what is sent to Trace.
    const { mode: stampedMode, ...unstamped } = command;
    void stampedMode;
    const trackCommand = { ...unstamped };
    const track = async (credential: string) => {
      // Do not forward caller/page-supplied correlation or retain it across accounts.
      const { attempt_id: ignored, ...payload } = command.payload;
      const id = context?.setupAttemptID;
      const expiresAt = context?.setupAttemptExpiresAt;
      const now = this.#ports.clock.now();
      const valid = sameAccountScope(this.#ports.session.publicationScope(), scope) &&
        typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) &&
        typeof expiresAt === "number" && Number.isFinite(expiresAt) &&
        expiresAt > now && expiresAt - now <= 86_400_000;
      trackCommand.payload = { ...payload, ...(valid ? { attempt_id: id.toLowerCase() } : {}) };
      // From here the write counts as out, whatever becomes of it.
      write.handedOver = true;
      write.refused = false;
      await write.before();
      return this.#ports.api.track(credential, trackCommand).then((outcome) => {
        // A refusal is an answer: sign-in rejected, or Trace declined the
        // story. Anything else leaves the write's fate open.
        write.refused =
          outcome.kind === "auth_rejected" ||
          (outcome.kind === "success" && outcome.value.kind === "rejected");
        return outcome;
      });
    };
    let mutation = await this.#ports.session.executeAuthenticated(track);
    if (
      mutation.kind === "auth_rejected" &&
      mutation.recovery === "connected"
    ) {
      // A 401 is a definitive non-write, so it is safe to use the refreshed
      // capability. Save commands re-check in case another actor saved while
      // auth recovered; monotonic progress commands can retry directly.
      if (command.intent === "ensure_saved") {
        const lookup = await this.#lookup(command.workKey, false);
        if (lookup.kind !== "published") return executionFailure(lookup);
        if (
          lookup.value.kind === "found" &&
          confirmationSatisfiesStoryCommand(command, lookup.value.confirmation)
        ) {
          return this.#finalize(scope, command, lookup.value.confirmation, "preflight", context);
        }
        if (lookup.value.kind === "invalid_response") return failure("invalid_response");
        if (lookup.value.kind === "unavailable") return failure("unavailable");
      }
      mutation = await this.#ports.session.executeAuthenticated(track);
    }
    if (mutation.kind !== "published") return executionFailure(mutation);
    if (mutation.value.kind === "confirmed") {
      if (!confirmationSatisfiesStoryCommand(command, mutation.value.confirmation)) {
        return failure("confirmation_missing");
      }
      return this.#finalize(scope, command, mutation.value.confirmation, "mutation", context);
    }
    if (mutation.value.kind === "rejected") return failure(mutation.value.reason);
    if (mutation.value.kind === "invalid_response") return failure("invalid_response");

    // A timeout/network failure is not evidence that POST did not commit.
    // Reconcile with the authoritative account projection; never blindly POST.
    const reconciliation = await this.#lookup(command.workKey, false);
    if (reconciliation.kind !== "published") return executionFailure(reconciliation);
    if (
      reconciliation.value.kind === "found" &&
      confirmationSatisfiesStoryCommand(
        command,
        reconciliation.value.confirmation,
      )
    ) {
      return this.#finalize(
        scope,
        command,
        reconciliation.value.confirmation,
        "reconciliation", context,
      );
    }
    if (reconciliation.value.kind === "invalid_response") {
      return failure("invalid_response");
    }
    return failure(
      reconciliation.value.kind === "unavailable"
        ? "unavailable"
        : "confirmation_missing",
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
    context?: Readonly<Record<string, unknown>>,
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

    let receipt: "published" | "unavailable";
    try {
      receipt = await this.#ports.receipt.publishSaveReceipt({
        accountID: scope.accountId, entryID: confirmation.entryId,
        workKey: confirmation.workKey, source,
        ...(command.mode === undefined ? {} : { mode: command.mode }),
        ...(context === undefined ? {} : { context }),
        hostKind: command.hostKind,
        action: command.intent === "ensure_saved" ? "quick_add" : "read",
        at: this.#ports.clock.now(),
        ...(command.handoffId === undefined ? {} : { handoffId: command.handoffId }),
      })
        ? "published"
        : "unavailable";
    } catch {
      receipt = "unavailable";
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
