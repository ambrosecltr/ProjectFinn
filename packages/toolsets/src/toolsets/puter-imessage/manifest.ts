import type { ToolsetManifest } from "../../types.js";
import { historyInputSchema, listChatsInputSchema, loadAttachmentInputSchema, readThreadInputSchema, searchMessagesInputSchema } from "./schemas.js";

export const puterImessageManifest: ToolsetManifest = {
  slug: "puter.imessage",
  displayName: "Puter iMessage",
  description: "Read-only Finn JS workspace navigation over local iMessage/SMS records on the user's paired Mac.",
  capability: "read",
  processTypes: ["worker", "personal_intelligence"],
  connectorGate: {
    toolkitSlug: "puter",
    enabledTool: "puter.imessage",
  },
  defaultLimit: 25,
  maxLimit: 100,
  commands: [
    {
      name: "chats",
      description: "List recent iMessage/SMS chats with imsg-style chat IDs, raw handles, saved names when available, counts, and latest timestamps.",
      inputSchema: listChatsInputSchema,
      argumentGuidance: [
        "limit caps returned chats. Use cursor to continue when nextCursor is present.",
        "since accepts an ISO timestamp to limit broad coverage by recency.",
      ],
      examples: [
        { purpose: "Start broad iMessage coverage", code: "await finn.puter.imessage.chats({ limit: 25 })" },
        { purpose: "Page additional chats", code: "await finn.puter.imessage.chats({ limit: 25, cursor: \"25\" })" },
        { purpose: "List chats updated since a time", code: "await finn.puter.imessage.chats({ limit: 25, since: \"2026-05-01T00:00:00.000Z\" })" },
      ],
      outputGuidance: [
        "Use returned chatId/threadId values with history. If nextCursor is present, continue when coverage matters.",
      ],
    },
    {
      name: "history",
      description: "Read iMessage/SMS history for one chatId or threadId with cursor pagination and optional attachment metadata.",
      inputSchema: historyInputSchema,
      argumentGuidance: [
        "Provide chatId or threadId from chats/search results.",
        "attachments includes attachment metadata; use it when files or images may be important.",
        "start and end accept ISO timestamps. cursor continues older/newer pages according to the returned cursor.",
      ],
      examples: [
        { purpose: "Read a specific chat with attachments visible", code: "await finn.puter.imessage.history({ chatId: \"42\", limit: 50, attachments: true })" },
        { purpose: "Read a thread in a bounded time window", code: "await finn.puter.imessage.history({ threadId: \"thread_project\", start: \"2026-05-01T00:00:00.000Z\", end: \"2026-05-21T00:00:00.000Z\", limit: 50 })" },
        { purpose: "Page a chat when nextCursor is present", code: "await finn.puter.imessage.history({ chatId: \"42\", limit: 50, cursor: \"50\" })" },
      ],
      outputGuidance: [
        "Messages may be newest-first. Keep paging when nextCursor is present and coverage matters.",
        "Sent rows from the local user are normalized with direction sent_by_user, sender me, metadata.localUser true, and metadata.sourceDirection sent_or_authored_by_user.",
        "If metadata.localSenderHandle is present, it is the user's own Messages/iCloud sending alias, not another contact.",
      ],
    },
    {
      name: "search",
      description: "Search local iMessage/SMS history with contains or exact matching.",
      inputSchema: searchMessagesInputSchema,
      argumentGuidance: [
        "query searches message bodies, titles, senders, recipients, saved contact names when available, and thread IDs.",
        "match is contains or exact. Use contains for discovery and exact for known IDs/names/phrases.",
        "threadId narrows search after you identify a relevant thread.",
      ],
      examples: [
        { purpose: "Search messages for a project", code: "await finn.puter.imessage.search({ query: \"Project Atlas\", limit: 25 })" },
        { purpose: "Search one thread exactly", code: "await finn.puter.imessage.search({ query: \"invoice\", match: \"exact\", threadId: \"thread_project\", limit: 25 })" },
        { purpose: "Search within a PI window", code: "await finn.puter.imessage.search({ query: \"decision\", start: \"2026-05-01T00:00:00.000Z\", end: \"2026-05-21T00:00:00.000Z\", limit: 25 })" },
      ],
      outputGuidance: [
        "Use returned chat/thread IDs with history for full context before retaining or summarizing durable facts.",
      ],
    },
    {
      name: "load_attachment",
      description: "Load one Messages attachment from the paired Mac by resolved Mac-local attachment path, returning bounded base64 data and metadata for inspection.",
      inputSchema: loadAttachmentInputSchema,
      argumentGuidance: [
        "path must be a resolved Puter/Mac-local attachment path returned in message attachment metadata. It is not a Finn /workspace or /artifacts path.",
        "maxBytes bounds attachment bytes. Use it only for high-signal attachments that need direct inspection.",
      ],
      examples: [
        { purpose: "Load a bounded attachment returned by history", code: "await finn.puter.imessage.loadAttachment({ path: \"~/Library/Messages/Attachments/12/34/report.pdf\", maxBytes: 5000000 })" },
      ],
      outputGuidance: [
        "The result contains metadata and base64 bytes. Record a coverage gap if a relevant attachment is missing or cannot be loaded.",
      ],
    },
    {
      name: "list_chats",
      description: "List recently active iMessage/SMS chats with cursor pagination, participants, message counts, and latest timestamps.",
      inputSchema: listChatsInputSchema,
      argumentGuidance: [
        "Legacy alias for chats. Prefer finn.puter.imessage.chats in new plans.",
      ],
      examples: [
        { purpose: "Legacy broad chat list", code: "await finn.puter.imessage.listChats({ limit: 25 })" },
      ],
    },
    {
      name: "search_messages",
      description: "Search local iMessage/SMS message text, senders, recipients, titles, and thread IDs with cursor pagination.",
      inputSchema: searchMessagesInputSchema,
      argumentGuidance: [
        "Legacy alias for search. Prefer finn.puter.imessage.search in new plans.",
      ],
      examples: [
        { purpose: "Legacy message search", code: "await finn.puter.imessage.searchMessages({ query: \"Project Atlas\", limit: 25 })" },
      ],
    },
    {
      name: "read_thread",
      description: "Read messages from one iMessage/SMS thread by threadId with cursor pagination for older history.",
      inputSchema: readThreadInputSchema,
      argumentGuidance: [
        "Legacy thread read. Prefer finn.puter.imessage.history with threadId in new plans.",
      ],
      examples: [
        { purpose: "Legacy thread read", code: "await finn.puter.imessage.readThread({ threadId: \"thread_project\", limit: 50 })" },
      ],
    },
  ],
  instructions: {
    overview: [
      "Use this read-only toolset to inspect iMessage/SMS context from the user's paired Mac when live Puter access is available.",
      "Start broad with chats or targeted with search, then use history for full context before making durable claims.",
    ],
    referenceFormats: [
      "chat IDs come from chats/search results and are passed as chatId.",
      "thread IDs come from chats/search/history results and are passed as threadId.",
      "attachment paths come from message attachment metadata and are passed as path to finn.puter.imessage.loadAttachment. They are Puter/Mac-local paths, not Finn /workspace or /artifacts paths.",
    ],
    syntaxRules: [
      "Use ISO timestamps for since, start, and end.",
      "Batch independent reads only. Do not batch a follow-up history command that needs an ID from a previous result.",
      "When nextCursor is present, repeat the same API call with cursor to continue.",
    ],
    safetyRules: [
      "Finn's own chat/line and archived or deleted Messages conversations are excluded before results reach the model.",
      "Retain concise durable summaries, not raw transcripts. Skip routine logistics and low-signal small talk.",
      "Do not guess when local history does not cover enough context; record a coverage gap.",
    ],
    outputGuidance: [
      "Preserve source provenance when retaining memory: toolkitSlug puter, accountScopeId puter:local, sourceType imessage, sourceId/messageId/threadId, timestamp, direction, sender, recipients, and useful flat metadata.",
      "Treat puter:<deviceId> as live bridge transport only. Do not derive Personal Intelligence account identity from device IDs, Mac names, iMessage handles, Apple IDs, or iCloud aliases.",
      "For direction sent_by_user or metadata.localUser true, describe the sender as the local user/me. Do not turn metadata.localSenderHandle into a separate person.",
    ],
  },
};
