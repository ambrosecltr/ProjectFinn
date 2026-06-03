import type { ToolsetManifest } from "../../types.js";
import { getNoteInputSchema, listNotesInputSchema, searchNotesInputSchema } from "./schemas.js";

export const puterNotesManifest: ToolsetManifest = {
  slug: "puter.notes",
  displayName: "Puter Notes",
  description: "Read-only Finn JS workspace navigation over Apple Notes records on the user's paired Mac.",
  capability: "read",
  processTypes: ["worker", "personal_intelligence"],
  connectorGate: {
    toolkitSlug: "puter",
    enabledTool: "puter.notes",
  },
  defaultLimit: 25,
  maxLimit: 100,
  commands: [
    {
      name: "list_notes",
      description: "List recent Apple Notes with cursor pagination, note IDs, titles, modified timestamps, and folders.",
      inputSchema: listNotesInputSchema,
      argumentGuidance: [
        "limit caps returned notes. Use cursor to continue when nextCursor is present.",
        "modifiedAfter accepts an ISO timestamp to focus on recently changed notes.",
      ],
      examples: [
        { purpose: "Start broad Notes coverage", code: "await finn.puter.notes.listNotes({ limit: 25 })" },
        { purpose: "List notes modified since a time", code: "await finn.puter.notes.listNotes({ modifiedAfter: \"2026-05-01T00:00:00.000Z\", limit: 25 })" },
        { purpose: "Page additional notes", code: "await finn.puter.notes.listNotes({ limit: 25, cursor: \"25\" })" },
      ],
      outputGuidance: [
        "List results include metadata and excerpts, not necessarily full note bodies. Use get_note when the title/excerpt is relevant.",
      ],
    },
    {
      name: "search_notes",
      description: "Search Apple Notes titles, body text, folders, and IDs with cursor pagination.",
      inputSchema: searchNotesInputSchema,
      argumentGuidance: [
        "query searches titles, bodies, folders, and IDs. Use targeted names, projects, people, places, or durable responsibility terms.",
        "modifiedAfter accepts an ISO timestamp. Use cursor to continue when nextCursor is present.",
      ],
      examples: [
        { purpose: "Search notes for a project", code: "await finn.puter.notes.searchNotes({ query: \"Project Atlas\", limit: 25 })" },
        { purpose: "Search recent notes only", code: "await finn.puter.notes.searchNotes({ query: \"doctor\", modifiedAfter: \"2026-05-01T00:00:00.000Z\", limit: 25 })" },
        { purpose: "Page search results", code: "await finn.puter.notes.searchNotes({ query: \"house\", limit: 25, cursor: \"25\" })" },
      ],
      outputGuidance: [
        "Use get_note before relying on a note when excerpts are insufficient or stale/ambiguous.",
      ],
    },
    {
      name: "get_note",
      description: "Read one Apple Note by noteId/sourceId.",
      inputSchema: getNoteInputSchema,
      argumentGuidance: [
        "noteId must be a note ID/sourceId returned by finn.puter.notes.listNotes or finn.puter.notes.searchNotes.",
      ],
      examples: [
        { purpose: "Read one relevant note", code: "await finn.puter.notes.getNote({ noteId: \"note_123\" })" },
      ],
      outputGuidance: [
        "Treat Notes as user-authored evidence, but do not overgeneralize from drafts, checklists, or stale notes.",
      ],
    },
  ],
  instructions: {
    overview: [
      "Use this read-only toolset to inspect Apple Notes from the user's paired Mac when live Puter access is available.",
      "Start with list_notes for broad coverage or search_notes for a targeted topic, then get_note for full context.",
    ],
    referenceFormats: [
      "Note IDs/source IDs come from finn.puter.notes.listNotes or finn.puter.notes.searchNotes and are passed as noteId.",
      "Use ISO timestamps with modifiedAfter.",
    ],
    syntaxRules: [
      "Batch independent reads only. Do not batch get_note when it depends on a note ID from a previous command.",
      "When nextCursor is present, repeat the same list/search API call with cursor to continue.",
    ],
    safetyRules: [
      "Notes are private, user-authored material; inspect narrowly and only for the task at hand.",
      "Retain stable self-knowledge only: preferences, project directions, household details, recurring obligations, relationship context, health/care constraints, locations, and long-lived plans.",
      "Skip raw journal-like detail unless it clearly contains durable context Finn needs.",
    ],
    outputGuidance: [
      "Preserve source provenance when retaining memory: toolkitSlug puter, accountScopeId puter:local, sourceType notes, sourceId, timestamp, title, and useful flat metadata like folder.",
      "Treat puter:<deviceId> as live bridge transport only. Do not derive Personal Intelligence account identity from device IDs, Mac names, Notes accounts, Apple IDs, or iCloud aliases.",
    ],
  },
};
