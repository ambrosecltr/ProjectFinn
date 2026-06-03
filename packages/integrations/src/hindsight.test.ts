import { afterEach, describe, expect, it, mock } from "bun:test";

import { getHindsightConnectivityHint, HindsightClient } from "./hindsight.js";

const user = {
  tenantId: "tenant.test",
  userId: "usr:test/one",
};

const originalFetch = globalThis.fetch;

const userBaseTags = [
  "tenant:tenant.test_b46065d939d1",
  "user:usr_test_one_052b3393c48e",
  "scope:personal",
];

const userRecallTagGroups = [{
  and: [
    { tags: userBaseTags, match: "all_strict" },
    { not: { tags: ["sensitivity:sensitive"], match: "any_strict" } },
    { not: { tags: ["retention_policy:default_hidden", "retention_policy:requires_user_consent"], match: "any_strict" } },
    { not: { tags: ["visibility:restricted"], match: "any_strict" } },
  ],
}];

function getRequestBody(call: unknown[] | undefined): Record<string, unknown> {
  const body = (call?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") {
    throw new Error("Expected request body to be a string");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function getFirstCallEndingWith(fetchMock: ReturnType<typeof mock>, suffix: string): unknown[] {
  const call = fetchMock.mock.calls.find(([url]) => typeof url === "string" && url.endsWith(suffix));
  if (!call) {
    throw new Error(`Expected fetch call ending with ${suffix}`);
  }
  return call;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HindsightClient", () => {
  it("builds stable provider-safe bank IDs and custom IDs", () => {
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    expect(client.getUserBankId(user)).toBe("finn_user_9d1a4474890e");
    expect(client.getUserBankId(user).length).toBeLessThanOrEqual(64);
    expect(client.getPatternBankId(user, "ptn:abc/123")).toBe("finn_pattern_862fdac67f06");
    expect(client.getPatternBankId(user, "ptn:abc/123").length).toBeLessThanOrEqual(64);
    expect(client.buildHotPathTurnCustomId("msg:abc/123")).toBe("hot-path-turn_msg_abc_123_0a4224fc1923");
    expect(client.buildPatternRunCustomId("ptrun:abc/123")).toBe("pattern-run_ptrun_abc_123_e9cb56e5aa17");
  });

  it("configures the user bank and retains user sessions as JSONL with strict scope tags", async () => {
    const retainBodies: Array<{
      items: Array<{
        content: string;
        context: string;
        document_id: string;
        metadata: Record<string, string>;
        observation_scopes: string[][];
        tags: string[];
        timestamp?: string;
        update_mode: string;
      }>;
    }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/memories")) {
        retainBodies.push(JSON.parse(init?.body as string) as typeof retainBodies[number]);
        return new Response(JSON.stringify({ success: true, bank_id: "finn_user_9d1a4474890e", items_count: 1, async: true, operation_id: "op_123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ apiKey: "test", baseUrl: "https://hindsight.example.com/" });

    const result = await client.addDocument({
      user,
      customId: client.buildHotPathTurnCustomId("msg_123"),
      content: "[user] hi\n[assistant] hey",
      conversationMessages: [
        { role: "user", content: "hi", timestamp: "2026-05-07T09:00:00.000Z", messageId: "msg_123" },
        { role: "assistant", content: "hey", delivered: true },
      ],
      metadata: {
        kind: "hot_path_turn",
        source: "hot_path",
        delivered: true,
        messageId: "msg_123",
        conversationId: "cnv_123",
        day: "2026-05-07",
        timestamp: "2026-05-07T09:00:00.000Z",
      },
      source: {
        provider: "finn",
        type: "imessage_turn",
        id: "msg_123",
        timestamp: "2026-05-07T09:00:00.000Z",
        metadata: { conversationId: "cnv_123" },
      },
    });

    expect(result).toEqual({ id: expect.stringMatching(/^hot-path-session_cnv_123_2026-05-07_/), status: "op_123" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ Authorization: "Bearer test" }),
      body: JSON.stringify({ name: "Finn user memory" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/config", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining("retain_mission"),
    }));
    const configBody = getRequestBody(fetchMock.mock.calls[1]);
    expect(configBody.updates).toEqual(expect.objectContaining({
      retain_mission: expect.stringContaining("notice the smaller, telling details of everyday life"),
      observations_mission: expect.stringContaining("ONE canonical observation per distinct person"),
      disposition_skepticism: 3,
      reflect_mission: expect.stringContaining("Only say information is unavailable when there is genuinely no relevant memory"),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models?detail=content&limit=1000", expect.objectContaining({
      method: "GET",
    }));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models"
      && (init as RequestInit | undefined)?.method === "POST"
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/memories", expect.objectContaining({
      method: "POST",
    }));
    const retainBody = retainBodies[0];
    expect(retainBody).toBeDefined();
    const item = retainBody?.items[0];
    expect(item).toEqual(expect.objectContaining({
      content: [
        JSON.stringify({ role: "user", content: "hi", timestamp: "2026-05-07T09:00:00.000Z", messageId: "msg_123" }),
        JSON.stringify({ role: "assistant", content: "hey", delivered: true }),
      ].join("\n"),
      document_id: result?.id,
      observation_scopes: [userBaseTags],
      timestamp: "2026-05-07T09:00:00.000Z",
      update_mode: "append",
    }));
    expect(item?.metadata).toEqual(expect.objectContaining({
      sourceProvider: "finn",
      sourceType: "imessage_turn",
      sourceId: "msg_123",
    }));
    expect(item?.metadata).not.toHaveProperty("sourceContext");
    expect(item?.metadata).not.toHaveProperty("delivered");
    expect(item?.context).toContain("newline-delimited JSON messages");
    expect(item?.tags).toEqual([
      ...userBaseTags,
      "source:imessage",
      "source_kind:imessage",
      "visibility:ordinary",
      expect.stringMatching(/^session:cnv_123_/),
      expect.stringMatching(/^day:2026-05-07_/),
    ]);
  });

  it("appends assistant-only worker deliveries to the same Hindsight user session", async () => {
    const retainBodies: Array<{
      items: Array<{
        content: string;
        document_id: string;
        metadata: Record<string, string>;
        tags: string[];
        timestamp?: string;
        update_mode: string;
      }>;
    }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/memories")) {
        retainBodies.push(JSON.parse(init?.body as string) as typeof retainBodies[number]);
        return new Response(JSON.stringify({ success: true, bank_id: "finn_user_9d1a4474890e", items_count: 1, async: true, operation_id: "op_456" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const result = await client.addDocument({
      user,
      customId: client.buildHotPathTurnCustomId("wrk_123"),
      content: "[assistant | delivered | source:worker]\nworker result",
      conversationMessages: [{ role: "assistant", content: "worker result", delivered: true }],
      metadata: {
        kind: "hot_path_turn",
        source: "hot_path",
        delivered: true,
        messageId: "wrk_123",
        conversationId: "cnv_123",
        day: "2026-05-07",
        timestamp: "2026-05-07T09:05:00.000Z",
        inboundSource: "worker",
      },
    });

    expect(result).toEqual({ id: expect.stringMatching(/^hot-path-session_cnv_123_2026-05-07_/), status: "op_456" });
    const item = retainBodies[0]?.items[0];
    expect(item).toEqual(expect.objectContaining({
      content: JSON.stringify({ role: "assistant", content: "worker result", delivered: true }),
      document_id: result?.id,
      metadata: expect.objectContaining({ inboundSource: "worker", messageId: "wrk_123" }),
      timestamp: "2026-05-07T09:05:00.000Z",
      update_mode: "append",
    }));
    expect(item?.tags).toEqual([
      ...userBaseTags,
      "source:imessage",
      "source_kind:imessage",
      "visibility:ordinary",
      expect.stringMatching(/^session:cnv_123_/),
      expect.stringMatching(/^day:2026-05-07_/),
    ]);
  });

  it("provisions missing Finn-managed user mental models and reconciles drifted ones on retain", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/mental-models?detail=content&limit=1000")) {
        return new Response(JSON.stringify({
          items: [
            { id: "user-identity", name: "User identity", source_query: "stale identity query" },
            { id: "manual-model", name: "Manual", source_query: "manual query" },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/directives")) {
        return new Response(JSON.stringify({
          items: [{ id: "dir_existing", name: "Synthesize from available evidence", content: "Always attempt a synthesized answer grounded in the available memories, noting confidence when evidence is partial. Only state that information is unavailable when there is genuinely no relevant memory to draw on.", priority: 10 }],
        }), { status: 200 });
      }
      if (url.endsWith("/memories")) {
        return new Response(JSON.stringify({ success: true, bank_id: "finn_user_9d1a4474890e", items_count: 1, async: true, operation_id: "op_mental_provision" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await client.addDocument({
      user,
      customId: client.buildHotPathTurnCustomId("msg_mental_provision"),
      content: "user likes quiet reminders",
      metadata: {
        kind: "hot_path_turn",
        source: "hot_path",
        messageId: "msg_mental_provision",
      },
    });

    const calls = fetchMock.mock.calls as unknown as unknown[][];
    const mentalModelPosts = calls.filter(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models"
      && (init as RequestInit | undefined)?.method === "POST");
    const provisionedIds = mentalModelPosts.map((call) => getRequestBody(call).id);
    expect(provisionedIds).not.toContain("user-identity");
    expect(provisionedIds).toEqual(expect.arrayContaining([
      "user-relationships",
      "user-health-constraints",
      "user-work-professional",
      "user-personality-style",
      "user-current-concerns",
      "user-interests-aspirations",
    ]));
    expect(getRequestBody(mentalModelPosts[0]).trigger).toEqual({ mode: "delta", refresh_after_consolidation: true });

    // Drifted existing model is PATCHed with the managed query, then refreshed.
    const identityPatch = calls.find(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models/user-identity"
      && (init as RequestInit | undefined)?.method === "PATCH");
    expect(identityPatch).toBeDefined();
    expect(getRequestBody(identityPatch).source_query).toContain("Summarize who this user is as a person");
    expect(calls.some(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models/user-identity/refresh"
      && (init as RequestInit | undefined)?.method === "POST")).toBe(true);

    // Manual (non-Finn) models are never touched.
    expect(calls.some(([url]) => typeof url === "string" && url.includes("/mental-models/manual-model"))).toBe(false);

    const directivePosts = calls.filter(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/directives"
      && (init as RequestInit | undefined)?.method === "POST");
    const directiveNames = directivePosts.map((call) => getRequestBody(call).name);
    expect(directiveNames).not.toContain("Synthesize from available evidence");
    expect(directiveNames).toEqual(expect.arrayContaining([
      "Standing constraints are always relevant",
      "Preserve relationship precision",
    ]));
    // Existing directive whose content already matches is not PATCHed.
    expect(calls.some(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/directives/dir_existing"
      && (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);

    expect(calls.some(([url, init]) =>
      url === "https://hindsight.example.com/v1/default/banks/finn_user_9d1a4474890e/mental-models"
      && (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("skips mental model provisioning when disabled", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/memories")) {
        return new Response(JSON.stringify({ success: true, bank_id: "finn_user_9d1a4474890e", items_count: 1, async: true, operation_id: "op_no_provision" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com", provisionMentalModels: false });

    await client.addDocument({
      user,
      customId: client.buildHotPathTurnCustomId("msg_no_provision"),
      content: "user likes quiet reminders",
      metadata: {
        kind: "hot_path_turn",
        source: "hot_path",
        messageId: "msg_no_provision",
      },
    });

    expect(fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.includes("/mental-models"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.endsWith("/directives"))).toBe(false);
  });

  it("builds profile context from Finn-managed mental models", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/mental-models?detail=content&limit=1000")) {
        return new Response(JSON.stringify({
          items: [
            { id: "user-identity", name: "User identity", content: "## Overview\n\nGenerating content...\n\nGoes by Alex, lives in Brisbane." },
            { id: "user-current-concerns", name: "User current concerns and open loops", content: "Preparing a move next month." },
            { id: "user-health-constraints", name: "User health and constraints", content: "I cannot find any information about this." },
            { id: "user-relationships", name: "User relationships", content: "## Overview\n\nGenerating content..." },
            { id: "manual-model", name: "Manual", content: "Should be ignored." },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.buildProfileContext({ user });

    expect(response).toEqual({
      ok: true,
      profile: {
        static: ["User identity: Goes by Alex, lives in Brisbane."],
        dynamic: ["User current concerns and open loops: Preparing a move next month."],
      },
    });
  });

  it("returns fail-open profile context on provider errors", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await expect(client.buildProfileContext({ user })).resolves.toEqual({
      ok: false,
      profile: null,
      error: "memory profile is unavailable right now",
    });
  });

  it("appends activity feed events to a stable per-Pattern user-bank timeline document", async () => {
    const retainBodies: Array<{
      items: Array<{
        content: string;
        context: string;
        document_id: string;
        metadata: Record<string, string>;
        observation_scopes: string[][];
        tags: string[];
        timestamp?: string;
        update_mode: string;
      }>;
    }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/memories")) {
        retainBodies.push(JSON.parse(init?.body as string) as typeof retainBodies[number]);
        return new Response(JSON.stringify({ success: true, bank_id: "finn_user_9d1a4474890e", items_count: 1, async: true, operation_id: "op_789" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const result = await client.addDocument({
      user,
      customId: "activity-feed_act_123",
      content: "[Pattern lifecycle event]\nlifecycle_action: paused\nresulting_pattern_status: paused\npattern_name: Daily news",
      metadata: {
        kind: "activity_feed_event",
        source: "finn_activity_feed",
        sourceType: "pattern_activity_timeline",
        process: "activity_feed",
        entityType: "pattern",
        entityId: "ptn_123",
        patternId: "ptn_123",
      },
      source: {
        provider: "finn_activity_feed",
        type: "activity_feed_event",
        id: "act_123",
        timestamp: "2026-05-07T09:00:00.000Z",
      },
    });

    expect(result).toEqual({ id: expect.stringMatching(/^pattern-activity_ptn_123_/), status: "op_789" });
    const item = retainBodies[0]?.items[0];
    expect(item).toEqual(expect.objectContaining({
      content: "[Pattern lifecycle event]\nlifecycle_action: paused\nresulting_pattern_status: paused\npattern_name: Daily news",
      document_id: result?.id,
      context: expect.stringContaining("Pattern lifecycle timeline"),
      timestamp: "2026-05-07T09:00:00.000Z",
      metadata: {
        kind: "activity_feed_event",
        source: "finn_activity_feed",
        sourceType: "pattern_activity_timeline",
        process: "activity_feed",
        tenantId: "tenant.test",
        userId: "usr:test/one",
        entityType: "pattern",
        entityId: "ptn_123",
        patternId: "ptn_123",
      },
      update_mode: "append",
    }));
    expect(item?.metadata).not.toEqual(expect.objectContaining({
      action: expect.anything(),
      activityEventId: expect.anything(),
      day: expect.anything(),
    }));
    expect(item?.observation_scopes).toEqual([userBaseTags]);
    expect(item?.tags).toEqual([
      ...userBaseTags,
      "source:finn_activity_feed",
      "source_kind:other",
      "visibility:ordinary",
    ]);
  });

  it("retains Pattern outcomes in Pattern-specific banks with run tags", async () => {
    const retainBodies: Array<{
      items: Array<{ observation_scopes: string[][]; tags: string[]; timestamp?: string }>;
    }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/memories")) {
        retainBodies.push(JSON.parse(init?.body as string) as typeof retainBodies[number]);
        return new Response(JSON.stringify({ success: true, bank_id: "bank", items_count: 1, async: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await client.addDocument({
      user,
      customId: "pattern-run_ptrun_123",
      content: "Worker summary: found launch",
      metadata: {
        kind: "pattern_run_outcome",
        source: "pattern_worker",
        patternId: "ptn:daily/news",
        patternRunId: "ptrun:abc/123",
        triggeredBy: "schedule",
        notified: true,
        surfaced: false,
        completedAt: "2026-05-07T09:01:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://hindsight.example.com/v1/default/banks/finn_pattern_032f9640f5d9", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://hindsight.example.com/v1/default/banks/finn_pattern_032f9640f5d9/memories", expect.objectContaining({
      body: expect.stringContaining("run:ptrun_abc_123_e9cb56e5aa17"),
    }));
    const retainBody = retainBodies[0];
    expect(retainBody).toBeDefined();
    if (!retainBody) {
      throw new Error("Expected retain body to be captured");
    }
    expect(retainBody.items[0]?.observation_scopes).toEqual([["tenant:tenant.test_b46065d939d1", "user:usr_test_one_052b3393c48e", "scope:pattern", "source:pattern-run", "pattern:ptn_daily_news_7b0b06803db4"]]);
    expect(retainBody.items[0]?.tags).toEqual(["tenant:tenant.test_b46065d939d1", "user:usr_test_one_052b3393c48e", "scope:pattern", "source:pattern-run", "pattern:ptn_daily_news_7b0b06803db4", "run:ptrun_abc_123_e9cb56e5aa17", "trigger:schedule_5f72005e81c4", "notified:true", "surfaced:false"]);
    expect(retainBody.items[0]?.timestamp).toBe("2026-05-07T09:01:00.000Z");
  });

  it("searches Pattern memory with strict Pattern tags and maps recall results", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      results: [{
        id: "mem_123",
        text: "Pattern already notified about Launch A.",
        type: "experience",
        context: "Finn Pattern worker run outcome",
        document_id: "pattern-run_ptrun_123",
        mentioned_at: "2026-05-07T09:01:00.000Z",
        metadata: { kind: "pattern_run_outcome", patternRunId: "ptrun_123", notified: "true" },
        tags: ["tenant:tenant.test_b46065d939d1", "user:usr_test_one_052b3393c48e", "scope:pattern", "source:pattern-run", "pattern:ptn_123_f405a6cb71d8"],
      }],
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.searchDocuments({
      user,
      query: "launch",
      limit: 3,
      metadata: { kind: "pattern_run_outcome", source: "pattern_worker", patternId: "ptn_123" },
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]).toEqual(expect.objectContaining({
      documentId: "pattern-run_ptrun_123",
      content: "Pattern already notified about Launch A.",
      createdAt: "2026-05-07T09:01:00.000Z",
    }));
    expect(response.results[0]?.metadata).toEqual(expect.objectContaining({
      kind: "pattern_run_outcome",
      notified: true,
      patternRunId: "ptrun_123",
      memoryId: "mem_123",
      memoryType: "experience",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://hindsight.example.com/v1/default/banks/finn_pattern_d517bbd3bdb5/memories/recall", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        budget: "low",
        max_tokens: 900,
        query: "launch",
        tags: ["tenant:tenant.test_b46065d939d1", "user:usr_test_one_052b3393c48e", "scope:pattern", "source:pattern-run", "pattern:ptn_123_f405a6cb71d8"],
        tags_match: "all_strict",
        trace: false,
        types: ["world", "experience", "observation"],
      }),
    }));
  });

  it("searches user memory with strict user tags", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await client.searchDocuments({
      user,
      query: "reply style",
      limit: 5,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" },
    });

    const recallBody = getRequestBody(getFirstCallEndingWith(fetchMock, "/memories/recall"));
    expect(recallBody).toEqual({
      budget: "mid",
      max_tokens: 1500,
      query: "reply style",
      tag_groups: userRecallTagGroups,
      trace: false,
      types: ["world", "experience", "observation"],
    });
  });

  it("builds compact user context from observations first without Hindsight provenance fields", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      results: [{
        id: "mem_123",
        text: "User is married to a wife | Involving: user, wife",
        type: "observation",
        context: "Finn iMessage conversation session retained as newline-delimited JSON messages",
        document_id: "hot-path-session_cnv_123",
        mentioned_at: "2026-05-11T09:59:24.359395+00:00",
        metadata: { noisy: "value" },
        chunk_id: "chunk_123",
        tags: ["scope:personal"],
      }],
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.buildContext({
      user,
      query: "dinner plans",
      limit: 3,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    expect(response).toEqual({
        ok: true,
        results: [{
          text: "User is married to a wife | Involving: user, wife",
          type: "observation",
          occurredAt: "2026-05-11T09:59:24.359395+00:00",
        }],
      });
    const recallBody = getRequestBody(getFirstCallEndingWith(fetchMock, "/memories/recall"));
    expect(recallBody).toEqual({
      budget: "low",
      max_tokens: 660,
      query: "dinner plans",
      tag_groups: userRecallTagGroups,
      trace: false,
      types: ["observation"],
    });
  });

  it("does not add raw facts when observation context exists", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const request = JSON.parse(init?.body as string) as { types?: string[] };
      return new Response(JSON.stringify({
        results: request.types?.includes("observation")
          ? [{
              id: "obs_123",
              text: "User prefers concise morning updates.",
              type: "observation",
              mentioned_at: "2026-05-11T09:59:24.359395+00:00",
            }]
          : [{
              id: "fact_123",
              text: "User asked Finn to avoid long morning briefs.",
              type: "experience",
              mentioned_at: "2026-05-10T09:59:24.359395+00:00",
            }],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.buildContext({
      user,
      query: "morning brief",
      limit: 2,
      queryTimestamp: "2026-05-19T00:00:00.000Z",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    expect(response).toEqual({
      ok: true,
      results: [{
        text: "User prefers concise morning updates.",
        type: "observation",
        occurredAt: "2026-05-11T09:59:24.359395+00:00",
      }],
    });
    const recallBodies = fetchMock.mock.calls
      .filter(([url]) => typeof url === "string" && url.endsWith("/memories/recall"))
      .map((call) => getRequestBody(call));
    expect(recallBodies).toEqual([{
      budget: "low",
      max_tokens: 512,
      query: "morning brief",
      query_timestamp: "2026-05-19T00:00:00.000Z",
      tag_groups: userRecallTagGroups,
      trace: false,
      types: ["observation"],
    }]);
  });

  it("falls back to raw facts when no observations match", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const request = JSON.parse(init?.body as string) as { types?: string[] };
      return new Response(JSON.stringify({
        results: request.types?.includes("observation")
          ? []
          : [{
              id: "fact_123",
              text: "User asked Finn to avoid long morning briefs.",
              type: "experience",
              mentioned_at: "2026-05-10T09:59:24.359395+00:00",
            }],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.buildContext({
      user,
      query: "morning brief",
      limit: 2,
      queryTimestamp: "2026-05-19T00:00:00.000Z",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    expect(response).toEqual({
      ok: true,
      results: [{
        text: "User asked Finn to avoid long morning briefs.",
        type: "experience",
        occurredAt: "2026-05-10T09:59:24.359395+00:00",
      }],
    });
    const recallBodies = fetchMock.mock.calls
      .filter(([url]) => typeof url === "string" && url.endsWith("/memories/recall"))
      .map((call) => getRequestBody(call));
    expect(recallBodies).toEqual([{
      budget: "low",
      max_tokens: 512,
      query: "morning brief",
      query_timestamp: "2026-05-19T00:00:00.000Z",
      tag_groups: userRecallTagGroups,
      trace: false,
      types: ["observation"],
    }, {
      budget: "low",
      max_tokens: 512,
      query: "morning brief",
      query_timestamp: "2026-05-19T00:00:00.000Z",
      tag_groups: userRecallTagGroups,
      trace: false,
      types: ["world", "experience"],
    }]);
  });

  it("reflects over user memory with strict user tags and evidence", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      text: "User prefers concise replies.",
      based_on: {
        memories: [{
          id: "mem_123",
          text: "User likes short replies.",
          type: "observation",
          context: "Finn iMessage conversation session",
          occurred_start: "2026-05-07T09:00:00.000Z",
          occurred_end: null,
        }],
        mental_models: [{ id: "mm_123", text: "User communication style", context: null }],
        directives: [{ id: "dir_123", name: "Personal memory", content: "Prefer grounded answers." }],
      },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.reflectMemory({
      user,
      query: "What reply style does the user prefer?",
      budget: "high",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "reflect_memory" },
    });

    expect(response).toEqual({
      ok: true,
      answer: "User prefers concise replies.",
      evidence: {
        memories: [{
          id: "mem_123",
          text: "User likes short replies.",
          type: "observation",
          context: "Finn iMessage conversation session",
          occurredStart: "2026-05-07T09:00:00.000Z",
          occurredEnd: null,
        }],
        mentalModels: [{ id: "mm_123", text: "User communication style", context: null }],
        directives: [{ id: "dir_123", name: "Personal memory", content: "Prefer grounded answers." }],
      },
    });
    const reflectBody = getRequestBody(getFirstCallEndingWith(fetchMock, "/reflect"));
    expect(reflectBody).toEqual({
      budget: "high",
      exclude_mental_models: true,
      fact_types: ["world", "experience", "observation"],
      include: { facts: {} },
      max_tokens: 1500,
      query: "What reply style does the user prefer?",
      tag_groups: userRecallTagGroups,
    });
  });

  it("reflects over Pattern memory with strict Pattern tags", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ text: "Pattern has already seen Launch A.", based_on: null }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    const response = await client.reflectMemory({
      user,
      query: "Has this Pattern already seen Launch A?",
      metadata: { kind: "pattern_run_outcome", source: "pattern_worker", patternId: "ptn_123" },
      observability: { operation: "reflect_memory", patternId: "ptn_123" },
    });

    expect(response).toEqual({ ok: true, answer: "Pattern has already seen Launch A.", evidence: null });
    expect(fetchMock).toHaveBeenCalledWith("https://hindsight.example.com/v1/default/banks/finn_pattern_d517bbd3bdb5/reflect", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        budget: "mid",
        exclude_mental_models: true,
        fact_types: ["world", "experience", "observation"],
        include: { facts: {} },
        max_tokens: 1500,
        query: "Has this Pattern already seen Launch A?",
        tags: ["tenant:tenant.test_b46065d939d1", "user:usr_test_one_052b3393c48e", "scope:pattern", "source:pattern-run", "pattern:ptn_123_f405a6cb71d8"],
        tags_match: "all_strict",
      }),
    }));
  });

  it("returns fail-open responses on provider errors", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await expect(client.addDocument({ user, customId: "id", content: "content", metadata: {} })).resolves.toBeNull();
    await expect(client.searchDocuments({ user, query: "q", metadata: {} })).resolves.toEqual({
      ok: false,
      results: [],
      error: "memory search is unavailable right now",
    });
  });

  it("does not include provider response bodies in failure reasons", async () => {
    const text = mock(async () => "secret response body");
    globalThis.fetch = mock(async () => ({ ok: false, status: 500, text })) as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

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
    await expect(client.reflectMemory({
      user,
      query: "secret query",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "reflect_memory" },
    })).resolves.toEqual({
      ok: false,
      answer: null,
      evidence: null,
      error: "memory reflection is unavailable right now",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("explains Docker localhost Hindsight URLs", () => {
    expect(getHindsightConnectivityHint("http://localhost:8888")).toContain("host.docker.internal:8888");
    expect(getHindsightConnectivityHint("https://hindsight.example.com")).toBeUndefined();
  });

  it("does not retain before bank mission configuration succeeds", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/config")) {
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

    await expect(client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "content",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/memories"), expect.anything());
  });
});
