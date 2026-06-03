import type { ToolsetExecutionContext } from "../../types.js";
import {
  byTimestampDescending,
  clampLimit,
  isWithinWindow,
  paginateItems,
  parseOptionalDate,
  recordMatchesQuery,
  summarizeRecord,
} from "../../utils.js";
import type { GetNoteInput, ListNotesInput, SearchNotesInput } from "./schemas.js";

const defaultLimit = 25;
const maxLimit = 100;

export function listNotes(args: ListNotesInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return context.executeCommand({ toolset: "puter.notes", command: "list_notes", args }, { abortSignal: context.abortSignal });
  }

  const modifiedAfter = parseOptionalDate(args.modifiedAfter);
  const limit = clampLimit(args.limit, defaultLimit, maxLimit);

  const { items, nextCursor, previousCursor, total } = paginateItems(
    (context.records ?? [])
      .filter((record) => record.sourceType === "notes")
      .filter((record) => {
        const timestamp = parseOptionalDate(record.timestamp);
        return !modifiedAfter || !timestamp || timestamp >= modifiedAfter;
      })
      .sort(byTimestampDescending),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    notes: items.map(summarizeNoteListItem),
    nextCursor,
    previousCursor,
    total,
  };
}

export function searchNotes(args: SearchNotesInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return context.executeCommand({ toolset: "puter.notes", command: "search_notes", args }, { abortSignal: context.abortSignal });
  }

  const modifiedAfter = parseOptionalDate(args.modifiedAfter);
  const limit = clampLimit(args.limit, defaultLimit, maxLimit);

  const { items, nextCursor, previousCursor, total } = paginateItems(
    (context.records ?? [])
      .filter((record) => record.sourceType === "notes")
      .filter((record) => {
        const timestamp = parseOptionalDate(record.timestamp);
        return !modifiedAfter || !timestamp || timestamp >= modifiedAfter;
      })
      .filter((record) => recordMatchesQuery(record, args.query))
      .sort(byTimestampDescending),
    { cursor: args.cursor, limit },
  );

  return {
    connectedAccountId: context.connectedAccountId,
    notes: items.map((record) => summarizeRecord(record, 1200)),
    nextCursor,
    previousCursor,
    total,
  };
}

export function getNote(args: GetNoteInput, context: ToolsetExecutionContext) {
  if (context.executeCommand) {
    return context.executeCommand({ toolset: "puter.notes", command: "get_note", args }, { abortSignal: context.abortSignal });
  }

  const note = (context.records ?? []).find((record) =>
    record.sourceType === "notes"
    && record.sourceId === args.noteId
    && isWithinWindow(record, context.windowStart!.toISOString(), context.windowEnd!.toISOString())
  );
  if (!note) {
    return {
      connectedAccountId: context.connectedAccountId,
      note: null,
    };
  }

  return {
    connectedAccountId: context.connectedAccountId,
    note: summarizeRecord(note, 6000),
  };
}

function summarizeNoteListItem(record: Parameters<typeof summarizeRecord>[0]) {
  const summary = summarizeRecord(record, 0);
  const { content: _content, ...withoutContent } = summary;
  return withoutContent;
}
