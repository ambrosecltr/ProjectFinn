import { describe, expect, it } from "bun:test";
import { asSchema, type ModelMessage } from "ai";
import type { WorkerRecord } from "@finn/core";

import { buildWorkerResumeCheckpoint, compactWorkerLoopMessages, compactWorkerMessages, compactWorkerMessagesWithCheckpoint, createOutcomeRecorder, finalizeFallbackWorkerOutcome, getImplicitOutcomeFromToolResults, setStatusSchema, WorkerAgent } from "./worker.js";
import { WorkerFollowUpUnavailableError, WorkerManager } from "./worker-manager.js";

const baseUser = {
  tenantId: "tenant_default",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: "Test User",
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

function createCompletedWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = new Date();

  return {
    id: "wrk_resume",
    tenantId: baseUser.tenantId,
    userId: baseUser.userId,
    type: "general",
    task: "research flights",
    state: "done",
    runSequence: 1,
    statusDetail: "done",
    toolCallsUsed: 0,
    result: { summary: "done" },
    modelMessages: [{ role: "user", content: "Task:\nresearch flights" }],
    followUpExpiresAt: new Date(Date.now() + 60_000),
    parentConversationId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    originMessageId: "msg_original",
    completionDeliveredAt: now,
    ...overrides,
  };
}

function createRunningWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = new Date();

  return {
    id: "wrk_active",
    tenantId: baseUser.tenantId,
    userId: baseUser.userId,
    type: "general",
    task: "research flights",
    state: "running",
    runSequence: 1,
    statusDetail: "searching",
    toolCallsUsed: 0,
    result: null,
    modelMessages: null,
    followUpExpiresAt: null,
    parentConversationId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    originMessageId: "msg_original",
    completionDeliveredAt: null,
    ...overrides,
  };
}

function createCancelableWorkerDb(initialWorker: WorkerRecord) {
  let worker = initialWorker;

  const db = {
    select() {
      return {
        from(_table: unknown) {
          return {
            where(_condition?: unknown) {
              return this;
            },
            limit: async (_limit: number) => [worker],
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(patch: Partial<WorkerRecord>) {
          return {
            where(_condition?: unknown) {
              return {
                returning: async () => {
                  if (worker.state !== "created" && worker.state !== "running") {
                    return [];
                  }

                  worker = {
                    ...worker,
                    ...patch,
                  };

                  return [{ id: worker.id }];
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db,
    getWorker: () => worker,
    setWorker: (nextWorker: WorkerRecord) => {
      worker = nextWorker;
    },
  };
}

function createConcurrentResumeDb(initialWorker: WorkerRecord) {
  let worker = initialWorker;
  let selectCount = 0;
  let releaseSecondSelect: (() => void) | null = null;
  const waitForSecondSelect = new Promise<void>((resolve) => {
    releaseSecondSelect = resolve;
  });

  const db = {
    select() {
      return {
        from(_table: unknown) {
          return {
            where(_condition?: unknown) {
              return this;
            },
            limit: async (_limit: number) => {
              selectCount += 1;
              const selected = worker ? { ...worker } : undefined;
              if (selectCount <= 2) {
                if (selectCount === 2) releaseSecondSelect?.();
                await waitForSecondSelect;
              }

              return selected ? [selected] : [];
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(patch: Partial<WorkerRecord>) {
          return {
            where(_condition?: unknown) {
              return {
                returning: async () => {
                  if (patch.state === "created" && worker.state !== "done") {
                    return [];
                  }

                  if (patch.state === "running") {
                    return [];
                  }

                  worker = {
                    ...worker,
                    ...patch,
                  };

                  return [{ id: worker.id }];
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db,
    getWorker: () => worker,
  };
}

function createWorkerManager(db: unknown, eventBus: { emit: (event: unknown) => Promise<void> } = { emit: async () => undefined }): WorkerManager {
  return new WorkerManager({
    db: db as never,
    llmManager: {
      getModel: () => ({}),
      getRequestOptions: () => ({}),
    } as never,
    eventBus: eventBus as never,
    config: {
      workerLimits: {
        maxConcurrent: 10,
        maxToolCalls: 10,
      },
      workerTimeoutMs: 10_000,
      maxTurns: {
        worker: 1,
      },
      context: {
        maxTokens: 128_000,
      },
      userTimezone: "UTC",
    } as never,
    user: baseUser,
  });
}

describe("WorkerAgent set_status schema", () => {
  it("sends OpenAI-compatible parameters as a top-level object", async () => {
    const jsonSchema = await asSchema(setStatusSchema).jsonSchema;

    expect(jsonSchema).toMatchObject({
      type: "object",
      required: ["kind", "detail"],
    });
    expect(Object.hasOwn(jsonSchema, "anyOf")).toBe(false);
    expect(Object.hasOwn(jsonSchema, "oneOf")).toBe(false);
  });

  it("keeps kind-specific status detail validation", () => {
    expect(setStatusSchema.safeParse({ kind: "working", detail: "checking inbox" }).success).toBe(true);
    expect(setStatusSchema.safeParse({ kind: "outcome", detail: { summary: "Found the answer." } }).success).toBe(true);
    expect(setStatusSchema.safeParse({ kind: "working", detail: { summary: "Not valid for progress." } }).success).toBe(false);
    expect(setStatusSchema.safeParse({ kind: "outcome", detail: "done" }).success).toBe(false);
  });
});

describe("WorkerManager cancellation", () => {
  it("aborts active general workers cancelled by the hot path", async () => {
    const { db, getWorker } = createCancelableWorkerDb(createRunningWorker());
    const events: unknown[] = [];
    const manager = createWorkerManager(db, {
      emit: async (event) => {
        events.push(event);
      },
    });
    const abortController = new AbortController();
    (manager as unknown as {
      activeExecutions: Map<string, { timeout: ReturnType<typeof setTimeout>; abortController: AbortController }>;
    }).activeExecutions.set("wrk_active", {
      timeout: setTimeout(() => undefined, 10_000),
      abortController,
    });

    const result = await manager.cancelHotPathWorker("wrk_active", "superseded_by_new_request");

    expect(result).toEqual({
      cancelled: true,
      workerId: "wrk_active",
      task: "research flights",
      reason: "superseded_by_new_request",
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(getWorker()).toMatchObject({
      state: "cancelled",
      statusDetail: "Cancelled by hot path: superseded_by_new_request.",
      followUpExpiresAt: null,
    });
    expect(events).toEqual([{
      type: "worker_cancelled",
      tenantId: baseUser.tenantId,
      userId: baseUser.userId,
      workerId: "wrk_active",
      task: "research flights",
      source: "user",
      originMessageId: "msg_original",
      reason: "Cancelled by hot path: superseded_by_new_request.",
    }]);
  });

  it("refuses hot-path cancellation for non-general workers", async () => {
    const { db, getWorker } = createCancelableWorkerDb(createRunningWorker({
      id: "wrk_pattern_mgmt",
      type: "pattern_management",
      task: "create a pattern",
    }));
    const manager = createWorkerManager(db);

    const result = await manager.cancelHotPathWorker("wrk_pattern_mgmt", "user_cancelled");

    expect(result).toMatchObject({
      cancelled: false,
      workerId: "wrk_pattern_mgmt",
    });
    expect(getWorker()).toMatchObject({
      state: "running",
      type: "pattern_management",
    });
  });
});

describe("WorkerManager resume", () => {
  it("only claims one concurrent follow-up for the same completed worker", async () => {
    const { db, getWorker } = createConcurrentResumeDb(createCompletedWorker());
    const manager = createWorkerManager(db);
    const spawnOpts = {
      tenantId: baseUser.tenantId,
      userId: baseUser.userId,
      workerId: "wrk_resume",
      task: "compare those options in business class",
      source: "user" as const,
    };

    const results = await Promise.allSettled([
      manager.spawn(spawnOpts),
      manager.spawn({ ...spawnOpts, task: "compare those options in economy" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(WorkerFollowUpUnavailableError);
    expect(getWorker()).toMatchObject({
      id: "wrk_resume",
      state: "created",
      runSequence: 2,
      completionDeliveredAt: null,
      followUpExpiresAt: null,
    });
  });
});

describe("WorkerManager runtime cleanup", () => {
  it("preserves temporary run artifacts until a completed worker cannot resume", async () => {
    const { db } = createCancelableWorkerDb(createCompletedWorker({
      followUpExpiresAt: new Date(Date.now() + 60_000),
    }));
    const manager = createWorkerManager(db);
    const cleanupCalls: Array<{ preserveTemporaryWorkspace?: boolean } | undefined> = [];
    const cleanupRuntime = (manager as unknown as {
      cleanupRuntime(workerId: string, runtimeConfig: { cleanup: (options?: { preserveTemporaryWorkspace?: boolean }) => void | Promise<void> }): Promise<void>;
    }).cleanupRuntime.bind(manager);

    await cleanupRuntime("wrk_resume", {
      cleanup: (options) => {
        cleanupCalls.push(options);
      },
    });

    expect(cleanupCalls).toEqual([{ preserveTemporaryWorkspace: true }]);

    await manager.shutdownAll();

    expect(cleanupCalls).toEqual([{ preserveTemporaryWorkspace: true }, undefined]);
  });

  it("cleans temporary run artifacts immediately for non-resumable workers", async () => {
    const { db } = createCancelableWorkerDb(createCompletedWorker({
      state: "failed",
      followUpExpiresAt: null,
    }));
    const manager = createWorkerManager(db);
    const cleanupCalls: Array<{ preserveTemporaryWorkspace?: boolean } | undefined> = [];
    const cleanupRuntime = (manager as unknown as {
      cleanupRuntime(workerId: string, runtimeConfig: { cleanup: (options?: { preserveTemporaryWorkspace?: boolean }) => void | Promise<void> }): Promise<void>;
    }).cleanupRuntime.bind(manager);

    await cleanupRuntime("wrk_resume", {
      cleanup: (options) => {
        cleanupCalls.push(options);
      },
    });

    expect(cleanupCalls).toEqual([undefined]);
  });

  it("keeps pending follow-up cleanup when runtime creation fails", async () => {
    const { db, getWorker, setWorker } = createCancelableWorkerDb(createCompletedWorker({
      followUpExpiresAt: new Date(Date.now() + 60_000),
    }));
    const manager = createWorkerManager(db);
    const cleanupCalls: Array<{ preserveTemporaryWorkspace?: boolean } | undefined> = [];
    const cleanupRuntime = (manager as unknown as {
      cleanupRuntime(workerId: string, runtimeConfig: { cleanup: (options?: { preserveTemporaryWorkspace?: boolean }) => void | Promise<void> }): Promise<void>;
    }).cleanupRuntime.bind(manager);
    const runWorker = (manager as unknown as {
      runWorker(workerId: string, opts: { type?: "general"; task: string; source: "user" }, initialMessages?: unknown[]): Promise<void>;
    }).runWorker.bind(manager);

    await cleanupRuntime("wrk_resume", {
      cleanup: (options) => {
        cleanupCalls.push(options);
      },
    });
    setWorker({
      ...getWorker(),
      state: "created",
      followUpExpiresAt: null,
      runSequence: 2,
    });
    (manager as unknown as {
      getWorkerTools: () => Promise<never>;
    }).getWorkerTools = async () => {
      throw new Error("runtime unavailable");
    };

    await runWorker("wrk_resume", { task: "follow up", source: "user" }, [{ role: "user", content: "previous" }]);
    await manager.shutdownAll();

    expect(cleanupCalls).toEqual([{ preserveTemporaryWorkspace: true }, undefined]);
  });

  it("pauses pending follow-up cleanup while runtime creation is in progress", async () => {
    const { db, getWorker, setWorker } = createCancelableWorkerDb(createCompletedWorker({
      followUpExpiresAt: new Date(Date.now() + 60_000),
    }));
    const manager = createWorkerManager(db);
    const cleanupCalls: Array<{ preserveTemporaryWorkspace?: boolean } | undefined> = [];
    const cleanupRuntime = (manager as unknown as {
      cleanupRuntime(workerId: string, runtimeConfig: { cleanup: (options?: { preserveTemporaryWorkspace?: boolean }) => void | Promise<void> }): Promise<void>;
    }).cleanupRuntime.bind(manager);
    const runWorker = (manager as unknown as {
      runWorker(workerId: string, opts: { type?: "general"; task: string; source: "user" }, initialMessages?: unknown[]): Promise<void>;
    }).runWorker.bind(manager);
    const pendingRuntimeCleanups = (manager as unknown as {
      pendingRuntimeCleanups: Map<string, unknown>;
    }).pendingRuntimeCleanups;

    await cleanupRuntime("wrk_resume", {
      cleanup: (options) => {
        cleanupCalls.push(options);
      },
    });
    setWorker({
      ...getWorker(),
      state: "created",
      followUpExpiresAt: null,
      runSequence: 2,
    });

    const runtimeCreation = {
      reject: undefined as undefined | ((error: Error) => void),
    };
    const runtimeCreationStarted = new Promise<void>((resolve) => {
      (manager as unknown as {
        getWorkerTools: () => Promise<never>;
      }).getWorkerTools = async () => {
        return await new Promise<never>((_resolve, reject) => {
          runtimeCreation.reject = reject;
          resolve();
        });
      };
    });

    const run = runWorker("wrk_resume", { task: "follow up", source: "user" }, [{ role: "user", content: "previous" }]);
    await runtimeCreationStarted;

    expect(cleanupCalls).toEqual([{ preserveTemporaryWorkspace: true }]);
    expect(pendingRuntimeCleanups.has("wrk_resume")).toBe(false);

    if (!runtimeCreation.reject) {
      throw new Error("runtime creation did not start");
    }
    runtimeCreation.reject(new Error("runtime unavailable"));
    await run;

    expect(pendingRuntimeCleanups.has("wrk_resume")).toBe(true);

    await manager.shutdownAll();

    expect(cleanupCalls).toEqual([{ preserveTemporaryWorkspace: true }, undefined]);
  });
});

describe("createOutcomeRecorder", () => {
  it("rejects multiple terminal outcomes", async () => {
    const outcomes: string[] = [];
    const recordOutcome = createOutcomeRecorder(async (outcome) => {
      outcomes.push(outcome.summary);
    });

    await recordOutcome({ summary: "first" });
    await expect(recordOutcome({ summary: "second" })).rejects.toThrow(
      "Worker reported multiple terminal outcomes.",
    );

    expect(outcomes).toEqual(["first"]);
  });

  it("allows retry when outcome persistence rejects", async () => {
    const outcomes: string[] = [];
    let attempts = 0;
    const recordOutcome = createOutcomeRecorder(async (outcome) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("invalid input syntax for type json");
      }

      outcomes.push(outcome.summary);
    });

    await expect(recordOutcome({ summary: "bad emoji \uD83C" })).rejects.toThrow("invalid input syntax");
    await recordOutcome({ summary: "clean retry" });

    expect(outcomes).toEqual(["clean retry"]);
  });

  it("requires pattern workers to include notify in their terminal outcome", async () => {
    const recordOutcome = createOutcomeRecorder(async () => undefined, { requirePatternOutcome: true });

    await expect(recordOutcome({ summary: "matched" })).rejects.toThrow(
      "Pattern workers must report notify",
    );
  });

  it("normalizes pattern outcomes without duplicating notify data into worker results", async () => {
    const outcomes: unknown[] = [];
    const notifyOutcomes: unknown[] = [];
    const recordOutcome = createOutcomeRecorder(async (outcome) => {
      outcomes.push(outcome);
    }, {
      requirePatternOutcome: true,
      onPatternNotifyOutcome: async (outcome) => {
        notifyOutcomes.push(outcome);
      },
    });

    await recordOutcome({
      notify: true,
      summary: "Matched email from Kenny.",
      reason: "Sender matched.",
      data: { emailId: "email_123" },
    });

    expect(outcomes).toEqual([{
      summary: "Matched email from Kenny.",
      data: { emailId: "email_123" },
      error: undefined,
    }]);
    expect(notifyOutcomes).toEqual([{
      notify: true,
      summary: "Matched email from Kenny.",
      reason: "Sender matched.",
      data: { emailId: "email_123" },
    }]);
  });
});

describe("WorkerAgent persistence repair", () => {
  it("surfaces checkpoint persistence failures as internal repair context", async () => {
    const agent = new WorkerAgent({
      task: "test task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      onMessagesChange: async () => {
        throw new Error("invalid input syntax for type json");
      },
    });

    const repaired = await (agent as unknown as {
      persistWorkerMessages(messages: ModelMessage[], reason: string): Promise<ModelMessage[]>;
    }).persistWorkerMessages([{ role: "user", content: "Task:\ninspect inbox" }], "after_step");

    expect(repaired).toHaveLength(2);
    expect(repaired[1]).toMatchObject({
      role: "user",
    });
    expect(String(repaired[1]?.content)).toContain("[worker runtime repair - not from the user]");
    expect(String(repaired[1]?.content)).toContain("invalid input syntax for type json");
  });
});

describe("WorkerAgent implicit outcomes", () => {
  it("ignores legacy native media tool results when set_status is omitted", async () => {
    const outcome = getImplicitOutcomeFromToolResults([
      {
        toolName: "create_or_edit_image",
        result: {
          fileIds: ["file_123"],
          images: [{ fileId: "file_123", url: "https://example.com/files/file_123", contentType: "image/png" }],
          storedLocally: true,
        },
      },
    ]);

    expect(outcome).toBeNull();
  });

  it("treats successful creative JS workspace results as an outcome when set_status is omitted", async () => {
    const outcome = getImplicitOutcomeFromToolResults([
      {
        toolName: "workspace_execute",
        result: {
          success: true,
          result: {
            fileIds: ["file_123"],
            images: [{ fileId: "file_123", url: "https://example.com/files/file_123", contentType: "image/png" }],
            storedLocally: true,
          },
          logs: [],
        },
      },
    ]);

    expect(outcome).toEqual({
      summary: "Completed via workspace_execute.",
      data: {
        fileIds: ["file_123"],
        images: [{ fileId: "file_123", url: "https://example.com/files/file_123", contentType: "image/png" }],
        storedLocally: true,
      },
    });
  });

  it("ignores tool results that only contain errors", async () => {
    const outcome = getImplicitOutcomeFromToolResults([
      {
        toolName: "create_or_edit_image",
        result: {
          error: "FAL failed",
        },
      },
    ]);

    expect(outcome).toBeNull();
  });

  it("fails pattern workers instead of using implicit fallback outcomes", () => {
    const outcome = finalizeFallbackWorkerOutcome({
      source: "pattern",
      implicitOutcome: {
        summary: "Completed via creative image.",
        data: { fileIds: ["file_123"] },
      },
      text: "completed",
      maxTurns: 3,
    });

    expect(outcome).toEqual({
      summary: "Pattern worker failed to report a notify outcome.",
      error: "Pattern workers must report notify, summary, and optional reason/data in their terminal outcome.",
    });
  });

  it("keeps implicit fallback outcomes for user-sourced workers", () => {
    const outcome = finalizeFallbackWorkerOutcome({
      source: "user",
      implicitOutcome: {
        summary: "Completed via creative image.",
        data: { fileIds: ["file_123"] },
      },
      text: "",
      maxTurns: 3,
    });

    expect(outcome).toEqual({
      summary: "Completed via creative image.",
      data: { fileIds: ["file_123"] },
    });
  });
});

describe("Worker finalization prompt", () => {
  it("keeps implicit tool outcome fallback available for successful creative JS workspace results", () => {
    const outcome = getImplicitOutcomeFromToolResults([
      {
        toolName: "workspace_execute",
        result: {
          success: true,
          result: { fileIds: ["file_abc"] },
          logs: [],
        },
      },
    ]);

    expect(outcome?.summary).toBe("Completed via workspace_execute.");
  });

  it("compacts oversized tool results before follow-up worker turns", () => {
    const messages = compactWorkerMessages([
      {
        role: "user",
        content: "Task:\ninspect a large tool result",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
          output: { type: "text", value: "x".repeat(700_000) },
        }],
      },
    ]);

    expect(JSON.stringify(messages).length).toBeLessThan(200_000);
    expect(JSON.stringify(messages)).toContain("Large tool output omitted from worker history");
    expect(JSON.stringify(messages)).not.toContain("workbench");
  });

  it("keeps fresh image tool output for the next worker model call", () => {
    const messages = compactWorkerMessages([
      {
        role: "user",
        content: "Task:\ninspect an image",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_image", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "{\"filename\":\"dog.jpg\"}" },
              { type: "image-data", data: "x".repeat(500), mediaType: "image/jpeg" },
            ],
          },
        }],
      },
    ] as ModelMessage[]);

    expect(JSON.stringify(messages)).toContain("\"type\":\"image-data\"");
  });

  it("omits consumed image tool output from later worker history", () => {
    const messages = compactWorkerMessages([
      {
        role: "user",
        content: "Task:\ninspect an image",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_image", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "{\"filename\":\"dog.jpg\"}" },
              { type: "image-data", data: "x".repeat(500), mediaType: "image/jpeg" },
            ],
          },
        }],
      },
      {
        role: "assistant",
        content: "The image is a dog.",
      },
    ] as ModelMessage[]);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("\"type\":\"image-data\"");
    expect(serialized).toContain("image data omitted from worker history");
    expect(serialized).toContain("dog.jpg");
  });

  it("omits consumed image tool output before checkpoint compaction measures prompt size", async () => {
    const messages = await compactWorkerMessagesWithCheckpoint([
      {
        role: "user",
        content: "Task:\ninspect an image",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_image", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "{\"filename\":\"dog.jpg\"}" },
              { type: "image-data", data: "x".repeat(500), mediaType: "image/jpeg" },
            ],
          },
        }],
      },
      {
        role: "assistant",
        content: "The image is a dog.",
      },
    ] as ModelMessage[], {
      model: {} as never,
      maxPromptTokens: 10_000,
      maxMessageTokens: 500,
    }, () => undefined);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("\"type\":\"image-data\"");
    expect(serialized).toContain("image data omitted from worker history");
    expect(serialized).toContain("dog.jpg");
  });

  it("can compact worker history against a smaller explicit context budget", () => {
    const messages = compactWorkerMessages([
      {
        role: "user",
        content: "Task:\ninspect a large tool result",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "workspace_execute", input: { code: "return await finn.web.search({ query: 'atlas' });" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "workspace_execute",
          output: { type: "text", value: "x".repeat(80_000) },
        }],
      },
    ], { maxPromptTokens: 100, maxMessageTokens: 500 });

    expect(JSON.stringify(messages)).toContain("Tool output omitted from worker history");
    expect(JSON.stringify(messages).length).toBeLessThan(12_000);
  });

  it("persists the latest compacted checkpoint for future follow-ups", async () => {
    const baseMessages = [
      {
        role: "user",
        content: "Task:\ninspect a large tool result",
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "workspace_execute", input: { code: "return await finn.web.search({ query: 'atlas' });" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "workspace_execute",
          output: { type: "text", value: "x".repeat(80_000) },
        }],
      },
    ] as ModelMessage[];
    const responseMessages = [{ role: "assistant", content: "done" }] as never;

    const checkpoint = await buildWorkerResumeCheckpoint({
      baseMessages,
      responseMessages,
      compactMessages: async (messages) => compactWorkerMessages(messages, { maxPromptTokens: 100, maxMessageTokens: 500 }),
    });

    expect(JSON.stringify(checkpoint)).toContain("Tool output omitted from worker history");
    expect(JSON.stringify(checkpoint)).toContain("done");
    expect(JSON.stringify(checkpoint).length).toBeLessThan(12_000);
  });

  it("resets long-running worker context to initial message plus checkpoint", async () => {
    const messages = [
      { role: "user", content: "Task:\ninitial worker task" },
      { role: "assistant", content: "older action 1" },
      { role: "tool", content: [{ type: "tool-result", output: { type: "text", value: "older output" } }] },
      { role: "user", content: "[worker context checkpoint - not from the user]\n\nsummary of older work" },
      { role: "assistant", content: "recent action after compaction" },
    ] as ModelMessage[];

    const checkpoint = await compactWorkerLoopMessages({
      messages,
      fixedMessageCount: 1,
      compactMessages: async () => messages.slice(0, 1).concat(messages.slice(3)),
    });

    expect(checkpoint).toEqual([
      { role: "user", content: "Task:\ninitial worker task" },
      { role: "user", content: "[worker context checkpoint - not from the user]\n\nsummary of older work" },
      { role: "assistant", content: "recent action after compaction" },
    ]);
  });

  it("describes the Finn JS workspace without host machine details", () => {
    const agent = new WorkerAgent({
      task: "test task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).not.toContain("## workspace " + "runtime");
    expect(systemPrompt).toContain("Finn JS workspace tools");
    expect(systemPrompt).toContain("workspace_search before workspace_execute");
    expect(systemPrompt).toContain("workspace-local scratch");
    expect(systemPrompt).toContain("runtime appendix");
    expect(systemPrompt).not.toContain("Secure Exec");
    expect(systemPrompt).not.toContain("not a shell");
    expect(systemPrompt).not.toContain("## machine details");
    expect(systemPrompt).not.toContain("package managers available:");
    expect(systemPrompt).not.toContain("common commands available:");
    expect(systemPrompt).not.toContain("Use these details when choosing shell commands or install steps.");
    expect(systemPrompt).not.toContain("apt-get");
  });

  it("builds a follow-up message after existing worker history", () => {
    const agent = new WorkerAgent({
      task: "compare those options in business class",
      context: "The user is still talking about the flights from the original worker.",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      initialMessages: [{ role: "user", content: "Task:\nresearch flights" }],
    });

    const content = (agent as unknown as { buildFollowUpMessageContent: () => string }).buildFollowUpMessageContent();

    expect(content).toContain("This is a follow-up to the same worker run.");
    expect(content).toContain("Follow-up task:");
    expect(content).toContain("compare those options in business class");
    expect(content).toContain("Follow-up context:");
  });

  it("does not include optional worker tool-family instructions without a runtime appendix", () => {
    const agent = new WorkerAgent({
      task: "test task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).not.toContain("COMPOSIO");
    expect(systemPrompt).not.toContain("## composio auth");
    expect(systemPrompt).not.toContain("search_mcp_tools");
    expect(systemPrompt).not.toContain("call_mcp_tool");
    expect(systemPrompt).not.toContain("create_or_edit_image");
    expect(systemPrompt).not.toContain("search_skills_sh");
    expect(systemPrompt).not.toContain("install_skill_from_skills_sh");
  });

  it("uses kids-mode worker prompts for kids-mode users", () => {
    const agent = new WorkerAgent({
      task: "test kid task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: { ...baseUser, kidsMode: true },
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("running for a kids-mode user");
    expect(systemPrompt).toContain("do not create new external-service connection requests");
    expect(systemPrompt).not.toContain("<overview>\nyou are a background worker for finn, a personal intelligence. you execute");
  });

  it("uses the pattern worker prompt for pattern-triggered workers", () => {
    const agent = new WorkerAgent({
      task: "test pattern task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      source: "pattern",
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("<pattern_worker>");
    expect(systemPrompt).toContain("do NOT create, edit, delete, list, or manage patterns");
    expect(systemPrompt).toContain("<tool_usage>");
    expect(systemPrompt).toContain("available tools are listed in the runtime appendix");
    expect(systemPrompt).toContain("<email_drafting>");
    expect(systemPrompt).not.toContain("### composio");
    expect(systemPrompt).not.toContain("### MCP");
    expect(systemPrompt).not.toContain("## pattern tools");
    expect(systemPrompt).not.toContain("search_mcp_tools");
    expect(systemPrompt).not.toContain("create_or_edit_image");
    expect(systemPrompt).not.toContain("search_skills_sh");
  });

  it("uses the pattern worker prompt for pattern_worker workers", () => {
    const agent = new WorkerAgent({
      task: "run saved pattern",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      workerType: "pattern_worker",
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("<pattern_worker>");
    expect(systemPrompt).toContain("do NOT create, edit, delete, list, or manage patterns");
    expect(systemPrompt).toContain("with an explicit notify boolean");
    expect(systemPrompt).not.toContain("<pattern_management_worker>");
  });

  it("uses the pattern worker prompt for pattern-triggered workers regardless of stored type", () => {
    const agent = new WorkerAgent({
      task: "run saved pattern",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      source: "pattern",
      workerType: "pattern_management",
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("<pattern_worker>");
    expect(systemPrompt).not.toContain("<pattern_management_worker>");
  });

  it("uses the pattern management prompt for pattern_management workers", () => {
    const agent = new WorkerAgent({
      task: "create a pattern",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: baseUser,
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      workerType: "pattern_management",
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("<pattern_management_worker>");
    expect(systemPrompt).toContain("create, inspect, list, update, pause/resume, or delete patterns");
  });

  it("uses kids-mode pattern worker prompts for kids-mode pattern workers", () => {
    const agent = new WorkerAgent({
      task: "test kid pattern task",
      context: "",
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      timeZone: "UTC",
      user: { ...baseUser, kidsMode: true },
      tools: {},
      model: {} as never,
      onStatus: () => undefined,
      maxTurns: 1,
      maxToolCalls: 1,
      source: "pattern",
    });

    const systemPrompt = (agent as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();

    expect(systemPrompt).toContain("running a saved pattern for a kids-mode user");
    expect(systemPrompt).toContain("do not create new external-service connection requests");
    expect(systemPrompt).toContain("do not create, edit, delete, list, or manage patterns");
    expect(systemPrompt).not.toContain("running a saved pattern that was triggered automatically");
  });
});
