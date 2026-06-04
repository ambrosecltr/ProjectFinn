import type { MemoryReflectBudget, MemoryReflectEvidence, MemorySearchResult } from "@finn/integrations";
import type { MemoryRuntimeService } from "@finn/runtime";
import { tool } from "ai";
import { z } from "zod";

function formatResult(result: MemorySearchResult) {
  const bestChunk = result.chunks.find((chunk) => chunk.isRelevant !== false) ?? result.chunks[0];
  const metadata = result.metadata;

  return {
    content: bestChunk?.content ?? result.summary ?? result.content ?? "",
    messageId: typeof metadata["messageId"] === "string" ? metadata["messageId"] : null,
    conversationId: typeof metadata["conversationId"] === "string" ? metadata["conversationId"] : null,
    day: typeof metadata["day"] === "string" ? metadata["day"] : null,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    score: bestChunk?.score ?? result.score,
  };
}

function formatEvidence(evidence: MemoryReflectEvidence | null) {
  if (!evidence) {
    return null;
  }

  return {
    memories: evidence.memories.map((memory) => ({
      text: memory.text,
      type: memory.type,
      context: memory.context,
      occurredStart: memory.occurredStart,
      occurredEnd: memory.occurredEnd,
    })),
    mentalModels: evidence.mentalModels.map((model) => ({
      text: model.text,
      context: model.context,
    })),
  };
}

export function createHotPathMemoryTool(deps: {
  memory: MemoryRuntimeService;
}) {
  return tool({
    description: "Search Finn's user memory: durable context inferred from prior Finn/user interactions, including preferences, personal facts, communication style, history, and what Finn may already know or have told the user. This never searches Pattern worker continuity records.",
    inputSchema: z.object({
      query: z.string().trim().min(1).describe("Focused memory search query."),
      limit: z.number().int().min(1).max(10).optional().describe("Maximum number of matches to return. Defaults to 5."),
    }),
    execute: async ({ query, limit }) => {
      const response = await deps.memory.searchDocuments({
        query,
        limit,
        metadata: { kind: "hot_path_turn", source: "hot_path" },
        observability: { operation: "search_memory" },
      });

      if (!response.ok) {
        return { error: response.error, results: [] };
      }

      return {
        results: response.results.map(formatResult),
      };
    },
  });
}

export function createHotPathReflectMemoryTool(deps: {
  memory: MemoryRuntimeService & Required<Pick<MemoryRuntimeService, "reflectMemory">>;
}) {
  return tool({
    description: "Ask Finn's memory layer to synthesize an answer from user memory. Use for higher-level questions about patterns, preferences, relationship context, history, or what Finn should understand about the user; use search_memory when raw matching facts are enough. Budget is a work budget, not an answer-quality slider: low for simple/specific facts, mid for synthesis across a few related memories, high for broad, ambiguous, sensitive, or high-consequence synthesis.",
    inputSchema: z.object({
      question: z.string().trim().min(1).describe("Focused question for Finn's memory layer to answer from user memory."),
      budget: z.enum(["low", "mid", "high"]).optional().describe("Work budget for memory reasoning. Use low for simple/specific facts, mid for synthesis across a few related memories, and high only for broad, ambiguous, sensitive, or high-consequence questions. Defaults to mid."),
    }),
    execute: async ({ question, budget }: { question: string; budget?: MemoryReflectBudget }) => {
      const response = await deps.memory.reflectMemory({
        query: question,
        budget,
        metadata: { kind: "hot_path_turn", source: "hot_path" },
        observability: { operation: "reflect_memory" },
      });

      if (!response.ok) {
        return { error: response.error, answer: null, evidence: null };
      }

      return {
        answer: response.answer,
        evidence: formatEvidence(response.evidence),
      };
    },
  });
}

export function createHotPathMemoryTools(deps: {
  memory: MemoryRuntimeService;
  reflect?: boolean;
}) {
  return {
    search_memory: createHotPathMemoryTool(deps),
    ...((deps.reflect ?? true) && deps.memory.reflectMemory ? {
      reflect_memory: createHotPathReflectMemoryTool({
        memory: deps.memory as MemoryRuntimeService & Required<Pick<MemoryRuntimeService, "reflectMemory">>,
      }),
    } : {}),
  };
}
