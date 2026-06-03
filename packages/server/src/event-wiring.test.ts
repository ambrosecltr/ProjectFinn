import { describe, expect, it } from "bun:test";

import type { EventBus, ProcessEvent, TriggerMessage, WorkerMessage } from "@finn/core";
import { wireTriggerDelivery, wireWorkerDelivery } from "./event-wiring.js";

function createEventBus() {
  const handlers = new Map<string, Array<(event: never) => Promise<void> | void>>();
  return {
    eventBus: {
      on: (type: ProcessEvent["type"], handler: (event: never) => Promise<void> | void) => {
        handlers.set(type, [...handlers.get(type) ?? [], handler]);
        return () => undefined;
      },
      emit: async () => undefined,
    } as unknown as EventBus,
    handlers,
  };
}

async function emitHandler(handlers: Map<string, Array<(event: never) => Promise<void> | void>>, type: string, event: never): Promise<void> {
  for (const handler of handlers.get(type) ?? []) {
    await handler(event);
  }
}

describe("wireWorkerDelivery", () => {
  it("suppresses pattern completions when notify is false", async () => {
    const { eventBus, handlers } = createEventBus();
    const delivered: WorkerMessage[] = [];
    const surfaced: string[] = [];
    wireWorkerDelivery(eventBus, { enqueueInternal: (message) => { delivered.push(message as WorkerMessage); } }, {
      markPatternRunSurfaced: (runId) => { surfaced.push(runId); },
    });

    await emitHandler(handlers, "pattern_run_completed", {
      type: "pattern_run_completed",
      tenantId: "tenant_test",
      userId: "usr_test",
      patternId: "ptn_123",
      patternName: "Morning weather",
      runId: "ptrun_123",
      workerId: "wrk_123",
      task: "check weather",
      triggeredBy: "schedule",
      triggerPayload: null,
      result: { summary: "No alert." },
      notifyOutcome: { notify: false, summary: "No alert.", reason: "No notable weather alert." },
    } as never);

    expect(delivered).toEqual([]);
    expect(surfaced).toEqual([]);
  });

  it("delivers pattern completions with notify metadata when notify is true", async () => {
    const { eventBus, handlers } = createEventBus();
    const delivered: WorkerMessage[] = [];
    const surfaced: string[] = [];
    wireWorkerDelivery(eventBus, { enqueueInternal: (message) => { delivered.push(message as WorkerMessage); } }, {
      markPatternRunSurfaced: (runId) => { surfaced.push(runId); },
    });

    await emitHandler(handlers, "pattern_run_completed", {
      type: "pattern_run_completed",
      tenantId: "tenant_test",
      userId: "usr_test",
      patternId: "ptn_123",
      patternName: "Morning weather",
      runId: "ptrun_123",
      workerId: "wrk_123",
      task: "check weather",
      triggeredBy: "schedule",
      triggerPayload: { source: "schedule" },
      result: { summary: "Storm warning." },
      notifyOutcome: { notify: true, summary: "Storm warning.", reason: "Alert found." },
    } as never);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      source: "worker",
      originSource: "pattern",
      pattern: {
        id: "ptn_123",
        name: "Morning weather",
        notifyOutcome: { notify: true, summary: "Storm warning.", reason: "Alert found." },
      },
    });
    expect(surfaced).toEqual(["ptrun_123"]);
  });

  it("delivers user worker completions for Finn to decide My Day updates", async () => {
    const { eventBus, handlers } = createEventBus();
    const delivered: WorkerMessage[] = [];
    wireWorkerDelivery(eventBus, { enqueueInternal: (message) => { delivered.push(message as WorkerMessage); } });
    const workerCompletedHandlers = handlers.get("worker_completed") ?? [];

    expect(workerCompletedHandlers).toHaveLength(1);

    await emitHandler(handlers, "worker_completed", {
      type: "worker_completed",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_123",
      task: "Reply to Sam",
      result: { summary: "Sent the reply." },
      source: "user",
      originMessageId: null,
    } as never);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      source: "worker",
      workerId: "wrk_123",
      originSource: "user",
    });
  });

  it("preserves delegated trigger origin on worker completions", async () => {
    const { eventBus, handlers } = createEventBus();
    const delivered: WorkerMessage[] = [];
    wireWorkerDelivery(eventBus, { enqueueInternal: (message) => { delivered.push(message as WorkerMessage); } });

    await emitHandler(handlers, "worker_completed", {
      type: "worker_completed",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_trigger",
      task: "Follow up from reminder",
      result: { summary: "Done." },
      source: "user",
      originSource: "trigger",
      originMessageId: "ptrun_123",
    } as never);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      source: "worker",
      workerId: "wrk_trigger",
      originSource: "trigger",
      originMessageId: "ptrun_123",
    });
  });
});

describe("wireTriggerDelivery", () => {
  it("delivers reminders directly to hot path trigger ingress", async () => {
    const { eventBus, handlers } = createEventBus();
    const delivered: TriggerMessage[] = [];
    const surfaced: string[] = [];
    wireTriggerDelivery(eventBus, { enqueueInternal: (message) => { delivered.push(message as TriggerMessage); } }, {
      markPatternRunSurfaced: (runId) => { surfaced.push(runId); },
    });

    await emitHandler(handlers, "reminder_triggered", {
      type: "reminder_triggered",
      tenantId: "tenant_test",
      userId: "usr_test",
      patternId: "ptn_reminder",
      patternName: "Trash reminder",
      runId: "ptrun_reminder",
      triggeredBy: "schedule",
      triggerPayload: null,
      summary: "Take out the trash.",
      reminder: {
        reminderText: "Take out the trash.",
        reason: "The user asked for a recurring trash reminder.",
        supportingContext: "Every second Thursday at 8am.",
      },
    } as never);

    expect(delivered).toEqual([{
      source: "trigger",
      tenantId: "tenant_test",
      userId: "usr_test",
      triggerId: "ptrun_reminder",
      triggerType: "reminder",
      details: {
        patternId: "ptn_reminder",
        patternName: "Trash reminder",
        runId: "ptrun_reminder",
        triggeredBy: "schedule",
        triggerPayload: null,
        summary: "Take out the trash.",
        reminder: {
          reminderText: "Take out the trash.",
          reason: "The user asked for a recurring trash reminder.",
          supportingContext: "Every second Thursday at 8am.",
        },
      },
    }]);
    expect(surfaced).toEqual(["ptrun_reminder"]);
  });
});
