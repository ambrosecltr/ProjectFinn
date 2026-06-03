import { z } from "zod";

const paginationCursorSchema = z.string().regex(/^\d+$/, "cursor must be a cursor returned by the previous page");
const booleanFlagSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

export const listChatsInputSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: paginationCursorSchema.optional(),
  since: z.string().datetime().optional(),
}).strict();

export const searchMessagesInputSchema = z.object({
  query: z.string().min(1),
  threadId: z.string().min(1).optional(),
  match: z.enum(["contains", "exact"]).optional().default("contains"),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: paginationCursorSchema.optional(),
}).strict();

export const readThreadInputSchema = z.object({
  threadId: z.string().min(1),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: paginationCursorSchema.optional(),
}).strict();

export const historyInputSchema = z.object({
  chatId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  attachments: booleanFlagSchema.optional().default(false),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: paginationCursorSchema.optional(),
}).strict().refine((input) => input.chatId || input.threadId, {
  message: "chatId or threadId is required",
});

export const loadAttachmentInputSchema = z.object({
  path: z.string().min(1).describe("Puter/Mac-local attachment path returned by Puter message metadata, not a Finn /workspace or /artifacts path."),
  maxBytes: z.coerce.number().int().positive().max(10_000_000).optional(),
}).strict();

export type ListChatsInput = z.infer<typeof listChatsInputSchema>;
export type SearchMessagesInput = z.infer<typeof searchMessagesInputSchema>;
export type ReadThreadInput = z.infer<typeof readThreadInputSchema>;
export type HistoryInput = z.infer<typeof historyInputSchema>;
export type LoadAttachmentInput = z.infer<typeof loadAttachmentInputSchema>;
