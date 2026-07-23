import type { ArchiveHostKind } from "../extension-core/index.mjs";
import type { RuntimeMessageSender } from "./browser-platform.mjs";

function isInactiveSender(sender: RuntimeMessageSender | undefined): boolean {
  if (typeof sender?.frameId === "number" && sender.frameId !== 0) return true;
  const lifecycle = typeof sender?.documentLifecycle === "string"
    ? sender.documentLifecycle.toLowerCase()
    : "";
  return lifecycle === "prerender" || lifecycle === "pending_deletion";
}

export function archiveHostKindFromSender(
  sender: RuntimeMessageSender | undefined,
): ArchiveHostKind | null {
  if (isInactiveSender(sender)) return null;
  const rawUrl = sender?.tab?.url ?? sender?.url;
  if (typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "archiveofourown.org" ||
      host.endsWith(".archiveofourown.org") ||
      host === "archiveofourown.gay" ||
      host.endsWith(".archiveofourown.gay") ||
      host === "archive.transformativeworks.org" ||
      host === "ao3.org" ||
      host.endsWith(".ao3.org")
    ) {
      return "ao3";
    }
    if (host === "www.fanfiction.net" || host === "m.fanfiction.net") {
      return "ffn";
    }
  } catch {
    // Invalid sender URLs are unsupported.
  }
  return null;
}

export function isBlockedArchivePath(
  rawUrl: unknown,
  hostKind: ArchiveHostKind,
): boolean {
  if (typeof rawUrl !== "string") return true;
  try {
    const pathname = new URL(rawUrl).pathname;
    return hostKind === "ao3"
      ? /^\/users\/(?:login|sign_up|password|auth\/|logout)/i.test(pathname)
      : /^\/(?:login\.php|signup\.php|account\/(?:login|signup)|auth\/)/i.test(pathname);
  } catch {
    return true;
  }
}

export function workKeyFromArchiveUrl(
  rawUrl: unknown,
  expectedHost: ArchiveHostKind,
): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length > 4_096) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (expectedHost === "ao3") {
      const supported =
        host === "archiveofourown.org" ||
        host.endsWith(".archiveofourown.org") ||
        host === "archiveofourown.gay" ||
        host.endsWith(".archiveofourown.gay") ||
        host === "archive.transformativeworks.org" ||
        host === "ao3.org" ||
        host.endsWith(".ao3.org");
      if (!supported) return null;
      const match = url.pathname.match(/^\/works\/([1-9][0-9]{0,19})(?:\/|$)/);
      return match?.[1] ? `ao3:${match[1]}` : null;
    }
    if (host !== "www.fanfiction.net" && host !== "m.fanfiction.net") return null;
    const match = url.pathname.match(/^\/s\/([1-9][0-9]{0,19})(?:\/|$)/);
    return match?.[1] ? `ffn:${match[1]}` : null;
  } catch {
    return null;
  }
}

export function sourceMatchesArchiveHost(
  source: unknown,
  hostKind: ArchiveHostKind,
): boolean {
  if (typeof source !== "string") return false;
  const normalized = source.trim().toLowerCase();
  return hostKind === "ao3"
    ? normalized === "ao3" ||
        normalized === "archiveofourown.org" ||
        normalized === "archiveofourown.gay" ||
        normalized === "archive.transformativeworks.org"
    : normalized === "ffn" || normalized === "fanfiction.net";
}
