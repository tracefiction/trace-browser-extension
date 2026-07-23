import type { StoryTrackCommand } from "../extension-core/index.mjs";
import type { RuntimeMessageSender } from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  sourceMatchesArchiveHost,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";

const MAX_TRACK_PAYLOAD_BYTES = 64 * 1_024;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COMMAND_TYPES = Object.freeze({
  connectAndSave: "TRACE_CONNECT_AND_SAVE",
  quickAdd: "TRACE_QUICK_ADD",
  autoTrack: "TRACE_AUTO_TRACK",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function progressTarget(
  item: Readonly<Record<string, unknown>>,
): Readonly<{ current: number; total: number | null }> | null {
  if (!Number.isSafeInteger(item.chn) || (item.chn as number) < 1) return null;
  const chapter = item.chn as number;
  const rawTotal = Number.isSafeInteger(item.cht) && (item.cht as number) > 0
    ? item.cht as number
    : Number.isSafeInteger(item.chPub) && (item.chPub as number) > 0
      ? item.chPub as number
      : null;
  return Object.freeze({
    current: chapter > 1 ? chapter : 0,
    total: rawTotal,
  });
}

function cloneBoundedPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!serialized || serialized.length > MAX_TRACK_PAYLOAD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  return isRecord(parsed) ? Object.freeze(parsed) : null;
}

export function storyTrackCommandFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
): StoryTrackCommand | null {
  if (!isRecord(message)) return null;
  const hostKind = archiveHostKindFromSender(sender);
  if (hostKind === null) return null;
  const senderUrl = sender?.tab?.url ?? sender?.url;
  if (isBlockedArchivePath(senderUrl, hostKind)) return null;
  const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind);

  const payload = cloneBoundedPayload(message.payload);
  if (payload === null || !sourceMatchesArchiveHost(payload.s, hostKind)) return null;
  if (typeof payload.at !== "string" || payload.at.length === 0 || payload.at.length > 128) {
    return null;
  }
  if (!isRecord(payload.item)) return null;
  if (!sourceMatchesArchiveHost(payload.item.src, hostKind)) return null;
  const payloadWorkKey = workKeyFromArchiveUrl(payload.item.u, hostKind);
  if (payloadWorkKey === null) return null;

  const messageType = typeof message.type === "string" ? message.type : "";
  const context = payload.item.ctx;
  let intent: "ensure_saved" | "record_progress";
  let progress: Readonly<{ current: number; total: number | null }> | undefined;
  if (messageType === COMMAND_TYPES.autoTrack) {
    if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
      return null;
    }
    const target = progressTarget(payload.item);
    if (target === null) return null;
    intent = "record_progress";
    progress = target;
  } else if (messageType === COMMAND_TYPES.connectAndSave) {
    if (context !== "story" || senderWorkKey === null || payloadWorkKey !== senderWorkKey) {
      return null;
    }
    intent = "ensure_saved";
  } else if (messageType === COMMAND_TYPES.quickAdd) {
    if (context !== "story" && context !== "listing" && context !== "bookmark") return null;
    if (senderWorkKey !== null && (context !== "story" || payloadWorkKey !== senderWorkKey)) {
      return null;
    }
    if (senderWorkKey === null && context === "story") return null;
    intent = "ensure_saved";
  } else {
    return null;
  }

  const claimedWorkKey = typeof message.workKey === "string" ? message.workKey.trim() : "";
  if (claimedWorkKey && claimedWorkKey !== payloadWorkKey) return null;
  const rawHandoffId =
    typeof message.handoffId === "string" ? message.handoffId.trim() : "";
  const handoffId =
    messageType === COMMAND_TYPES.connectAndSave &&
    HANDOFF_ID_PATTERN.test(rawHandoffId)
      ? rawHandoffId
      : undefined;

  return Object.freeze({
    intent,
    hostKind,
    workKey: payloadWorkKey,
    payload,
    ...(progress === undefined ? {} : { progress }),
    ...(handoffId === undefined ? {} : { handoffId }),
  });
}
