/**
 * Chrome's offscreen document for Keep a Copy. Chrome's service worker cannot
 * make blob URLs, so files are fetched and held here, and saved from here.
 */

import { KEEP_ALIVE_PING_MS, KEEP_ALIVE_PORT, OFFSCREEN_TARGET, offscreenFetcher, requestAO3 } from "./keep-a-copy-fetch.mjs";

interface OffscreenMessage {
  target?: unknown;
  type?: unknown;
  url?: unknown;
  handle?: unknown;
  timeoutMs?: unknown;
  limit?: unknown;
}

interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
}

const runtime = (globalThis as unknown as {
  chrome: {
    runtime: {
      connect(options: { name: string }): Port;
      onMessage: { addListener(listener: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean | void): void };
    };
  };
}).chrome.runtime;

let limits = { timeoutMs: 120_000, limit: 50 * 1_024 * 1_024 };
const fetcher = offscreenFetcher({
  fetchFile: (url) => requestAO3(url, "file", limits.timeoutMs, limits.limit),
  revoke: (handle) => URL.revokeObjectURL(handle),
  keepAlive() {
    const port = runtime.connect({ name: KEEP_ALIVE_PORT });
    const ping = setInterval(() => port.postMessage("fetching"), KEEP_ALIVE_PING_MS);
    return () => {
      clearInterval(ping);
      port.disconnect();
    };
  },
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

runtime.onMessage.addListener((message, _sender, respond) => {
  const request = message as OffscreenMessage | null;
  if (request?.target !== OFFSCREEN_TARGET) return;
  if ((request.type === "release" || request.type === "claim") && typeof request.handle === "string" && request.handle.startsWith("blob:")) {
    if (request.type === "release") fetcher.release(request.handle);
    else fetcher.claim(request.handle);
    return;
  }
  if (request.type !== "fetch" || typeof request.url !== "string" || typeof request.timeoutMs !== "number" || typeof request.limit !== "number") return;
  // Only AO3's own hosts, whatever asks.
  if (!/^https:\/\/(?:download\.)?archiveofourown\.org\//.test(request.url)) return;
  limits = { timeoutMs: request.timeoutMs, limit: request.limit };
  fetcher.fetch(request.url).then(respond);
  return true;
});
