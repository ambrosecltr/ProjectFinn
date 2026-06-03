import { describe, expect, it, mock } from "bun:test";

import type { PatternRecord, PatternRunRecord, UserMessage } from "@finn/core";
import { buildUserProfileSeedMemoryDocument, MemoryRecorder, type MemoryClient } from "./memory.js";

const user = {
  tenantId: "tenant_test",
  userId: "usr_test",
  timezone: "UTC",
};

const profileUser = {
  ...user,
  displayName: "Alex",
  timezone: "Australia/Brisbane",
  timezoneSource: "browser" as const,
  location: "Brisbane, Australia",
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

function createPattern(overrides: Partial<PatternRecord> = {}): PatternRecord {
  return {
    id: "ptn_123",
    tenantId: user.tenantId,
    userId: user.userId,
    name: "Daily news",
    description: null,
    userDescription: null,
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "09:00" }, timezoneSource: "user" },
    connectorScope: { composio: [], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "worker_decision", instruction: "Notify on new things." },
    workerType: "pattern_worker",
    taskPrompt: "Check news.",
    reminderContext: null,
    timezone: "UTC",
    active: true,
    failureCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-05-07T08:00:00.000Z"),
    updatedAt: new Date("2026-05-07T08:00:00.000Z"),
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
    result: { summary: "Found launch." },
    error: null,
    skipReason: null,
    notifyOutcome: { notify: true, summary: "Found launch." },
    surfacedAt: null,
    toolScope: null,
    createdAt: new Date("2026-05-07T09:00:00.000Z"),
    startedAt: new Date("2026-05-07T09:00:01.000Z"),
    completedAt: new Date("2026-05-07T09:01:00.000Z"),
  };
}

describe("MemoryRecorder", () => {
  it("builds a core profile seed document with browser-captured timezone and no phone number", () => {
    const document = buildUserProfileSeedMemoryDocument({
      user: profileUser,
      timestamp: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(document).toEqual({
      kind: "user_profile_seed",
      content: [
        "Finn core profile snapshot",
        "",
        "This is Finn's authoritative current operational profile for the user.",
        "Extract only explicit fields as current facts. Do not infer missing values.",
        "",
        "Name: Alex",
        "Home/base location: Brisbane, Australia",
        "Timezone: Australia/Brisbane",
        "Timezone source: browser",
      ].join("\n"),
      source: {
        provider: "finn",
        type: "user_profile_seed",
        id: "core_profile",
        title: "Finn core profile snapshot",
        timestamp: "2026-05-31T05:00:00.000Z",
        metadata: {
          hasDisplayName: true,
          hasLocation: true,
          hasTimezone: true,
          timezoneSource: "browser",
        },
      },
      metadata: {
        kind: "user_profile_seed",
        source: "finn_core_profile",
        process: "profile_sync",
        tenantId: "tenant_test",
        userId: "usr_test",
        seedVersion: 1,
        hasDisplayName: true,
        hasLocation: true,
        hasTimezone: true,
        timezoneSource: "browser",
        timestamp: "2026-05-31T05:00:00.000Z",
      },
    });
    expect(document?.content).not.toContain("+15555555555");
  });

  it("omits server-default timezone from the core profile seed", () => {
    const document = buildUserProfileSeedMemoryDocument({
      user: {
        ...profileUser,
        timezone: "UTC",
        timezoneSource: "server",
        location: null,
      },
      timestamp: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(document?.content).toContain("Name: Alex");
    expect(document?.content).not.toContain("Timezone:");
    expect(document?.metadata).toMatchObject({
      hasDisplayName: true,
      hasLocation: false,
      hasTimezone: false,
      timezoneSource: "server",
    });
  });

  it("does not build an empty core profile seed", () => {
    expect(buildUserProfileSeedMemoryDocument({
      user: {
        tenantId: "tenant_test",
        userId: "usr_test",
        timezone: "UTC",
        timezoneSource: "server",
        displayName: null,
        location: null,
      },
      timestamp: new Date("2026-05-31T05:00:00.000Z"),
    })).toBeNull();
  });

  it("records one delivered hot-path document per handled user turn", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });
    const message: UserMessage = {
      source: "user",
      tenantId: user.tenantId,
      userId: user.userId,
      phoneNumber: "+15555555555",
      content: "first",
      messageId: "msg_root",
      timestamp: new Date("2026-05-07T09:00:00.000Z"),
      parts: [
        { content: "first", messageId: "msg_1", timestamp: new Date("2026-05-07T09:00:00.000Z") },
        { content: "second", messageId: "msg_2", timestamp: new Date("2026-05-07T09:00:01.000Z") },
      ],
    };

    await recorder.recordHotPathTurn({
      message,
      conversationId: "cnv_123",
      deliveredAssistantText: "got it",
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "hot-path-turn_msg_root",
      content: expect.stringContaining("first"),
      conversationMessages: [
        { role: "user", content: "first", timestamp: "2026-05-07T09:00:00.000Z", messageId: "msg_1" },
        { role: "user", content: "second", timestamp: "2026-05-07T09:00:01.000Z", messageId: "msg_2" },
        { role: "assistant", content: "got it", delivered: true },
      ],
      source: expect.objectContaining({
        provider: "finn",
        type: "imessage_turn",
        id: "msg_root",
        timestamp: "2026-05-07T09:00:00.000Z",
      }),
      metadata: expect.objectContaining({
        kind: "hot_path_turn",
        source: "hot_path",
        messageId: "msg_root",
        conversationId: "cnv_123",
        day: "2026-05-07",
        timestamp: "2026-05-07T09:00:00.000Z",
        delivered: true,
      }),
    }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("second") }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("got it") }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      observability: {
        operation: "retain_hot_path_turn",
        messageId: "msg_root",
        conversationId: "cnv_123",
      },
    }));
  });

  it("records hot-path turns without visible assistant output", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "hi",
        messageId: "msg_123",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "  ",
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "hot-path-turn_msg_123",
      content: expect.stringContaining("[assistant | delivered]\n[no visible assistant response]"),
      metadata: expect.objectContaining({
        delivered: false,
        messageId: "msg_123",
      }),
    }));
  });

  it("records attachment context for user turns", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "what is this?",
        messageId: "msg_photo",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
        attachments: [{
          id: "att_123",
          filename: "photo.jpeg",
          mimeType: "image/jpeg",
          url: "https://files.example.com/photo.jpeg",
          contextText: "A photo of a handwritten receipt.",
        }],
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "looks like a receipt",
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("filename: photo.jpeg"),
    }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("context: A photo of a handwritten receipt."),
    }));
  });

  it("records visible assistant tapbacks and media summaries without internal traces", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "look at this",
        messageId: "msg_123",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "[sent media file_123]\n\n[tapback: like | target_handle: msg_123]",
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("[sent media file_123]"),
      metadata: expect.objectContaining({ delivered: true }),
    }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("[tapback: like]"),
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("target_handle"),
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("toolCallId"),
    }));
  });

  it("strips assistant delivery handles before retaining conversation messages", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "hi",
        messageId: "msg_123",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "[handle:spc-msg-out]\nhey there",
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("[assistant | delivered]\nhey there"),
      conversationMessages: [
        { role: "user", content: "hi", timestamp: "2026-05-07T09:00:00.000Z", messageId: "msg_123" },
        { role: "assistant", content: "hey there", delivered: true },
      ],
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("[handle:spc-msg-out]"),
    }));
  });

  it("records visible worker-origin assistant messages into the hot-path session", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordVisibleAssistantMessage({
      source: "worker",
      sourceMessageId: "wrk_123",
      conversationId: "cnv_123",
      deliveredAssistantText: "[handle:spc-msg-out]\nworker result",
      timestamp: new Date("2026-05-07T09:05:00.000Z"),
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "hot-path-turn_wrk_123",
      content: "[assistant | delivered | source:worker]\nworker result",
      conversationMessages: [{ role: "assistant", content: "worker result", delivered: true }],
      metadata: expect.objectContaining({
        kind: "hot_path_turn",
        messageId: "wrk_123",
        conversationId: "cnv_123",
        delivered: true,
        inboundSource: "worker",
      }),
      observability: {
        operation: "retain_hot_path_turn",
        messageId: "wrk_123",
        conversationId: "cnv_123",
      },
    }));
  });

  it("does nothing when no provider is configured", async () => {
    const recorder = new MemoryRecorder({ user });

    await expect(recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "hi",
        messageId: "msg_123",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "hey",
    })).resolves.toBeUndefined();
  });

  it("records activity feed events with operational Pattern context", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });
    const pattern = createPattern({ active: false, nextRunAt: new Date("2026-05-08T09:00:00.000Z") });

    await recorder.recordActivityFeedEvent({
      type: "activity_feed_event",
      tenantId: user.tenantId,
      userId: user.userId,
      eventId: "act_123",
      occurredAt: "2026-05-07T09:00:00.000Z",
      source: "finn",
      origin: "pattern_management",
      entityType: "pattern",
      action: "paused",
      summary: "Pattern paused: Daily news",
      details: {
        patternId: pattern.id,
        patternName: pattern.name,
        workerType: pattern.workerType,
        triggerType: pattern.triggerType,
        active: pattern.active,
        userDescription: "Send a daily news brief.",
        nextRunAt: pattern.nextRunAt?.toISOString() ?? null,
      },
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "activity-feed_act_123",
      content: expect.stringContaining("lifecycle_action: paused"),
      source: expect.objectContaining({
        provider: "finn_activity_feed",
        type: "activity_feed_event",
        id: "act_123",
      }),
      metadata: expect.objectContaining({
        kind: "activity_feed_event",
        source: "finn_activity_feed",
        sourceType: "pattern_activity_timeline",
        process: "activity_feed",
        entityType: "pattern",
        entityId: pattern.id,
        patternId: pattern.id,
      }),
      observability: {
        operation: "retain_activity_feed_event",
        activityEventId: "act_123",
        patternId: pattern.id,
      },
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        action: expect.anything(),
        active: expect.anything(),
        day: expect.anything(),
      }),
    }));
  });

  it("lets provider failures propagate for the hot path fire-and-forget logger", async () => {
    const client = createClient();
    const addDocument = client.addDocument as ReturnType<typeof mock>;
    addDocument.mockImplementationOnce(async () => {
      throw new Error("provider down");
    });
    const recorder = new MemoryRecorder({ client, user });

    await expect(recorder.recordHotPathTurn({
      message: {
        source: "user",
        tenantId: user.tenantId,
        userId: user.userId,
        phoneNumber: "+15555555555",
        content: "hi",
        messageId: "msg_123",
        timestamp: new Date("2026-05-07T09:00:00.000Z"),
      },
      conversationId: "cnv_123",
      deliveredAssistantText: "hey",
    })).rejects.toThrow("provider down");
  });

  it("records recurring Pattern outcomes with final notify semantics", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });
    const pattern = createPattern();

    await recorder.recordPatternRunOutcome({
      pattern,
      run: createRun(pattern),
      result: { summary: "Found launch.", data: { title: "Launch" } },
      notifyOutcome: { notify: false, summary: "Found launch.", reason: "User already saw it.", data: { messageId: "msg_1" } },
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "pattern-run_ptrun_123",
      content: expect.stringContaining("Worker summary: Found launch."),
      metadata: expect.objectContaining({
        kind: "pattern_run_outcome",
        source: "pattern_worker",
        patternId: pattern.id,
        patternRunId: "ptrun_123",
        notified: false,
        day: "2026-05-07",
      }),
      observability: {
        operation: "retain_pattern_run_outcome",
        patternId: pattern.id,
        patternRunId: "ptrun_123",
      },
    }));
    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Notify reason: User already saw it.") }));
  });

  it("does not store one-shot schedule Pattern outcomes as continuity memory", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });
    const pattern = createPattern({ triggerConfig: { type: "schedule", schedule: { kind: "once", localDateTime: "2026-05-07T09:00:00" }, timezoneSource: "user" } });

    await recorder.recordPatternRunOutcome({
      pattern,
      run: createRun(pattern),
      result: { summary: "done" },
      notifyOutcome: { notify: true, summary: "done" },
    });

    expect(client.addDocument).not.toHaveBeenCalled();
  });

  it("records personal intelligence with stable connected-app provenance", async () => {
    const client = createClient();
    const recorder = new MemoryRecorder({ client, user });

    await recorder.recordPersonalIntelligenceItem({
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      messageId: "msg_123",
      threadId: "thread_123",
      senderEmail: "alex@example.com",
      recipientEmails: ["user@example.com"],
      sourceUrl: "https://mail.google.com/mail/u/0/#inbox/msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Alex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      metadata: { labelIds: ["INBOX"], ignoredObject: { nested: true } },
    });

    expect(client.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "personal-intelligence_gmail_gmail_3Aemail_3Auser_40example.com_email_msg_123",
      content: expect.stringContaining("PI account scope ID: gmail:email:user@example.com"),
      source: expect.objectContaining({
        provider: "gmail",
        type: "email",
        id: "msg_123",
        url: "https://mail.google.com/mail/u/0/#inbox/msg_123",
        metadata: expect.objectContaining({
          accountScopeId: "gmail:email:user@example.com",
          connectedAccountId: "acct_123",
          messageId: "msg_123",
          threadId: "thread_123",
          labelIds: ["INBOX"],
        }),
      }),
      metadata: expect.objectContaining({
        kind: "personal_intelligence_source",
        source: "gmail",
        accountScopeId: "gmail:email:user@example.com",
        connectedAccountId: "acct_123",
        messageId: "msg_123",
        threadId: "thread_123",
        senderEmail: "alex@example.com",
        recipientEmails: ["user@example.com"],
        sourceUrl: "https://mail.google.com/mail/u/0/#inbox/msg_123",
        labelIds: ["INBOX"],
      }),
      observability: { operation: "retain_personal_intelligence_item" },
    }));
    expect(client.addDocument).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ ignoredObject: expect.anything() }),
    }));
  });
});
