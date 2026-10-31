/**
 * Keep a Copy's requests to AO3, shared by the background and Chrome's
 * offscreen document. A file is kept as a blob, with a URL the downloads API
 * saves from; only its first bytes travel on, to be checked.
 */

import type { Fetched } from "./keep-a-copy.mjs";

/** A file's first bytes handed on for checking: enough for any format's marks. */
export const HEAD_BYTES = 8_192;

/** Reads at most `limit` bytes of a body; null when it runs past. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A page as text, or a file as a blob URL plus its first bytes; never more
 * than `limit` bytes. Signed out unless `credentials` says otherwise: only
 * the reader's own lists are read with their AO3 session.
 */
export async function requestAO3(url: string, as: "text" | "file", timeoutMs: number, limit: number, credentials: "omit" | "include" = "omit"): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials, redirect: "follow", signal: controller.signal });
    const bytes = await readCapped(response, limit);
    if (!bytes) return { kind: "failed", code: "too_large" };
    const facts = {
      status: response.status,
      url: response.url || url,
      contentType: response.headers.get("content-type"),
      retryAfter: response.headers.get("retry-after"),
      cfMitigated: response.headers.get("cf-mitigated"),
    };
    if (as === "text") return { kind: "response", ...facts, text: new TextDecoder().decode(bytes) };
    const handle = URL.createObjectURL(new Blob([bytes as BlobPart], { type: facts.contentType ?? "application/octet-stream" }));
    return { kind: "response", ...facts, bytes: bytes.slice(0, HEAD_BYTES), size: bytes.length, handle };
  } catch {
    return { kind: "failed", code: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** The message a file fetch crosses to and from Chrome's offscreen document as. */
export const OFFSCREEN_TARGET = "keep-a-copy-offscreen";

export type OffscreenAnswer = Exclude<Fetched, { kind: "response" }> | (Omit<Extract<Fetched, { kind: "response" }>, "bytes"> & { head: number[] });

export function toOffscreenAnswer(fetched: Fetched): OffscreenAnswer {
  if (fetched.kind !== "response") return fetched;
  const { bytes, ...rest } = fetched;
  return { ...rest, head: Array.from(bytes ?? []) };
}

export function fromOffscreenAnswer(answer: OffscreenAnswer): Fetched {
  if (answer.kind !== "response") return answer;
  const { head, ...rest } = answer;
  return { ...rest, bytes: Uint8Array.from(head) };
}

/** The port Chrome's offscreen document holds open, and pings, while it fetches, so the service worker stays up. */
export const KEEP_ALIVE_PORT = "keep-a-copy-fetching";
export const KEEP_ALIVE_PING_MS = 20_000;
/** A blob the service worker has not claimed by then (it was stopped) is let go. */
export const CLAIM_MS = 60_000;

export interface OffscreenFetcherDeps {
  fetchFile(url: string): Promise<Fetched>;
  revoke(handle: string): void;
  /** Starts keeping the service worker up; returns how to stop. */
  keepAlive(): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/**
 * The offscreen document's fetches: one at a time, a repeat of the one under
 * way joins it (a restarted service worker asking again), and a blob nobody
 * claims is let go.
 */
export function offscreenFetcher(deps: OffscreenFetcherDeps) {
  let current: { url: string; answer: Promise<OffscreenAnswer> } | null = null;
  const unclaimed = new Map<string, unknown>();
  const claim = (handle: string) => {
    if (!unclaimed.has(handle)) return;
    deps.clearTimer(unclaimed.get(handle));
    unclaimed.delete(handle);
  };
  return {
    fetch(url: string): Promise<OffscreenAnswer> {
      if (current) return current.url === url ? current.answer : Promise.resolve({ kind: "failed", code: "busy" });
      const stop = deps.keepAlive();
      const answer = deps.fetchFile(url)
        .then((fetched): OffscreenAnswer => {
          const handle = fetched.kind === "response" ? fetched.handle : undefined;
          if (handle) {
            unclaimed.set(handle, deps.setTimer(() => {
              unclaimed.delete(handle);
              deps.revoke(handle);
            }, CLAIM_MS));
          }
          return toOffscreenAnswer(fetched);
        })
        .catch((): OffscreenAnswer => ({ kind: "failed", code: "network" }))
        .finally(() => {
          stop();
          current = null;
        });
      current = { url, answer };
      return answer;
    },
    claim,
    release(handle: string) {
      claim(handle);
      deps.revoke(handle);
    },
  };
}
