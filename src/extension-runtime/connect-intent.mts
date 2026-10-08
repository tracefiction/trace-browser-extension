import type { BrowserStorage } from "./browser-platform.mjs";

// A reader asked to connect (installed the extension, or pressed Connect on an
// archive page) but no signed-in Trace page could answer yet. While this
// content-free marker is fresh, a Trace page that reports it is signed in
// finishes that connect. It never holds a credential or account detail.
export const CONNECT_INTENT_KEY = "traceConnectIntentV1";
export const CONNECT_RETURN_KEY = "traceConnectReturnV1";
export const CONNECT_INTENT_TTL_MS = 30 * 60_000;

type IntentStorage = Pick<BrowserStorage, "get" | "set" | "remove">;

export async function rememberConnectIntent(
  storage: IntentStorage,
  now = Date.now(),
): Promise<void> {
  try {
    await storage.set({ [CONNECT_INTENT_KEY]: now + CONNECT_INTENT_TTL_MS });
  } catch {
    // Best effort: the reader can still press Connect again.
  }
}

export async function hasConnectIntent(
  storage: IntentStorage,
  now = Date.now(),
): Promise<boolean> {
  try {
    const values = await storage.get(CONNECT_INTENT_KEY);
    const expiresAt = values[CONNECT_INTENT_KEY];
    if (
      typeof expiresAt === "number" &&
      expiresAt > now &&
      expiresAt <= now + CONNECT_INTENT_TTL_MS
    ) {
      return true;
    }
    if (expiresAt !== undefined) await clearConnectIntent(storage);
    return false;
  } catch {
    return false;
  }
}

export async function clearConnectIntent(storage: IntentStorage): Promise<void> {
  try {
    await storage.remove([CONNECT_INTENT_KEY, CONNECT_RETURN_KEY]);
  } catch {
    // An unremoved marker still expires on its own.
  }
}

export async function rememberConnectReturn(storage: IntentStorage, sourceTabId: number, connectTabId: number): Promise<void> {
  try { await storage.set({ [CONNECT_RETURN_KEY]: { sourceTabId, connectTabId, expiresAt: Date.now() + CONNECT_INTENT_TTL_MS } }); }
  catch { /* Connection still works when return storage is unavailable. */ }
}

export async function readConnectReturn(storage: IntentStorage): Promise<{ sourceTabId: number; connectTabId: number } | null> {
  try {
    const value = (await storage.get(CONNECT_RETURN_KEY))[CONNECT_RETURN_KEY] as Record<string, unknown> | undefined;
    if (value && Number.isInteger(value.sourceTabId) && Number.isInteger(value.connectTabId) &&
        typeof value.expiresAt === "number" && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + CONNECT_INTENT_TTL_MS) {
      return { sourceTabId: value.sourceTabId as number, connectTabId: value.connectTabId as number };
    }
  } catch { /* No return target. */ }
  return null;
}
