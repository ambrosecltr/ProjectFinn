import { describe, expect, it, mock } from "bun:test";
import type { UserContext } from "@finn/core";
import type { MemoryClient } from "@finn/integrations";
import { createMemoryRuntimeService } from "@finn/runtime";
import { createRecallUserMemoryTool } from "./automation-memory-tools.js";

const user: UserContext = {
  tenantId: "tenant_default",
  userId: "usr_123",
  phoneNumber: "+15555550123",
  timezone: "America/New_York",
  timezoneSource: "manual",
  kidsMode: false,
};

describe("createRecallUserMemoryTool", () => {
  it("searches provider-neutral user memory and returns compact results", async () => {
    const searchDocuments = mock(async () => ({
      ok: true as const,
      results: [{
        documentId: "doc_123",
        title: "Lease memory",
        summary: "Alex handles lease renewals.",
        content: "Source ID: msg_123\nAlex needs lease renewals signed by Fridays.",
        score: 0.9,
        createdAt: "2026-05-12T12:00:00.000Z",
        updatedAt: null,
        metadata: { kind: "personal_intelligence_source", sourceId: "msg_123" },
        chunks: [{ content: "Alex needs lease renewals signed by Fridays.", score: 0.9, isRelevant: true }],
      }],
    }));
    const memory = {
      provider: "test",
      addDocument: mock(async () => ({ id: "doc_new", status: "queued" })),
      searchDocuments,
      buildHotPathTurnCustomId: (messageId: string) => `hot-path-turn_${messageId}`,
      buildPatternRunCustomId: (patternRunId: string) => `pattern-run_${patternRunId}`,
    } satisfies MemoryClient;
    const recallTool = createRecallUserMemoryTool({ memory: createMemoryRuntimeService({ client: memory, user }), maxResults: 3 });

    const result = await recallTool.execute?.({ query: "msg_123 lease", limit: 5 }, { toolCallId: "call_123", messages: [] });

    expect(searchDocuments).toHaveBeenCalledWith({
      user: { tenantId: user.tenantId, userId: user.userId, timezone: user.timezone },
      query: "msg_123 lease",
      limit: 3,
      metadata: {},
      observability: { operation: "search_memory" },
    });
    expect(result).toEqual({
      ok: true,
      results: [expect.objectContaining({
        documentId: "doc_123",
        title: "Lease memory",
        metadata: expect.objectContaining({ kind: "personal_intelligence_source", sourceId: "msg_123" }),
      })],
    });
  });

  it("fails open when memory is unavailable", async () => {
    const recallTool = createRecallUserMemoryTool({});

    const result = await recallTool.execute?.({ query: "preferences", limit: 2 }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: false, results: [], error: "memory_unavailable" });
  });
});
