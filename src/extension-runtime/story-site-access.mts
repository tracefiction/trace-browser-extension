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
 * browser reports both the same way, so no state says which it was.
 */

/**
 * How a page saved on a first tap goes on to automatic saving once the story
 * sites are allowed. `false`: the page script that is already there leaves
 * manual mode and carries on, with no reload. `true`: that page is reloaded
 * once instead, and the scripts registered under the grant start in the new
 * document. This is the only switch between the two.
 */
export const HAND_OVER_BY_RELOADING_THE_PAGE = false;

/**
 * A request answered "no" faster than this was not answered by a person: the
 * browser returned without showing its question. Not yet measured.
 */
export const ASK_ANSWERED_WITHOUT_A_QUESTION_MS = 400;

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
  | Readonly<{ kind: "returned"; value: unknown; elapsedMs: number | null }>
  | Readonly<{ kind: "threw" }>;

/** What the popup is given. Machine values only; wording belongs to the popup. */
export type StorySiteAccessView =
  /** The request is out and the browser's question may be up. */
  | Readonly<{ state: "waiting" }>
  /** Not allowed, and nothing was asked just now: the ask is offered. */
  | Readonly<{ state: "not_allowed" }>
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
  | Readonly<{ state: "declined" }>
  /** The request failed, or came back without the browser having asked. */
  | Readonly<{ state: "could_not_ask" }>
  /** What the browser allows could not be established. Never "declined". */
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
}

const view = <V extends StorySiteAccessView>(value: V): V => Object.freeze(value);

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

  /** The popup's request came back. The outcome is read, not taken from it. */
  async answered(popup: unknown, ask: StorySiteAsk): Promise<StorySiteAccessView> {
    try {
      return await this.observe(ask);
    } finally {
      this.#asking.delete(popup);
    }
  }

  /** A popup that closes mid-ask leaves nothing behind; the next one looks afresh. */
  closed(popup: unknown): void {
    this.#asking.delete(popup);
  }

  /** What holds now. With no request made, pass nothing. */
  async observe(ask: StorySiteAsk = { kind: "none" }): Promise<StorySiteAccessView> {
    const reading = await this.#ports.access().catch(() => null);
    if (reading?.complete === true) {
      const registered = await this.#ports.registered().catch(() => null);
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
    if (ask.kind === "threw") return view({ state: "could_not_ask" });
    if (reading === null) return view({ state: "not_known" });
    if (ask.kind === "none") return view({ state: "not_allowed" });
    // The browser said yes and reads back no. Neither is taken over the other.
    if (ask.value === true) return view({ state: "not_known" });
    if (ask.elapsedMs !== null && ask.elapsedMs < ASK_ANSWERED_WITHOUT_A_QUESTION_MS) {
      return view({ state: "could_not_ask" });
    }
    return view({ state: "declined" });
  }
}
