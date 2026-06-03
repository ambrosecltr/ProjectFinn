import { z } from "zod";

const fetchModeSchema = z.enum(["highlights", "text", "both"]);
const searchVerticalSchema = z.enum(["company", "people"]);

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).describe("Natural language search query. Use specific, semantically rich phrasing."),
  numResults: z.coerce.number().int().min(1).max(100).optional().default(5),
  maxAgeHours: z.coerce.number().int().min(-1).optional(),
  vertical: searchVerticalSchema.optional().describe("Optional Exa vertical. Use company for company lookup/discovery, and people for professional/person profile searches. Omit for normal web, news, docs, articles, and factual searches."),
}).strict();

export const webFetchInputSchema = z.object({
  url: z.string().url(),
  mode: fetchModeSchema.optional().default("highlights"),
}).strict();

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export type WebFetchMode = z.infer<typeof fetchModeSchema>;
