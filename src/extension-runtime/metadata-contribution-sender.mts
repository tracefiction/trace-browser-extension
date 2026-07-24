import type {
  MetadataContributionCommand,
} from "../extension-core/index.mjs";
import type { RuntimeMessageSender } from "./browser-platform.mjs";
import {
  archiveHostKindFromSender,
  isBlockedArchivePath,
  sourceMatchesArchiveHost,
  workKeyFromArchiveUrl,
} from "./archive-sender.mjs";

const MAX_STORY_METADATA_BYTES = 64 * 1_024;
const MAX_LIBRARY_REFRESH_BYTES = 512 * 1_024;
const MAX_LIBRARY_REFRESH_ITEMS = 100;
const MAX_METADATA_ARRAY_ITEMS = 200;
const MAX_METADATA_INTEGER = 100_000_000;
const SOURCE_STORY_ID_PATTERN = /^[1-9][0-9]{0,39}$/;
const LIBRARY_REFRESH_FIELDS = new Set([
  "source",
  "sourceStoryId",
  "url",
  "title",
  "author",
  "summary",
  "chapters",
  "chaptersPublished",
  "chaptersPlanned",
  "words",
  "status",
  "updatedAt",
  "publishedAt",
  "rating",
  "language",
  "fandoms",
  "characters",
  "relationships",
  "genre",
]);
const STRING_LIMITS = Object.freeze({
  title: 300,
  author: 120,
  summary: 20_000,
  status: 60,
  updatedAt: 50,
  publishedAt: 50,
  rating: 60,
  language: 60,
  genre: 100,
} as const);
const INTEGER_FIELDS = Object.freeze([
  "chapters",
  "chaptersPublished",
  "chaptersPlanned",
  "words",
] as const);
const ARRAY_FIELDS = Object.freeze([
  "fandoms",
  "characters",
  "relationships",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneBoundedRecord(
  value: unknown,
  maxBytes: number,
): Readonly<Record<string, unknown>> | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (
    !serialized ||
    new TextEncoder().encode(serialized).byteLength > maxBytes
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

function validOptionalString(
  value: unknown,
  maxLength: number,
): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function validOptionalInteger(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (
      Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= MAX_METADATA_INTEGER
    )
  );
}

function validOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (
      Array.isArray(value) &&
      value.length <= MAX_METADATA_ARRAY_ITEMS &&
      value.every(
        (item) =>
          item === null ||
          (typeof item === "string" && item.length <= 255),
      )
    )
  );
}

function refreshItemWorkKey(
  item: Readonly<Record<string, unknown>>,
  hostKind: "ao3" | "ffn",
): string | null {
  if (
    item.source !== hostKind ||
    Object.keys(item).some((key) => !LIBRARY_REFRESH_FIELDS.has(key))
  ) {
    return null;
  }
  const rawId =
    typeof item.sourceStoryId === "string" ? item.sourceStoryId.trim() : "";
  if (rawId && !SOURCE_STORY_ID_PATTERN.test(rawId)) return null;
  const urlWorkKey =
    item.url === undefined
      ? null
      : workKeyFromArchiveUrl(item.url, hostKind);
  if (item.url !== undefined && urlWorkKey === null) return null;
  const idWorkKey = rawId ? `${hostKind}:${rawId}` : null;
  if (urlWorkKey !== null && idWorkKey !== null && urlWorkKey !== idWorkKey) {
    return null;
  }
  const workKey = urlWorkKey ?? idWorkKey;
  if (workKey === null) return null;

  for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
    if (!validOptionalString(item[field], maxLength)) return null;
  }
  for (const field of INTEGER_FIELDS) {
    if (!validOptionalInteger(item[field])) return null;
  }
  for (const field of ARRAY_FIELDS) {
    if (!validOptionalStringArray(item[field])) return null;
  }
  return workKey;
}

function storyMetadataCommand(
  message: Readonly<Record<string, unknown>>,
  hostKind: "ao3" | "ffn",
  senderUrl: unknown,
): MetadataContributionCommand | null {
  const senderWorkKey = workKeyFromArchiveUrl(senderUrl, hostKind);
  if (senderWorkKey === null) return null;
  const payload = cloneBoundedRecord(message.payload, MAX_STORY_METADATA_BYTES);
  if (
    payload === null ||
    !sourceMatchesArchiveHost(payload.s, hostKind) ||
    typeof payload.at !== "string" ||
    payload.at.length === 0 ||
    payload.at.length > 500 ||
    !isRecord(payload.item) ||
    payload.item.ctx !== "story" ||
    typeof payload.item.t !== "string" ||
    payload.item.t.trim().length === 0 ||
    payload.item.t.length > 300 ||
    !sourceMatchesArchiveHost(payload.item.src, hostKind) ||
    workKeyFromArchiveUrl(payload.item.u, hostKind) !== senderWorkKey
  ) {
    return null;
  }
  return Object.freeze({
    kind: "story_metadata",
    hostKind,
    workKeys: Object.freeze([senderWorkKey]) as readonly [string],
    payload,
  });
}

function libraryMetadataRefreshCommand(
  message: Readonly<Record<string, unknown>>,
  hostKind: "ao3" | "ffn",
  senderUrl: unknown,
): MetadataContributionCommand | null {
  if (workKeyFromArchiveUrl(senderUrl, hostKind) !== null) return null;
  const payload = cloneBoundedRecord(message.payload, MAX_LIBRARY_REFRESH_BYTES);
  if (
    payload === null ||
    Object.keys(payload).length !== 1 ||
    !Array.isArray(payload.items) ||
    payload.items.length < 1 ||
    payload.items.length > MAX_LIBRARY_REFRESH_ITEMS
  ) {
    return null;
  }
  const workKeys: string[] = [];
  const seen = new Set<string>();
  for (const item of payload.items) {
    if (!isRecord(item)) return null;
    const workKey = refreshItemWorkKey(item, hostKind);
    if (workKey === null) return null;
    if (!seen.has(workKey)) {
      seen.add(workKey);
      workKeys.push(workKey);
    }
  }
  return Object.freeze({
    kind: "library_metadata_refresh",
    hostKind,
    workKeys: Object.freeze(workKeys),
    payload,
  });
}

export function metadataContributionCommandFromMessage(
  message: unknown,
  sender: RuntimeMessageSender | undefined,
): MetadataContributionCommand | null {
  if (!isRecord(message)) return null;
  const hostKind = archiveHostKindFromSender(sender);
  if (hostKind === null) return null;
  const senderUrl = sender?.tab?.url ?? sender?.url;
  if (isBlockedArchivePath(senderUrl, hostKind)) return null;
  if (message.type === "TRACE_METADATA_BROADCAST") {
    return storyMetadataCommand(message, hostKind, senderUrl);
  }
  if (message.type === "TRACE_LIBRARY_METADATA_REFRESH") {
    return libraryMetadataRefreshCommand(message, hostKind, senderUrl);
  }
  return null;
}
