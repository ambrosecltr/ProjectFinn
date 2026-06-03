import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type { PatternRecord } from "@finn/core";
import type { PatternsRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createPatternsToolsetDefinition } from "./index.js";

const basePattern = {
  id: "ptn_123",
  tenantId: "tenant_test",
  userId: "usr_test",
  name: "Email watch",
  description: null,
  userDescription: "Notify me when Alex emails.",
  triggerType: "composio",
  triggerConfig: {
    type: "composio",
    toolkitSlug: "gmail",
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    connectedAccountId: "acct_123",
    triggerId: "trg_123",
  },
  connectorScope: { composio: [], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "always" },
  workerType: "pattern_worker",
  taskPrompt: "Notify when Alex emails.",
  reminderContext: null,
  timezone: "UTC",
  active: true,
  failureCount: 0,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-05-04T00:00:00.000Z"),
  updatedAt: new Date("2026-05-04T00:00:00.000Z"),
} satisfies PatternRecord;

function createRuntime(patterns: PatternsRuntimeService) {
  return createToolsetRuntime({
    processType: "pattern_management",
    enabledTools: ["patterns"],
    includeBuiltInToolsets: false,
    toolsetGrants: { patterns: "write" },
    definitions: [createPatternsToolsetDefinition({
      processTypes: ["pattern_management"],
      runtime: patterns,
    })],
    context: {},
  });
}

function createPatternsRuntime(overrides: Partial<PatternsRuntimeService> = {}): PatternsRuntimeService {
  return {
    kind: "finn-patterns-runtime",
    user: { timezone: "Australia/Brisbane" },
    create: mock(async () => basePattern),
    list: mock(async () => []),
    update: mock(async () => null),
    remove: mock(async () => null),
    ...overrides,
  };
}

describe("patterns toolset", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("lists Pattern summaries five at a time", async () => {
    const patterns = Array.from({ length: 6 }, (_, index): PatternRecord => ({
      ...basePattern,
      id: `ptn_${index}`,
      name: `Pattern ${index}`,
      userDescription: `Description ${index}`,
    }));
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => patterns),
    }));

    const firstPage = await runtime.execute({ toolset: "patterns", command: "list", args: {} });
    const secondPage = await runtime.execute({ toolset: "patterns", command: "list", args: { cursor: "5" } });

    expect(firstPage).toMatchObject({
      command: "list",
      result: {
        patterns: patterns.slice(0, 5).map((pattern) => ({ id: pattern.id, name: pattern.name, userDescription: pattern.userDescription, type: "pattern" })),
        nextCursor: "5",
      },
    });
    expect(secondPage).toMatchObject({
      command: "list",
      result: {
        patterns: [{ id: "ptn_5", name: "Pattern 5", userDescription: "Description 5", type: "pattern" }],
        nextCursor: null,
      },
    });
  });

  it("creates scheduled Patterns from JSON schedule flags", async () => {
    const create = mock(async (params): Promise<PatternRecord> => ({
      ...basePattern,
      triggerType: params.triggerType,
      triggerConfig: params.triggerConfig,
      timezone: params.timezone ?? "UTC",
    }));
    const runtime = createRuntime(createPatternsRuntime({ create }));

    const result = await runtime.execute({
      toolset: "patterns",
      command: "create",
      args: {
        name: "Daily Morning Briefing",
        userDescription: "Send a daily briefing at 8am.",
        prompt: "Prepare the daily briefing.",
        schedule: { kind: "daily", time: "08:00" },
      },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
      timezone: "Australia/Brisbane",
      nextRunAt: expect.any(Date),
    }));
    expect(result).toMatchObject({
      result: {
        runtimeAccessWarning: expect.stringContaining("No connector scope is saved"),
      },
    });
  });

  it("does not warn when scheduled Patterns include connector scope for future workers", async () => {
    const create = mock(async (params): Promise<PatternRecord> => ({
      ...basePattern,
      triggerType: params.triggerType,
      triggerConfig: params.triggerConfig,
      connectorScope: params.connectorScope ?? { composio: [], mcpServerIds: [] },
      timezone: params.timezone ?? "UTC",
    }));
    const runtime = createRuntime(createPatternsRuntime({ create }));

    const result = await runtime.execute({
      toolset: "patterns",
      command: "create",
      args: {
        name: "Daily Morning Briefing",
        userDescription: "Send a daily briefing at 8am.",
        prompt: "Prepare the daily briefing from Gmail and web news.",
        schedule: { kind: "daily", time: "08:00" },
        connectorScope: {
          composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }],
          mcpServerIds: [],
        },
      },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      connectorScope: {
        composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }],
        mcpServerIds: [],
      },
    }));
    expect(JSON.stringify(result)).not.toContain("runtimeAccessWarning");
  });

  it("normalizes trigger filter paths and adds native Gmail sender query", async () => {
    const create = mock(async (params): Promise<PatternRecord> => ({
      ...basePattern,
      triggerConfig: params.triggerConfig,
      triggerFilters: params.triggerFilters ?? [],
    }));
    const createComposioTrigger = mock(async () => "trg_123");
    const runtime = createRuntime(createPatternsRuntime({
      create,
      getTriggerType: async () => ({
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        toolkitSlug: "gmail",
        payloadSchema: { properties: { sender: { type: "string" }, subject: { type: "string" } } },
      }),
      createComposioTrigger,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "create",
      args: {
        name: "Email watch",
        userDescription: "Notify me when Alex emails.",
        prompt: "Notify when Alex emails.",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_123",
        },
        triggerFilters: [{ path: "sender", operator: "equals", value: "alex@example.com" }],
      },
    });

    expect(createComposioTrigger).toHaveBeenCalledWith({
      toolkitSlug: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "acct_123",
      triggerConfig: { query: "from:alex@example.com" },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      triggerConfig: expect.objectContaining({ triggerConfig: { query: "from:alex@example.com" } }),
      connectorScope: {
        composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }],
        mcpServerIds: [],
      },
      triggerFilters: [{ path: "payload.sender", operator: "equals", value: "alex@example.com" }],
    }));
  });

  it("edits schedules and uses explicit pause and resume commands", async () => {
    setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    const update = mock(async (id, params): Promise<PatternRecord> => ({
      ...basePattern,
      id,
      active: params.active ?? basePattern.active,
      triggerType: params.triggerType ?? basePattern.triggerType,
      triggerConfig: params.triggerConfig ?? basePattern.triggerConfig,
      timezone: params.timezone ?? basePattern.timezone,
      nextRunAt: params.nextRunAt ?? basePattern.nextRunAt,
    }));
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: { id: "ptn_123", schedule: { kind: "interval", every: 6, unit: "hours" } },
    });
    await runtime.execute({ toolset: "patterns", command: "pause", args: { id: "ptn_123" } });
    await runtime.execute({ toolset: "patterns", command: "resume", args: { id: "ptn_123" } });

    expect(update).toHaveBeenNthCalledWith(1, "ptn_123", {
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: { kind: "interval", every: 6, unit: "hours" }, timezoneSource: "user" },
      timezone: "Australia/Brisbane",
      nextRunAt: new Date("2026-05-08T16:00:00.000Z"),
    });
    expect(update).toHaveBeenNthCalledWith(2, "ptn_123", { active: false });
    expect(update).toHaveBeenNthCalledWith(3, "ptn_123", { active: true });
  });

  it("does not resume Patterns paused for connector reconnect", async () => {
    const update = mock(async () => basePattern);
    const pausedPattern = {
      ...basePattern,
      active: false,
      connectorScope: {
        composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }],
        mcpServerIds: [],
        issues: [{
          type: "composio_connector_unavailable",
          toolkitSlug: "gmail",
          connectedAccountId: "acct_123",
          reason: "disconnected",
          pausedAt: "2026-05-20T00:00:00.000Z",
          resumeOnReconnect: true,
        }],
      },
    } satisfies PatternRecord;
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [pausedPattern]),
      update,
    }));

    const result = await runtime.execute({ toolset: "patterns", command: "resume", args: { id: "ptn_123" } });

    expect(result).toMatchObject({
      result: { error: "Reconnect this Pattern's connector before resuming it." },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves existing connector scope when editing a Pattern to use a Composio trigger", async () => {
    const scheduledPattern: PatternRecord = {
      ...basePattern,
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
      connectorScope: {
        composio: [{ toolkitSlug: "linear", connectedAccountId: "acct_linear" }],
        mcpServerIds: ["mcp_123"],
      },
    };
    const update = mock(async (id, params): Promise<PatternRecord> => ({
      ...scheduledPattern,
      id,
      triggerType: params.triggerType ?? scheduledPattern.triggerType,
      triggerConfig: params.triggerConfig ?? scheduledPattern.triggerConfig,
      connectorScope: params.connectorScope ?? scheduledPattern.connectorScope,
    }));
    const createComposioTrigger = mock(async () => "trg_new");
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [scheduledPattern]),
      update,
      createComposioTrigger,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: {
        id: "ptn_123",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_gmail",
        },
      },
    });

    expect(update).toHaveBeenCalledWith("ptn_123", expect.objectContaining({
      connectorScope: {
        composio: [
          { toolkitSlug: "linear", connectedAccountId: "acct_linear" },
          { toolkitSlug: "gmail", connectedAccountId: "acct_gmail" },
        ],
        mcpServerIds: ["mcp_123"],
      },
    }));
  });

  it("edits Composio trigger scope without rewriting other accounts for the same toolkit", async () => {
    const existingPattern: PatternRecord = {
      ...basePattern,
      triggerConfig: {
        type: "composio",
        toolkitSlug: "gmail",
        triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "acct_old",
        triggerId: "trg_old",
      },
      connectorScope: {
        composio: [
          { toolkitSlug: "gmail", connectedAccountId: "acct_old" },
          { toolkitSlug: "gmail", connectedAccountId: "acct_other" },
          { toolkitSlug: "linear", connectedAccountId: "acct_linear" },
        ],
        mcpServerIds: ["mcp_123"],
        issues: [
          {
            type: "composio_connector_unavailable",
            toolkitSlug: "gmail",
            connectedAccountId: "acct_old",
            reason: "account_replaced",
            pausedAt: "2026-05-20T00:00:00.000Z",
            resumeOnReconnect: true,
          },
          {
            type: "composio_connector_unavailable",
            toolkitSlug: "gmail",
            connectedAccountId: "acct_other",
            reason: "disconnected",
            pausedAt: "2026-05-20T00:00:00.000Z",
            resumeOnReconnect: false,
          },
        ],
      },
    };
    const update = mock(async (id, params): Promise<PatternRecord> => ({
      ...existingPattern,
      id,
      triggerType: params.triggerType ?? existingPattern.triggerType,
      triggerConfig: params.triggerConfig ?? existingPattern.triggerConfig,
      connectorScope: params.connectorScope ?? existingPattern.connectorScope,
    }));
    const createComposioTrigger = mock(async () => "trg_new");
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [existingPattern]),
      update,
      createComposioTrigger,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: {
        id: "ptn_123",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_new",
        },
      },
    });

    expect(update).toHaveBeenCalledWith("ptn_123", expect.objectContaining({
      connectorScope: {
        composio: [
          { toolkitSlug: "gmail", connectedAccountId: "acct_new" },
          { toolkitSlug: "gmail", connectedAccountId: "acct_other" },
          { toolkitSlug: "linear", connectedAccountId: "acct_linear" },
        ],
        mcpServerIds: ["mcp_123"],
        issues: [{
          type: "composio_connector_unavailable",
          toolkitSlug: "gmail",
          connectedAccountId: "acct_other",
          reason: "disconnected",
          pausedAt: "2026-05-20T00:00:00.000Z",
          resumeOnReconnect: false,
        }],
      },
    }));
  });

  it("deletes replacement Composio triggers when a Pattern edit update fails", async () => {
    const update = mock(async () => {
      throw new Error("database unavailable");
    });
    const createComposioTrigger = mock(async () => "trg_new");
    const deleteComposioTrigger = mock(async () => undefined);
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
      createComposioTrigger,
      deleteComposioTrigger,
    }));

    await expect(runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: {
        id: "ptn_123",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_new",
        },
      },
    })).rejects.toThrow("database unavailable");

    expect(deleteComposioTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("deletes replacement Composio triggers when a Pattern edit update returns null", async () => {
    const update = mock(async () => null);
    const createComposioTrigger = mock(async () => "trg_new");
    const deleteComposioTrigger = mock(async () => undefined);
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
      createComposioTrigger,
      deleteComposioTrigger,
    }));

    const result = await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: {
        id: "ptn_123",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_new",
        },
      },
    });

    expect(result).toMatchObject({
      result: { error: "Pattern not found." },
    });
    expect(deleteComposioTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("preserves the Pattern edit error when replacement trigger cleanup fails", async () => {
    const update = mock(async () => {
      throw new Error("database unavailable");
    });
    const createComposioTrigger = mock(async () => "trg_new");
    const deleteComposioTrigger = mock(async () => {
      throw new Error("cleanup unavailable");
    });
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
      createComposioTrigger,
      deleteComposioTrigger,
    }));

    await expect(runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: {
        id: "ptn_123",
        composio: {
          toolkitSlug: "gmail",
          triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
          connectedAccountId: "acct_new",
        },
      },
    })).rejects.toThrow("database unavailable");

    expect(deleteComposioTrigger).toHaveBeenCalledWith("trg_new");
  });

  it("preserves existing Composio triggers on metadata-only edits", async () => {
    const update = mock(async (id, params): Promise<PatternRecord> => ({
      ...basePattern,
      id,
      name: params.name ?? basePattern.name,
      triggerConfig: params.triggerConfig ?? basePattern.triggerConfig,
    }));
    const deleteComposioTrigger = mock(async () => undefined);
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
      deleteComposioTrigger,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: { id: "ptn_123", name: "Renamed email watch" },
    });

    expect(update).toHaveBeenCalledWith("ptn_123", { name: "Renamed email watch" });
    expect(deleteComposioTrigger).not.toHaveBeenCalled();
  });

  it("deletes old Composio triggers after switching to a schedule", async () => {
    const scheduledPattern: PatternRecord = {
      ...basePattern,
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: { kind: "interval", every: 6, unit: "hours" }, timezoneSource: "user" },
    };
    const update = mock(async () => scheduledPattern);
    const deleteComposioTrigger = mock(async () => undefined);
    const runtime = createRuntime(createPatternsRuntime({
      list: mock(async () => [basePattern]),
      update,
      deleteComposioTrigger,
    }));

    await runtime.execute({
      toolset: "patterns",
      command: "edit",
      args: { id: "ptn_123", schedule: { kind: "interval", every: 6, unit: "hours" } },
    });

    expect(deleteComposioTrigger).toHaveBeenCalledWith("trg_123", { excludedPatternId: "ptn_123" });
  });

  it("does not expose removed list_pattern_mcp_connectors or toggle_pattern commands", async () => {
    const runtime = createRuntime(createPatternsRuntime());

    const loaded = await runtime.load("patterns");

    expect(loaded.instructions).toContain("API: finn.patterns.pause(input)");
    expect(loaded.instructions).toContain("API: finn.patterns.resume(input)");
    expect(loaded.instructions).toContain("runtimeAccessWarning");
    expect(loaded.instructions).toContain("connectorScope");
    expect(loaded.instructions).toContain("delivery style");
    expect(loaded.instructions).toContain("source/action access");
    expect(loaded.instructions).toContain("what Finn will do");
    expect(loaded.instructions).not.toContain("toggle_pattern");
    expect(loaded.instructions).not.toContain("list_pattern_mcp_connectors");
    await expect(runtime.execute({
      toolset: "patterns",
      command: "toggle",
      args: { id: "ptn_123" },
    })).rejects.toThrow("Toolset command is not allowed");
  });
});
