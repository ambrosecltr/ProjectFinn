import { z } from "zod";

const fetchModeSchema = z.enum(["excerpts", "full", "both", "highlights", "text"]);
const searchVerticalSchema = z.enum(["company", "people"]);
const searchModeSchema = z.enum(["basic", "advanced"]);

const domainListSchema = z.array(z.string().trim().min(1)).max(200);

const sourcePolicySchema = z.object({
  includeDomains: domainListSchema.optional().describe("Domains or domain suffixes to restrict results to, such as wikipedia.org, docs.parallel.ai, .gov, or .edu."),
  excludeDomains: domainListSchema.optional().describe("Domains or domain suffixes to exclude from results."),
  afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only include sources published on or after this YYYY-MM-DD date."),
}).strict().superRefine((value, ctx) => {
  const totalDomains = (value.includeDomains?.length ?? 0) + (value.excludeDomains?.length ?? 0);
  if (totalDomains > 200) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "includeDomains and excludeDomains can contain at most 200 domains combined.",
    });
  }
});

const fetchPolicySchema = z.object({
  maxAgeSeconds: z.coerce.number().int().min(600).optional().describe("Maximum cached content age before live fetch is attempted. Minimum is 600 seconds."),
  timeoutSeconds: z.coerce.number().positive().optional().describe("Timeout for live fetch attempts."),
  disableCacheFallback: z.boolean().optional().describe("When true, return an error instead of older cached content if live fetch fails."),
}).strict();

const contentLimitSchema = z.object({
  maxCharsPerResult: z.coerce.number().int().positive().optional(),
}).strict();

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe("Simple natural-language query. For Parallel, prefer objective plus searchQueries when doing serious research."),
  objective: z.string().trim().min(1).optional().describe("Self-contained research goal or underlying question. Parallel uses this to focus retrieved excerpts."),
  searchQueries: z.array(z.string().trim().min(1)).min(1).max(5).optional().describe("Concise keyword queries, ideally 2-3 queries of 3-6 words each for Parallel."),
  numResults: z.coerce.number().int().min(1).max(100).optional().default(5),
  maxAgeHours: z.coerce.number().int().min(-1).optional(),
  vertical: searchVerticalSchema.optional().describe("Optional Exa vertical. Use company for company lookup/discovery, and people for professional/person profile searches. Omit for normal web, news, docs, articles, and factual searches."),
  mode: searchModeSchema.optional().describe("Parallel search mode. basic is lower latency; advanced is higher quality and the default."),
  maxCharsTotal: z.coerce.number().int().positive().optional().describe("Upper bound on total excerpt characters across all results."),
  sessionId: z.string().trim().min(1).max(1000).optional().describe("Parallel session ID from a prior web call. Reuse it across related search/fetch calls in one task."),
  sourcePolicy: sourcePolicySchema.optional(),
  fetchPolicy: fetchPolicySchema.optional(),
  maxCharsPerResult: z.coerce.number().int().positive().optional().describe("Upper bound on excerpt characters per result."),
  location: z.string().trim().length(2).optional().describe("ISO 3166-1 alpha-2 country code for geo-targeted Parallel search results, such as us, gb, de, or jp."),
}).strict().refine((value) => Boolean(value.query || value.objective || value.searchQueries?.length), {
  message: "Provide query, objective, or searchQueries.",
});

export const webFetchInputSchema = z.object({
  url: z.string().url().optional(),
  urls: z.array(z.string().url()).min(1).max(20).optional().describe("Parallel can extract up to 20 URLs in one call."),
  mode: fetchModeSchema.optional().default("excerpts").describe("excerpts returns focused snippets, full returns full markdown content when available, both returns both. highlights/text are legacy aliases."),
  objective: z.string().trim().min(1).optional().describe("Focused extraction goal. Use when only part of a page matters."),
  searchQueries: z.array(z.string().trim().min(1)).min(1).max(5).optional().describe("Optional keyword queries to focus Parallel excerpts."),
  maxCharsTotal: z.coerce.number().int().positive().optional().describe("Upper bound on total excerpt characters across extracted results."),
  sessionId: z.string().trim().min(1).max(1000).optional().describe("Parallel session ID from a prior web search or fetch call."),
  fetchPolicy: fetchPolicySchema.optional(),
  maxCharsPerResult: z.coerce.number().int().positive().optional().describe("Upper bound on excerpt or full-content characters per URL."),
  fullContent: z.union([z.boolean(), contentLimitSchema]).optional().describe("Parallel full-content extraction control. Use true for defaults, false to disable, or { maxCharsPerResult }."),
}).strict().refine((value) => Boolean(value.url) !== Boolean(value.urls?.length), {
  message: "Provide exactly one of url or urls.",
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export type WebFetchMode = z.infer<typeof fetchModeSchema>;
