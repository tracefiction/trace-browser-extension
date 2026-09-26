export interface ReadingActivityContext {
  operationId: string;
  occurredAt: string;
  calendarDate: string;
  timeZone: { kind: "OFFSET"; value: string };
}

/** One runtime-owned command identity, retained across its authentication retry.
 * The kernel copies commands per execute; identical later intents stay distinct.
 * There is no background retry queue across worker/account lifetimes.
 */
export class ReadingActivityCommands {
  readonly #contexts = new WeakMap<object, ReadingActivityContext>();
  context(command: object, operationId?: string): ReadingActivityContext {
    const previous = this.#contexts.get(command);
    if (previous) return previous;
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const absolute = Math.abs(offset);
    const context: ReadingActivityContext = {
      operationId: operationId ?? crypto.randomUUID(), occurredAt: now.toISOString(),
      calendarDate: new Date(now.getTime()+offset*60_000).toISOString().slice(0,10),
      timeZone: { kind: "OFFSET", value: `${offset < 0 ? "-" : "+"}${String(Math.floor(absolute/60)).padStart(2,"0")}:${String(absolute%60).padStart(2,"0")}` },
    };
    this.#contexts.set(command, context);
    return context;
  }
}
