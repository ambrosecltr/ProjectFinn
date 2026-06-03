import { describe, expect, it, mock } from "bun:test";
import type { EventBus, PatternRecord } from "@finn/core";
import type { ComposioClient } from "@finn/integrations";
import type { PatternStore } from "@finn/patterns";
import { patternUsesComposioConnector } from "@finn/patterns";
import {
  pausePatternsForComposioConnector,
  rehydratePatternsForComposioConnector,
  resolvePatternConnectorIssues,
} from "./composio-pattern-lifecycle.js";

const basePattern = {
  id: "ptn_123",
  tenantId: "tenant_test",
  userId: "usr_test",
  name: "Daily briefing",
  description: null,
  userDescription: "Send a briefing.",
  triggerType: "schedule",
  triggerConfig: {
    type: "schedule",
    schedule: { kind: "daily", time: "08:00" },
    timezoneSource: "user",
  },
  connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_old" }], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "always" },
  workerType: "pattern_worker",
  taskPrompt: "Send a briefing.",
  reminderContext: null,
  timezone: "UTC",
  active: true,
  failureCount: 0,
  lastRunAt: null,
  nextRunAt: new Date("2026-05-20T08:00:00.000Z"),
  createdAt: new Date("2026-05-19T00:00:00.000Z"),
  updatedAt: new Date("2026-05-19T00:00:00.000Z"),
} satisfies PatternRecord;

function createPatternStore(patterns: PatternRecord[]) {
  const rows = [...patterns];
  const store = {
    listByComposioConnector: mock(async (toolkitSlug: string, connectedAccountId?: string) => {
      return rows.filter((pattern) => patternUsesComposioConnector(pattern, toolkitSlug, connectedAccountId));
    }),
    update: mock(async (id: string, params: Partial<PatternRecord>) => {
      const index = rows.findIndex((pattern) => pattern.id === id);
      if (index === -1) return null;
      rows[index] = { ...rows[index], ...params, updatedAt: new Date("2026-05-20T00:00:00.000Z") };
      return rows[index];
    }),
  };

  return { store: store as unknown as PatternStore, rows, update: store.update };
}

describe("Composio Pattern lifecycle", () => {
  it("pauses scheduled and app-triggered Patterns when a connector disconnects", async () => {
    const triggeredPattern: PatternRecord = {
      ...basePattern,
      id: "ptn_trigger",
      name: "Email watch",
      triggerType: "composio",
      triggerConfig: {
        type: "composio",
        toolkitSlug: "gmail",
        triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "acct_old",
        triggerId: "trg_old",
      },
      connectorScope: { composio: [], mcpServerIds: [] },
      nextRunAt: null,
    };
    const { store, rows } = createPatternStore([basePattern, triggeredPattern]);
    const deleteTrigger = mock(async () => undefined);

    const updated = await pausePatternsForComposioConnector({
      patternStore: store,
      composio: { deleteTrigger } as unknown as ComposioClient,
    }, {
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
      reason: "disconnected",
    });

    expect(updated).toHaveLength(2);
    expect(rows.every((pattern) => pattern.active === false)).toBe(true);
    expect(rows[0].connectorScope.issues?.[0]).toMatchObject({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
      reason: "disconnected",
      resumeOnReconnect: true,
    });
    expect(rows[1].triggerConfig).toEqual({
      type: "composio",
      toolkitSlug: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "acct_old",
    });
    expect(deleteTrigger).toHaveBeenCalledWith("trg_old");
  });

  it("pauses unpinned scheduled Pattern scopes when a specific connector account disconnects", async () => {
    const unpinnedPattern: PatternRecord = {
      ...basePattern,
      connectorScope: { composio: [{ toolkitSlug: "gmail" }], mcpServerIds: [] },
    };
    const otherAccountPattern: PatternRecord = {
      ...basePattern,
      id: "ptn_other",
      connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_other" }], mcpServerIds: [] },
    };
    const { store, rows } = createPatternStore([unpinnedPattern, otherAccountPattern]);

    const updated = await pausePatternsForComposioConnector({
      patternStore: store,
    }, {
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
      reason: "disconnected",
    });

    expect(updated.map((pattern) => pattern.id)).toEqual(["ptn_123"]);
    expect(rows[0].active).toBe(false);
    expect(rows[0].connectorScope.issues?.[0]).toMatchObject({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
      reason: "disconnected",
      resumeOnReconnect: true,
    });
    expect(rows[1].active).toBe(true);
  });

  it("rehydrates old connector accounts and recreates Composio triggers after reconnect", async () => {
    const triggeredPattern: PatternRecord = {
      ...basePattern,
      id: "ptn_trigger",
      triggerType: "composio",
      triggerConfig: {
        type: "composio",
        toolkitSlug: "gmail",
        triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "acct_old",
      },
      connectorScope: {
        composio: [],
        mcpServerIds: [],
        issues: [{
          type: "composio_connector_unavailable",
          toolkitSlug: "gmail",
          connectedAccountId: "acct_old",
          reason: "disconnected",
          pausedAt: "2026-05-20T00:00:00.000Z",
          resumeOnReconnect: true,
        }],
      },
      active: false,
      nextRunAt: null,
    };
    const { store, rows } = createPatternStore([triggeredPattern]);
    const createTrigger = mock(async () => ({ triggerId: "trg_new" }));

    await rehydratePatternsForComposioConnector({
      patternStore: store,
      composio: { createTrigger } as unknown as ComposioClient,
    }, {
      composioUserId: "tenant_test:usr_test",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_new",
      previousConnectedAccountId: "acct_old",
    });

    expect(createTrigger).toHaveBeenCalledWith("tenant_test:usr_test", "GMAIL_NEW_GMAIL_MESSAGE", {
      connectedAccountId: "acct_new",
    });
    expect(rows[0].active).toBe(true);
    expect(rows[0].connectorScope.composio).toEqual([{ toolkitSlug: "gmail", connectedAccountId: "acct_new" }]);
    expect(rows[0].connectorScope.issues).toBeUndefined();
    expect(rows[0].triggerConfig).toMatchObject({
      connectedAccountId: "acct_new",
      triggerId: "trg_new",
    });
  });

  it("rehydrates only the matching Composio account scope", async () => {
    const pausedPattern: PatternRecord = {
      ...basePattern,
      connectorScope: {
        composio: [
          { toolkitSlug: "gmail", connectedAccountId: "acct_old" },
          { toolkitSlug: "gmail", connectedAccountId: "acct_other" },
          { toolkitSlug: "linear", connectedAccountId: "acct_linear" },
        ],
        mcpServerIds: [],
        issues: [
          {
            type: "composio_connector_unavailable",
            toolkitSlug: "gmail",
            connectedAccountId: "acct_old",
            reason: "disconnected",
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
      active: false,
      nextRunAt: null,
    };
    const { store, rows } = createPatternStore([pausedPattern]);

    await rehydratePatternsForComposioConnector({
      patternStore: store,
    }, {
      composioUserId: "tenant_test:usr_test",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_new",
      previousConnectedAccountId: "acct_old",
    });

    expect(rows[0].active).toBe(true);
    expect(rows[0].connectorScope.composio).toEqual([
      { toolkitSlug: "gmail", connectedAccountId: "acct_new" },
      { toolkitSlug: "gmail", connectedAccountId: "acct_other" },
      { toolkitSlug: "linear", connectedAccountId: "acct_linear" },
    ]);
    expect(rows[0].connectorScope.issues).toMatchObject([{
      toolkitSlug: "gmail",
      connectedAccountId: "acct_other",
    }]);
  });

  it("keeps a Pattern paused when trigger rehydration fails", async () => {
    const triggeredPattern: PatternRecord = {
      ...basePattern,
      id: "ptn_trigger",
      triggerType: "composio",
      triggerConfig: {
        type: "composio",
        toolkitSlug: "gmail",
        triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "acct_old",
        triggerId: "trg_old",
      },
      connectorScope: {
        composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_old" }],
        mcpServerIds: [],
        issues: [{
          type: "composio_connector_unavailable",
          toolkitSlug: "gmail",
          connectedAccountId: "acct_old",
          reason: "disconnected",
          pausedAt: "2026-05-20T00:00:00.000Z",
          resumeOnReconnect: true,
        }],
      },
      active: false,
      nextRunAt: null,
    };
    const { store, rows } = createPatternStore([triggeredPattern]);
    const createTrigger = mock(async () => {
      throw new Error("Composio auth expired");
    });

    await rehydratePatternsForComposioConnector({
      patternStore: store,
      composio: { createTrigger } as unknown as ComposioClient,
      eventBus: { emit: mock(async () => undefined) } as unknown as EventBus,
    }, {
      composioUserId: "tenant_test:usr_test",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_new",
      previousConnectedAccountId: "acct_old",
    });

    expect(rows[0].active).toBe(false);
    expect(rows[0].connectorScope.issues?.[0]).toMatchObject({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
      reason: "account_replaced",
      resumeOnReconnect: true,
    });
    expect(rows[0].triggerConfig).toEqual({
      type: "composio",
      toolkitSlug: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "acct_old",
    });
  });

  it("reports connector issues from persisted pauses and live account mismatches", () => {
    const issues = resolvePatternConnectorIssues({
      ...basePattern,
      connectorScope: {
        composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_old" }],
        mcpServerIds: [],
      },
    }, new Map([["gmail", {
      toolkitSlug: "gmail",
      toolkitName: "Gmail",
      connected: true,
      connectedAccountId: "acct_new",
    } as never]]));

    expect(issues).toMatchObject([{
      toolkitSlug: "gmail",
      toolkitName: "Gmail",
      connectedAccountId: "acct_old",
      reason: "account_replaced",
    }]);
  });
});
