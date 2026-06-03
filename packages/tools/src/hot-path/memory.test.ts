import { describe, expect, it, mock } from "bun:test";

import type { MemoryClient } from "@finn/integrations";
import { createFilesRuntime, createMemoryRuntimeService, createProcessRuntimeServices, createUserRuntimeServices } from "@finn/runtime";
import { createHotPathTools } from "./index.js";

const user = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: "Test User",
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

const sender = {
  sendText: async () => undefined,
  sendMedia: async () => undefined,
  sendVoiceMessage: async () => undefined,
  sendReaction: async () => undefined,
  sendTypingIndicator: async () => undefined,
  markRead: async () => undefined,
} as never;

const runtime = createProcessRuntimeServices(createUserRuntimeServices({
  workspace: "/tmp/finn-hot-path-memory-test",
  files: createFilesRuntime({ workspaceRoot: "/tmp/finn-hot-path-memory-test" }),
}), {
  processType: "hot_path",
  filesAccess: "write",
});

function createMemoryClient(): MemoryClient {
  return {
    provider: "test",
    addDocument: mock(async () => ({ id: "doc_123", status: "queued" })),
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
    buildHotPathTurnCustomId: (messageId) => `hot-path-turn_${messageId}`,
    buildPatternRunCustomId: (patternRunId) => `pattern-run_${patternRunId}`,
  };
}

function createReflectMemoryClient(): MemoryClient {
  return {
    ...createMemoryClient(),
    reflectMemory: mock(async () => ({ ok: true as const, answer: "user prefers concise replies", evidence: null })),
  };
}

function createMemoryRuntime(memory: MemoryClient) {
  return createMemoryRuntimeService({ client: memory, user });
}

describe("createHotPathTools memory", () => {
  it("omits search_memory when memory is absent", () => {
    const tools = createHotPathTools({ sender, runtime });

    expect(tools.search_memory).toBeUndefined();
    expect(tools.reflect_memory).toBeUndefined();
  });

  it("omits reflect_memory when the provider does not support reflection", () => {
    const tools = createHotPathTools({
      sender,
      runtime,
      memory: createMemoryRuntime(createMemoryClient()),
    });

    expect(tools.search_memory).toBeDefined();
    expect(tools.reflect_memory).toBeUndefined();
  });

  it("enforces hot-path filters for search_memory", async () => {
    const memory = createMemoryClient();
    const tools = createHotPathTools({
      sender,
      runtime,
      memory: createMemoryRuntime(memory),
    });

    await tools.search_memory.execute?.({ query: "already told", limit: 2 }, {} as never);

    expect(memory.searchDocuments).toHaveBeenCalledWith({
      user: { tenantId: user.tenantId, userId: user.userId, timezone: user.timezone },
      query: "already told",
      limit: 2,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" },
    });
  });

  it("formats sanitized search_memory results without provider provenance", async () => {
    const memory = createMemoryClient();
    memory.searchDocuments = mock(async () => ({
      ok: true as const,
      results: [{
        documentId: "hot-path-turn_msg_123",
        title: null,
        summary: null,
        content: "user likes short replies",
        score: null,
        createdAt: "2026-05-07T09:00:00.000Z",
        updatedAt: null,
        metadata: {
          messageId: "msg_123",
          conversationId: "cnv_123",
          day: "2026-05-07",
          memoryId: "mem_123",
          memoryType: "observation",
          memoryContext: "Finn iMessage conversation turn",
          memoryTags: ["scope:personal"],
          memoryEntities: ["user"],
        },
        chunks: [{ content: "user likes short replies", score: null, isRelevant: true }],
      }],
    }));
    const tools = createHotPathTools({
      sender,
      runtime,
      memory: createMemoryRuntime(memory),
    });

    const result = await tools.search_memory.execute?.({ query: "reply style" }, {} as never);

    expect(result).toEqual({
      results: [{
        content: "user likes short replies",
        messageId: "msg_123",
        conversationId: "cnv_123",
        day: "2026-05-07",
        createdAt: "2026-05-07T09:00:00.000Z",
        updatedAt: null,
        score: null,
      }],
    });
  });

  it("reflects user memory only when the provider supports reflection", async () => {
    const memory = createReflectMemoryClient();
    const tools = createHotPathTools({
      sender,
      runtime,
      memory: createMemoryRuntime(memory),
    });

    const result = await tools.reflect_memory.execute?.({ question: "what reply style does the user prefer?", budget: "high" }, {} as never);

    expect(memory.reflectMemory).toHaveBeenCalledWith({
      user: { tenantId: user.tenantId, userId: user.userId, timezone: user.timezone },
      query: "what reply style does the user prefer?",
      budget: "high",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "reflect_memory" },
    });
    expect(result).toEqual({ answer: "user prefers concise replies", evidence: null });
  });

  it("omits reflect_memory when reflection is disabled for the runtime", () => {
    const tools = createHotPathTools({
      sender,
      runtime,
      memory: createMemoryRuntime(createReflectMemoryClient()),
      reflectMemory: false,
    });

    expect(tools.search_memory).toBeDefined();
    expect(tools.reflect_memory).toBeUndefined();
  });

  it("exposes active Pattern summaries when Pattern ops are configured", async () => {
    const tools = createHotPathTools({
      sender,
      runtime,
      patterns: {
        list: async () => [{
          id: "ptn_123",
          tenantId: "tenant_test",
          userId: "usr_test",
          name: "Morning briefing",
          description: null,
          userDescription: "Sends a daily briefing.",
          triggerType: "schedule",
          triggerConfig: { type: "schedule", schedule: { kind: "interval", every: 1, unit: "days" }, timezoneSource: "user" },
          connectorScope: { composio: [], mcpServerIds: [] },
          triggerFilters: [],
          notifyCondition: { type: "always" },
          workerType: "pattern_worker",
          taskPrompt: "Prepare a morning briefing.",
          reminderContext: null,
          timezone: "UTC",
          active: true,
          failureCount: 0,
          lastRunAt: null,
          nextRunAt: new Date("2026-05-10T08:00:00.000Z"),
          createdAt: new Date("2026-05-09T00:00:00.000Z"),
          updatedAt: new Date("2026-05-09T00:00:00.000Z"),
        }, {
          id: "ptn_inactive",
          tenantId: "tenant_test",
          userId: "usr_test",
          name: "Paused watch",
          description: null,
          userDescription: null,
          triggerType: "composio",
          triggerConfig: {
            type: "composio",
            toolkitSlug: "gmail",
            triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
            connectedAccountId: "acct_123",
          },
          connectorScope: { composio: [], mcpServerIds: [] },
          triggerFilters: [],
          notifyCondition: { type: "always" },
          workerType: "pattern_worker",
          taskPrompt: "Watch email.",
          reminderContext: null,
          timezone: "UTC",
          active: false,
          failureCount: 0,
          lastRunAt: null,
          nextRunAt: null,
          createdAt: new Date("2026-05-09T00:00:00.000Z"),
          updatedAt: new Date("2026-05-09T00:00:00.000Z"),
        }],
      },
    });

    const result = await tools.list_active_patterns.execute?.({}, {} as never);

    expect(result).toEqual({
      patterns: [{
        id: "ptn_123",
        name: "Morning briefing",
        triggerType: "schedule",
        scheduleType: "interval",
        nextRun: "2026-05-10T08:00:00.000Z",
        userDescription: "Sends a daily briefing.",
        type: "pattern",
      }],
    });
  });
});
