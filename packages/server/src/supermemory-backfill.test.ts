import { describe, expect, it, mock } from "bun:test";

import type { PatternRecord, PatternRunRecord, WorkerResult } from "@finn/core";
import type { Message, StoredUser } from "@finn/db";
import { HindsightClient, SupermemoryClient, type MemoryClient } from "@finn/integrations";
import {
  buildHotPathAssistantBackfillDocument,
  buildHotPathTurnBackfillDocument,
  buildPatternRunOutcomeBackfillDocument,
  buildUserProfileSeedBackfillDocument,
  planMemoryBackfill,
  runMemoryBackfill,
  type MemoryBackfillKind,
  type MemoryBackfillOptions,
} from "./memory-backfill.js";

const user = {
  id: "usr_test",
  tenantId: "tenant_test",
  phoneNumber: "+15555555555",
  timezone: "UTC",
  displayName: "Alex",
  location: "Brisbane, Australia",
  metadata: { profile: { timezoneSource: "browser" } },
} satisfies Pick<StoredUser, "id" | "tenantId" | "phoneNumber" | "timezone" | "displayName" | "location" | "metadata">;

const client = new SupermemoryClient({ apiKey: "test" });
const hindsightClient = new HindsightClient({ baseUrl: "https://hindsight.example.com" });

function createOptions(kinds: MemoryBackfillKind[], overrides: Partial<MemoryBackfillOptions> = {}): MemoryBackfillOptions {
  return {
    dryRun: true,
    kinds,
    concurrency: 1,
    defaultTimezone: "UTC",
    ...overrides,
  };
}

function createQuery(rows: unknown[]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async (limit: number) => rows.slice(0, limit),
    then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };

  return query;
}

function createDb(...responses: unknown[][]) {
  const queue = [...responses];
  return {
    select: () => createQuery(queue.shift() ?? []),
  } as never;
}

function createMemoryClient(provider = "test"): MemoryClient {
  return {
    provider,
    addDocument: mock(async () => ({ id: "doc_123", status: "queued" })),
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
    buildHotPathTurnCustomId: (messageId) => `hot-path-turn_${messageId}`,
    buildPatternRunCustomId: (patternRunId) => `pattern-run_${patternRunId}`,
  };
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_123",
    tenantId: user.tenantId,
    userId: user.id,
    conversationId: "cnv_123",
    role: "user",
    content: "hi finn",
    source: "user",
    sourceMessageId: "spectrum_123",
    toolCalls: null,
    tokenEstimate: 2,
    createdAt: new Date("2026-05-07T09:00:00.000Z"),
    compacted: false,
    compactionGroup: null,
    ...overrides,
  };
}

function createPattern(overrides: Partial<PatternRecord> = {}): PatternRecord {
  return {
    id: "ptn_123",
    tenantId: user.tenantId,
    userId: user.id,
    name: "Daily news",
    description: null,
    userDescription: null,
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    connectorScope: { composio: [], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "worker_decision", instruction: "Notify on new things." },
    workerType: "pattern_worker",
    taskPrompt: "Check news.",
    reminderContext: null,
    timezone: "UTC",
    active: true,
    failureCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-05-07T08:00:00.000Z"),
    updatedAt: new Date("2026-05-07T08:00:00.000Z"),
    ...overrides,
  };
}

function createRun(pattern: PatternRecord, overrides: Partial<PatternRunRecord> = {}): PatternRunRecord {
  return {
    id: "ptrun_123",
    tenantId: pattern.tenantId,
    userId: pattern.userId,
    patternId: pattern.id,
    triggeredBy: "schedule",
    triggerPayload: null,
    workerId: "wrk_123",
    state: "done",
    result: { summary: "Found launch." },
    error: null,
    skipReason: null,
    notifyOutcome: { notify: true, summary: "Found launch." },
    surfacedAt: null,
    toolScope: null,
    createdAt: new Date("2026-05-07T09:00:00.000Z"),
    startedAt: new Date("2026-05-07T09:00:01.000Z"),
    completedAt: new Date("2026-05-07T09:01:00.000Z"),
    ...overrides,
  };
}

describe("memory backfill document builders", () => {
  it("uses persisted message source IDs for idempotent hot-path custom IDs", () => {
    const document = buildHotPathTurnBackfillDocument({
      client,
      user,
      userMessage: createMessage(),
      assistantMessage: createMessage({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        sourceMessageId: null,
        content: "hey there",
        createdAt: new Date("2026-05-07T09:00:03.000Z"),
      }),
      defaultTimezone: "UTC",
    });

    expect(document?.customId).toBe("hot-path-turn_spectrum_123");
    expect(document?.content).toContain("[user | 2026-05-07T09:00:00.000Z | message:spectrum_123]");
    expect(document?.content).toContain("[assistant | delivered]\nhey there");
    expect(document?.conversationMessages).toEqual([
      { role: "user", content: "hi finn", timestamp: "2026-05-07T09:00:00.000Z", messageId: "spectrum_123" },
      { role: "assistant", content: "hey there", delivered: true },
    ]);
    expect(document?.metadata).toMatchObject({
      kind: "hot_path_turn",
      source: "hot_path",
      messageId: "spectrum_123",
      conversationId: "cnv_123",
      day: "2026-05-07",
      delivered: true,
    });
  });

  it("retains assistant-only non-text deliveries as visible action metadata", () => {
    const document = buildHotPathTurnBackfillDocument({
      client,
      user,
      userMessage: createMessage(),
      assistantMessage: createMessage({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        content: "[tapback: like | target_handle: spectrum_123]",
        sourceMessageId: null,
      }),
      defaultTimezone: "UTC",
    });

    expect(document?.content).toContain("[tapback: like]");
    expect(document?.content).not.toContain("target_handle");
    expect(document?.metadata).toMatchObject({ delivered: true });
  });

  it("retains user-message-only historical turns", () => {
    const document = buildHotPathTurnBackfillDocument({
      client,
      user,
      userMessage: createMessage(),
      defaultTimezone: "UTC",
    });

    expect(document?.customId).toBe("hot-path-turn_spectrum_123");
    expect(document?.content).toContain("[assistant | delivered]\n[no visible assistant response]");
    expect(document?.metadata).toMatchObject({ delivered: false });
  });

  it("builds assistant-only worker delivery documents for Hindsight session appends", () => {
    const document = buildHotPathAssistantBackfillDocument({
      client: hindsightClient,
      user,
      source: "worker",
      sourceMessageId: "wrk_123",
      conversationId: "cnv_123",
      assistantMessages: [createMessage({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        sourceMessageId: null,
        content: "[handle:spc-msg-out]\nworker answer",
        createdAt: new Date("2026-05-07T09:05:00.000Z"),
      })],
      defaultTimezone: "UTC",
    });

    expect(document?.customId).toBe("hot-path-turn_wrk_123_5c0bc811a8db");
    expect(document?.content).toBe("[assistant | delivered | source:worker]\nworker answer");
    expect(document?.conversationMessages).toEqual([{ role: "assistant", content: "worker answer", delivered: true }]);
    expect(document?.metadata).toMatchObject({
      kind: "hot_path_turn",
      messageId: "wrk_123",
      conversationId: "cnv_123",
      delivered: true,
      inboundSource: "worker",
      timestamp: "2026-05-07T09:05:00.000Z",
    });
  });

  it("renders recurring Pattern run outcomes with stable custom IDs", () => {
    const pattern = createPattern();
    const result = { summary: "Found launch.", data: { title: "Launch" } } satisfies WorkerResult;
    const document = buildPatternRunOutcomeBackfillDocument({
      client,
      user,
      pattern,
      run: createRun(pattern, { result, notifyOutcome: { notify: false, summary: "Found launch.", reason: "already surfaced" } }),
      result,
      defaultTimezone: "UTC",
    });

    expect(document?.customId).toBe("pattern-run_ptrun_123");
    expect(document?.content).toContain("Pattern run ID: ptrun_123");
    expect(document?.content).toContain("Notify reason: already surfaced");
    expect(document?.metadata).toMatchObject({
      kind: "pattern_run_outcome",
      source: "pattern_worker",
      patternId: "ptn_123",
      patternRunId: "ptrun_123",
      notified: false,
      oneShot: false,
    });
  });

  it("builds Hindsight Pattern backfill documents with provider-specific IDs and Pattern metadata", () => {
    const pattern = createPattern({ id: "ptn:daily/news" });
    const result = { summary: "Found launch." } satisfies WorkerResult;
    const document = buildPatternRunOutcomeBackfillDocument({
      client: hindsightClient,
      user,
      pattern,
      run: createRun(pattern, {
        id: "ptrun:abc/123",
        result,
        notifyOutcome: { notify: true, summary: "Found launch." },
        surfacedAt: new Date("2026-05-07T09:03:00.000Z"),
      }),
      result,
      defaultTimezone: "UTC",
    });

    expect(document?.customId).toBe("pattern-run_ptrun_abc_123_e9cb56e5aa17");
    expect(document?.metadata).toMatchObject({
      kind: "pattern_run_outcome",
      source: "pattern_worker",
      patternId: "ptn:daily/news",
      patternRunId: "ptrun:abc/123",
      triggeredBy: "schedule",
      notified: true,
      surfaced: true,
      completedAt: "2026-05-07T09:01:00.000Z",
    });
  });

  it("skips one-shot schedule Pattern outcomes", () => {
    const pattern = createPattern({ triggerConfig: { type: "schedule", schedule: { kind: "once", localDateTime: "2026-05-07T09:00:00" }, timezoneSource: "user" } });
    const result = { summary: "done" } satisfies WorkerResult;
    const document = buildPatternRunOutcomeBackfillDocument({
      client,
      user,
      pattern,
      run: createRun(pattern, { result, notifyOutcome: { notify: true, summary: "done" } }),
      result,
      defaultTimezone: "UTC",
    });

    expect(document).toBeNull();
  });

  it("renders user profile seed backfills with browser-captured timezone", () => {
    const document = buildUserProfileSeedBackfillDocument({
      user: {
        ...user,
        timezone: "Australia/Brisbane",
      },
      defaultTimezone: "UTC",
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(document?.kind).toBe("user_profile_seed");
    expect(document?.customId).toBe("user-profile-seed");
    expect(document?.content).toContain("Name: Alex");
    expect(document?.content).toContain("Home/base location: Brisbane, Australia");
    expect(document?.content).toContain("Timezone: Australia/Brisbane");
    expect(document?.content).not.toContain("+15555555555");
    expect(document?.metadata).toMatchObject({
      kind: "user_profile_seed",
      source: "finn_core_profile",
      timezoneSource: "browser",
    });
  });

  it("does not default browser-captured profile seeds without a stored timezone", () => {
    const document = buildUserProfileSeedBackfillDocument({
      user: {
        ...user,
        timezone: "",
      },
      defaultTimezone: "UTC",
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(document?.content).toContain("Name: Alex");
    expect(document?.content).not.toContain("Timezone: UTC");
    expect(document?.content).not.toContain("Timezone source:");
    expect(document?.metadata).toMatchObject({
      kind: "user_profile_seed",
      source: "finn_core_profile",
      hasTimezone: false,
      timezoneSource: "browser",
    });
  });
});

describe("memory backfill planning", () => {
  it("plans user-message-only historical turns instead of skipping them", async () => {
    const db = createDb(
      [{ message: createMessage(), user }],
      [],
      [],
      [],
    );

    const plan = await planMemoryBackfill({
      db,
      client,
      options: createOptions(["hot_path_turn"]),
    });

    expect(plan.scanned).toBe(1);
    expect(plan.skipped).toEqual({});
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]?.content).toContain("[no visible assistant response]");
    expect(plan.documents[0]?.metadata).toMatchObject({ delivered: false });
  });

  it("plans existing user profile seeds", async () => {
    const db = createDb([{ user: { ...user, timezone: "Australia/Brisbane" } }]);

    const plan = await planMemoryBackfill({
      db,
      client,
      options: createOptions(["user_profile_seed"], {
        defaultTimezone: "UTC",
      }),
    });

    expect(plan.scanned).toBe(1);
    expect(plan.skipped).toEqual({});
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]?.kind).toBe("user_profile_seed");
    expect(plan.documents[0]?.content).toContain("Timezone: Australia/Brisbane");
  });

  it("does not plan profile seeds for providers without profile seed backfill support", async () => {
    const db = createDb([{ user: { ...user, timezone: "Australia/Brisbane" } }]);

    const plan = await planMemoryBackfill({
      db,
      client: hindsightClient,
      options: createOptions(["user_profile_seed"], {
        defaultTimezone: "UTC",
      }),
    });

    expect(plan.scanned).toBe(0);
    expect(plan.documents).toEqual([]);
    expect(plan.skipped).toEqual({ user_profile_seed_unsupported_provider: 1 });
  });

  it("plans existing user profile seeds for Mem0", async () => {
    const db = createDb([{ user: { ...user, timezone: "Australia/Brisbane" } }]);

    const plan = await planMemoryBackfill({
      db,
      client: createMemoryClient("mem0"),
      options: createOptions(["user_profile_seed"], {
        defaultTimezone: "UTC",
      }),
    });

    expect(plan.scanned).toBe(1);
    expect(plan.skipped).toEqual({});
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]?.kind).toBe("user_profile_seed");
    expect(plan.documents[0]?.customId).toBe("user-profile-seed");
  });

  it("plans worker-origin visible assistant deliveries as separate session appends", async () => {
    const workerInbound = createMessage({
      id: "msg_worker_inbound",
      role: "user",
      source: "worker",
      sourceMessageId: "wrk_123",
      content: "[Internal — message from background worker, not the user]",
      createdAt: new Date("2026-05-07T09:05:00.000Z"),
    });
    const db = createDb(
      [{ message: createMessage(), user }],
      [workerInbound],
      [],
      [{ message: workerInbound, user }],
      [],
      [createMessage({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        sourceMessageId: null,
        content: "[handle:spc-msg-out]\nworker answer",
        createdAt: new Date("2026-05-07T09:05:10.000Z"),
      })],
      [],
    );

    const plan = await planMemoryBackfill({
      db,
      client: hindsightClient,
      options: createOptions(["hot_path_turn"]),
    });

    expect(plan.scanned).toBe(2);
    expect(plan.skipped).toEqual({});
    expect(plan.documents).toHaveLength(2);
    expect(plan.documents[1]?.customId).toBe("hot-path-turn_wrk_123_5c0bc811a8db");
    expect(plan.documents[1]?.content).toBe("[assistant | delivered | source:worker]\nworker answer");
    expect(plan.documents[1]?.metadata).toMatchObject({ inboundSource: "worker", messageId: "wrk_123" });
  });

  it("executes provider-neutral writes and reports counts", async () => {
    const memory = createMemoryClient();
    const db = createDb(
      [{ message: createMessage(), user }],
      [],
      [createMessage({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        sourceMessageId: null,
        content: "hey there",
        createdAt: new Date("2026-05-07T09:00:03.000Z"),
      })],
      [],
    );

    const result = await runMemoryBackfill({
      db,
      client: memory,
      options: createOptions(["hot_path_turn"], { dryRun: false }),
    });

    expect(result.written).toBe(1);
    expect(result.failed).toBe(0);
    expect(memory.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "hot-path-turn_spectrum_123",
      content: expect.stringContaining("hey there"),
      source: expect.objectContaining({
        provider: "finn",
        type: "imessage_turn",
        id: "spectrum_123",
      }),
      observability: {
        operation: "backfill_retain",
        messageId: "spectrum_123",
        conversationId: "cnv_123",
      },
    }));
  });

  it("counts provider-neutral write failures", async () => {
    const memory = createMemoryClient();
    const addDocument = memory.addDocument as ReturnType<typeof mock>;
    addDocument.mockResolvedValueOnce(null);
    const db = createDb(
      [{ message: createMessage(), user }],
      [],
      [],
    );

    const result = await runMemoryBackfill({
      db,
      client: memory,
      options: createOptions(["hot_path_turn"], { dryRun: false }),
    });

    expect(result.written).toBe(0);
    expect(result.failed).toBe(1);
  });
});
