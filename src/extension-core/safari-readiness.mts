import { ARCHIVE_ACCESS_CONFIRM_DELAY_MS } from "./archive-readiness.mjs";

/**
 * Whether Trace in Safari is ready to save by itself, as far as the extension
 * can establish it, for the Trace app beside it on iPhone and iPad.
 *
 * Four things have to hold, and each is read on its own and answered on its
 * own: positive, a known blocker, or not known. Not known is never rounded to
 * either side. The whole is ready only when all four are positive in one
 * cycle under one account session.
 *
 * What a report does not say, and must never be read as saying: how long the
 * reader's website access lasts, that a story was saved, that the next save
 * will work, that a page already open was taken over, or anything about
 * Private Browsing. It carries no credential, address or story.
 */

export const SAFARI_READINESS_REPORT_VERSION = 1 as const;

export type SafariReadinessAnswer = "positive" | "blocker" | "unknown";

export type WebsiteAccessReason =
  /** Every story site read as allowed just now. */
  | "allowed"
  /** None allowed, read twice with the full list answering both times. */
  | "not_allowed"
  /** Some allowed and not all, read twice the same way. */
  | "partly_allowed"
  /** Safari did not answer. */
  | "unreadable"
  /** Read as incomplete, without the two agreeing readings a blocker needs. */
  | "unconfirmed";

export type ScriptRegistrationReason =
  /** Every page script is registered, by this build's generation. */
  | "registered"
  /** This build declares its page scripts in its manifest. */
  | "declared"
  /** The list answered and the scripts are not there. */
  | "not_registered"
  /** The story sites are allowed and an attempt to register the scripts failed. */
  | "registration_failed"
  | "unreadable";

export type AccountReason =
  | "connected"
  /** The app holds no account for Safari. */
  | "no_account"
  /** Trace refused the account the app holds. */
  | "reconnect_required"
  /** Still being confirmed. */
  | "pending"
  /** The account could not be read or confirmed just now. */
  | "unreachable"
  /** The account changed while this report was being read. */
  | "changed"
  /** The account confirmed here is not the one the app's cycle is for. */
  | "mismatch";

export type AutomaticSavingReason = "on" | "off" | "unreadable";

export interface SafariReadinessComponent<Reason extends string> {
  readonly answer: SafariReadinessAnswer;
  readonly reason: Reason;
  /** When this one thing was read (epoch milliseconds). */
  readonly observedAt: number;
}

export interface SafariReadinessComponents {
  readonly websiteAccess: SafariReadinessComponent<WebsiteAccessReason>;
  readonly scriptRegistration: SafariReadinessComponent<ScriptRegistrationReason>;
  readonly account: SafariReadinessComponent<AccountReason>;
  readonly automaticSaving: SafariReadinessComponent<AutomaticSavingReason>;
}

export type SafariReadinessResult = "ready" | "not_ready" | "unknown";

export interface SafariReadinessReport {
  readonly version: typeof SAFARI_READINESS_REPORT_VERSION;
  readonly observedAt: number;
  readonly result: SafariReadinessResult;
  readonly components: SafariReadinessComponents;
  /** The account the report is for; present only when the account is positive. */
  readonly accountId?: string;
}

/** One look at Safari's website access for the story sites. */
export interface SafariWebsiteAccessReading {
  /** Whether every story site is allowed; null when there was no answer. */
  readonly complete: boolean | null;
  /** How many of them Safari listed as allowed; null when it listed nothing. */
  readonly granted: number | null;
}

export type SafariReadinessAccount =
  | { readonly state: "connected"; readonly session: string; readonly accountId: string }
  | { readonly state: "no_account" | "reconnect_required" | "pending" | "unreachable" | "changed" };

/** What the app's side holds when a cycle of reading begins. */
export interface SafariReadinessPreparation {
  /** The provider the app issued, as its side names it. Passed back unread. */
  readonly provider: unknown;
  /** The cycle the app has open, if any, and the account it is for. */
  readonly cycle: { readonly id: string; readonly accountId: string | null } | null;
}

export interface SafariReadinessPorts {
  /** Null when the app holds no provider, or could not be reached. */
  prepare(): Promise<SafariReadinessPreparation | null>;
  /**
   * `stale_cycle`: the app opened another cycle meanwhile, and this answer
   * was for the one before it.
   */
  deliver(
    report: SafariReadinessReport,
    preparation: SafariReadinessPreparation,
  ): Promise<"stored" | "stale_cycle" | "refused">;
  websiteAccess(): Promise<SafariWebsiteAccessReading>;
  scriptRegistration(): Promise<ScriptRegistrationReason>;
  account(): Promise<SafariReadinessAccount>;
  /** The account session right now, or null for none. Compared for equality only. */
  session(): string | null;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
  wait(ms: number): Promise<void>;
  now(): number;
}

export type SafariReadinessOutcome =
  | { readonly kind: "delivered"; readonly report: SafariReadinessReport }
  /** Nothing was sent: the app holds no provider to bind a report to. */
  | { readonly kind: "no_provider" }
  /** The app's side did not take the report. */
  | { readonly kind: "refused"; readonly report: SafariReadinessReport };

const ANSWERS: Readonly<Record<string, SafariReadinessAnswer>> = Object.freeze({
  allowed: "positive", not_allowed: "blocker", partly_allowed: "blocker",
  registered: "positive", declared: "positive", not_registered: "blocker", registration_failed: "blocker",
  connected: "positive", no_account: "blocker", reconnect_required: "blocker",
  on: "positive", off: "blocker",
});

function component<Reason extends string>(reason: Reason, observedAt: number): SafariReadinessComponent<Reason> {
  // Every reason not named above is one of the ways of not knowing.
  return Object.freeze({ answer: ANSWERS[reason] ?? "unknown", reason, observedAt });
}

/**
 * Ready only when all four are positive. Not ready when at least one is a
 * known blocker; every blocker stays on the report. Otherwise not known.
 *
 * A report whose account changed while it was read is about no one account,
 * and is not known whatever else it found.
 */
export function safariReadinessResult(components: SafariReadinessComponents): SafariReadinessResult {
  if (components.account.reason === "changed") return "unknown";
  const answers = [
    components.websiteAccess, components.scriptRegistration, components.account, components.automaticSaving,
  ].map(({ answer }) => answer);
  if (answers.every((answer) => answer === "positive")) return "ready";
  return answers.includes("blocker") ? "not_ready" : "unknown";
}

const MAX_PASSES = 3;

export class SafariReadinessService {
  readonly #ports: SafariReadinessPorts;
  #running: Promise<SafariReadinessOutcome> | null = null;
  #askedAgain = false;

  constructor(ports: SafariReadinessPorts) {
    this.#ports = ports;
  }

  /**
   * Reads the four things and sends the app one report. A request that
   * arrives while one is being read is answered by reading again afterwards,
   * since what it was asked about may have changed since.
   */
  report(): Promise<SafariReadinessOutcome> {
    if (this.#running !== null) {
      this.#askedAgain = true;
      return this.#running;
    }
    const running = (async () => {
      let outcome: SafariReadinessOutcome = { kind: "no_provider" };
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        this.#askedAgain = false;
        const once = await this.#reportOnce();
        outcome = once.outcome;
        if (!once.again && !this.#askedAgain) break;
      }
      return outcome;
    })().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  async #reportOnce(): Promise<{ outcome: SafariReadinessOutcome; again: boolean }> {
    // The provider and the cycle are fixed before anything is read, so that a
    // report can only ever be an answer to the cycle that was open then.
    const preparation = await this.#ports.prepare().catch(() => null);
    if (preparation === null) return { outcome: { kind: "no_provider" }, again: false };

    const account = await this.#ports.account().catch(
      (): SafariReadinessAccount => ({ state: "unreachable" }),
    );
    const accountAt = this.#ports.now();
    const session = this.#ports.session();
    const [websiteAccess, scriptRegistration, automaticSaving] = await Promise.all([
      this.#websiteAccess(),
      this.#ports.scriptRegistration().then(
        (reason) => component(reason, this.#ports.now()),
        () => component<ScriptRegistrationReason>("unreadable", this.#ports.now()),
      ),
      this.#ports.automaticSaving().then(
        (value) => component<AutomaticSavingReason>(value === "unknown" ? "unreadable" : value, this.#ports.now()),
        () => component<AutomaticSavingReason>("unreadable", this.#ports.now()),
      ),
    ]);

    // One account session for the whole report. If it is not the one the
    // account was read under, the report is about no account in particular.
    let accountReason: AccountReason = account.state;
    if (this.#ports.session() !== session || (account.state === "connected" && account.session !== session)) {
      accountReason = "changed";
    } else if (
      account.state === "connected" && preparation.cycle !== null &&
      preparation.cycle.accountId !== null && preparation.cycle.accountId !== account.accountId
    ) {
      accountReason = "mismatch";
    }
    const components: SafariReadinessComponents = Object.freeze({
      websiteAccess,
      scriptRegistration,
      account: component(accountReason, accountReason === account.state ? accountAt : this.#ports.now()),
      automaticSaving,
    });
    const report: SafariReadinessReport = Object.freeze({
      version: SAFARI_READINESS_REPORT_VERSION,
      observedAt: this.#ports.now(),
      result: safariReadinessResult(components),
      components,
      ...(accountReason === "connected" && account.state === "connected"
        ? { accountId: account.accountId }
        : {}),
    });
    const delivered = await this.#ports.deliver(report, preparation).catch(() => "refused" as const);
    // After an account change, or a cycle opened meanwhile, the next reading
    // is the one that can answer for the account and cycle there are now.
    const again = accountReason === "changed" || delivered === "stale_cycle";
    return {
      outcome: delivered === "stored" ? { kind: "delivered", report } : { kind: "refused", report },
      again,
    };
  }

  /**
   * Allowed on one fresh reading. Not allowed only on two readings a moment
   * apart that both say so, with Safari listing what is allowed both
   * times: a single reading, or one without the list, is not an answer.
   */
  async #websiteAccess(): Promise<SafariReadinessComponent<WebsiteAccessReason>> {
    const read = (): Promise<SafariWebsiteAccessReading> =>
      this.#ports.websiteAccess().catch(() => ({ complete: null, granted: null }));
    const done = (reason: WebsiteAccessReason) => component(reason, this.#ports.now());
    const first = await read();
    if (first.complete === true) return done("allowed");
    if (first.complete === null) return done("unreadable");
    if (first.granted === null) return done("unconfirmed");
    await this.#ports.wait(ARCHIVE_ACCESS_CONFIRM_DELAY_MS);
    const second = await read();
    if (second.complete === true) return done("allowed");
    if (second.complete === null || second.granted === null) return done("unconfirmed");
    return done(second.granted > 0 ? "partly_allowed" : "not_allowed");
  }
}
