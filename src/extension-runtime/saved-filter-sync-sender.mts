import type { RuntimeMessageSender } from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
} from "./archive-sender.mjs";

export const SAVED_FILTER_SYNC_MESSAGE =
  "TRACE_AO3_SAVED_FILTERS_SYNC_REQUEST" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSavedFilterSyncRequest(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
): boolean {
  if (
    !isRecord(message) ||
    Object.keys(message).length !== 1 ||
    message.type !== SAVED_FILTER_SYNC_MESSAGE ||
    archiveHostKindFromSender(sender) !== "ao3"
  ) {
    return false;
  }
  const senderUrl = sender?.tab?.url ?? sender?.url;
  return !isBlockedArchivePath(senderUrl, "ao3");
}
