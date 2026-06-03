import { afterEach, describe, expect, it, mock } from "bun:test";
import { APIError } from "supermemory";

import { createIntegrationClients } from "./factory.js";
import { HindsightClient } from "./hindsight.js";
import { getSafeMemoryFailureReason } from "./memory.js";
import { buildSupermemoryFilters, getSupermemoryFailureReason, SupermemoryClient } from "./supermemory.js";

const user = {
  tenantId: "tenant.test",
  userId: "usr:test/one",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function getJsonBody(fetchMock: ReturnType<typeof mock>, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body.");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

describe("getSafeMemoryFailureReason", () => {
  it("reports nested aggregate errors when the aggregate has no message", () => {
    const error = new AggregateError([
      new Error("connect ECONNREFUSED ::1:5432"),
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    ]);

    expect(getSafeMemoryFailureReason(error)).toBe("connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("sanitizes official SDK API errors without provider response bodies", () => {
    const error = APIError.generate(500, { message: "secret response body" }, undefined, new Headers());

    expect(getSupermemoryFailureReason(error)).toBe("provider_http_500");
  });
});

describe("SupermemoryClient", () => {
  it("routes provider operations through the official SDK client boundary", async () => {
    const add = mock(async () => ({ id: "doc_123", status: "queued" }));
    const memories = mock(async () => ({
      results: [{
        id: "mem_123",
        memory: "User prefers concise morning updates.",
        similarity: 0.9,
        updatedAt: "2026-05-07T00:01:00.000Z",
        metadata: { kind: "hot_path_turn" },
      }],
      timing: 12,
      total: 1,
    }));
    const profile = mock(async () => ({
      profile: {
        static: ["User prefers concise morning updates."],
        dynamic: ["User is currently planning a mobile onboarding project."],
      },
    }));
    globalThis.fetch = mock(async () => {
      throw new Error("direct fetch should not be used");
    }) as unknown as typeof fetch;
    const client = new SupermemoryClient({
      apiKey: "test",
      sdkClient: {
        add,
        search: { memories },
        profile,
      },
    } as never);

    await expect(client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "user: hi\nassistant: hey",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    })).resolves.toEqual({ id: "doc_123", status: "queued" });
    await expect(client.searchDocuments({
      user,
      query: "already told",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      limit: 3,
    })).resolves.toMatchObject({ ok: true, results: [{ documentId: "mem_123" }] });
    await expect(client.buildProfileContext({
      user,
      observability: { operation: "build_profile_context" },
    })).resolves.toEqual({
      ok: true,
      profile: {
        static: ["User prefers concise morning updates."],
        dynamic: ["User is currently planning a mobile onboarding project."],
      },
    });

    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      containerTag: "finn_user_tenant.test_usr_test_one",
      customId: "hot-path-turn_msg_123",
      filterByMetadata: { kind: "hot_path_turn", source: "hot_path" },
      entityContext: expect.any(String),
    }));
    expect(memories).toHaveBeenCalledWith(expect.objectContaining({
      q: "already told",
      containerTag: "finn_user_tenant.test_usr_test_one",
      searchMode: "hybrid",
    }));
    expect(profile).toHaveBeenCalledWith({
      containerTag: "finn_user_tenant.test_usr_test_one",
    });
  });

  it("builds stable provider-safe container tags and custom IDs", () => {
    const client = new SupermemoryClient({ apiKey: "test" });

    expect(client.getUserContainerTag(user)).toBe("finn_user_tenant.test_usr_test_one");
    expect(client.buildHotPathTurnCustomId("msg:abc/123")).toBe("hot-path-turn_msg_abc_123");
    expect(client.buildPatternRunCustomId("ptrun:abc/123")).toBe("pattern-run_ptrun_abc_123");
  });

  it("adds documents with one user container, Finn entity context, and source-scoped filtered writes", async () => {
    const fetchMock = mock(async () => jsonResponse({ id: "doc_123", status: "queued" }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test", baseUrl: "https://memory.example.com/" });

    const result = await client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "user: hi\nassistant: hey",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    expect(result).toEqual({ id: "doc_123", status: "queued" });
    expect(fetchMock).toHaveBeenCalledWith("https://memory.example.com/v3/documents", expect.objectContaining({ method: "POST" }));
    const body = getJsonBody(fetchMock);
    expect(body).toEqual({
      content: "user: hi\nassistant: hey",
      containerTag: "finn_user_tenant.test_usr_test_one",
      customId: "hot-path-turn_msg_123",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      filterByMetadata: { kind: "hot_path_turn", source: "hot_path" },
      entityContext: expect.any(String),
    });
    expect(body.entityContext).toContain("Finn is a personal intelligence companion");
  });

  it("adds structured source context to provider metadata", async () => {
    const fetchMock = mock(async () => jsonResponse({ id: "doc_123", status: "queued" }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    await client.addDocument({
      user,
      customId: "external_email_msg_123",
      content: "from: alex@example.com\nsubject: Dinner",
      metadata: { kind: "personal_intelligence_source", source: "gmail" },
      source: {
        provider: "gmail",
        type: "email",
        id: "msg_123",
        title: "Dinner",
        timestamp: "2026-05-07T09:00:00.000Z",
        metadata: { from: "alex@example.com" },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.supermemory.ai/v3/documents", expect.anything());
    const body = getJsonBody(fetchMock);
    expect(body).toEqual({
      content: "from: alex@example.com\nsubject: Dinner",
      containerTag: "finn_user_tenant.test_usr_test_one",
      customId: "external_email_msg_123",
      metadata: {
        kind: "personal_intelligence_source",
        source: "gmail",
        sourceProvider: "gmail",
        sourceType: "email",
        sourceId: "msg_123",
        sourceContext: JSON.stringify({
          provider: "gmail",
          type: "email",
          id: "msg_123",
          title: "Dinner",
          timestamp: "2026-05-07T09:00:00.000Z",
          metadata: { from: "alex@example.com" },
        }),
      },
      filterByMetadata: {
        kind: "personal_intelligence_source",
        source: "gmail",
      },
      entityContext: expect.any(String),
    });
    expect(body.entityContext).toContain("source-backed personal context");
  });

  it("searches v4 memory entries with enforced metadata filters and compact results", async () => {
    const fetchMock = mock(async () => jsonResponse({
      results: [{
        id: "mem_123",
        memory: "User prefers concise morning updates.",
        similarity: 0.9,
        updatedAt: "2026-05-07T00:01:00.000Z",
        metadata: { messageId: "msg_123" },
      }],
    }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    const response = await client.searchDocuments({
      user,
      query: "already told",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      limit: 3,
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]?.documentId).toBe("mem_123");
    expect(response.results[0]?.chunks[0]?.content).toBe("User prefers concise morning updates.");
    expect(fetchMock).toHaveBeenCalledWith("https://api.supermemory.ai/v4/search", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        q: "already told",
        containerTag: "finn_user_tenant.test_usr_test_one",
        searchMode: "hybrid",
        threshold: 0.6,
        filters: { AND: [{ key: "kind", value: "hot_path_turn" }, { key: "source", value: "hot_path" }] },
        limit: 3,
      }),
    }));
  });

  it("builds compact user context from v4 memories-only recall and filters operational records", async () => {
    const fetchMock = mock(async () => jsonResponse({
      results: [{
        id: "mem_personal",
        memory: "User is planning a mobile onboarding project.",
        similarity: 0.9,
        metadata: { kind: "personal_intelligence_source", sourceType: "email" },
      }, {
        id: "mem_pattern",
        memory: "Pattern found a launch.",
        metadata: { kind: "pattern_run_outcome" },
      }, {
        id: "mem_activity",
        memory: "Pattern paused: Daily news.",
        metadata: { kind: "activity_feed_event" },
      }],
    }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    const response = await client.buildContext({
      user,
      query: "mobile onboarding",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      limit: 3,
    });

    expect(response).toEqual({
      ok: true,
      results: [{
        text: "User is planning a mobile onboarding project.",
        type: "email",
        occurredAt: null,
      }],
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.supermemory.ai/v4/search", expect.objectContaining({
      body: JSON.stringify({
        q: "mobile onboarding",
        containerTag: "finn_user_tenant.test_usr_test_one",
        searchMode: "memories",
        threshold: 0.6,
        filters: { AND: [] },
        limit: 3,
      }),
    }));
  });

  it("builds provider profile context without query-specific recall", async () => {
    const fetchMock = mock(async () => jsonResponse({
      profile: {
        static: ["User prefers concise morning updates."],
        dynamic: ["User is currently planning a mobile onboarding project."],
      },
    }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    const response = await client.buildProfileContext({
      user,
      observability: { operation: "build_profile_context" },
    });

    expect(response).toEqual({
      ok: true,
      profile: {
        static: ["User prefers concise morning updates."],
        dynamic: ["User is currently planning a mobile onboarding project."],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.supermemory.ai/v4/profile", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        containerTag: "finn_user_tenant.test_usr_test_one",
      }),
    }));
  });

  it("builds typed metadata filters for numeric and array metadata", () => {
    expect(buildSupermemoryFilters({
      kind: "personal_intelligence_source",
      priority: 5,
      delivered: true,
      recipientEmails: ["alex@example.com", "sam@example.com"],
    })).toEqual({
      AND: [
        { key: "kind", value: "personal_intelligence_source" },
        { key: "priority", value: "5", filterType: "numeric", numericOperator: "=" },
        { key: "delivered", value: "true" },
        {
          OR: [
            { key: "recipientEmails", value: "alex@example.com", filterType: "array_contains" },
            { key: "recipientEmails", value: "sam@example.com", filterType: "array_contains" },
          ],
        },
      ],
    });
  });

  it("returns fail-open responses on provider errors", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    await expect(client.addDocument({ user, customId: "id", content: "content", metadata: {} })).resolves.toBeNull();
    await expect(client.searchDocuments({ user, query: "q", metadata: {} })).resolves.toEqual({
      ok: false,
      results: [],
      error: "memory search is unavailable right now",
    });
  });

  it("returns fail-open responses when the SDK receives provider response bodies", async () => {
    globalThis.fetch = mock(async () => new Response("secret response body", { status: 500 })) as unknown as typeof fetch;
    const client = new SupermemoryClient({ apiKey: "test" });

    await client.addDocument({
      user,
      customId: "id",
      content: "content",
      metadata: { kind: "hot_path_turn", source: "hot_path", messageId: "msg_123" },
      observability: { operation: "retain_hot_path_turn", messageId: "msg_123" },
    });

    await expect(client.searchDocuments({
      user,
      query: "secret query",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" },
    })).resolves.toEqual({
      ok: false,
      results: [],
      error: "memory search is unavailable right now",
    });
  });
});

describe("createIntegrationClients", () => {
  it("creates memory client only when a provider is selected and configured", () => {
    expect(createIntegrationClients({ memory: { provider: "none" }, integrations: {} } as never).memory).toBeUndefined();
    expect(createIntegrationClients({
      memory: { provider: "none" },
      integrations: { supermemory: { apiKey: "test" } },
    } as never).memory).toBeUndefined();
    expect(createIntegrationClients({
      memory: { provider: "supermemory" },
      integrations: { supermemory: { apiKey: "test" } },
    } as never).memory).toBeInstanceOf(SupermemoryClient);
    expect(createIntegrationClients({
      memory: { provider: "hindsight" },
      integrations: { hindsight: { baseUrl: "https://hindsight.example.com" } },
    } as never).memory).toBeInstanceOf(HindsightClient);
    expect(createIntegrationClients({
      memory: { provider: "hindsight" },
      integrations: { hindsight: { apiKey: "test" } },
    } as never).memory).toBeUndefined();
  });
});
