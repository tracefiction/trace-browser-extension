/**
 * Keep a Copy's requests in Safari, made in the reader's own AO3 tab: each
 * function here is put into that tab by `scripting.executeScript`, so it runs
 * with the tab's own sign-in and must use nothing from outside itself.
 *
 * A file is kept in the tab as a Blob, never as text, until the background
 * has handed it to the Trace app a part at a time (keep-a-copy-native.mts).
 * A file not asked for again within ten minutes is let go.
 */

/** What a request in the tab answers: a `Fetched` with the file's first bytes as numbers. */
export type TabAnswer =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly url: string;
      readonly contentType: string | null;
      readonly retryAfter: string | null;
      readonly cfMitigated: string | null;
      readonly text?: string;
      readonly head?: number[];
      readonly size?: number;
      readonly handle?: string;
      /** The whole file's SHA-256, lowercase hex. */
      readonly sha256?: string;
    }
  | { readonly kind: "failed"; readonly code: "network" | "timeout" | "too_large" | "busy" };

/** Makes one request to AO3 from the tab. `as: "file"` keeps the file in the tab under a handle. */
export async function keepCopyFetchInTab(url: string, as: "text" | "file", timeoutMs: number, limit: number, handle: string): Promise<TabAnswer> {
  const scope = globalThis as unknown as { __traceKeepCopyFilesV1?: Map<string, { blob: Blob; timer: ReturnType<typeof setTimeout> }> };
  const files = (scope.__traceKeepCopyFilesV1 ??= new Map());
  if (!/^https:\/\/(?:download\.)?archiveofourown\.org\//.test(url)) return { kind: "failed", code: "network" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", redirect: "follow", signal: controller.signal });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) return { kind: "failed", code: "too_large" };
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: "failed", code: "too_large" };
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    parts.length = 0;
    const facts = {
      status: response.status,
      url: response.url || url,
      contentType: response.headers.get("content-type"),
      retryAfter: response.headers.get("retry-after"),
      cfMitigated: response.headers.get("cf-mitigated"),
    };
    if (as === "text") return { kind: "response", ...facts, text: new TextDecoder().decode(bytes) };
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const head = Array.from(bytes.subarray(0, 8_192));
    // One file at a time: one the background no longer asks for is let go.
    for (const [old, kept] of files) {
      clearTimeout(kept.timer);
      files.delete(old);
    }
    files.set(handle, { blob: new Blob([bytes as BlobPart]), timer: setTimeout(() => files.delete(handle), 10 * 60_000) });
    return { kind: "response", ...facts, head, size: length, handle, sha256 };
  } catch {
    return { kind: "failed", code: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** One part of a kept file as base64, or null when the tab no longer has it. Each ask keeps it ten minutes more. */
export async function keepCopyPartInTab(handle: string, index: number, partBytes: number): Promise<string | null> {
  const scope = globalThis as unknown as { __traceKeepCopyFilesV1?: Map<string, { blob: Blob; timer: ReturnType<typeof setTimeout> }> };
  const kept = scope.__traceKeepCopyFilesV1?.get(handle);
  if (!kept || !Number.isSafeInteger(index) || index < 0 || index * partBytes >= kept.blob.size) return null;
  clearTimeout(kept.timer);
  kept.timer = setTimeout(() => scope.__traceKeepCopyFilesV1?.delete(handle), 10 * 60_000);
  const bytes = new Uint8Array(await kept.blob.slice(index * partBytes, (index + 1) * partBytes).arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32_768) binary += String.fromCharCode(...bytes.subarray(at, at + 32_768));
  return btoa(binary);
}

/** Lets a kept file go. */
export function keepCopyReleaseInTab(handle: string): boolean {
  const scope = globalThis as unknown as { __traceKeepCopyFilesV1?: Map<string, { blob: Blob; timer: ReturnType<typeof setTimeout> }> };
  const kept = scope.__traceKeepCopyFilesV1?.get(handle);
  if (kept) clearTimeout(kept.timer);
  return scope.__traceKeepCopyFilesV1?.delete(handle) ?? false;
}
