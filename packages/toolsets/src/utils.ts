import { formatUnknownError } from "@finn/core";
import type { PuterToolsetRecord } from "./types.js";

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}

export interface PaginationResult<T> {
  items: T[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

export function paginateItems<T>(items: T[], input: { cursor?: string; limit: number }): PaginationResult<T> {
  const offset = parseCursor(input.cursor);
  const page = items.slice(offset, offset + input.limit);
  return {
    items: page,
    ...createPagination({
      limit: input.limit,
      total: items.length,
      offset,
      returned: page.length,
      hasMore: offset + page.length < items.length,
    }),
  };
}

export function paginateNewestWindow<T>(items: T[], input: { cursor?: string; limit: number }): PaginationResult<T> {
  const offset = parseCursor(input.cursor);
  const end = Math.max(0, items.length - offset);
  const start = Math.max(0, end - input.limit);
  const page = items.slice(start, end);
  return {
    items: page,
    ...createPagination({
      limit: input.limit,
      total: items.length,
      offset,
      returned: page.length,
      hasMore: start > 0,
    }),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function parseOptionalDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isWithinWindow(record: PuterToolsetRecord, start?: string, end?: string): boolean {
  const timestamp = parseOptionalDate(record.timestamp);
  if (!timestamp) {
    return true;
  }
  const startDate = parseOptionalDate(start);
  if (startDate && timestamp < startDate) {
    return false;
  }
  const endDate = parseOptionalDate(end);
  return !(endDate && timestamp > endDate);
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function recordMatchesQuery(record: PuterToolsetRecord, query: string): boolean {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return true;
  }

  return [
    record.title,
    record.content,
    record.sender ?? "",
    record.senderContact?.displayName ?? "",
    record.recipients.join(" "),
    record.recipientContacts?.map((contact) => contact.displayName).join(" ") ?? "",
    record.attachments?.map((attachment) => [
      attachment.filename ?? "",
      attachment.transferName ?? "",
      attachment.mimeType ?? "",
      attachment.uti ?? "",
    ].join(" ")).join(" ") ?? "",
    record.threadId ?? "",
    record.sourceId,
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function recordMatchesExcludedHandle(record: PuterToolsetRecord, excludedHandles: readonly string[] | undefined): boolean {
  const excluded = new Set((excludedHandles ?? []).flatMap(handleLookupKeys));
  if (excluded.size === 0) {
    return false;
  }

  return [
    record.sender ?? "",
    record.threadId ?? "",
    record.title,
    ...record.recipients,
  ].flatMap(handleLookupKeys).some((key) => excluded.has(key));
}

export function isVisibleImessageRecord(record: PuterToolsetRecord): boolean {
  if (record.sourceType !== "imessage") {
    return true;
  }

  const metadata = record.metadata;
  return ![
    metadata.isArchive,
    metadata.isArchived,
    metadata.messageIsArchive,
    metadata.chatIsArchived,
    metadata.isDeleted,
    metadata.messageIsDeleted,
    metadata.chatIsDeleted,
    metadata.dateDeleted,
    metadata.dateRetracted,
    metadata.chatDateDeleted,
    metadata.messageDateDeleted,
    metadata.isRecoverable,
    metadata.isSpam,
    metadata.messageIsSpam,
    metadata.chatIsBlackholed,
  ].some(isTruthyMetadataFlag);
}

export function byTimestampDescending(left: PuterToolsetRecord, right: PuterToolsetRecord): number {
  return (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0);
}

export function byTimestampAscending(left: PuterToolsetRecord, right: PuterToolsetRecord): number {
  return (Date.parse(left.timestamp) || 0) - (Date.parse(right.timestamp) || 0);
}

export function summarizeRecord(record: PuterToolsetRecord, contentLimit = 700) {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.direction ? { direction: record.direction } : {}),
    ...(record.sender ? { sender: record.sender } : {}),
    ...(record.senderContact ? { senderContact: record.senderContact } : {}),
    recipients: record.recipients,
    ...(record.recipientContacts?.length ? { recipientContacts: record.recipientContacts } : {}),
    title: record.title,
    timestamp: record.timestamp,
    content: truncate(record.content, contentLimit),
    ...(record.attachments?.length ? { attachments: record.attachments } : {}),
    metadata: record.metadata,
  };
}

export function normalizeLocalUserImessageRecord(
  record: PuterToolsetRecord,
): PuterToolsetRecord {
  if (record.sourceType !== "imessage" || !isTruthyMetadataFlag(record.metadata.isFromMe)) {
    return record;
  }

  const metadata: Record<string, unknown> = {
    ...record.metadata,
    localUser: true,
    sourceDirection: "sent_or_authored_by_user",
  };
  delete metadata.senderDisplayName;
  const destinationCallerId = metadata.destinationCallerId;
  delete metadata.destinationCallerId;
  if (typeof destinationCallerId === "string" && destinationCallerId.trim()) {
    metadata.localSenderHandle = destinationCallerId.trim();
  } else if (typeof destinationCallerId === "number" && Number.isFinite(destinationCallerId)) {
    metadata.localSenderHandle = String(destinationCallerId);
  }

  const next: PuterToolsetRecord = {
    ...record,
    direction: "sent_by_user",
    sender: "me",
    metadata,
  };
  delete next.senderContact;
  return next;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatToolsetError(error: unknown): string {
  return formatUnknownError(error, { zodPrefix: "Validation failed" });
}

function createPagination(input: {
  limit: number;
  total: number;
  offset: number;
  returned: number;
  hasMore: boolean;
}) {
  return {
    total: input.total,
    nextCursor: input.hasMore ? String(input.offset + input.returned) : null,
    previousCursor: input.offset > 0 ? String(Math.max(0, input.offset - input.limit)) : null,
  };
}

function handleLookupKeys(handle: string): string[] {
  const normalized = handle.trim().toLowerCase();
  const digits = normalized.replace(/\D+/g, "");
  const keys = [];
  if (normalized) {
    keys.push(normalized);
  }
  if (digits) {
    keys.push(digits);
    if (digits.length > 10) {
      keys.push(digits.slice(-10));
    }
  }
  return keys;
}

function isTruthyMetadataFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "null";
  }
  return false;
}
