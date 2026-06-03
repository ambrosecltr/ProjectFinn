import { readFile } from "node:fs/promises";
import type { ToolsetDefinition } from "../../types.js";
import { getNote, listNotes, searchNotes } from "./executor.js";
import { puterNotesManifest } from "./manifest.js";
import { getNoteInputSchema, listNotesInputSchema, searchNotesInputSchema } from "./schemas.js";

export const puterNotesToolset: ToolsetDefinition = {
  manifest: puterNotesManifest,
  loadInstructions: () => readFile(new URL("./TOOL.md", import.meta.url), "utf8"),
  executors: {
    list_notes: (args, context) => listNotes(listNotesInputSchema.parse(args), context),
    search_notes: (args, context) => searchNotes(searchNotesInputSchema.parse(args), context),
    get_note: (args, context) => getNote(getNoteInputSchema.parse(args), context),
  },
};
