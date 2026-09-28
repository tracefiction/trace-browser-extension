export interface ReadingActivityContext {
  operationId: string;
  occurredAt: string;
  calendarDate: string;
  timeZone: { kind: "OFFSET"; value: string };
}

/** Error code the API returns when a command's occurrence time is ahead of its clock. */
export const READING_ACTIVITY_CLOCK_AHEAD = "READING_ACTIVITY_CLOCK_AHEAD";
/** The API's accepted client clock lead. */
const MAX_CLOCK_LEAD_MS = 300_000;

/**
 * One instant, that instant's numeric UTC offset, and the local calendar date
 * derived from both, so the date never mixes a UTC day with a local zone.
 */
export function readingActivityContext(
  now: Date,
  operationId: string,
): ReadingActivityContext {
  const offset = -now.getTimezoneOffset();
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return {
    operationId,
    occurredAt: now.toISOString(),
    calendarDate: new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 10),
    timeZone: { kind: "OFFSET", value: `${offset < 0 ? "-" : "+"}${hours}:${minutes}` },
  };
}

/** The server clock from a clock-ahead rejection body, or null for anything else. */
export function readingActivityClockAheadServerTime(body: unknown): Date | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { code, server_time: serverTime } = body as Record<string, unknown>;
  if (code !== READING_ACTIVITY_CLOCK_AHEAD || typeof serverTime !== "string") return null;
  const parsed = new Date(serverTime);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** One runtime-owned command identity, retained across its authentication retry.
 * The kernel copies commands per execute; identical later intents stay distinct.
 * There is no background retry queue across worker/account lifetimes.
 */
export class ReadingActivityCommands {
  readonly #contexts = new WeakMap<object, ReadingActivityContext>();
  readonly #reanchored = new WeakSet<object>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  context(command: object, operationId?: string): ReadingActivityContext {
    const previous = this.#contexts.get(command);
    if (previous) return previous;
    const context = readingActivityContext(this.#now(), operationId ?? crypto.randomUUID());
    this.#contexts.set(command, context);
    return context;
  }

  /**
   * Re-anchor a command the API rejected as ahead of its clock. The rejected
   * command committed nothing, so it keeps its operation id; the device offset
   * at the server instant derives the local date. Returns false when the
   * command was already re-anchored (including before an authentication
   * retry) or its context was one the API could have accepted, so an exact
   * retry still replays.
   */
  reanchor(command: object, serverTime: Date): boolean {
    const context = this.#contexts.get(command);
    if (
      !context ||
      this.#reanchored.has(command) ||
      !(Date.parse(context.occurredAt) > serverTime.getTime() + MAX_CLOCK_LEAD_MS)
    ) {
      return false;
    }
    this.#reanchored.add(command);
    this.#contexts.set(
      command,
      readingActivityContext(new Date(serverTime.getTime()), context.operationId),
    );
    return true;
  }

  /**
   * Send one reading command. On a clock-ahead rejection, re-anchor it and
   * send it exactly once more; `send` rebuilds its body from `context`.
   */
  async send(
    command: object,
    send: () => Promise<Response | null>,
  ): Promise<Response | null> {
    const response = await send();
    if (response?.status !== 400) return response;
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    const serverTime = readingActivityClockAheadServerTime(body);
    if (serverTime === null || !this.reanchor(command, serverTime)) return response;
    return send();
  }
}
