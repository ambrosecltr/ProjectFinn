import type { MemoryMetadata, MemoryObservabilityContext, MemoryReflectBudget, MemoryReflectEvidence, MemorySearchResult } from "@finn/integrations";
import type { MemoryRuntimeService } from "@finn/runtime";
import { tool } from "ai";
import { z } from "zod";

function formatResult(result: MemorySearchResult) {
  const bestChunk = result.chunks.find((chunk) => chunk.isRelevant !== false) ?? result.chunks[0];
  const metadata = result.metadata;

  return {
    content: bestChunk?.content ?? result.summary ?? result.content ?? "",
    score: bestChunk?.score ?? result.score,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    metadata: {
      kind: typeof metadata["kind"] === "string" ? metadata["kind"] : null,
      messageId: typeof metadata["messageId"] === "string" ? metadata["messageId"] : null,
      conversationId: typeof metadata["conversationId"] === "string" ? metadata["conversationId"] : null,
      patternRunId: typeof metadata["patternRunId"] === "string" ? metadata["patternRunId"] : null,
      day: typeof metadata["day"] === "string" ? metadata["day"] : null,
      notified: typeof metadata["notified"] === "boolean" ? metadata["notified"] : null,
      surfaced: typeof metadata["surfaced"] === "boolean" ? metadata["surfaced"] : null,
    },
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

type WorkerMemoryScope = "user" | "pattern";

const userSearchInputSchema = z.object({
  query: z.string().trim().min(1).describe("Focused query for user memory, such as preferences, personal facts, history, communication style, or prior Finn/user context."),
  limit: z.number().int().min(1).max(10).optional().describe("Maximum number of matches to return. Defaults to 5."),
});

const patternSearchInputSchema = userSearchInputSchema.extend({
  scope: z.enum(["user", "pattern"]).optional().describe("Search user memory or current-Pattern continuity memory. Defaults to user."),
});

const userReflectInputSchema = z.object({
  question: z.string().trim().min(1).describe("Focused question for Finn's memory layer to answer from user memory."),
  budget: z.enum(["low", "mid", "high"]).optional().describe("How deeply Finn's memory layer should explore memory. Defaults to mid."),
});

const patternReflectInputSchema = userReflectInputSchema.extend({
  scope: z.enum(["user", "pattern"]).optional().describe("Reflect over user memory or current-Pattern continuity memory. Defaults to user."),
});

function getSearchMemoryParams(scope: WorkerMemoryScope, deps: {
  patternId?: string;
  patternRunId?: string;
}): { metadata: MemoryMetadata; observability: MemoryObservabilityContext } {
  if (scope === "pattern") {
    if (!deps.patternId) {
      throw new Error("Pattern memory scope is not available in this run.");
    }
    return {
      metadata: {
        kind: "pattern_run_outcome",
        source: "pattern_worker",
        patternId: deps.patternId,
      },
      observability: {
        operation: "search_memory" as const,
        patternId: deps.patternId,
        patternRunId: deps.patternRunId,
      },
    };
  }

  return {
    metadata: { kind: "hot_path_turn", source: "hot_path" },
    observability: { operation: "search_memory" as const },
  };
}

function getReflectMemoryParams(scope: WorkerMemoryScope, deps: {
  patternId?: string;
  patternRunId?: string;
}): { metadata: MemoryMetadata; observability: MemoryObservabilityContext } {
  if (scope === "pattern") {
    if (!deps.patternId) {
      throw new Error("Pattern memory scope is not available in this run.");
    }
    return {
      metadata: {
        kind: "pattern_run_outcome",
        source: "pattern_worker",
        patternId: deps.patternId,
      },
      observability: {
        operation: "reflect_memory" as const,
        patternId: deps.patternId,
        patternRunId: deps.patternRunId,
      },
    };
  }

  return {
    metadata: { kind: "hot_path_turn", source: "hot_path" },
    observability: { operation: "reflect_memory" as const },
  };
}

export function createWorkerMemoryTools(deps: {
  memory: MemoryRuntimeService;
  patternId?: string;
  patternRunId?: string;
  reflect?: boolean;
}) {
  const hasPatternScope = Boolean(deps.patternId);
  const tools = {
    search_memory: tool({
      description: hasPatternScope
        ? "Search Finn's memory. User scope searches durable user context. Pattern scope searches previous terminal outcomes for the current Pattern only; Pattern results are internal continuity, not proof the user saw the information."
        : "Search Finn's user memory: durable context inferred from prior Finn/user interactions, including preferences, personal facts, communication style, history, and what Finn may already know or have told the user. Use selectively when user-specific context would improve the work.",
      inputSchema: hasPatternScope ? patternSearchInputSchema : userSearchInputSchema,
      execute: async (input: { query: string; limit?: number; scope?: WorkerMemoryScope }) => {
        const scope = hasPatternScope ? input.scope ?? "user" : "user";
        const params = getSearchMemoryParams(scope, deps);
        const response = await deps.memory.searchDocuments({
          query: input.query,
          limit: input.limit,
          ...params,
        });

        if (!response.ok) {
          return { error: response.error, results: [] };
        }

        return { results: response.results.map(formatResult) };
      },
    }),
    ...((deps.reflect ?? true) && deps.memory.reflectMemory ? {
      reflect_memory: createWorkerReflectMemoryTool({
        memory: deps.memory as MemoryRuntimeService & Required<Pick<MemoryRuntimeService, "reflectMemory">>,
        patternId: deps.patternId,
        patternRunId: deps.patternRunId,
      }),
    } : {}),
  };

  return tools;
}

export function createUserMemoryTool(deps: {
  memory: MemoryRuntimeService;
}) {
  return createWorkerMemoryTools(deps).search_memory;
}

export function createUserReflectMemoryTool(deps: {
  memory: MemoryRuntimeService & Required<Pick<MemoryRuntimeService, "reflectMemory">>;
}) {
  return createWorkerReflectMemoryTool(deps);
}

function createWorkerReflectMemoryTool(deps: {
  memory: MemoryRuntimeService & Required<Pick<MemoryRuntimeService, "reflectMemory">>;
  patternId?: string;
  patternRunId?: string;
}) {
  const hasPatternScope = Boolean(deps.patternId);
  return tool({
    description: hasPatternScope
      ? "Ask Finn's memory layer to synthesize an answer. User scope reflects over user memory; Pattern scope reflects over previous terminal outcomes for the current Pattern only."
      : "Ask Finn's memory layer to synthesize an answer from user memory. Use for higher-level questions about user patterns, preferences, relationship context, prior Finn/user history, or what Finn should understand about the user; use search_memory when raw matching facts are enough.",
    inputSchema: hasPatternScope ? patternReflectInputSchema : userReflectInputSchema,
    execute: async ({ question, budget, scope }: { question: string; budget?: MemoryReflectBudget; scope?: WorkerMemoryScope }) => {
      const resolvedScope = hasPatternScope ? scope ?? "user" : "user";
      const params = getReflectMemoryParams(resolvedScope, deps);
      const response = await deps.memory.reflectMemory({
        query: question,
        budget,
        ...params,
      });

      if (!response.ok) {
        return { error: response.error, answer: null, evidence: null };
      }

      return { answer: response.answer, evidence: formatEvidence(response.evidence) };
    },
  });
}
