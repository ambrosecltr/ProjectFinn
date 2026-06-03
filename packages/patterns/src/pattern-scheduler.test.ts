import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";

import type { EventBus, PatternRecord, PatternRunRecord, WorkerResult } from "@finn/core";
import { PatternScheduler } from "./scheduler.js";
import { PatternStore } from "./store.js";

function createPattern(overrides: Partial<PatternRecord> = {}): PatternRecord {
  return {
    id: "ptn_123",
    tenantId: "tenant_test",
    userId: "usr_test",
    name: "One-shot reminder",
    description: null,
    userDescription: null,
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "once", localDateTime: "2026-04-27T09:00:00" }, timezoneSource: "user" },
    connectorScope: { composio: [], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    workerType: "pattern_worker",
    taskPrompt: "Reminder: call the dentist.",
    reminderContext: null,
    timezone: "UTC",
    active: false,
    failureCount: 0,
    lastRunAt: new Date("2026-04-27T09:00:00.000Z"),
    nextRunAt: null,
    createdAt: new Date("2026-04-27T08:00:00.000Z"),
    updatedAt: new Date("2026-04-27T09:00:00.000Z"),
    ...overrides,
  };
}

function createRun(pattern: PatternRecord): PatternRunRecord {
  return {
    id: "ptrun_123",
    tenantId: pattern.tenantId,
    userId: pattern.userId,
    patternId: pattern.id,
    triggeredBy: "schedule",
    triggerPayload: null,
    workerId: "wrk_123",
    state: "done",
    result: { summary: "done" },
    notifyOutcome: { notify: true, summary: "done" },
    surfacedAt: null,
    toolScope: null,
    error: null,
    skipReason: null,
    createdAt: new Date("2026-04-27T09:00:00.000Z"),
    startedAt: new Date("2026-04-27T09:00:00.000Z"),
    completedAt: new Date("2026-04-27T09:01:00.000Z"),
  };
}

function createConfig(memory = false, memoryReflect = false) {
  return {
    capabilities: {
      tools: {
        worker: { memory, memory_reflect: memoryReflect },
      },
    },
    intervals: { patternCircuitBreakerThreshold: 3 },
  } as never;
}

describe("PatternScheduler", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("does not spawn Pattern workers when preflight blocks the run", async () => {
    const spawnWorker = mock(async () => "wrk_unused");
    const scheduler = new PatternScheduler({
      store: {} as never,
      spawnWorker,
      eventBus: { on: () => () => undefined, emit: async () => undefined } as never,
      config: createConfig(),
      beforeRunPattern: mock(async () => false),
    });

    const workerId = await scheduler.runPattern(createPattern({ active: true }), "manual");

    expect(workerId).toBe("");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("deletes completed one-shot schedule patterns", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern();
    const removed: string[] = [];
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        listRuns: async () => [],
        getByWorkerId: async () => pattern,
        markRunCompleted: async (_workerId: string, _result: WorkerResult) => createRun(pattern),
        getById: async () => pattern,
        remove: async (id: string) => {
          removed.push(id);
          return pattern;
        },
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never);

    expect(removed).toEqual([pattern.id]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "pattern_run_completed",
      patternId: pattern.id,
      notifyOutcome: { notify: true, summary: "done" },
    });
  });

  it("enforces never notify conditions when completing Pattern runs", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      notifyCondition: { type: "never" },
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const storedNotifyOutcomes: unknown[] = [];
    const storedResults: unknown[] = [];
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async (_workerId: string, result: WorkerResult, notifyOutcome: unknown) => {
          storedResults.push(result);
          storedNotifyOutcomes.push(notifyOutcome);
          return createRun(pattern);
        },
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never);

    expect(storedNotifyOutcomes).toEqual([{ notify: false, summary: "done" }]);
    expect(storedResults[0]).toEqual({ summary: "done" });
    expect(emitted[0]).toMatchObject({
      type: "pattern_run_completed",
      result: { summary: "done" },
      notifyOutcome: { notify: false, summary: "done" },
    });
  });

  it("ignores duplicate Pattern worker completions after a run is terminal", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const emitted: unknown[] = [];
    let completionCount = 0;

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async () => {
          completionCount += 1;
          return completionCount === 1 ? createRun(pattern) : null;
        },
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    const event = {
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never;
    await handlers.get("worker_completed")?.(event);
    await handlers.get("worker_completed")?.(event);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "pattern_run_completed", workerId: "wrk_123" });
  });

  it("records recurring Pattern outcomes after notify policy is applied", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      notifyCondition: { type: "never" },
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const recorded: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async (_workerId: string, result: WorkerResult, notifyOutcome: unknown) => ({
          ...createRun(pattern),
          result,
          notifyOutcome,
        }),
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
      outcomeRecorder: {
        recordPatternRunOutcome: async (input) => {
          recorded.push(input);
        },
      },
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done", data: { count: 1 } },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      pattern: { id: pattern.id },
      result: { summary: "done", data: { count: 1 } },
      notifyOutcome: { notify: false, summary: "done" },
    });
  });

  it("records Pattern outcomes after delivery handlers can mark surfaced state", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const completedRun = {
      ...createRun(pattern),
      id: "ptrun_completed",
      completedAt: new Date("2026-04-27T09:01:00.000Z"),
      notifyOutcome: { notify: true, summary: "done" },
      result: { summary: "done" },
    } satisfies PatternRunRecord;
    const surfacedRun = {
      ...completedRun,
      surfacedAt: new Date("2026-04-27T09:02:00.000Z"),
    } satisfies PatternRunRecord;
    const recorded: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async () => completedRun,
        getRun: async () => surfacedRun,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(true),
      outcomeRecorder: {
        recordPatternRunOutcome: async (input) => {
          recorded.push(input);
        },
      },
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never);

    expect(recorded).toEqual([{ pattern, run: surfacedRun, result: { summary: "done" }, notifyOutcome: { notify: true, summary: "done" } }]);
  });

  it("does not let memory recording failures block Pattern completion", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async () => createRun(pattern),
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
      outcomeRecorder: {
        recordPatternRunOutcome: async () => {
          throw new Error("provider down");
        },
      },
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: true, summary: "done" },
    } as never);

    expect(emitted[0]).toMatchObject({ type: "pattern_run_completed", patternId: pattern.id });
  });

  it("marks Pattern runs failed when completed workers omit notify outcomes", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const failures: string[] = [];
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        markRunFailed: async (_workerId: string, error: string) => {
          failures.push(error);
          return createRun(pattern);
        },
        incrementFailure: async () => 1,
        getById: async () => pattern,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
    } as never);

    expect(failures).toEqual(["Pattern worker wrk_123 completed without a notify outcome."]);
    expect(emitted[0]).toMatchObject({
      type: "pattern_run_failed",
      patternId: pattern.id,
      workerId: "wrk_123",
      error: "Pattern worker wrk_123 completed without a notify outcome.",
    });
  });

  it("enforces always notify conditions when completing Pattern runs", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      notifyCondition: { type: "always" },
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async () => createRun(pattern),
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: false, summary: "done", reason: "Worker skipped." },
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "pattern_run_completed",
      notifyOutcome: { notify: true, summary: "done", reason: "Worker skipped." },
    });
  });

  it("preserves worker decisions for worker_decision notify conditions", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      notifyCondition: { type: "worker_decision", instruction: "Notify only on matches." },
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        getByWorkerId: async () => pattern,
        markRunCompleted: async () => createRun(pattern),
        getRun: async () => null,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_completed")?.({
      type: "worker_completed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      result: { summary: "done" },
      patternNotifyOutcome: { notify: false, summary: "done" },
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "pattern_run_completed",
      notifyOutcome: { notify: false, summary: "done" },
    });
  });

  it("retries failed one-shot schedule patterns with exponential backoff", async () => {
    setSystemTime(new Date("2026-04-27T09:01:00.000Z"));
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern();
    const updates: Array<{ id: string; params: { active?: boolean; nextRunAt?: Date | null } }> = [];
    const removed: string[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        markRunFailed: async () => createRun(pattern),
        incrementFailure: async () => 2,
        getById: async () => pattern,
        update: async (id: string, params: { active?: boolean; nextRunAt?: Date | null }) => {
          updates.push({ id, params });
          return pattern;
        },
        remove: async (id: string) => {
          removed.push(id);
          return pattern;
        },
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_failed")?.({
      type: "worker_failed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      error: "failed",
      source: "pattern",
    } as never);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      id: pattern.id,
      params: {
        active: true,
        nextRunAt: new Date("2026-04-27T09:03:00.000Z"),
      },
    });
    expect(removed).toEqual([]);
  });

  it("finalizes cancelled Pattern workers so runs do not stay running", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    });
    const cancellations: string[] = [];
    const emitted: unknown[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async (event: unknown) => {
        emitted.push(event);
      },
    } as unknown as EventBus;

    new PatternScheduler({
      store: {
        markRunCancelled: async (_workerId: string, error: string) => {
          cancellations.push(error);
          return { ...createRun(pattern), state: "cancelled", error };
        },
        incrementFailure: async () => 1,
        getById: async () => pattern,
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_cancelled")?.({
      type: "worker_cancelled",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      source: "pattern",
      reason: "Timed out after 900000ms.",
    } as never);

    expect(cancellations).toEqual(["Timed out after 900000ms."]);
    expect(emitted[0]).toMatchObject({
      type: "pattern_run_failed",
      patternId: pattern.id,
      workerId: "wrk_123",
      error: "Timed out after 900000ms.",
    });
  });

  it("ignores non-Pattern worker cancellations", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern();
    const markRunCancelled = mock(async () => createRun(pattern));

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus;

    new PatternScheduler({
      store: { markRunCancelled } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_cancelled")?.({
      type: "worker_cancelled",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      source: "user",
      reason: "Cancelled.",
    } as never);

    expect(markRunCancelled).not.toHaveBeenCalled();
  });

  it("deletes failed one-shot schedule patterns on the third failed attempt", async () => {
    const handlers = new Map<string, (event: never) => Promise<void> | void>();
    const pattern = createPattern();
    const removed: string[] = [];

    const eventBus = {
      on: (type: string, handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, handler);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus;

    new PatternScheduler({
        store: {
        markRunFailed: async () => createRun(pattern),
        incrementFailure: async () => 3,
        getById: async () => pattern,
        remove: async (id: string) => {
          removed.push(id);
          return pattern;
        },
      } as never,
      spawnWorker: async () => "wrk_unused",
      eventBus,
      config: createConfig(),
    });

    await handlers.get("worker_failed")?.({
      type: "worker_failed",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      workerId: "wrk_123",
      task: pattern.taskPrompt,
      error: "failed",
      source: "pattern",
    } as never);

    expect(removed).toEqual([pattern.id]);
  });

  it("includes Pattern scope contracts in worker context", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern({
      connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123", allowedTools: ["GMAIL_FETCH_EMAILS"] }], mcpServerIds: ["mcp_123"] },
      triggerFilters: [{ path: "payload.sender", operator: "contains", value: "racq" }],
      notifyCondition: { type: "worker_decision", instruction: "Notify only when this is about insurance renewal." },
    });
    const contexts: string[] = [];
    const workerTypes: string[] = [];

    const scheduler = new PatternScheduler({
      store: {
        createRun: async () => ({ ...createRun(pattern), id: "ptrun_pending", state: "queued", workerId: null }),
        listRuns: async () => [],
        countRuns: async () => 0,
        recordRunToolScope: async () => undefined,
        markRunStarted: async () => undefined,
        update: async () => pattern,
      } as never,
      spawnWorker: async (params) => {
        contexts.push(params.context ?? "");
        workerTypes.push(params.type ?? "");
        return "wrk_123";
      },
      eventBus,
      config: createConfig(),
    });

    await scheduler.runPattern(pattern, "composio", { payload: { sender: "Kenny at RACQ" } });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain("Notify condition:");
    expect(contexts[0]).toContain("insurance renewal");
    expect(contexts[0]).not.toContain("Runtime scope:");
    expect(contexts[0]).toContain("Trigger filters:");
    expect(contexts[0]).toContain("Connector scope:");
    expect(workerTypes).toEqual(["pattern_worker"]);
  });

  it("includes recent run history and temporal context for recurring Pattern workers", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern();
    const previousRun = {
      ...createRun(pattern),
      id: "ptrun_previous",
      result: { summary: "OpenAI launched model X." },
      notifyOutcome: { notify: true, summary: "OpenAI launched model X.", reason: "New release found." },
      surfacedAt: new Date("2026-04-26T09:02:00.000Z"),
      createdAt: new Date("2026-04-26T09:00:00.000Z"),
    };
    const contexts: string[] = [];
    const toolScopes: unknown[] = [];

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => ({
          run: { ...createRun(pattern), id: "ptrun_current", state: "queued", workerId: null, createdAt: new Date("2026-04-27T09:00:00.000Z") },
        }),
        listRuns: async (params: { patternId: string; limit?: number; beforeRunId?: string }) => {
          expect(params).toEqual({ patternId: pattern.id, limit: 5, beforeRunId: "ptrun_current" });
          return [previousRun];
        },
        countRuns: async () => 1,
        recordRunToolScope: async (_runId: string, toolScope: unknown) => { toolScopes.push(toolScope); },
        markRunFailedById: async () => null,
        markRunStarted: async () => undefined,
      } as never,
      spawnWorker: async (params) => {
        contexts.push(params.context ?? "");
        expect(params.pattern?.runId).toBe("ptrun_current");
        return "wrk_123";
      },
      eventBus,
      config: createConfig(),
    });

    await scheduler.runPattern(pattern, "schedule");

    expect(contexts[0]).not.toContain("Pattern run ID: ptrun_current");
    expect(contexts[0]).toContain("Current time:");
    expect(contexts[0]).toContain("Trigger event time:");
    expect(contexts[0]).toContain("Recent runs for this Pattern only (");
    expect(contexts[0]).toContain("runId=ptrun_previous");
    expect(contexts[0]).toContain("Showing all 1 previous run");
    expect(contexts[0]).not.toContain("notify=notify");
    expect(contexts[0]).not.toContain("surfacedAt=");
    expect(contexts[0]).toContain("OpenAI launched model X.");
    expect(toolScopes).toEqual([{
      connectorScope: pattern.connectorScope,
    }]);
  });

  it("passes only connector scope to Pattern workers", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern();
    const toolScopes: unknown[] = [];
    const patternInputs: unknown[] = [];

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => ({
          run: { ...createRun(pattern), id: "ptrun_current", state: "queued", workerId: null },
        }),
        listRuns: async () => [],
        countRuns: async () => 0,
        recordRunToolScope: async (_runId: string, toolScope: unknown) => { toolScopes.push(toolScope); },
        markRunFailedById: async () => null,
        markRunStarted: async () => undefined,
      } as never,
      spawnWorker: async (params) => {
        patternInputs.push(params.pattern);
        return "wrk_123";
      },
      eventBus,
      config: createConfig(true),
    });

    await scheduler.runPattern(pattern, "schedule");

    expect(toolScopes).toEqual([{
      connectorScope: pattern.connectorScope,
    }]);
    expect(patternInputs[0]).toEqual({
      patternId: pattern.id,
      runId: "ptrun_current",
      connectorScope: pattern.connectorScope,
    });
  });

  it("always fetches compact recent run context for scheduled Pattern workers", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern();
    let listRunsCalled = false;
    const contexts: string[] = [];

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => ({
          run: { ...createRun(pattern), id: "ptrun_current", state: "queued", workerId: null },
        }),
        listRuns: async () => {
          listRunsCalled = true;
          return [];
        },
        countRuns: async () => 0,
        recordRunToolScope: async () => undefined,
        markRunFailedById: async () => null,
        markRunStarted: async () => undefined,
      } as never,
      spawnWorker: async (params) => {
        contexts.push(params.context ?? "");
        return "wrk_123";
      },
      eventBus,
      config: createConfig(),
    });

    await scheduler.runPattern(pattern, "schedule");

    expect(listRunsCalled).toBe(true);
    expect(contexts[0]).toContain("Recent runs for this Pattern only: none");
  });

  it("reschedules interval patterns after scheduled runs", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "interval", every: 8, unit: "hours" }, timezoneSource: "user" },
      nextRunAt: new Date("2026-04-27T09:00:00.000Z"),
    });
    let claimed = false;

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => {
          claimed = true;
          return {
            run: { ...createRun(pattern), id: "ptrun_current", state: "queued", workerId: null },
          };
        },
        listRuns: async () => [],
        countRuns: async () => 0,
        recordRunToolScope: async () => undefined,
        markRunFailedById: async () => null,
        markRunStarted: async () => undefined,
      } as never,
      spawnWorker: async () => "wrk_123",
      eventBus,
      config: createConfig(),
    });

    const workerId = await scheduler.runPattern(pattern, "schedule");

    expect(workerId).toBe("wrk_123");
    expect(claimed).toBe(true);
  });

  it("completes reminder Patterns without spawning workers", async () => {
    const pattern = createPattern({
      workerType: "reminder",
      userDescription: "Take out the trash.",
      taskPrompt: "Take out the trash.",
      reminderContext: {
        reminderText: "Take out the trash.",
        reason: "The user asked for a recurring trash reminder.",
        supportingContext: "Every second Thursday at 8am.",
      },
    });
    const emitted: unknown[] = [];
    let spawned = false;

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => ({
          run: { ...createRun(pattern), id: "ptrun_reminder", state: "queued", workerId: null },
        }),
        markReminderRunCompleted: async (_runId: string, result: WorkerResult, notifyOutcome: unknown) => ({
          ...createRun(pattern),
          id: "ptrun_reminder",
          workerId: null,
          result,
          notifyOutcome,
        }),
        remove: async () => pattern,
      } as never,
      spawnWorker: async () => {
        spawned = true;
        return "wrk_123";
      },
      eventBus: {
        on: () => () => undefined,
        emit: async (event: unknown) => { emitted.push(event); },
      } as unknown as EventBus,
      config: createConfig(),
    });

    const runId = await scheduler.runPattern(pattern, "schedule");

    expect(runId).toBe("ptrun_reminder");
    expect(spawned).toBe(false);
    expect(emitted).toEqual([expect.objectContaining({
      type: "reminder_triggered",
      patternId: pattern.id,
      runId: "ptrun_reminder",
      reminder: pattern.reminderContext,
      summary: "Take out the trash.",
    })]);
  });

  it("skips scheduled runs that were already claimed", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
      nextRunAt: new Date("2026-04-27T09:00:00.000Z"),
    });
    let spawned = false;

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => null,
      } as never,
      spawnWorker: async () => {
        spawned = true;
        return "wrk_123";
      },
      eventBus,
      config: createConfig(),
    });

    await expect(scheduler.runPattern(pattern, "schedule")).resolves.toBe("");
    expect(spawned).toBe(false);
  });

  it("marks claimed scheduled runs failed if worker spawn fails", async () => {
    const eventBus = {
      on: () => () => undefined,
      emit: async () => undefined,
    } as unknown as EventBus;
    const pattern = createPattern({
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
      nextRunAt: new Date("2026-04-27T09:00:00.000Z"),
    });
    const failures: string[] = [];

    const scheduler = new PatternScheduler({
      store: {
        claimScheduledRun: async () => ({
          run: { ...createRun(pattern), id: "ptrun_current", state: "queued", workerId: null },
        }),
        listRuns: async () => [],
        countRuns: async () => 0,
        recordRunToolScope: async () => undefined,
        markRunFailedById: async (_runId: string, error: string) => {
          failures.push(error);
          return { ...createRun(pattern), id: "ptrun_current", state: "failed", workerId: null, error };
        },
        incrementFailure: async () => 1,
        getById: async () => pattern,
      } as never,
      spawnWorker: async () => {
        throw new Error("spawn unavailable");
      },
      eventBus,
      config: createConfig(),
    });

    await expect(scheduler.runPattern(pattern, "schedule")).rejects.toThrow("spawn unavailable");
    expect(failures).toEqual(["spawn unavailable"]);
  });

  it("computes interval next runs from the current time", () => {
    setSystemTime(new Date("2026-05-08T10:26:43.000Z"));
    const store = new PatternStore({ db: {} as never, user: { tenantId: "tenant_test", userId: "usr_test", phoneNumber: "+10000000000", timezone: "Australia/Brisbane", timezoneSource: "manual", kidsMode: false } });

    expect(store.computeNextRun({ type: "schedule", schedule: { kind: "interval", every: 8, unit: "hours" }, timezoneSource: "user" }, "Australia/Brisbane"))
      .toEqual(new Date("2026-05-08T18:26:43.000Z"));
  });

  it("recomputes next run when an active schedule is updated without an explicit next run", async () => {
    setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    const updates: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [createPattern({
              active: true,
              triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
              timezone: "Australia/Brisbane",
            })],
          }),
        }),
      }),
      update: () => ({
        set: (params: unknown) => {
          updates.push(params);
          return {
            where: () => ({
              returning: async () => [{
                ...createPattern({
                  active: true,
                  triggerConfig: { type: "schedule", schedule: { kind: "weekly", daysOfWeek: ["friday"], time: "09:00" }, timezoneSource: "user" },
                  timezone: "Australia/Brisbane",
                }),
                ...(params as object),
              }],
            }),
          };
        },
      }),
    };
    const store = new PatternStore({ db: db as never, user: { tenantId: "tenant_test", userId: "usr_test", phoneNumber: "+10000000000", timezone: "Australia/Brisbane", timezoneSource: "manual", kidsMode: false } });

    await store.update("ptn_123", {
      triggerConfig: { type: "schedule", schedule: { kind: "weekly", daysOfWeek: ["friday"], time: "09:00" }, timezoneSource: "user" },
    });

    expect(updates[0]).toMatchObject({ nextRunAt: new Date("2026-05-08T23:00:00.000Z") });
  });

  it("computes wall-clock schedules in the supplied timezone", () => {
    const store = new PatternStore({ db: {} as never, user: { tenantId: "tenant_test", userId: "usr_test", phoneNumber: "+10000000000", timezone: "Australia/Brisbane", timezoneSource: "manual", kidsMode: false } });
    const schedule = { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" } as const;

    expect(store.computeNextRun(schedule, "Australia/Brisbane", new Date("2026-05-08T10:00:00.000Z")))
      .toEqual(new Date("2026-05-08T23:00:00.000Z"));
    expect(store.computeNextRun(schedule, "America/New_York", new Date("2026-05-08T10:00:00.000Z")))
      .toEqual(new Date("2026-05-08T13:00:00.000Z"));
  });

  it("honors delayed weekday starts for recurring schedules", () => {
    const store = new PatternStore({ db: {} as never, user: { tenantId: "tenant_test", userId: "usr_test", phoneNumber: "+10000000000", timezone: "Australia/Brisbane", timezoneSource: "manual", kidsMode: false } });

    expect(store.computeNextRun({
      type: "schedule",
      schedule: { kind: "daily", time: "09:00", startDate: "2026-05-15" },
      timezoneSource: "user",
    }, "Australia/Brisbane", new Date("2026-05-08T10:00:00.000Z")))
      .toEqual(new Date("2026-05-14T23:00:00.000Z"));
  });

  it("computes monthly last-day schedules", () => {
    const store = new PatternStore({ db: {} as never, user: { tenantId: "tenant_test", userId: "usr_test", phoneNumber: "+10000000000", timezone: "UTC", timezoneSource: "manual", kidsMode: false } });

    expect(store.computeNextRun({
      type: "schedule",
      schedule: { kind: "monthly", dayOfMonth: "last", time: "09:00" },
      timezoneSource: "user",
    }, "UTC", new Date("2026-02-01T00:00:00.000Z")))
      .toEqual(new Date("2026-02-28T09:00:00.000Z"));
  });

});
