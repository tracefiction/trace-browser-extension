import type { FirstTapAccount } from "./first-tap-save.mjs";

/**
 * The ask for lasting access to the story sites, and what came of it.
 *
 * The request itself is made by Trace's popup, in the reader's tap: a browser
 * raises its question only for a request made that way. Everything said about
 * the outcome is said here, by the background, from what it reads afterwards.
 * What the request returned is one piece of evidence and never the answer:
 * "allowed" is the complete set of story sites read back just now, with the
 * page scripts registered.
 *
 * Nothing here can tell a grant that lasts from one that ends tomorrow. The
 * browser reports both the same way, so no state says which it was. Nor can
 * it tell a reader who answered "no" from a browser that answered "no" for
 * them without asking: both are a request that came back false, and one state.
 * Nothing is guessed from how long a request took.
 */

/**
 * How a page saved on a first tap goes on to automatic saving once the story
 * sites are allowed. `false`: the page script that is already there leaves
 * manual mode and carries on, with no reload. `true`: that page is reloaded
 * once instead, and the scripts registered under the grant start in the new
 * document. This is the only switch between the two.
 */
export const HAND_OVER_BY_RELOADING_THE_PAGE = false;

/** One fresh look at the browser's website access for the story sites. */
export type StorySiteAccessReading = Readonly<{
  /** Every story site is allowed. */
  complete: boolean;
  /** How many of them the browser listed as allowed. */
  granted: number;
  total: number;
}>;

/** What the popup reports of the request it made. It is never the outcome. */
export type StorySiteAsk =
  /** No request was made: this is a look, for a popup just opened. */
  | Readonly<{ kind: "none" }>
  /** The request is still out: a look while waiting on it. */
  | Readonly<{ kind: "waiting" }>
  /** The request is still out and the popup has stopped waiting on it. */
  | Readonly<{ kind: "unanswered" }>
  | Readonly<{ kind: "returned"; value: unknown }>
  | Readonly<{ kind: "threw" }>;

/** What the popup is given. Machine values only; wording belongs to the popup. */
export type StorySiteAccessView =
  /** The request is out and the browser's question may be up. */
  | Readonly<{ state: "waiting" }>
  /** Not allowed, and nothing was asked just now: the ask is offered. */
  | Readonly<{ state: "not_asked" }>
  /**
   * Every story site is allowed and the page scripts are registered. The
   * other two readings are for the popup to decide how much it may say:
   * saving is automatic from here only with an account and the preference on.
   */
  | Readonly<{
      state: "allowed";
      account: "connected" | "missing" | "reconnect_required" | "unknown";
      automaticSaving: "on" | "off" | "unknown";
      handOver: "in_place" | "reload";
    }>
  /** Every story site is allowed; the page scripts are not registered. */
  | Readonly<{ state: "registration_failed" }>
  /** Every story site is allowed; whether the scripts are registered could not be read. */
  | Readonly<{ state: "registration_unknown" }>
  /** Some of the story sites are allowed, not all. Never drawn as allowed. */
  | Readonly<{ state: "partial"; granted: number; total: number }>
  /**
   * The request came back false and the story sites do not read as allowed.
   * Whether the reader said no, or the browser did without asking, is not known.
   * `automaticSaving` is the preference as read just now: with it off, opening
   * Trace on a story does not save that story until the reader asks.
   */
  | Readonly<{ state: "not_allowed"; automaticSaving: "on" | "off" | "unknown" }>
  /** The request itself failed: it threw. */
  | Readonly<{ state: "could_not_ask"; automaticSaving: "on" | "off" | "unknown" }>
  /**
   * What came of the ask could not be established: access could not be read,
   * the request came back with no answer or with one the read contradicts, or
   * it never came back. Never "not allowed".
   */
  | Readonly<{ state: "not_known" }>;

export interface StorySiteAccessPorts {
  /** Read now, never from a kept value; null when it could not be read. */
  access(): Promise<StorySiteAccessReading | null>;
  /** Whether the page scripts are registered right now; null when unread. */
  registered(): Promise<boolean | null>;
  account(): Promise<FirstTapAccount>;
  automaticSaving(): Promise<"on" | "off" | "unknown">;
  /** Pages saved on a first tap go on to save by themselves. Best effort. */
  handOver(): Promise<void>;
  /**
   * Resolves once a registration of the page scripts that is under way, or
   * about to start, has ended; true when it ended within its bound. Absent
   * where nothing registers them.
   */
  registrationSettled?(): Promise<boolean>;
  /**
   * The pauses before each further read where a fresh read may lag what the
   * browser has just done. Read once, never more than these.
   */
  readonly settleDelaysMs?: readonly number[];
}

/**
 * Safari can answer the request "yes" a moment before what it allows reads
 * that way, and registers the page scripts only once it has told the
 * background of the new access. A read that lags is read again after these
 * pauses, about a second in all, before anything less than allowed is said.
 */
export const STORY_SITE_SETTLE_DELAYS_MS: readonly number[] = Object.freeze([300, 700]);

const view = <V extends StorySiteAccessView>(value: V): V => Object.freeze(value);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class StorySiteAccess {
  readonly #ports: StorySiteAccessPorts;
  /** Popups with a request out. */
  readonly #asking = new Set<unknown>();

  constructor(ports: StorySiteAccessPorts) {
    this.#ports = ports;
  }

  /**
   * The popup made its request. Returns the waiting state, or null when this
   * popup already has one out: a second tap changes nothing.
   */
  asking(popup: unknown): StorySiteAccessView | null {
    if (this.#asking.has(popup)) return null;
    this.#asking.add(popup);
    return view({ state: "waiting" });
  }

  /**
   * The popup has word of its request, or looks while it waits. The outcome
   * is read, not taken from that word. A look that finds the request still
   * out and the sites not yet allowed leaves the popup waiting.
   */
  async answered(popup: unknown, ask: StorySiteAsk): Promise<StorySiteAccessView> {
    let outcome: StorySiteAccessView | null = null;
    try {
      outcome = await this.observe(ask);
      return outcome;
    } finally {
      if (outcome?.state !== "waiting") this.#asking.delete(popup);
    }
  }

  /** A popup that closes mid-ask leaves nothing behind; the next one looks afresh. */
  closed(popup: unknown): void {
    this.#asking.delete(popup);
  }

  /** What holds now. With no request made, pass nothing. */
  async observe(ask: StorySiteAsk = { kind: "none" }): Promise<StorySiteAccessView> {
    const delays = this.#ports.settleDelaysMs ?? STORY_SITE_SETTLE_DELAYS_MS;
    let reading = await this.#ports.access().catch(() => null);
    // A yes is read again before it is called anything else: it can only
    // turn out allowed, never be taken for a no.
    if (ask.kind === "returned" && ask.value === true) {
      for (const delay of delays) {
        if (reading?.complete === true) break;
        await pause(delay);
        reading = await this.#ports.access().catch(() => null);
      }
    }
    if (reading?.complete === true) {
      let registered = await this.#ports.registered().catch(() => null);
      // The sites have just been allowed and the scripts may still be going
      // in. A look while the request is out does not wait: the popup looks
      // again soon anyway.
      if (registered !== true && ask.kind !== "waiting") {
        if (this.#ports.registrationSettled) {
          await this.#ports.registrationSettled().catch(() => false);
          registered = await this.#ports.registered().catch(() => null);
        }
        for (const delay of delays) {
          if (registered === true) break;
          await pause(delay);
          registered = await this.#ports.registered().catch(() => null);
        }
      }
      if (registered === false) return view({ state: "registration_failed" });
      if (registered !== true) return view({ state: "registration_unknown" });
      const [account, automaticSaving] = await Promise.all([
        this.#ports.account().then(
          ({ state }) => state === "verified" ? "connected" as const : state,
          () => "unknown" as const,
        ),
        this.#ports.automaticSaving().catch(() => "unknown" as const),
        this.#ports.handOver().catch(() => undefined),
      ]);
      return view({
        state: "allowed", account, automaticSaving,
        handOver: HAND_OVER_BY_RELOADING_THE_PAGE ? "reload" : "in_place",
      });
    }
    // Fewer than all of them is not "allowed", whatever the request returned.
    if (reading !== null && reading.granted > 0) {
      return view({ state: "partial", granted: reading.granted, total: reading.total });
    }
    // Still out, and nothing allowed yet: only the sites being allowed, or
    // the popup giving up, ends the wait. Time alone decides nothing here.
    if (ask.kind === "waiting") return view({ state: "waiting" });
    if (ask.kind === "threw") {
      return view({ state: "could_not_ask", automaticSaving: await this.#automaticSaving() });
    }
    if (reading === null) return view({ state: "not_known" });
    if (ask.kind === "none") return view({ state: "not_asked" });
    // A request that never came back says nothing, and so is never "no".
    if (ask.kind === "unanswered") return view({ state: "not_known" });
    // Only an answer of exactly "no" is one. "Yes" with the sites reading as
    // not allowed, or no answer at all, leaves it not known.
    if (ask.value !== false) return view({ state: "not_known" });
    return view({ state: "not_allowed", automaticSaving: await this.#automaticSaving() });
  }

  #automaticSaving(): Promise<"on" | "off" | "unknown"> {
    return this.#ports.automaticSaving().catch(() => "unknown" as const);
  }
}
