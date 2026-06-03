import { z } from "zod";

const paginationCursorSchema = z.string().regex(/^\d+$/, "cursor must be a cursor returned by the previous page");

export const listNotesInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: paginationCursorSchema.optional(),
  modifiedAfter: z.string().datetime().optional(),
}).strict();

export const searchNotesInputSchema = z.object({
  query: z.string().min(1),
  modifiedAfter: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: paginationCursorSchema.optional(),
}).strict();

export const getNoteInputSchema = z.object({
  noteId: z.string().min(1),
}).strict();

export type ListNotesInput = z.infer<typeof listNotesInputSchema>;
export type SearchNotesInput = z.infer<typeof searchNotesInputSchema>;
export type GetNoteInput = z.infer<typeof getNoteInputSchema>;
