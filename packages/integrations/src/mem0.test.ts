import { describe, expect, it, mock } from "bun:test";

import { buildMem0Filters, buildMem0UserId, Mem0Client } from "./mem0.js";

const user = {
  tenantId: "tenant.test",
  userId: "usr:test/one",
};

describe("Mem0Client", () => {
  it("builds stable Mem0 user scopes and metadata filters", () => {
    expect(buildMem0UserId(user)).toBe("finn:tenant.test:usr:test_one");
    expect(buildMem0Filters(user, {
      kind: "personal_intelligence_source",
      delivered: true,
      recipientEmails: ["alex@example.com", "sam@example.com"],
    })).toEqual({
      AND: [
        { user_id: "finn:tenant.test:usr:test_one" },
        { metadata: { kind: "personal_intelligence_source" } },
        { metadata: { delivered: true } },
        {
          OR: [
            { metadata: { recipientEmails: { contains: "alex@example.com" } } },
            { metadata: { recipientEmails: { contains: "sam@example.com" } } },
          ],
        },
      ],
    });
  });

  it("adds memories through the Mem0 SDK with Finn metadata and source timestamps", async () => {
    const add = mock(async () => ({ eventId: "evt_123", status: "PENDING" }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add,
        search: mock(async () => ({ results: [] })),
      },
    } as never);

    await expect(client.addDocument({
      user,
      customId: "personal-intelligence_gmail_account_email_msg_123",
      content: "Project Atlas decision notes",
      conversationMessages: [
        { role: "user", content: "Project Atlas decision notes", timestamp: "2026-05-07T09:00:00.000Z" },
      ],
      source: {
        provider: "gmail",
        type: "email",
        id: "msg_123",
        title: "Project Atlas",
        url: "https://mail.example.com/msg_123",
        timestamp: "2026-05-07T09:00:00.000Z",
      },
      metadata: {
        kind: "personal_intelligence_source",
        source: "gmail",
        sourceType: "email",
        sourceId: "msg_123",
        timestamp: "2026-05-07T09:00:00.000Z",
      },
    })).resolves.toEqual({ id: "evt_123", status: "PENDING" });

    expect(add).toHaveBeenCalledWith([
      { role: "user", content: "Project Atlas decision notes" },
    ], {
      userId: "finn:tenant.test:usr:test_one",
      metadata: {
        kind: "personal_intelligence_source",
        source: "gmail",
        sourceType: "email",
        sourceId: "msg_123",
        timestamp: "2026-05-07T09:00:00.000Z",
        finnCustomId: "personal-intelligence_gmail_account_email_msg_123",
        sourceProvider: "gmail",
        sourceTitle: "Project Atlas",
        sourceUrl: "https://mail.example.com/msg_123",
        sourceTimestamp: "2026-05-07T09:00:00.000Z",
      },
      infer: true,
      timestamp: 1_778_144_400,
    });
  });

  it("stores operational records without inference", async () => {
    const add = mock(async () => ({ eventId: "evt_pattern", status: "PENDING" }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add,
        search: mock(async () => ({ results: [] })),
      },
    } as never);

    await client.addDocument({
      user,
      customId: "pattern-run_ptrun_123",
      content: "Pattern: Daily planning\nNotify: true",
      metadata: {
        kind: "pattern_run_outcome",
        source: "pattern_worker",
        patternRunId: "ptrun_123",
      },
    });

    expect(add).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ infer: false }));
  });

  it("deduplicates backfill writes by Finn custom ID", async () => {
    const add = mock(async () => ({ eventId: "evt_123", status: "PENDING" }));
    const getAll = mock(async () => ({
      results: [{
        id: "mem_existing",
        memory: "Existing memory",
        metadata: { finnCustomId: "hot-path-turn_msg_123" },
      }],
    }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add,
        getAll,
        search: mock(async () => ({ results: [] })),
      },
    } as never);

    await expect(client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "user: hi\nassistant: hey",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "backfill_retain" },
    })).resolves.toEqual({ id: "mem_existing", status: "skipped_duplicate" });

    expect(getAll).toHaveBeenCalledWith({
      filters: {
        AND: [
          { user_id: "finn:tenant.test:usr:test_one" },
          { metadata: { finnCustomId: "hot-path-turn_msg_123" } },
        ],
      },
      pageSize: 1,
      latestOnly: true,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("updates an existing profile seed instead of adding duplicates", async () => {
    const add = mock(async () => ({ eventId: "evt_123", status: "PENDING" }));
    const getAll = mock(async () => ({
      results: [{
        id: "mem_profile",
        memory: "Old profile",
        metadata: { finnCustomId: "user-profile-seed" },
      }],
    }));
    const update = mock(async () => ({ id: "mem_profile", status: "UPDATED" }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add,
        getAll,
        update,
        search: mock(async () => ({ results: [] })),
      },
    } as never);

    await expect(client.addDocument({
      user,
      customId: "user-profile-seed",
      content: "Name: Alex\nTimezone: Australia/Brisbane",
      metadata: {
        kind: "user_profile_seed",
        source: "finn_core_profile",
        timestamp: "2026-05-31T05:00:00.000Z",
      },
      observability: { operation: "retain_user_profile_seed" },
    })).resolves.toEqual({ id: "mem_profile", status: "UPDATED" });

    expect(update).toHaveBeenCalledWith("mem_profile", {
      text: "Name: Alex\nTimezone: Australia/Brisbane",
      metadata: {
        kind: "user_profile_seed",
        source: "finn_core_profile",
        timestamp: "2026-05-31T05:00:00.000Z",
        finnCustomId: "user-profile-seed",
      },
      timestamp: 1_780_203_600,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("searches memories with reranking, metadata filters, and temporal reference dates", async () => {
    const search = mock(async () => ({
      results: [{
        id: "mem_123",
        memory: "User prefers concise morning updates.",
        score: 0.82,
        categories: ["user_preferences"],
        metadata: { kind: "hot_path_turn", sourceType: "imessage_turn", timestamp: "2026-05-07T09:00:00.000Z" },
        createdAt: "2026-05-07T09:01:00.000Z",
      }],
    }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add: mock(async () => ({ eventId: "evt_123" })),
        search,
      },
    } as never);

    const response = await client.searchDocuments({
      user,
      query: "morning updates",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      queryTimestamp: "2026-05-08T00:00:00.000Z",
      limit: 3,
    });

    expect(response).toEqual({
      ok: true,
      results: [{
        documentId: "mem_123",
        title: null,
        summary: "User prefers concise morning updates.",
        content: "User prefers concise morning updates.",
        score: 0.82,
        createdAt: "2026-05-07T09:01:00.000Z",
        updatedAt: null,
        metadata: {
          kind: "hot_path_turn",
          sourceType: "imessage_turn",
          timestamp: "2026-05-07T09:00:00.000Z",
          categories: ["user_preferences"],
        },
        chunks: [{ content: "User prefers concise morning updates.", score: 0.82, isRelevant: true }],
      }],
    });
    expect(search).toHaveBeenCalledWith("morning updates", {
      filters: {
        AND: [
          { user_id: "finn:tenant.test:usr:test_one" },
          { metadata: { kind: "hot_path_turn" } },
          { metadata: { source: "hot_path" } },
        ],
      },
      topK: 3,
      threshold: 0.1,
      latestOnly: true,
      rerank: true,
      referenceDate: "2026-05-08T00:00:00.000Z",
    });
  });

  it("builds compact hot-path context from user-scoped search and filters operational memory", async () => {
    const search = mock(async () => ({
      results: [{
        id: "mem_personal",
        memory: "User is planning a mobile onboarding project.",
        score: 0.9,
        metadata: {
          kind: "personal_intelligence_source",
          sourceType: "email",
          timestamp: "2026-05-07T09:00:00.000Z",
        },
      }, {
        id: "mem_pattern",
        memory: "Pattern found a launch.",
        metadata: { kind: "pattern_run_outcome" },
      }],
    }));
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add: mock(async () => ({ eventId: "evt_123" })),
        search,
      },
    } as never);

    const response = await client.buildContext({
      user,
      query: "mobile onboarding",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      queryTimestamp: "2026-05-08T00:00:00.000Z",
      limit: 3,
    });

    expect(response).toEqual({
      ok: true,
      results: [{
        text: "User is planning a mobile onboarding project.",
        type: "email",
        occurredAt: "2026-05-07T09:00:00.000Z",
      }],
    });
    expect(search).toHaveBeenCalledWith("mobile onboarding", {
      filters: { user_id: "finn:tenant.test:usr:test_one" },
      topK: 3,
      threshold: 0.1,
      latestOnly: true,
      rerank: false,
      referenceDate: "2026-05-08T00:00:00.000Z",
    });
  });

  it("returns fail-open responses on provider errors", async () => {
    const client = new Mem0Client({
      apiKey: "test",
      sdkClient: {
        add: mock(async () => {
          throw new Error("provider unavailable");
        }),
        search: mock(async () => {
          throw new Error("provider unavailable");
        }),
      },
    } as never);

    await expect(client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "user: hi",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    })).resolves.toBeNull();
    await expect(client.searchDocuments({
      user,
      query: "hi",
      metadata: {},
    })).resolves.toEqual({
      ok: false,
      results: [],
      error: "memory search is unavailable right now",
    });
  });
});
