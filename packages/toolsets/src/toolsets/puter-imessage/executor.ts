import type { PuterContactIdentity, PuterToolsetRecord, ToolsetExecutionContext } from "../../types.js";
import {
  byTimestampAscending,
  byTimestampDescending,
  clampLimit,
  isWithinWindow,
  isVisibleImessageRecord,
  normalizeLocalUserImessageRecord,
  paginateItems,
  paginateNewestWindow,
  parseOptionalDate,
  recordMatchesExcludedHandle,
  recordMatchesQuery,
  summarizeRecord,
} from "../../utils.js";
import type { HistoryInput, ListChatsInput, LoadAttachmentInput, ReadThreadInput, SearchMessagesInput } from "./schemas.js";

const defaultLimit = 25;
const maxLimit = 100;

export function listChats(args: ListChatsInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return context.executeCommand({ toolset: "puter.imessage", command: "list_chats", args }, { abortSignal: context.abortSignal });
  }

  const since = parseOptionalDate(args.since);
  const limit = clampLimit(args.limit, defaultLimit, maxLimit);
  const chats = new Map<string, {
    threadId: string;
    chatId?: number;
    title: string;
    participants: Set<string>;
    participantDetails: Map<string, PuterContactIdentity>;
    lastMessageAt: string;
    messageCount: number;
    sample: string;
  }>();

  for (const record of (context.records ?? [])
    .filter((record) => record.sourceType === "imessage")
    .filter(isVisibleImessageRecord)
    .map(normalizeLocalUserImessageRecord)
    .filter((record) => !recordMatchesExcludedHandle(record, context.excludedHandles))) {
    const timestamp = parseOptionalDate(record.timestamp);
    if (since && timestamp && timestamp < since) {
      continue;
    }

    const threadId = record.threadId ?? record.sourceId;
    const chatId = typeof record.metadata.chatRowId === "number" ? record.metadata.chatRowId : undefined;
    const existing = chats.get(threadId);
    const participants = new Set(existing?.participants ?? []);
    if (record.sender) {
      participants.add(record.sender);
    }
    for (const recipient of record.recipients) {
      participants.add(recipient);
    }
    const participantDetails = new Map(existing?.participantDetails ?? []);
    if (record.senderContact) {
      participantDetails.set(record.senderContact.handle, record.senderContact);
    }
    for (const contact of record.recipientContacts ?? []) {
      participantDetails.set(contact.handle, contact);
    }

    const next = {
      threadId,
      chatId: existing?.chatId ?? chatId,
      title: existing?.title || record.title,
      participants,
      participantDetails,
      lastMessageAt: existing && Date.parse(existing.lastMessageAt) > (Date.parse(record.timestamp) || 0)
        ? existing.lastMessageAt
        : record.timestamp,
      messageCount: (existing?.messageCount ?? 0) + 1,
      sample: existing?.sample || record.content.slice(0, 240),
    };
    chats.set(threadId, next);
  }

  const { items, nextCursor, previousCursor, total } = paginateItems(
    [...chats.values()]
      .sort((left, right) => (Date.parse(right.lastMessageAt) || 0) - (Date.parse(left.lastMessageAt) || 0)),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    windowStart: context.windowStart!.toISOString(),
    windowEnd: context.windowEnd!.toISOString(),
    chats: items.map((chat) => ({
      ...chat,
      participants: [...chat.participants],
      participantDetails: [...chat.participantDetails.values()],
    })),
    nextCursor,
    previousCursor,
    total,
  };
}

export function searchMessages(args: SearchMessagesInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return executeLiveImessageCommand(context, "search_messages", args);
  }

  const limit = clampLimit(args.limit, defaultLimit, maxLimit);
  const { items, nextCursor, previousCursor, total } = paginateItems(
    (context.records ?? [])
      .filter((record) => record.sourceType === "imessage")
      .filter(isVisibleImessageRecord)
      .map(normalizeLocalUserImessageRecord)
      .filter((record) => !recordMatchesExcludedHandle(record, context.excludedHandles))
      .filter((record) => !args.threadId || record.threadId === args.threadId)
      .filter((record) => isWithinWindow(record, args.start, args.end))
      .filter((record) => recordMatchesQueryWithMode(record, args.query, args.match))
      .sort(byTimestampDescending),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    messages: items.map((record) => summarizeRecord(record, 1000)),
    nextCursor,
    previousCursor,
    total,
  };
}

export function search(args: SearchMessagesInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return executeLiveImessageCommand(context, "search", args);
  }

  return searchMessages(args, context);
}

export function readThread(args: ReadThreadInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return executeLiveImessageCommand(context, "read_thread", args);
  }

  const limit = clampLimit(args.limit, 50, 200);
  const { items, nextCursor, previousCursor, total } = paginateNewestWindow(
    (context.records ?? [])
      .filter((record) => record.sourceType === "imessage")
      .filter(isVisibleImessageRecord)
      .map(normalizeLocalUserImessageRecord)
      .filter((record) => !recordMatchesExcludedHandle(record, context.excludedHandles))
      .filter((record) => record.threadId === args.threadId)
      .filter((record) => isWithinWindow(record, args.start, args.end))
      .sort(byTimestampAscending),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    threadId: args.threadId,
    messages: items.map((record) => summarizeRecord(record, 1600)),
    nextCursor,
    previousCursor,
    total,
  };
}

export function history(args: HistoryInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return executeLiveImessageCommand(context, "history", args);
  }

  const limit = clampLimit(args.limit, 50, 200);
  const { items, nextCursor, previousCursor, total } = paginateNewestWindow(
    (context.records ?? [])
      .filter((record) => record.sourceType === "imessage")
      .filter(isVisibleImessageRecord)
      .map(normalizeLocalUserImessageRecord)
      .filter((record) => !recordMatchesExcludedHandle(record, context.excludedHandles))
      .filter((record) => {
        if (args.threadId) {
          return record.threadId === args.threadId;
        }
        return String(record.metadata.chatRowId ?? "") === args.chatId;
      })
      .filter((record) => isWithinWindow(record, args.start, args.end))
      .sort(byTimestampAscending),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    chatId: args.chatId,
    threadId: args.threadId,
    messages: items.map((record) => summarizeRecord(record, 1600)),
    nextCursor,
    previousCursor,
    total,
  };
}

export function loadAttachment(args: LoadAttachmentInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return context.executeCommand({ toolset: "puter.imessage", command: "load_attachment", args }, { abortSignal: context.abortSignal });
  }

  throw new Error("load_attachment requires the live Puter bridge.");
}

function recordMatchesQueryWithMode(
  record: Parameters<typeof recordMatchesQuery>[0],
  query: string,
  matchMode: "contains" | "exact",
): boolean {
  if (matchMode === "contains") {
    return recordMatchesQuery(record, query);
  }

  const normalizedQuery = query.trim().toLowerCase();
  return [
    record.title,
    record.content,
    record.sender ?? "",
    record.senderContact?.displayName ?? "",
    record.threadId ?? "",
    record.sourceId,
    ...record.recipients,
    ...(record.recipientContacts?.map((contact) => contact.displayName) ?? []),
    ...(record.attachments?.flatMap((attachment) => [
      attachment.filename ?? "",
      attachment.transferName ?? "",
      attachment.mimeType ?? "",
      attachment.uti ?? "",
    ]) ?? []),
  ].some((value) => value.toLowerCase() === normalizedQuery);
}

async function executeLiveImessageCommand(
  context: ToolsetExecutionContext,
  command: "search_messages" | "search" | "read_thread" | "history",
  args: SearchMessagesInput | ReadThreadInput | HistoryInput,
): Promise<unknown> {
  const executeCommand = context.executeCommand;
  if (!executeCommand) {
    throw new Error("Live Puter command bridge is not configured.");
  }

  const result = await executeCommand(
    { toolset: "puter.imessage", command, args },
    { abortSignal: context.abortSignal },
  );
  return normalizeLiveImessageResult(result);
}

function normalizeLiveImessageResult(result: unknown): unknown {
  if (!isRecordObject(result) || !Array.isArray(result.messages)) {
    return result;
  }

  return {
    ...result,
    messages: result.messages.map((message) => {
      if (!isPuterImessageRecord(message)) {
        return message;
      }
      return normalizeLocalUserImessageRecord(message);
    }),
  };
}

function isPuterImessageRecord(value: unknown): value is PuterToolsetRecord {
  return isRecordObject(value)
    && value.sourceType === "imessage"
    && typeof value.sourceId === "string"
    && Array.isArray(value.recipients)
    && typeof value.title === "string"
    && typeof value.timestamp === "string"
    && typeof value.content === "string"
    && isRecordObject(value.metadata);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
