import { describe, expect, it, mock } from "bun:test";

import { EventBus, type PatternRecord } from "@finn/core";
import type { MemoryClient } from "@finn/integrations";
import { createMemoryRuntimeService } from "@finn/runtime";
import { buildPatternActivityFeedEvent, emitPatternActivity, wireMemoryActivityFeed } from "./activity-feed.js";

const pattern: PatternRecord = {
  id: "ptn_123",
  tenantId: "tenant_test",
  userId: "usr_test",
  name: "Daily news",
  description: null,
  userDescription: "Send a daily news brief.",
  triggerType: "schedule",
  triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
  connectorScope: { composio: [], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "always" },
  workerType: "pattern_worker",
  taskPrompt: "Check news.",
  reminderContext: null,
  timezone: "UTC",
  active: false,
  failureCount: 0,
  lastRunAt: null,
  nextRunAt: new Date("2026-05-08T09:00:00.000Z"),
  createdAt: new Date("2026-05-07T08:00:00.000Z"),
  updatedAt: new Date("2026-05-07T09:00:00.000Z"),
};

function createClient(): MemoryClient {
  return {
    provider: "test",
    addDocument: mock(async () => ({ id: "doc_123", status: "queued" })),
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
    buildHotPathTurnCustomId: (messageId) => `hot-path-turn_${messageId}`,
    buildPatternRunCustomId: (patternRunId) => `pattern-run_${patternRunId}`,
  };
}

describe("activity feed", () => {
  it("builds Pattern lifecycle events with stable operational details", () => {
    const event = buildPatternActivityFeedEvent({
      pattern,
      action: "paused",
      origin: "pattern_management",
      occurredAt: new Date("2026-05-07T09:00:00.000Z"),
      eventId: "act_123",
    });

    expect(event).toEqual({
      type: "activity_feed_event",
      tenantId: "tenant_test",
      userId: "usr_test",
      eventId: "act_123",
      occurredAt: "2026-05-07T09:00:00.000Z",
      source: "finn",
      origin: "pattern_management",
      entityType: "pattern",
      action: "paused",
      summary: "Pattern paused: Daily news",
      details: {
        patternId: "ptn_123",
        patternName: "Daily news",
        workerType: "pattern_worker",
        triggerType: "schedule",
        active: false,
        userDescription: "Send a daily news brief.",
        nextRunAt: "2026-05-08T09:00:00.000Z",
      },
    });
  });

  it("records emitted activity events through the memory subscriber", async () => {
    const eventBus = new EventBus();
    const client = createClient();

    wireMemoryActivityFeed(eventBus, {
      getMemoryRuntime: async () => createMemoryRuntimeService({
        client,
        user: { tenantId: pattern.tenantId, userId: pattern.userId, timezone: "UTC" },
      }),
    });
    emitPatternActivity({ eventBus, pattern, action: "paused", origin: "pattern_management" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("pattern_name: Daily news"),
      metadata: expect.objectContaining({
        kind: "activity_feed_event",
        source: "finn_activity_feed",
        sourceType: "pattern_activity_timeline",
        entityId: "ptn_123",
      }),
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "paused" }),
    }));
  });
});
