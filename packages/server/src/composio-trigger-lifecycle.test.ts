import { describe, expect, it, mock } from "bun:test";
import type { PatternRecord } from "@finn/core";
import {
  removePatternWithComposioTriggerLifecycle,
  setPatternActiveWithComposioTriggerLifecycle,
  updatePatternWithComposioTriggerLifecycle,
} from "./composio-trigger-lifecycle.js";

function triggerPattern(id: string, triggerId = "trg_shared"): PatternRecord {
  return {
    id,
    tenantId: "tenant_default",
    userId: "usr_test",
    name: "Gmail trigger",
    description: null,
    userDescription: "React to Gmail.",
    triggerType: "composio",
    triggerConfig: {
      type: "composio",
      toolkitSlug: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "acct_123",
      triggerId,
    },
    connectorScope: {
      composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }],
      mcpServerIds: [],
    },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    workerType: "pattern_worker",
    taskPrompt: "Handle Gmail.",
    reminderContext: null,
    timezone: "UTC",
    active: true,
    failureCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: new Date("2026-05-19T00:00:00.000Z"),
  };
}

function createSharedTriggerStore(patterns: PatternRecord[]) {
  const rows = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  const lockChains = new Map<string, Promise<void>>();
  const patternLockIds: string[] = [];
  const triggerLockIds: string[] = [];

  async function runWithLock<T>(lockId: string, operation: () => Promise<T>): Promise<T> {
    const run = (lockChains.get(lockId) ?? Promise.resolve()).then(operation);
    lockChains.set(lockId, run.then(() => undefined, () => undefined));
    return run;
  }

  const store = {
    getById: mock(async (id: string) => rows.get(id) ?? null),
    setActive: mock(async (id: string, active: boolean) => {
      const pattern = rows.get(id);
      if (!pattern) {
        return null;
      }
      const updated = { ...pattern, active, updatedAt: new Date("2026-05-20T00:00:00.000Z") };
      rows.set(id, updated);
      return updated;
    }),
    update: mock(async (id: string, params: Partial<PatternRecord>) => {
      const pattern = rows.get(id);
      if (!pattern) {
        return null;
      }
      const updated = { ...pattern, ...params, updatedAt: new Date("2026-05-20T00:00:00.000Z") };
      rows.set(id, updated);
      return updated;
    }),
    remove: mock(async (id: string) => {
      const pattern = rows.get(id);
      rows.delete(id);
      return pattern ?? null;
    }),
    hasOtherActiveComposioTriggerUsers: mock(async (triggerId: string, excludedPatternId: string) => (
      [...rows.values()].some((pattern) => pattern.id !== excludedPatternId
        && pattern.active
        && pattern.triggerConfig.type === "composio"
        && pattern.triggerConfig.triggerId === triggerId)
    )),
    hasComposioTriggerUsers: mock(async (triggerId: string) => (
      [...rows.values()].some((pattern) => pattern.triggerConfig.type === "composio"
        && pattern.triggerConfig.triggerId === triggerId)
    )),
    hasOtherComposioTriggerUsers: mock(async (triggerId: string, excludedPatternId: string) => (
      [...rows.values()].some((pattern) => pattern.id !== excludedPatternId
        && pattern.triggerConfig.type === "composio"
        && pattern.triggerConfig.triggerId === triggerId)
    )),
    withComposioTriggerLock: mock(async (triggerId: string, operation: (lockedStore: typeof store) => Promise<unknown>) => {
      triggerLockIds.push(triggerId);
      return runWithLock(`trigger:${triggerId}`, () => operation(store));
    }),
    withPatternLock: mock(async (patternId: string, operation: (lockedStore: typeof store) => Promise<unknown>) => {
      patternLockIds.push(patternId);
      return runWithLock(`pattern:${patternId}`, () => operation(store));
    }),
  };

  return { store, rows, patternLockIds, triggerLockIds };
}

describe("Composio trigger lifecycle", () => {
  it("disables a shared remote trigger after the last active Pattern pauses", async () => {
    const { store, rows } = createSharedTriggerStore([triggerPattern("ptn_1"), triggerPattern("ptn_2")]);
    const composio = {
      enableTrigger: mock(async () => undefined),
      disableTrigger: mock(async () => undefined),
      deleteTrigger: mock(async () => undefined),
    };

    await Promise.all([
      setPatternActiveWithComposioTriggerLifecycle({
        patternStore: store as never,
        composio,
        patternId: "ptn_1",
        active: false,
      }),
      setPatternActiveWithComposioTriggerLifecycle({
        patternStore: store as never,
        composio,
        patternId: "ptn_2",
        active: false,
      }),
    ]);

    expect(rows.get("ptn_1")?.active).toBe(false);
    expect(rows.get("ptn_2")?.active).toBe(false);
    expect(composio.disableTrigger).toHaveBeenCalledTimes(1);
    expect(composio.disableTrigger).toHaveBeenCalledWith("trg_shared");
    expect(composio.enableTrigger).not.toHaveBeenCalled();
  });

  it("syncs active state with the trigger read under the Pattern lock", async () => {
    const { store, rows, patternLockIds, triggerLockIds } = createSharedTriggerStore([triggerPattern("ptn_1", "trg_old")]);
    const composio = {
      enableTrigger: mock(async () => undefined),
      disableTrigger: mock(async () => undefined),
      deleteTrigger: mock(async () => undefined),
    };
    let replacedTrigger = false;
    store.withPatternLock.mockImplementation(async (patternId: string, operation: (lockedStore: typeof store) => Promise<unknown>) => {
      patternLockIds.push(patternId);
      if (!replacedTrigger) {
        const pattern = rows.get("ptn_1");
        if (pattern?.triggerConfig.type === "composio") {
          rows.set("ptn_1", {
            ...pattern,
            triggerConfig: { ...pattern.triggerConfig, triggerId: "trg_new" },
          });
        }
        replacedTrigger = true;
      }
      return operation(store);
    });

    await setPatternActiveWithComposioTriggerLifecycle({
      patternStore: store as never,
      composio,
      patternId: "ptn_1",
      active: false,
    });

    expect(patternLockIds).toEqual(["ptn_1"]);
    expect(triggerLockIds).toEqual(["trg_new"]);
    expect(rows.get("ptn_1")?.active).toBe(false);
    expect(composio.disableTrigger).toHaveBeenCalledTimes(1);
    expect(composio.disableTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("deletes using the trigger read under the Pattern lock", async () => {
    const { store, rows, triggerLockIds } = createSharedTriggerStore([triggerPattern("ptn_1", "trg_old")]);
    const composio = {
      enableTrigger: mock(async () => undefined),
      disableTrigger: mock(async () => undefined),
      deleteTrigger: mock(async () => undefined),
    };
    store.withPatternLock.mockImplementation(async (_patternId: string, operation: (lockedStore: typeof store) => Promise<unknown>) => {
      const pattern = rows.get("ptn_1");
      if (pattern?.triggerConfig.type === "composio") {
        rows.set("ptn_1", {
          ...pattern,
          triggerConfig: { ...pattern.triggerConfig, triggerId: "trg_new" },
        });
      }
      return operation(store);
    });

    await removePatternWithComposioTriggerLifecycle({
      patternStore: store as never,
      composio,
      patternId: "ptn_1",
    });

    expect(triggerLockIds).toEqual(["trg_new"]);
    expect(composio.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(composio.deleteTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("locks replacement triggers before syncing active updates", async () => {
    const { store, triggerLockIds } = createSharedTriggerStore([triggerPattern("ptn_1", "trg_old")]);
    const composio = {
      enableTrigger: mock(async () => undefined),
      disableTrigger: mock(async () => undefined),
      deleteTrigger: mock(async () => undefined),
    };

    await updatePatternWithComposioTriggerLifecycle({
      patternStore: store as never,
      composio,
      patternId: "ptn_1",
      params: {
        active: false,
        triggerConfig: {
          type: "composio",
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_new",
          triggerId: "trg_new",
        },
      },
    });

    expect(triggerLockIds).toEqual(["trg_new", "trg_old"]);
    expect(composio.disableTrigger).toHaveBeenCalledTimes(1);
    expect(composio.disableTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("deletes a shared remote trigger after the last Pattern is removed", async () => {
    const { store, rows } = createSharedTriggerStore([triggerPattern("ptn_1"), triggerPattern("ptn_2")]);
    const composio = {
      enableTrigger: mock(async () => undefined),
      disableTrigger: mock(async () => undefined),
      deleteTrigger: mock(async () => undefined),
    };

    await Promise.all([
      removePatternWithComposioTriggerLifecycle({
        patternStore: store as never,
        composio,
        patternId: "ptn_1",
      }),
      removePatternWithComposioTriggerLifecycle({
        patternStore: store as never,
        composio,
        patternId: "ptn_2",
      }),
    ]);

    expect(rows.size).toBe(0);
    expect(composio.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(composio.deleteTrigger).toHaveBeenCalledWith("trg_shared");
  });
});
