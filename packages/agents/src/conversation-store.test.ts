import { describe, expect, it } from "bun:test";

import type { AppConfig } from "@finn/core";
import type { WorkerMessage } from "@finn/core";
import type { StoredConversationTurn } from "@finn/db";
import type { LanguageModel } from "ai";

import {
  buildDailyHandoffPrompt,
  formatDailyHandoffSourceTurns,
  formatWorkerDeliveryContent,
  HotPathConversationStore,
} from "./conversation-store.js";

const storeConfig = {
  userTimezone: "UTC",
  context: {
    maxTokens: 128_000,
    promptHistoryTokenBudget: 200,
    promptHistoryMessageTokenBudget: 50,
    currentTurnTokenBudget: 200,
    chapterSummaryTokenBudget: 50,
    handoffInputTokenBudget: 100,
    compactionBufferTokens: 4_000,
    compactionBatchBackground: 20,
    compactionBatchAggressive: 40,
    compactionEmergencyBatch: 30,
    compactionMaxPasses: 3,
    dailyRolloverHour: 4,
    dailyRolloverMinute: 0,
    thresholdWarn: 0.7,
    thresholdBackground: 0.8,
    thresholdAggressive: 0.9,
    thresholdEmergency: 0.95,
  },
} satisfies Pick<AppConfig, "userTimezone" | "context">;

type TestConversationRow = {
  id: string;
  tenantId: string;
  userId: string;
  rootConversationId: string;
  previousConversationId: string | null;
  chapterIndex: number;
  userLocalDate: string;
  handoffSummary: string | null;
  startedAt: Date;
  lastMessageAt: Date;
  active: boolean;
  archivedAt: Date | null;
  metadata: Record<string, unknown> | null;
};

function createTurn(overrides: Partial<StoredConversationTurn>): StoredConversationTurn {
  return {
    id: "msg_test",
    tenantId: "tenant_test",
    userId: "usr_test",
    conversationId: "cnv_test",
    role: "user",
    content: "hello",
    source: "user",
    sourceMessageId: null,
    toolCalls: null,
    tokenEstimate: 1,
    createdAt: new Date("2026-05-04T09:00:00.000Z"),
    compacted: false,
    compactionGroup: null,
    ...overrides,
  } as StoredConversationTurn;
}

function toPromptMessageForTest(turn: StoredConversationTurn) {
  const store = new HotPathConversationStore(
    {} as never,
    storeConfig,
    {} as LanguageModel,
    {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+10000000000",
      displayName: "Test User",
      timezone: "UTC",
      timezoneSource: "server",
      location: null,
      kidsMode: false,
    },
  );

  return (store as unknown as {
    toBudgetedPromptMessage(turn: StoredConversationTurn, timeZone: string, tokenBudget: number): { role: "user" | "assistant"; content: string } | null;
  }).toBudgetedPromptMessage(turn, "UTC", 500);
}

describe("formatWorkerDeliveryContent", () => {
  it("includes origin metadata and weaving guidance for user-origin workers", () => {
    const message: WorkerMessage = {
      source: "worker",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_123",
      task: "check xAI news",
      result: { summary: "xAI shipped APIs", data: { fileId: "file_123", url: "https://example.com/files/file_123" } },
      originSource: "user",
      originMessageId: "msg_456",
    };

    const formatted = formatWorkerDeliveryContent(message);

    expect(formatted).toContain("Origin: user");
    expect(formatted).toContain("Origin message: msg_456");
    expect(formatted).toContain("Supporting data / dataSummary:");
    expect(formatted).toContain('"fileId": "file_123"');
    expect(formatted).toContain("weave it into the live thread");
  });

  it("keeps user-origin guidance for failed workers", () => {
    const message: WorkerMessage = {
      source: "worker",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_failed",
      task: "check Anthropic news",
      result: { summary: "Worker failed.", error: "Too Many Requests" },
      originSource: "user",
      originMessageId: "msg_789",
    };

    const formatted = formatWorkerDeliveryContent(message);

    expect(formatted).toContain("Status: Failed");
    expect(formatted).toContain("Origin: user");
    expect(formatted).toContain("Origin message: msg_789");
    expect(formatted).toContain("weave it into the live thread");
  });

  it("includes pattern metadata and notification guidance for pattern-origin workers", () => {
    const message: WorkerMessage = {
      source: "worker",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_456",
      task: "Check today's weather forecast for Brisbane, Queensland, Australia. Report the high and low temperatures, general conditions, and any notable alerts.",
      result: { summary: "High 26, low 18, partly cloudy, no alerts." },
      originSource: "pattern",
      pattern: {
        id: "ptn_123",
        name: "Morning weather",
        triggeredBy: "schedule",
        triggerPayload: null,
        notifyOutcome: {
          notify: true,
          summary: "High 26, low 18, partly cloudy, no alerts.",
          reason: "Daily weather pattern should notify every morning.",
        },
      },
    };

    const formatted = formatWorkerDeliveryContent(message);

    expect(formatted).toContain("Pattern: Morning weather");
    expect(formatted).toContain("Pattern ID: ptn_123");
    expect(formatted).toContain("Triggered by: schedule");
    expect(formatted).toContain("Notify: yes");
    expect(formatted).toContain("Notify reason: Daily weather pattern should notify every morning.");
    expect(formatted).toContain("saved pattern");
    expect(formatted).toContain("notify condition was met");
    expect(formatted).not.toContain("Pattern run ID");
    expect(formatted).not.toContain("wrk_456");
  });

  it("truncates oversized structured worker data before hot-path delivery", () => {
    const message: WorkerMessage = {
      source: "worker",
      tenantId: "tenant_test",
      userId: "usr_test",
      workerId: "wrk_large",
      task: "summarize a large export",
      result: { summary: "Export parsed.", data: { rows: "x".repeat(50_000), fileId: "file_large" } },
      originSource: "user",
    };

    const formatted = formatWorkerDeliveryContent(message);

    expect(formatted).toContain("Structured result data truncated");
    expect(formatted.length).toBeLessThan(18_000);
  });
});

describe("prompt history envelopes", () => {
  it("wraps legacy human turns in human_message envelopes", () => {
    const promptMessage = toPromptMessageForTest(createTurn({
      role: "user",
      source: "user",
      sourceMessageId: "msg_user",
      content: "yo",
    }));

    expect(promptMessage?.role).toBe("user");
    expect(promptMessage?.content).toContain('<human_message source="user">');
    expect(promptMessage?.content).toContain('<message handle="msg_user"');
    expect(promptMessage?.content).toContain('modality="text"');
    expect(promptMessage?.content).toContain("<text>\nyo\n</text>");
    expect(promptMessage?.content).not.toContain("[handle:msg_user]");
  });

  it("wraps legacy worker turns in internal_message envelopes", () => {
    const promptMessage = toPromptMessageForTest(createTurn({
      role: "user",
      source: "worker",
      sourceMessageId: "wrk_123",
      content: "worker result",
    }));

    expect(promptMessage?.role).toBe("user");
    expect(promptMessage?.content).toContain('<internal_message source="worker" source_message_id="wrk_123"');
    expect(promptMessage?.content).toContain("worker result");
  });

  it("does not double-wrap already enveloped prompt turns", () => {
    const promptMessage = toPromptMessageForTest(createTurn({
      role: "user",
      source: "user",
      content: '<human_message handle="msg_123">\nhey\n</human_message>',
    }));

    expect(promptMessage?.content).toBe('<human_message handle="msg_123">\nhey\n</human_message>');
  });

  it("sanitizes persisted host attachment paths before prompt history", () => {
    const promptMessage = toPromptMessageForTest(createTurn({
      role: "user",
      source: "user",
      content: [
        '<attachment_context handle="msg_123">',
        "filename: IMG_3853.jpg",
        "local path: /data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
        "</attachment_context>",
      ].join("\n"),
    }));

    expect(promptMessage?.content).not.toContain("/data/workspaces");
    expect(promptMessage?.content).not.toContain("local path:");
    expect(promptMessage?.content).toContain("workspace path: /workspace/files/file_image/IMG_3853.jpg");
    expect(promptMessage?.content?.match(/workspace path:/g)).toHaveLength(1);
  });

  it("preserves user-authored local path text outside attachment blocks", () => {
    const promptMessage = toPromptMessageForTest(createTurn({
      role: "user",
      source: "user",
      content: "my local path: /Users/test/Documents/note.txt",
    }));

    expect(promptMessage?.content).toContain("my local path: /Users/test/Documents/note.txt");
  });
});

describe("daily handoff prompt", () => {
  it("builds personal-continuity instructions that exclude operational state", () => {
    const prompt = buildDailyHandoffPrompt([
      createTurn({
        id: "msg_user",
        role: "user",
        source: "user",
        content: [
          "[user | 2026-05-04, 19:50:31 AEST]",
          "[handle:6A2E3F33-480D-4C38-B23C-F56B3A561C90]",
          "Every now and then I watch heaps of Japan vids and plan a trip I never take.",
        ].join("\n"),
      }),
      createTurn({
        id: "msg_worker",
        role: "user",
        source: "worker",
        content: [
          "Pattern: 10-Minute Email Check",
          "Notify: yes",
          "Result: Found 1 new email in the last 10 minutes.",
        ].join("\n"),
      }),
      createTurn({
        id: "msg_assistant",
        role: "assistant",
        source: "system",
        content: "haha your wife's got you there. the planning is half the fun tho right?",
      }),
    ], "Australia/Brisbane");

    expect(prompt).toContain("This is not same-day compaction and not a durable profile store.");
    expect(prompt).toContain("User profile context, Patterns, and worker status are handled separately.");
    expect(prompt).toContain("Do not preserve:");
    expect(prompt).toContain("Every now and then I watch heaps of Japan vids");
    expect(prompt).toContain("[user | 2026-05-04 19:00:00 AEST]");
    expect(prompt).toContain("[finn | 2026-05-04 19:00:00 AEST]");
    expect(prompt).not.toContain("Pattern: 10-Minute Email Check");
    expect(prompt).not.toContain("Worker ID: wrk_123");
    expect(prompt).not.toContain("[handle:6A2E3F33-480D-4C38-B23C-F56B3A561C90]");
  });

  it("keeps same-day compaction summaries available without raw internal sources", () => {
    const source = formatDailyHandoffSourceTurns([
      createTurn({
        id: "msg_summary",
        role: "system",
        source: "system",
        content: "[Summary of 12 messages]\nuser and finn were talking about Japan travel anxiety and the user's habit of planning trips without taking them.",
      }),
      createTurn({
        id: "msg_trigger",
        role: "user",
        source: "trigger",
        content: "[Internal — trigger] daily rollover fired",
      }),
      createTurn({
        id: "msg_reaction",
        role: "assistant",
        source: "system",
        content: "[tapback: laugh | target_handle: E1D81B76-BA63-49C6-8C52-41ADB87E2D51]",
      }),
    ], "UTC");

    expect(source).toContain("[same-day summary | 2026-05-04 09:00:00 UTC]");
    expect(source).toContain("Japan travel anxiety");
    expect(source).toContain("[tapback: laugh]");
    expect(source).not.toContain("[Summary of 12 messages]");
    expect(source).not.toContain("daily rollover fired");
    expect(source).not.toContain("target_handle");
  });

  it("does not create a handoff prompt from only internal worker or trigger turns", () => {
    const prompt = buildDailyHandoffPrompt([
      createTurn({
        id: "msg_worker",
        role: "user",
        source: "worker",
        content: "Pattern: Notify on important emails\nWorker ID: wrk_123",
      }),
      createTurn({
        id: "msg_trigger",
        role: "user",
        source: "trigger",
        content: "[Internal — trigger] daily rollover fired",
      }),
    ], "UTC");

    expect(prompt).toBeNull();
  });

  it("sanitizes persisted host attachment paths before handoff prompts", () => {
    const prompt = buildDailyHandoffPrompt([
      createTurn({
        id: "msg_user",
        role: "user",
        source: "user",
        content: [
          '<attachment_context handle="msg_user">',
          "filename: IMG_3853.jpg",
          "local path: /data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
          "</attachment_context>",
        ].join("\n"),
      }),
    ], "UTC");

    expect(prompt).not.toContain("/data/workspaces");
    expect(prompt).not.toContain("local path:");
    expect(prompt).toContain("workspace path: /workspace/files/file_image/IMG_3853.jpg");
    expect(prompt?.match(/workspace path:/g)).toHaveLength(1);
  });
});

describe("HotPathConversationStore", () => {
  it("can roll over without waiting for a handoff summary", async () => {
    const insertedConversations: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const db: {
      activeConversation: TestConversationRow | null;
      select: () => {
        from: () => {
          where: () => {
            limit: () => Promise<TestConversationRow[]>;
            orderBy: () => { limit: () => Promise<TestConversationRow[]> };
          };
        };
      };
      insert: () => { values: (value: Record<string, unknown>) => Promise<void> };
      update: () => { set: (value: Record<string, unknown>) => { where: () => Promise<void> } };
      transaction: (callback: (tx: typeof db) => Promise<void>) => Promise<void>;
    } = {
      activeConversation: {
        id: "cnv_old",
        tenantId: "tenant_test",
        userId: "usr_test",
        rootConversationId: "cnv_old",
        previousConversationId: null,
        chapterIndex: 1,
        userLocalDate: "2026-04-20",
        handoffSummary: null,
        startedAt: new Date("2026-04-20T00:00:00.000Z"),
        lastMessageAt: new Date("2026-04-20T01:00:00.000Z"),
        active: true,
        archivedAt: null,
        metadata: null,
      },
      select: () => ({
        from: () => ({
          where: () => {
            const result = Promise.resolve(db.activeConversation ? [db.activeConversation] : []);
            return {
              limit: () => result,
              orderBy: () => ({
                limit: () => Promise.resolve(db.activeConversation ? [db.activeConversation] : []),
              }),
            };
          },
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          insertedConversations.push(value);
          db.activeConversation = value as TestConversationRow;
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: () => {
            updates.push(value);
            return Promise.resolve();
          },
        }),
      }),
      transaction: async (callback) => {
        await callback(db);
      },
    };

    const store = new HotPathConversationStore(
      db as never,
      storeConfig,
      {} as LanguageModel,
      {
        tenantId: "tenant_test",
        userId: "usr_test",
        phoneNumber: "+10000000000",
        timezone: "UTC",
        timezoneSource: "server",
        kidsMode: false,
      },
    );

    const conversation = await store.ensureCurrentChapter(new Date("2026-04-21T05:00:00.000Z"), { waitForSummary: false });

    expect(conversation.previousConversationId).toBe("cnv_old");
    expect(insertedConversations).toHaveLength(1);
    expect(insertedConversations[0]?.handoffSummary).toBeNull();
    expect(updates[0]).toMatchObject({ active: false });
  });
});
