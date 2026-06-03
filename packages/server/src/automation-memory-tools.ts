import type { MemorySearchResult } from "@finn/integrations";
import type { MemoryRuntimeService } from "@finn/runtime";
import { tool } from "ai";
import { z } from "zod";

const defaultMemoryRecallLimit = 5;
const maxMemoryRecallLimit = 8;

export function createSearchMemoryTool(input: {
  memory?: MemoryRuntimeService;
  maxResults?: number;
}) {
  return tool({
    description: "Search existing user memory before making decisions. Use this to check what Finn already knows, avoid duplicate Personal Intelligence retention, and understand the user's durable preferences, relationships, responsibilities, and context.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(maxMemoryRecallLimit).optional().default(defaultMemoryRecallLimit),
    }),
    execute: async ({ query, limit }) => {
      if (!input.memory) {
        return { ok: false, results: [], error: "memory_unavailable" };
      }

      const response = await input.memory.searchDocuments({
        query,
        limit: Math.min(limit, input.maxResults ?? maxMemoryRecallLimit),
        metadata: {},
        observability: { operation: "search_memory" },
      });

      if (!response.ok) {
        return { ok: false, results: [], error: response.error };
      }

      return {
        ok: true,
        results: response.results.map(formatMemorySearchResult),
      };
    },
  });
}

export const createRecallUserMemoryTool = createSearchMemoryTool;

function formatMemorySearchResult(result: MemorySearchResult): Record<string, unknown> {
  const metadata = result.metadata;
  return {
    documentId: result.documentId,
    title: result.title,
    summary: truncateText(result.summary, 700),
    content: truncateText(result.content, 1200),
    createdAt: result.createdAt,
    metadata: {
      kind: typeof metadata["kind"] === "string" ? metadata["kind"] : null,
      source: typeof metadata["source"] === "string" ? metadata["source"] : null,
      sourceType: typeof metadata["sourceType"] === "string" ? metadata["sourceType"] : null,
      sourceId: typeof metadata["sourceId"] === "string" ? metadata["sourceId"] : null,
      messageId: typeof metadata["messageId"] === "string" ? metadata["messageId"] : null,
      threadId: typeof metadata["threadId"] === "string" ? metadata["threadId"] : null,
      eventId: typeof metadata["eventId"] === "string" ? metadata["eventId"] : null,
      day: typeof metadata["day"] === "string" ? metadata["day"] : null,
      timestamp: typeof metadata["timestamp"] === "string" ? metadata["timestamp"] : null,
      reason: typeof metadata["reason"] === "string" ? truncateText(metadata["reason"], 500) : null,
    },
    chunks: result.chunks.slice(0, 3).map((chunk) => ({
      content: truncateText(chunk.content, 900),
      score: chunk.score,
      isRelevant: chunk.isRelevant,
    })),
  };
}

function truncateText(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3).trim()}...`;
}
