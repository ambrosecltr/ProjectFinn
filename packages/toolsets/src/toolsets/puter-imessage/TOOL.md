# Puter iMessage

Use this read-only Finn JS workspace API namespace to inspect iMessage and SMS context from the user's paired Mac when this run has live Puter access. Calls run through `finn.puter.imessage.*` against the active paired Mac.

Finn's own chat/line and archived or deleted Messages conversations are excluded before results reach the model. Do not try to inspect or retain Finn conversation history from this toolset.

## Finn JS workspace API shape

Use the typed APIs discovered by `workspace_search`:

```js
await finn.puter.imessage.chats({ limit: 25 });
await finn.puter.imessage.history({ chatId: "42", limit: 50, attachments: true });
await finn.puter.imessage.loadAttachment({ path: "~/Library/Messages/Attachments/...", maxBytes: 5000000 });
await finn.puter.imessage.search({ query: "Project Atlas", limit: 25 });
await finn.puter.imessage.readThread({ threadId: "thread_project", limit: 50 });
```

The runtime validates input objects and rejects unknown fields.

## APIs

- `finn.puter.imessage.chats({ limit, cursor, since })`
  Start here for broad coverage. It returns recent thread IDs, titles, raw participant handles, saved contact names when available in `participantDetails`, latest timestamps, message counts, and a small sample.
- `finn.puter.imessage.history({ chatId, threadId, attachments, start, end, limit, cursor })`
  Read a specific chat after `chats` or `search` shows it may contain durable context. Long chats return newest messages first; if `total` is greater than the returned message count, keep paging with `nextCursor` before treating the chat as covered. `attachments: true` keeps attachment metadata visible on messages that have files.
- `finn.puter.imessage.search({ query, match, threadId, start, end, limit, cursor })`
  Search message bodies, titles, senders, recipients, saved contact names when available, and thread IDs. Use targeted searches for people, projects, organizations, places, and durable responsibilities.
- `finn.puter.imessage.loadAttachment({ path, maxBytes })`
  Load a bounded attachment from a path returned in message `attachments`. This returns filename, MIME type, byte count, and base64 data from the paired Mac. Use it only for high-signal attachments that need visual or file-level inspection.
- Legacy aliases are still available as JS APIs: `listChats`, `readThread`, and `searchMessages`.
- `finn.puter.imessage.readThread({ threadId, start, end, limit, cursor })`
  Inspect a specific thread after `list_chats` or `search_messages` shows it may contain durable context. Long threads return newest messages first; if `total` is greater than the returned message count, keep paging with `nextCursor` before treating the thread as covered.

All list/search/thread reads accept `limit` and optional `cursor`. When a result includes `nextCursor`, call the same API again with `cursor: nextCursor` to continue that result set.

You can run independent reads back-to-back when useful, for example a broad chat list plus a targeted message search. Do not batch a follow-up API call that depends on the previous result's IDs or cursor.

## Guidance

- For Personal Intelligence runs, sample across the provided ingestion window before retaining. General workers are not limited to a PI ingestion window; use normal pagination and targeted searches for the user task.
- For Personal Intelligence retains, use the server-provided durable Puter account scope `puter:local`. Treat `puter:<deviceId>` as live bridge transport only; do not derive account identity from Mac names, device IDs, iMessage handles, local sender handles, Apple IDs, or iCloud aliases.
- Do not stop on the first page of a relevant result set while `nextCursor` is present; keep paging until coverage is sufficient or the category is exhausted.
- Prefer bidirectional/user-authored evidence when available. `direction: "sent_by_user"`, `sender: "me"`, `metadata.localUser: true`, or `metadata.isFromMe` means the message was sent by the user's local Messages account. Saved contact names are convenience labels; preserve raw handles and stable IDs in retained metadata.
- Sent messages may include `metadata.localSenderHandle`; this is the user's own Messages/iCloud sending alias, not another contact or participant.
- Preserve source provenance in retained memory: `toolkitSlug: "puter"`, `sourceType: "imessage"`, `sourceId`, `messageId`, `threadId`, timestamp, direction, sender, recipients, and useful flat metadata like `rowId`, `chatRowId`, `chatGuid`, `isFromMe`, and `localUser`.
- When messages include `attachments`, inspect the filename, MIME/UTI, byte count, missing flag, and resolved path. Use `load_attachment` for high-signal image/file attachments that need direct inspection, and record a coverage gap if the attachment itself cannot be loaded in this run.
- Retain concise durable summaries, not raw transcripts. Relationship, household, project, recurring responsibility, preference, or long-lived constraint context is high signal.
- Skip routine logistics, transient plans, one-off small talk, promotions, and low-signal notifications.
- If a thread looks important but the available local batch does not cover enough history, record that coverage gap in the checkpoint rather than guessing.
