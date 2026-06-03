import { describe, expect, it } from "bun:test";
import { AutomationRunStore } from "./automation-run-store.js";

describe("AutomationRunStore", () => {
  it("stores connector scope on automation runs", async () => {
    const insertedValues: unknown[] = [];
    const db = {
      insert: () => ({
        values: (value: unknown) => {
          insertedValues.push(value);
          return {
            returning: async () => [{
              id: "arun_1",
              ...(value as Record<string, unknown>),
            }],
          };
        },
      }),
    };
    const store = new AutomationRunStore({
      db: db as never,
      user: { tenantId: "tenant_test", userId: "usr_test" },
    });

    await store.start({
      runType: "personal_intelligence",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
    });

    expect(insertedValues[0]).toEqual(expect.objectContaining({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
    }));
  });

  it("marks stale running automation runs failed by type and age", async () => {
    const updates: unknown[] = [];
    const whereCalls: unknown[] = [];
    const db = {
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return {
            where: (where: unknown) => {
              whereCalls.push(where);
              return {
                returning: async () => [{ id: "arun_1" }, { id: "arun_2" }],
              };
            },
          };
        },
      }),
    };
    const store = new AutomationRunStore({ db: db as never });
    const cutoff = new Date("2026-05-12T12:00:00.000Z");

    const count = await store.failRunningOlderThan(["my_day_refresh", "personal_intelligence"], cutoff, "timed out");

    expect(count).toBe(2);
    expect(updates[0]).toEqual(expect.objectContaining({
      state: "failed",
      error: "timed out",
      completedAt: expect.any(Date),
    }));
    expect(whereCalls).toHaveLength(1);
  });
});
