/**
 * Story saves to Trace under way in this background, and when the last one
 * ended. Work that reads a story site in the background waits for them.
 */

let inFlight = 0;
let lastEndedAt = 0;

export function storySaveStarted(): void {
  inFlight += 1;
}

export function storySaveEnded(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastEndedAt = Date.now();
}

export function storySaveActivity(): { readonly inFlight: number; readonly lastEndedAt: number } {
  return { inFlight, lastEndedAt };
}
