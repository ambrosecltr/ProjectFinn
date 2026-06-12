import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type { PatternRecord } from "@finn/core";
import { createReminderTools } from "./patterns.js";

const basePattern = {
  id: "ptn_123",
  tenantId: "tenant_test",
  userId: "usr_test",
  name: "Trash reminder",
  description: null,
  userDescription: "Take out the trash.",
  triggerType: "schedule",
  triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
  connectorScope: { composio: [], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "always" },
  workerType: "reminder",
  taskPrompt: "Take out the trash.",
  reminderContext: {
    reminderText: "Take out the trash.",
    reason: "The user asked for a trash reminder.",
    supportingContext: null,
  },
  timezone: "UTC",
  active: true,
  failureCount: 0,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-05-04T00:00:00.000Z"),
  updatedAt: new Date("2026-05-04T00:00:00.000Z"),
} satisfies PatternRecord;

describe("createReminderTools", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("keeps reminder tool descriptions stable across turns for prompt caching", () => {
    const ops = {
      user: { timezone: "Australia/Brisbane" },
      create: async () => basePattern,
      list: async () => [],
      update: async () => null,
      remove: async () => null,
    };

    setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    const firstDescription = (createReminderTools(ops).create_reminder as { description?: string }).description;

    setSystemTime(new Date("2026-05-08T10:05:00.000Z"));
    const secondDescription = (createReminderTools(ops).create_reminder as { description?: string }).description;

    expect(firstDescription).toBe(secondDescription);
    expect(firstDescription).toContain("Use the current user-local time from runtime context.");
    expect(firstDescription).not.toContain("2026-05-08");
  });

  it("creates lightweight reminders without Pattern worker scope", async () => {
    const create = mock(async (params): Promise<PatternRecord> => ({
      ...basePattern,
      ...params,
      id: "ptn_reminder",
      triggerType: params.triggerType,
      triggerConfig: params.triggerConfig,
      timezone: params.timezone ?? "UTC",
      createdAt: basePattern.createdAt,
      updatedAt: basePattern.updatedAt,
      lastRunAt: null,
      failureCount: 0,
    }));
    const tools = createReminderTools({
      user: { timezone: "Australia/Brisbane" },
      create,
      list: async () => [],
      update: async () => null,
      remove: async () => null,
    });

    const result = await tools.create_reminder.execute?.({
      name: "Julia birthday gift",
      reminder_text: "Get Julia a birthday gift",
      reason: "The user said Julia's birthday is next Friday and asked to be reminded to get her something.",
      supporting_context: "Julia's birthday is next Friday.",
      schedule: { kind: "once", localDateTime: "2099-05-15T09:00:00" },
    }, {} as never) as { workerType?: string; reminderContext?: unknown };

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      workerType: "reminder",
      taskPrompt: "Get Julia a birthday gift",
      userDescription: "Get Julia a birthday gift",
      connectorScope: { composio: [], mcpServerIds: [] },
      notifyCondition: { type: "always" },
      reminderContext: {
        reminderText: "Get Julia a birthday gift",
        reason: "The user said Julia's birthday is next Friday and asked to be reminded to get her something.",
        supportingContext: "Julia's birthday is next Friday.",
      },
      timezone: "Australia/Brisbane",
    }));
    expect(result.workerType).toBe("reminder");
    expect(result.reminderContext).toEqual({
      reminderText: "Get Julia a birthday gift",
      reason: "The user said Julia's birthday is next Friday and asked to be reminded to get her something.",
      supportingContext: "Julia's birthday is next Friday.",
    });
  });

  it("lists and edits reminder Patterns only", async () => {
    setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    const workerPattern = { ...basePattern, id: "ptn_worker", workerType: "pattern_worker" as const };
    const update = mock(async (id, params): Promise<PatternRecord> => ({
      ...basePattern,
      id,
      name: params.name ?? basePattern.name,
      triggerConfig: params.triggerConfig ?? basePattern.triggerConfig,
      timezone: params.timezone ?? basePattern.timezone,
      nextRunAt: params.nextRunAt ?? basePattern.nextRunAt,
    }));
    const tools = createReminderTools({
      user: { timezone: "Australia/Brisbane" },
      create: async () => basePattern,
      list: async () => [basePattern, workerPattern],
      update,
      remove: async () => null,
    });

    const listed = await tools.list_reminders.execute?.({}, {} as never);
    await tools.edit_reminder.execute?.({
      id: "ptn_123",
      name: "Updated reminder",
      schedule: { kind: "interval", every: 6, unit: "hours" },
    }, {} as never);

    expect(listed).toEqual({
      reminders: [{
        id: "ptn_123",
        name: "Trash reminder",
        reminderText: "Take out the trash.",
        reason: "The user asked for a trash reminder.",
        supportingContext: null,
        active: true,
        schedule: { kind: "daily", time: "08:00" },
        nextRun: null,
        lastRun: null,
      }],
    });
    expect(update).toHaveBeenCalledWith("ptn_123", {
      name: "Updated reminder",
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: { kind: "interval", every: 6, unit: "hours" }, timezoneSource: "user" },
      timezone: "Australia/Brisbane",
      nextRunAt: new Date("2026-05-08T16:00:00.000Z"),
    });
  });

  it("rejects non-reminder Patterns for inspect, edit, and delete", async () => {
    const workerPattern = { ...basePattern, id: "ptn_worker", workerType: "pattern_worker" as const };
    const get = mock(async (id: string) => id === "ptn_worker" ? workerPattern : null);
    const update = mock(async () => basePattern);
    const remove = mock(async () => workerPattern);
    const tools = createReminderTools({
      user: { timezone: "UTC" },
      create: async () => basePattern,
      list: async () => [workerPattern],
      get,
      update,
      remove,
    });

    await expect(tools.inspect_reminder.execute?.({ id: "ptn_worker" }, {} as never))
      .resolves.toEqual({ error: "Reminder not found." });
    await expect(tools.edit_reminder.execute?.({ id: "ptn_worker", active: false }, {} as never))
      .resolves.toEqual({ error: "Reminder not found." });
    await expect(tools.delete_reminder.execute?.({ id: "ptn_worker" }, {} as never))
      .resolves.toEqual({ deleted: false, id: "ptn_worker", error: "Reminder not found." });

    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
