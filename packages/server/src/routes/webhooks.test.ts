import { describe, expect, it, mock } from "bun:test";
import { createWebhookRoutes, matchesTriggerFilters } from "./webhooks.js";
import type { PatternRecord } from "@finn/core";

function createPattern(overrides: Partial<PatternRecord> = {}): PatternRecord {
  return {
    id: "ptn_123",
    tenantId: "tenant_test",
    userId: "usr_test",
    name: "RACQ emails",
    description: null,
    userDescription: "Watch RACQ emails.",
    triggerType: "composio",
    triggerConfig: { type: "composio", toolkitSlug: "gmail", triggerSlug: "new_email", connectedAccountId: "acct_123", triggerId: "trg_123" },
    connectorScope: { composio: [], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    workerType: "pattern_worker",
    taskPrompt: "Check email.",
    reminderContext: null,
    timezone: "UTC",
    active: true,
    failureCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-04-24T00:00:00.000Z"),
    updatedAt: new Date("2026-04-24T00:00:00.000Z"),
    ...overrides,
  };
}

describe("matchesTriggerFilters", () => {
  it("matches nested equality, contains, and exists filters", () => {
    expect(matchesTriggerFilters({ payload: { sender: "Kenny at RACQ", subject: "Renewal" } }, [
      { path: "payload.sender", operator: "contains", value: "racq" },
      { path: "payload.subject", operator: "exists" },
    ])).toBe(true);
  });

  it("matches email-address equality inside display-name sender strings", () => {
    expect(matchesTriggerFilters({ payload: { sender: "Alex Morgan <alex@example.com>" } }, [
      { path: "payload.sender", operator: "equals", value: "alex@example.com" },
    ])).toBe(true);
  });

  it("rejects non-matching trigger filters", () => {
    expect(matchesTriggerFilters({ payload: { sender: "Other" } }, [
      { path: "payload.sender", operator: "equals", value: "Kenny at RACQ" },
    ])).toBe(false);
  });
});

describe("createWebhookRoutes", () => {
  it("skips Composio Pattern workers when trigger filters do not match", async () => {
    const pattern = createPattern({
      triggerFilters: [{ path: "payload.sender", operator: "contains", value: "racq" }],
    });
    const runPattern = mock(async () => "wrk_123");
    const skipPattern = mock(async () => undefined);
    const app = createWebhookRoutes({
      config: { integrations: { composio: {} } } as never,
      composio: {} as never,
      patternStore: { getAllByComposioTriggerId: async () => [pattern] } as never,
      patternScheduler: { runPattern, skipPattern } as never,
    });

    const response = await app.request("http://localhost/composio", {
      method: "POST",
      body: JSON.stringify({
        id: "evt_123",
        metadata: { trigger_id: "trg_123", trigger_slug: "new_email", user_id: "usr_test" },
        data: { sender: "Other" },
      }),
    });

    expect(response.status).toBe(200);
    expect(runPattern).not.toHaveBeenCalled();
    expect(skipPattern).toHaveBeenCalledTimes(1);
  });

  it("ignores Composio webhooks for the wrong connected account", async () => {
    const pattern = createPattern();
    const runPattern = mock(async () => "wrk_123");
    const skipPattern = mock(async () => undefined);
    const app = createWebhookRoutes({
      config: { integrations: { composio: {} } } as never,
      composio: {} as never,
      patternStore: { getAllByComposioTriggerId: async () => [pattern] } as never,
      patternScheduler: { runPattern, skipPattern } as never,
    });

    const response = await app.request("http://localhost/composio", {
      method: "POST",
      body: JSON.stringify({
        id: "evt_123",
        metadata: {
          trigger_id: "trg_123",
          trigger_slug: "new_email",
          user_id: "tenant_test_usr_test",
          connectedAccount: { id: "acct_other", userId: "tenant_test_usr_test" },
        },
        data: { sender: "RACQ" },
      }),
    });

    expect(response.status).toBe(200);
    expect(runPattern).not.toHaveBeenCalled();
    expect(skipPattern).not.toHaveBeenCalled();
  });

  it("ignores Composio webhooks with snake_case metadata for the wrong connected account", async () => {
    const pattern = createPattern();
    const runPattern = mock(async () => "wrk_123");
    const skipPattern = mock(async () => undefined);
    const app = createWebhookRoutes({
      config: { integrations: { composio: {} } } as never,
      composio: {} as never,
      patternStore: { getAllByComposioTriggerId: async () => [pattern] } as never,
      patternScheduler: { runPattern, skipPattern } as never,
    });

    const response = await app.request("http://localhost/composio", {
      method: "POST",
      body: JSON.stringify({
        id: "evt_123",
        metadata: {
          trigger_id: "trg_123",
          trigger_slug: "new_email",
          user_id: "tenant_test_usr_test",
          connected_account_id: "acct_other",
        },
        data: { sender: "RACQ" },
      }),
    });

    expect(response.status).toBe(200);
    expect(runPattern).not.toHaveBeenCalled();
    expect(skipPattern).not.toHaveBeenCalled();
  });
});
