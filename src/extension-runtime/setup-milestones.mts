import type { AuthenticatedEffectResult, AuthenticatedExecutionResult } from "../extension-core/index.mjs";
import type { StorySiteAccessView } from "./story-site-access.mjs";

/**
 * Two steps of setting up Trace in Safari, told to Trace while the reader's
 * setup is under way: Trace's sheet was opened, and what came of Safari's
 * question about the story sites. Nothing else is sent: no address, no title,
 * no story, no list of sites. Only a setup the Trace app has begun, for the
 * account signed in now, is ever reported; without one nothing is kept or sent.
 *
 * A report is kept in local storage before it goes, and goes while the sheet
 * that caused it is open. A background stopped before it went sends it the
 * next time the sheet opens. Nothing waits on a timer, and nothing is sent
 * more than twice.
 */

/** A popup's word of a setup step. Only Trace's own popup may send it. */
export const SETUP_STEP_MESSAGE = "TRACE_SETUP_STEP" as const;
export const SETUP_MILESTONES_KEY = "traceSetupMilestonesV1" as const;

/** A report that has not gone, kept no longer than this. */
const PENDING_MAX_AGE_MS = 86_400_000;
/** Reports kept at once. There are at most a handful per setup. */
const MAX_PENDING = 8;
/** A report whose request never reached Trace goes once more, no more. */
const MAX_SENDS = 2;
const REQUEST_TIMEOUT_MS = 10_000;
/** How far ahead a setup's end may be: the app's own bound on it. */
const ATTEMPT_MAX_AHEAD_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SafariSheetPage = "story" | "other";
export type SafariAccessAnswer = "granted" | "declined" | "partial" | "unanswered";

export type SetupStep =
  | Readonly<{ kind: "sheet_opened"; page: SafariSheetPage }>
  | Readonly<{ kind: "access_answered"; answer: SafariAccessAnswer }>;

/** What goes to Trace, exactly; the attempt is added when it is sent. */
export type SetupMilestoneReport = Readonly<{
  milestone: "safari_sheet_opened" | "safari_access_answered";
  outcome: "confirmed" | "failed" | "unknown";
  evidence_source:
    | "extension_sheet_story_page"
    | "extension_sheet_other_page"
    | "extension_permission_granted"
    | "extension_permission_declined"
    | "extension_permission_partial"
    | "extension_permission_unanswered";
}>;

export function setupMilestoneReport(step: SetupStep): SetupMilestoneReport {
  if (step.kind === "sheet_opened") {
    return Object.freeze({
      milestone: "safari_sheet_opened",
      outcome: "confirmed",
      evidence_source: step.page === "story" ? "extension_sheet_story_page" : "extension_sheet_other_page",
    });
  }
  switch (step.answer) {
    case "granted":
      return Object.freeze({
        milestone: "safari_access_answered", outcome: "confirmed", evidence_source: "extension_permission_granted",
      });
    case "declined":
      return Object.freeze({
        milestone: "safari_access_answered", outcome: "failed", evidence_source: "extension_permission_declined",
      });
    case "partial":
      return Object.freeze({
        milestone: "safari_access_answered", outcome: "failed", evidence_source: "extension_permission_partial",
      });
    default:
      return Object.freeze({
        milestone: "safari_access_answered", outcome: "unknown", evidence_source: "extension_permission_unanswered",
      });
  }
}

/** A popup's message, read strictly; null for anything else. */
export function setupStepFromMessage(message: unknown): SetupStep | null {
  if (!isRecord(message) || message.type !== SETUP_STEP_MESSAGE) return null;
  if (message.step === "sheet_opened" && (message.page === "story" || message.page === "other")) {
    return Object.freeze({ kind: "sheet_opened", page: message.page });
  }
  if (
    message.step === "access_answered" &&
    (message.answer === "granted" || message.answer === "declined" ||
      message.answer === "partial" || message.answer === "unanswered")
  ) {
    return Object.freeze({ kind: "access_answered", answer: message.answer });
  }
  return null;
}

/**
 * The reader's answer to Safari's question, from what the background read
 * once the request came back or the popup stopped waiting on it. A look made
 * with no request out, or while one is still out, is no answer.
 */
export function safariAccessAnswer(view: StorySiteAccessView): SafariAccessAnswer | null {
  switch (view.state) {
    case "allowed":
    case "registration_failed":
    case "registration_unknown":
      return "granted";
    case "partial":
      return "partial";
    case "not_allowed":
      return "declined";
    case "not_known":
    case "could_not_ask":
      return "unanswered";
    default:
      return null;
  }
}

type Pending = {
  readonly attempt: string;
  readonly milestone: SetupMilestoneReport["milestone"];
  readonly outcome: SetupMilestoneReport["outcome"];
  readonly evidence_source: SetupMilestoneReport["evidence_source"];
  readonly at: number;
  sends: number;
};

type Stored = {
  readonly account: string;
  readonly attempt: string;
  /** What this attempt has reported already, so it is reported once. */
  readonly reported: string[];
  readonly pending: Pending[];
};

export interface SetupMilestonePorts {
  /** The account signed in now, or null. */
  account(): string | null;
  /** The app's word on the setup under way for that account; it writes nothing. */
  attempt(accountId: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Sends one report as the account signed in now. */
  send(body: Readonly<Record<string, string>>): Promise<"answered" | "unreached">;
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(patch: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  now(): number;
}

export class SetupMilestoneReporter {
  readonly #ports: SetupMilestonePorts;
  #tail: Promise<void> = Promise.resolve();

  constructor(ports: SetupMilestonePorts) {
    this.#ports = ports;
  }

  /** Keeps the step for the setup under way, if any, then sends what is kept. Never throws. */
  async record(step: SetupStep): Promise<void> {
    try {
      const account = this.#ports.account();
      if (account === null) return;
      const context = await this.#ports.attempt(account).catch(() => undefined);
      const attempt = this.#liveAttempt(context);
      if (attempt === null || this.#ports.account() !== account) return;
      const report = setupMilestoneReport(step);
      await this.#locked(async () => {
        const stored = await this.#read();
        const current: Stored = stored !== null && stored.account === account
          ? (stored.attempt === attempt ? stored : { account, attempt, reported: [], pending: stored.pending })
          : { account, attempt, reported: [], pending: [] };
        const key = step.kind === "sheet_opened"
          ? report.milestone
          : `${report.milestone}:${report.evidence_source}`;
        if (current.reported.includes(key)) return;
        // No answer is told once an answer has been, for the same setup.
        if (
          step.kind === "access_answered" && step.answer === "unanswered" &&
          current.reported.some((done) => done.startsWith("safari_access_answered:"))
        ) {
          return;
        }
        await this.#write({
          ...current,
          reported: [...current.reported, key],
          pending: [...current.pending, { attempt, ...report, at: this.#ports.now(), sends: 0 }].slice(-MAX_PENDING),
        });
      });
    } catch {
      // Best effort: a step that cannot be kept is not reported.
    }
    await this.flush();
  }

  /** One pass over what is kept: each report goes once now. Never throws. */
  flush(): Promise<void> {
    return this.#locked(async () => {
      const stored = await this.#read();
      if (stored === null || stored.pending.length === 0) return;
      const account = this.#ports.account();
      // Not signed in yet, as at a background's start: kept for later.
      if (account === null) return;
      if (account !== stored.account) {
        await this.#ports.storage.remove(SETUP_MILESTONES_KEY);
        return;
      }
      const now = this.#ports.now();
      const due = stored.pending.filter((item) =>
        item.sends < MAX_SENDS && now - item.at >= 0 && now - item.at <= PENDING_MAX_AGE_MS);
      // Counted before it goes, so a background stopped mid-request does
      // not send it again and again.
      for (const item of due) item.sends += 1;
      await this.#write({ ...stored, pending: due });
      const left: Pending[] = [];
      for (const item of due) {
        const outcome = await this.#ports.send(Object.freeze({
          attempt_id: item.attempt,
          milestone: item.milestone,
          outcome: item.outcome,
          evidence_source: item.evidence_source,
        })).catch(() => "unreached" as const);
        // Any answer from Trace is final, a refusal included.
        if (outcome === "unreached" && item.sends < MAX_SENDS) left.push(item);
      }
      // Nothing else writes meanwhile: every write takes the same turn.
      if (this.#ports.account() !== account) await this.#ports.storage.remove(SETUP_MILESTONES_KEY);
      else await this.#write({ ...stored, pending: left });
    }).catch(() => undefined);
  }

  /** Forgets every report and what was reported: on sign-out or a change of account. */
  clear(): Promise<void> {
    return this.#locked(() => this.#ports.storage.remove(SETUP_MILESTONES_KEY)).catch(() => undefined);
  }

  #liveAttempt(context: Readonly<Record<string, unknown>> | undefined): string | null {
    const id = context?.setupAttemptID;
    const expiresAt = context?.setupAttemptExpiresAt;
    const now = this.#ports.now();
    return typeof id === "string" && UUID_PATTERN.test(id) &&
      typeof expiresAt === "number" && Number.isFinite(expiresAt) &&
      expiresAt > now && expiresAt - now <= ATTEMPT_MAX_AHEAD_MS
      ? id.toLowerCase()
      : null;
  }

  #locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #read(): Promise<Stored | null> {
    const raw = (await this.#ports.storage.get(SETUP_MILESTONES_KEY))[SETUP_MILESTONES_KEY];
    if (
      !isRecord(raw) || typeof raw.account !== "string" || typeof raw.attempt !== "string" ||
      !Array.isArray(raw.reported) || !Array.isArray(raw.pending)
    ) {
      return null;
    }
    return {
      account: raw.account,
      attempt: raw.attempt,
      reported: raw.reported.filter((key): key is string => typeof key === "string"),
      pending: raw.pending.filter(isPending).map((item) => ({ ...item })),
    };
  }

  #write(stored: Stored): Promise<void> {
    return this.#ports.storage.set({ [SETUP_MILESTONES_KEY]: stored });
  }
}

/** Trace's endpoint for these steps. */
export class SetupMilestoneApi {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;

  constructor(fetchImpl: typeof fetch, apiBase: string) {
    this.#fetch = fetchImpl;
    this.#endpoint = `${apiBase.replace(/\/$/, "")}/api/extension/setup-milestones`;
  }

  /**
   * Any answer is final and reported as such, a refused credential included:
   * a report never makes the session look at its sign-in again.
   */
  async send(
    credential: string,
    body: Readonly<Record<string, string>>,
  ): Promise<AuthenticatedEffectResult<"answered" | "unreached">> {
    const abort = new AbortController();
    const timer = globalThis.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      return { kind: "success", value: "answered" };
    } catch {
      return { kind: "success", value: "unreached" };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

/** The send port, as the session runs it. */
export function sendAsSignedIn(
  execute: <T>(effect: (credential: string) => Promise<AuthenticatedEffectResult<T>>) =>
    Promise<AuthenticatedExecutionResult<T>>,
  api: SetupMilestoneApi,
): SetupMilestonePorts["send"] {
  return async (body) => {
    const result = await execute((credential) => api.send(credential, body));
    return result.kind === "published" ? result.value : "unreached";
  };
}

function isPending(value: unknown): value is Pending {
  return isRecord(value) &&
    typeof value.attempt === "string" && UUID_PATTERN.test(value.attempt) &&
    (value.milestone === "safari_sheet_opened" || value.milestone === "safari_access_answered") &&
    (value.outcome === "confirmed" || value.outcome === "failed" || value.outcome === "unknown") &&
    typeof value.evidence_source === "string" && value.evidence_source.startsWith("extension_") &&
    typeof value.at === "number" && Number.isFinite(value.at) &&
    typeof value.sends === "number" && Number.isInteger(value.sends) && value.sends >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
