import { describe, expect, it } from "bun:test";
import type { UserContext } from "@finn/core";
import type { UserConnectorConfig } from "@finn/db";
import { MemoryRecorder } from "@finn/integrations";
import { createMemoryRuntimeService } from "@finn/runtime";
import { buildPersonalIntelligenceCheckpointScopesForTest, buildPersonalIntelligenceCheckpointUpdatesForTest, buildPersonalIntelligenceFallbackCheckpointForTest, buildPersonalIntelligenceSystemPromptForTest, createRetainPersonalIntelligenceTool, getDeferredPersonalIntelligenceRefreshSlotForTest, getPersonalIntelligenceScheduleDayStartForTest, PersonalIntelligenceService, shouldRunPersonalIntelligenceNow, type PersonalIntelligenceRunPlan, type PersonalIntelligenceRunSelection } from "./personal-intelligence-service.js";
import { getEnabledAutomationConnectors } from "./automation-sources.js";

describe("createRetainPersonalIntelligenceTool", () => {
  it("retains source material immediately and records retained document IDs", async () => {
    const retainedDocumentIds: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    const ledgerCalls: unknown[] = [];
    let recordedInput: Record<string, unknown> | undefined;
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_123", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      runId: "arun_123",
      retainedDocumentIds,
      skippedReasons,
      seenSources,
      sourceStore: {
        hasSource: async () => false,
        recordRetainedSource: async (input: unknown) => {
          ledgerCalls.push(input);
          return {} as never;
        },
      },
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      messageId: "msg_123",
      threadId: "thread_123",
      senderEmail: "alex@example.com",
      recipientEmails: ["user@example.com"],
      attendeeEmails: [],
      sourceUrl: "https://mail.google.com/mail/u/0/#inbox/msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "from: alex@example.com\nsubject: Lease renewal\nAlex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      metadata: { from: "alex@example.com", labels: ["INBOX"] },
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: true, retainedDocumentId: "doc_123" });
    expect(retainedDocumentIds).toEqual(["doc_123"]);
    expect(skippedReasons).toEqual({});
    expect(recordedInput).toEqual(expect.objectContaining({
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      messageId: "msg_123",
      threadId: "thread_123",
      senderEmail: "alex@example.com",
      recipientEmails: ["user@example.com"],
      sourceUrl: "https://mail.google.com/mail/u/0/#inbox/msg_123",
      content: expect.stringContaining("Source perspective: inspected from the user's connected account/mailbox."),
      metadata: expect.objectContaining({
        sourcePerspective: "user_connected_account",
        sourceDirection: "received_or_visible_in_user_mailbox",
      }),
    }));
    expect(ledgerCalls).toEqual([expect.objectContaining({
      runId: "arun_123",
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      retainedDocumentId: "doc_123",
    })]);
  });

  it("dedupes source IDs within a run", async () => {
    const retainedDocumentIds: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    const recorder = {
      recordPersonalIntelligenceItem: async () => ({ id: "doc_123", status: "queued" }),
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds,
      skippedReasons,
      seenSources,
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
    });
    const candidate = {
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email" as const,
      sourceId: "msg_123",
      messageId: "msg_123",
      threadId: "thread_123",
      senderEmail: "alex@example.com",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "from: alex@example.com\nsubject: Lease renewal\nAlex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: { from: "alex@example.com", labels: ["INBOX"] },
    };

    await retainTool.execute?.(candidate, { toolCallId: "call_1", messages: [] });
    const duplicate = await retainTool.execute?.(candidate, { toolCallId: "call_2", messages: [] });

    expect(duplicate).toEqual({ ok: false, skipped: true, reason: "duplicate_source_in_run" });
    expect(retainedDocumentIds).toEqual(["doc_123"]);
    expect(skippedReasons).toEqual({ "gmail:gmail:email:user@example.com:email:msg_123": "duplicate_source_in_run" });
  });

  it("allows Composio retain scopes to preserve concrete source types", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const ledgerCalls: unknown[] = [];
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_email", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      runId: "arun_gmail",
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{
        toolkitSlug: "gmail",
        accountScopeId: "gmail:email:user@example.com",
        connectedAccountId: "acct_gmail",
        sourceType: "any-source",
        enforceSourceType: false,
      }],
      sourceStore: {
        hasSource: async () => false,
        recordRetainedSource: async (input: unknown) => {
          ledgerCalls.push(input);
          return {} as never;
        },
      },
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_gmail",
      sourceType: "email",
      sourceId: "msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Alex needs the signed lease by Friday.",
      reason: "Durable responsibility with a deadline.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: true, retainedDocumentId: "doc_email" });
    expect(recordedInput).toEqual(expect.objectContaining({
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_gmail",
      sourceType: "email",
    }));
    expect(ledgerCalls).toEqual([expect.objectContaining({
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_gmail",
      sourceType: "email",
    })]);
  });

  it("uses server-authoritative Puter scope instead of model-supplied account ids", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const ledgerCalls: unknown[] = [];
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_puter", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      runId: "arun_puter",
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{
        toolkitSlug: "puter",
        accountScopeId: "puter:local",
        connectedAccountId: "puter:mac",
        sourceType: "imessage",
      }],
      sourceStore: {
        hasSource: async () => false,
        recordRetainedSource: async (input: unknown) => {
          ledgerCalls.push(input);
          return {} as never;
        },
      },
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "puter",
      accountScopeId: "puter_mac_local",
      connectedAccountId: "puter_mac_local",
      sourceType: "imessage",
      sourceId: "msg_123",
      title: "Project thread",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "A durable project detail from local Messages.",
      reason: "Durable project context.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: true, retainedDocumentId: "doc_puter" });
    expect(recordedInput).toEqual(expect.objectContaining({
      toolkitSlug: "puter",
      accountScopeId: "puter:local",
      connectedAccountId: "puter:mac",
    }));
    expect(ledgerCalls).toEqual([expect.objectContaining({
      toolkitSlug: "puter",
      accountScopeId: "puter:local",
      connectedAccountId: "puter:mac",
      sourceType: "imessage",
    })]);
  });

  it("preserves supporting provenance for evidence-backed relationship summaries", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_relationship", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{ toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "imessage" }],
    });

    await retainTool.execute?.({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      sourceType: "imessage",
      sourceId: "thread_willow",
      supportingSourceIds: ["msg_1", "msg_2"],
      messageId: "msg_2",
      supportingMessageIds: ["msg_1", "msg_2"],
      threadId: "thread_willow",
      supportingThreadIds: ["thread_willow"],
      title: "Willow",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Multiple messages in this thread support that Willow is a close family relationship: she calls the user dad and sends recurring app/Roblox requests.",
      reason: "Evidence-backed durable relationship context.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: { relationshipConfidence: "high" },
    }, { toolCallId: "call_123", messages: [] });

    expect(recordedInput?.content).toEqual(expect.stringContaining("Supporting message IDs: msg_1, msg_2"));
    expect(recordedInput?.metadata).toEqual(expect.objectContaining({
      supportingSourceIds: ["msg_1", "msg_2"],
      supportingMessageIds: ["msg_1", "msg_2"],
      supportingThreadIds: ["thread_willow"],
      relationshipConfidence: "high",
    }));
  });

  it("treats Puter iMessage local-user metadata as authored by the user", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_sent_imessage", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{ toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "imessage" }],
    });

    await retainTool.execute?.({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      sourceType: "imessage",
      sourceId: "msg_sent",
      messageId: "msg_sent",
      threadId: "thread_project",
      senderEmail: "local-user@icloud.com",
      recipientEmails: ["mina@example.com"],
      attendeeEmails: [],
      title: "Project Atlas",
      timestamp: "2026-05-16T11:00:00.000Z",
      content: "The local user sent Mina a decision-log reminder for Project Atlas.",
      reason: "User-authored commitment in an active project thread.",
      metadata: {
        isFromMe: true,
        localUser: true,
        localSenderHandle: "local-user@icloud.com",
      },
    }, { toolCallId: "call_123", messages: [] });

    expect(recordedInput?.senderEmail).toBeNull();
    expect(recordedInput?.content).toEqual(expect.stringContaining("Source direction: sent_or_authored_by_user."));
    expect(recordedInput?.content).toEqual(expect.stringContaining("Sender in source record: local user."));
    expect(recordedInput?.content).not.toEqual(expect.stringContaining("Sender in source record: local-user@icloud.com"));
    expect(recordedInput?.metadata).toEqual(expect.objectContaining({
      sourceDirection: "sent_or_authored_by_user",
      localUser: true,
      localSenderHandle: "local-user@icloud.com",
    }));
  });

  it("preserves explicit received direction metadata", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_received_imessage", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{ toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "imessage" }],
    });

    await retainTool.execute?.({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      sourceType: "imessage",
      sourceId: "msg_received",
      messageId: "msg_received",
      threadId: "thread_project",
      senderEmail: "mina@example.com",
      recipientEmails: [],
      attendeeEmails: [],
      title: "Project Atlas",
      timestamp: "2026-05-16T11:00:00.000Z",
      content: "Mina sent an update about Project Atlas.",
      reason: "Durable project context from a received local message.",
      metadata: {
        direction: "received",
      },
    }, { toolCallId: "call_123", messages: [] });

    expect(recordedInput?.senderEmail).toBe("mina@example.com");
    expect(recordedInput?.content).toEqual(expect.stringContaining("Source direction: received_by_user."));
    expect(recordedInput?.content).toEqual(expect.stringContaining("Sender in source record: mina@example.com"));
    expect(recordedInput?.metadata).toEqual(expect.objectContaining({
      direction: "received",
      sourceDirection: "received_by_user",
    }));
  });

  it("prefers explicit sourceDirection over legacy direction metadata", async () => {
    let recordedInput: Record<string, unknown> | undefined;
    const recorder = {
      recordPersonalIntelligenceItem: async (input: Record<string, unknown>) => {
        recordedInput = input;
        return { id: "doc_explicit_direction", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds: [],
      skippedReasons: {},
      seenSources: new Set<string>(),
      allowedScopes: [{ toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "imessage" }],
    });

    await retainTool.execute?.({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      sourceType: "imessage",
      sourceId: "msg_direction",
      messageId: "msg_direction",
      threadId: "thread_project",
      senderEmail: "mina@example.com",
      recipientEmails: [],
      attendeeEmails: [],
      title: "Project Atlas",
      timestamp: "2026-05-16T11:00:00.000Z",
      content: "Mina sent an update about Project Atlas.",
      reason: "Durable project context from a received local message.",
      metadata: {
        direction: "sent_by_user",
        sourceDirection: "received_by_user",
      },
    }, { toolCallId: "call_123", messages: [] });

    expect(recordedInput?.senderEmail).toBe("mina@example.com");
    expect(recordedInput?.content).toEqual(expect.stringContaining("Source direction: received_by_user."));
    expect(recordedInput?.metadata).toEqual(expect.objectContaining({
      direction: "sent_by_user",
      sourceDirection: "received_by_user",
    }));
  });

  it("skips sources already retained in a previous Personal Intelligence run", async () => {
    const retainedDocumentIds: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    let recorderCalled = false;
    const recorder = {
      recordPersonalIntelligenceItem: async () => {
        recorderCalled = true;
        return { id: "doc_123", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds,
      skippedReasons,
      seenSources,
      sourceStore: {
        hasSource: async () => true,
        recordRetainedSource: async () => ({} as never),
      },
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      title: "Project update",
      timestamp: "",
      content: "important project context",
      reason: "Durable project context.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: false, skipped: true, reason: "duplicate_source_retained" });
    expect(recorderCalled).toBe(false);
    expect(retainedDocumentIds).toEqual([]);
    expect(skippedReasons).toEqual({ "gmail:gmail:email:user@example.com:email:msg_123": "duplicate_source_retained" });
  });

  it("does not mark a source duplicate in-run when the retain write fails", async () => {
    const retainedDocumentIds: string[] = [];
    const retainFailures: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    let calls = 0;
    const recorder = {
      recordPersonalIntelligenceItem: async () => {
        calls += 1;
        return calls === 1 ? null : { id: "doc_retry", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      retainedDocumentIds,
      retainFailures,
      skippedReasons,
      seenSources,
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
    });
    const candidate = {
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Alex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    };

    const failed = await retainTool.execute?.(candidate, { toolCallId: "call_1", messages: [] });
    const retried = await retainTool.execute?.(candidate, { toolCallId: "call_2", messages: [] });

    expect(failed).toEqual({ ok: false, skipped: true, reason: "retain_returned_empty" });
    expect(retried).toEqual({ ok: true, retainedDocumentId: "doc_retry" });
    expect(retainedDocumentIds).toEqual(["doc_retry"]);
    expect(retainFailures).toEqual([]);
    expect(skippedReasons).toEqual({});
  });

  it("recalls memory before retaining and skips exact source duplicates", async () => {
    const retainedDocumentIds: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    let recorderCalled = false;
    const recorder = {
      recordPersonalIntelligenceItem: async () => {
        recorderCalled = true;
        return { id: "doc_123", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      user: {
        tenantId: "tenant.test",
        userId: "usr_123",
        phoneNumber: "+10000000000",
        timezone: "UTC",
        timezoneSource: "server",
        kidsMode: false,
      },
      memory: createMemoryRuntimeService({
        client: {
          provider: "test",
          buildHotPathTurnCustomId: (id: string) => id,
          buildPatternRunCustomId: (id: string) => id,
          addDocument: async () => null,
          searchDocuments: async () => ({
            ok: true,
            results: [{
              documentId: "personal-intelligence_gmail_gmail_3Aemail_3Auser_40example.com_email_msg_123",
              title: "Lease renewal",
              summary: null,
              content: null,
              score: 1,
              createdAt: null,
              updatedAt: null,
              metadata: { accountScopeId: "gmail:email:user@example.com", sourceId: "msg_123" },
              chunks: [],
            }],
          }),
        },
        user: {
          tenantId: "tenant.test",
          userId: "usr_123",
          timezone: "UTC",
        },
      }),
      retainedDocumentIds,
      skippedReasons,
      seenSources,
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Alex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: false, skipped: true, reason: "duplicate_memory_recall", recall: "Lease renewal" });
    expect(recorderCalled).toBe(false);
    expect(retainedDocumentIds).toEqual([]);
    expect(skippedReasons).toEqual({ "gmail:gmail:email:user@example.com:email:msg_123": "duplicate_memory_recall" });
  });

  it("does not treat same source IDs from different account scopes as duplicate memory", async () => {
    const retainedDocumentIds: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    let recorderCalled = false;
    const recorder = {
      recordPersonalIntelligenceItem: async () => {
        recorderCalled = true;
        return { id: "doc_new", status: "queued" };
      },
    } as unknown as MemoryRecorder;
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder,
      user: {
        tenantId: "tenant.test",
        userId: "usr_123",
        phoneNumber: "+10000000000",
        timezone: "UTC",
        timezoneSource: "server",
        kidsMode: false,
      },
      memory: createMemoryRuntimeService({
        client: {
          provider: "test",
          buildHotPathTurnCustomId: (id: string) => id,
          buildPatternRunCustomId: (id: string) => id,
          addDocument: async () => null,
          searchDocuments: async () => ({
            ok: true,
            results: [{
              documentId: "personal-intelligence_gmail_gmail_3Aemail_3Aother_40example.com_email_msg_123",
              title: "Other account source",
              summary: null,
              content: null,
              score: 1,
              createdAt: null,
              updatedAt: null,
              metadata: { accountScopeId: "gmail:email:other@example.com", sourceId: "msg_123", messageId: "msg_123" },
              chunks: [],
            }],
          }),
        },
        user: {
          tenantId: "tenant.test",
          userId: "usr_123",
          timezone: "UTC",
        },
      }),
      retainedDocumentIds,
      skippedReasons,
      seenSources,
      allowedScopes: [{ toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_123", sourceType: "any-source", enforceSourceType: false }],
      sourceStore: {
        hasSource: async () => false,
        recordRetainedSource: async () => ({} as never),
      },
    });

    const result = await retainTool.execute?.({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      messageId: "msg_123",
      title: "Lease renewal",
      timestamp: "2026-05-12T12:00:00.000Z",
      content: "Alex needs the signed lease by Friday.",
      reason: "Durable active responsibility with a deadline.",
      recipientEmails: [],
      attendeeEmails: [],
      metadata: {},
    }, { toolCallId: "call_123", messages: [] });

    expect(result).toEqual({ ok: true, retainedDocumentId: "doc_new" });
    expect(recorderCalled).toBe(true);
    expect(retainedDocumentIds).toEqual(["doc_new"]);
    expect(skippedReasons).toEqual({});
  });
});

describe("personal intelligence connector gating", () => {
  it("uses every connected connector enabled for personal intelligence", () => {
    const configs = [
      { toolkitSlug: "gmail", connected: true, connectedAccountId: "acct_1", personalIntelligenceEnabled: true, personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "gmail:email:user@example.com" },
      { toolkitSlug: "slack", connected: true, connectedAccountId: "acct_2", personalIntelligenceEnabled: true, personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "slack:team:T1:user:U1" },
      { toolkitSlug: "outlook", connected: true, connectedAccountId: "acct_3", personalIntelligenceEnabled: false },
      { toolkitSlug: "googlecalendar", connected: false, connectedAccountId: "acct_4", personalIntelligenceEnabled: true },
    ];

    const enabled = getEnabledAutomationConnectors({
      configs: configs as never,
      feature: "personal_intelligence",
    });

    expect(enabled.map((config) => config.toolkitSlug)).toEqual(["gmail", "slack"]);
  });

  it("does not run Composio Personal Intelligence without a resolved account scope", async () => {
    const service = new PersonalIntelligenceService({
      config: { capabilities: { integrations: { memory: true } } },
      db: {},
      llmManager: {},
      users: {},
      composio: {},
    } as never);

    const result = await service.ingestConnector(makeTestUser(), {
      toolkitSlug: "gmail",
      connectedAccountId: "acct_gmail",
      personalIntelligenceEnabled: true,
      personalIntelligenceIdentityStatus: "pending",
    } as never);

    expect(result).toEqual({ runId: "", retainedDocumentIds: [] });
  });

  it("fans manual ingestion out per connector and can scope to one connector", async () => {
    const user: UserContext = {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+10000000000",
      timezone: "UTC",
      timezoneSource: "server",
      kidsMode: false,
    };
    const connectors = [
      { toolkitSlug: "gmail", connectedAccountId: "acct_gmail", personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "gmail:email:user@example.com" },
      { toolkitSlug: "linear", connectedAccountId: "acct_linear", personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "linear:org:org_1:user:usr_1" },
    ];
    const ingestedConnectors: string[] = [];
    const service = new PersonalIntelligenceService({
      config: { capabilities: { integrations: { memory: true } } },
      db: {},
      llmManager: {},
      users: {},
      composio: {},
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
      ingestConnector: (_user: UserContext, connector: { toolkitSlug: string }) => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => connectors;
    (service as never as {
      ingestConnector: (_user: UserContext, connector: { toolkitSlug: string }) => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).ingestConnector = async (_user, connector) => {
      ingestedConnectors.push(connector.toolkitSlug);
      return { runId: `arun_${connector.toolkitSlug}`, retainedDocumentIds: [`doc_${connector.toolkitSlug}`] };
    };

    const all = await service.ingestUser(user);
    const scoped = await service.ingestUser(user, { toolkitSlug: "gmail" });

    expect(all).toEqual({
      runId: "arun_gmail,arun_linear",
      retainedDocumentIds: ["doc_gmail", "doc_linear"],
    });
    expect(scoped).toEqual({
      runId: "arun_gmail",
      retainedDocumentIds: ["doc_gmail"],
    });
    expect(ingestedConnectors).toEqual(["gmail", "linear", "gmail"]);
  });

  it("scheduled ingestion runs at the configured local time for each enabled connector", async () => {
    const user: UserContext = {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+10000000000",
      timezone: "UTC",
      timezoneSource: "server",
      kidsMode: false,
    };
    const connectors = [
      { toolkitSlug: "gmail", connectedAccountId: "acct_gmail", personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "gmail:email:user@example.com" },
      { toolkitSlug: "linear", connectedAccountId: "acct_linear", personalIntelligenceIdentityStatus: "resolved", personalIntelligenceAccountScopeId: "linear:org:org_1:user:usr_1" },
    ];
    const ingestedConnectors: string[] = [];
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    };
    const service = new PersonalIntelligenceService({
      config: {
        capabilities: { integrations: { memory: true } },
        intervals: {
          personalIntelligenceRefreshTimes: [{ hour: 0, minute: 0 }],
          personalIntelligenceInitialBackfillMs: 30 * 86_400_000,
          personalIntelligenceOverlapMs: 6 * 60 * 60_000,
        },
        personalIntelligenceTimeoutMs: 30 * 60_000,
      },
      db,
      llmManager: {},
      users: { listExistingUsers: async () => [user] },
      composio: {},
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
      ingestConnector: (_user: UserContext, connector: { toolkitSlug: string }) => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => connectors;
    (service as never as {
      ingestConnector: (_user: UserContext, connector: { toolkitSlug: string }) => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).ingestConnector = async (_user, connector) => {
      ingestedConnectors.push(connector.toolkitSlug);
      return { runId: `arun_${connector.toolkitSlug}`, retainedDocumentIds: [`doc_${connector.toolkitSlug}`] };
    };

    await service.ingestDueUsers(new Date("2026-05-15T00:00:00.000Z"));

    expect(ingestedConnectors).toEqual(["gmail", "linear"]);
  });

  it("uses the matched refresh slot as scheduledAt for due connector jobs", async () => {
    const user: UserContext = {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+10000000000",
      timezone: "UTC",
      timezoneSource: "server",
      kidsMode: false,
    };
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    };
    const service = new PersonalIntelligenceService({
      config: {
        capabilities: { integrations: { memory: true } },
        intervals: {
          personalIntelligenceRefreshTimes: [{ hour: 0, minute: 0 }],
          personalIntelligenceInitialBackfillMs: 30 * 86_400_000,
          personalIntelligenceOverlapMs: 6 * 60 * 60_000,
        },
        personalIntelligenceTimeoutMs: 30 * 60_000,
      },
      db,
      llmManager: {},
      users: { listExistingUsers: async () => [user] },
      composio: {},
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "gmail",
      personalIntelligenceIdentityStatus: "resolved",
      personalIntelligenceAccountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_gmail",
    }];

    const jobs = await service.listDueConnectorJobs(new Date("2026-05-15T00:05:00.000Z"));

    expect(jobs).toEqual([expect.objectContaining({
      scheduledAt: "2026-05-15T00:00:00.000Z",
      accountScopeId: "gmail:email:user@example.com",
      jobKey: "finn:personal-intelligence:tenant_test:usr_test:gmail:gmail:email:user@example.com:2026-05-15",
    })]);
  });

  it("keeps Puter due when a completed run missed a newly enabled local source", async () => {
    const user = makeTestUser();
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      ...makeRunLookupDb(true, ["puter.notes"]),
    };
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db,
      llmManager: {},
      users: { listExistingUsers: async () => [user] },
      puterBridge: {
        getStatus: () => puterBridgeOnlineStatus(),
      },
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      enabledTools: ["puter.imessage.personal_intelligence", "puter.notes.personal_intelligence"],
    }];

    const jobs = await service.listDueConnectorJobs(new Date("2026-05-15T00:05:00.000Z"));

    expect(jobs).toEqual([expect.objectContaining({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
    })]);
  });

  it("discovers Puter Personal Intelligence without a Composio runtime", async () => {
    const user = makeTestUser();
    const getComposioService = async () => undefined;
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db: makeConnectorLookupDb(makePuterPersonalIntelligenceConnector()),
      llmManager: {},
      users: { listExistingUsers: async () => [user] },
      runtimes: { getComposioService },
      puterBridge: {
        getStatus: () => puterBridgeOnlineStatus(),
      },
    } as never);

    const jobs = await service.listDueConnectorJobs(new Date("2026-05-15T00:05:00.000Z"));

    expect(jobs).toEqual([expect.objectContaining({
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      scheduledAt: "2026-05-15T00:00:00.000Z",
    })]);
  });

  it("uses the previous local date when a late-day refresh slot is caught after midnight", async () => {
    const user: UserContext = {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+10000000000",
      timezone: "UTC",
      timezoneSource: "server",
      kidsMode: false,
    };
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    };
    const service = new PersonalIntelligenceService({
      config: {
        capabilities: { integrations: { memory: true } },
        intervals: {
          personalIntelligenceRefreshTimes: [{ hour: 23, minute: 59 }],
          personalIntelligenceInitialBackfillMs: 30 * 86_400_000,
          personalIntelligenceOverlapMs: 6 * 60 * 60_000,
        },
        personalIntelligenceTimeoutMs: 30 * 60_000,
      },
      db,
      llmManager: {},
      users: { listExistingUsers: async () => [user] },
      composio: {},
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "gmail",
      personalIntelligenceIdentityStatus: "resolved",
      personalIntelligenceAccountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_gmail",
    }];

    const jobs = await service.listDueConnectorJobs(new Date("2026-05-16T00:05:00.000Z"));

    expect(jobs).toEqual([expect.objectContaining({
      scheduledAt: "2026-05-15T23:59:00.000Z",
      accountScopeId: "gmail:email:user@example.com",
      jobKey: "finn:personal-intelligence:tenant_test:usr_test:gmail:gmail:email:user@example.com:2026-05-15",
    })]);
  });

  it("defers missed Puter Personal Intelligence until the Mac comes online", async () => {
    const user = makeTestUser();
    const ingested: Array<{ toolkitSlug: string; now: Date | undefined }> = [];
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db: makeRunLookupDb(false),
      llmManager: {},
      users: {},
      composio: {},
      puterBridge: {
        getStatus: () => puterBridgeOnlineStatus(),
      },
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
      ingestPuterLive: (_user: UserContext, options: { now?: Date; toolsets?: Iterable<string> }) => Promise<{ runId: string; retainedDocumentIds: string[]; active: boolean }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      personalIntelligenceEnabled: true,
      enabledTools: ["puter.imessage.personal_intelligence"],
    }];
    (service as never as {
      ingestPuterLive: (_user: UserContext, options: { now?: Date }) => Promise<{ runId: string; retainedDocumentIds: string[]; active: boolean }>;
    }).ingestPuterLive = async (_user, options) => {
      ingested.push({ toolkitSlug: "puter", now: options.now });
      return { runId: "arun_puter", retainedDocumentIds: ["doc_puter"], active: true };
    };

    const result = await service.ingestDeferredPuterIfDue(user, {
      deviceId: "mac",
      now: new Date("2026-05-17T11:00:00.000Z"),
    });

    expect(result).toEqual({
      runId: "arun_puter",
      retainedDocumentIds: ["doc_puter"],
      scheduledAt: "2026-05-17T00:00:00.000Z",
    });
    expect(ingested).toEqual([{
      toolkitSlug: "puter",
      now: new Date("2026-05-17T11:00:00.000Z"),
    }]);
  });

  it("does not run deferred Puter Personal Intelligence again when the current refresh window is complete", async () => {
    const user = makeTestUser();
    let ingested = false;
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db: makeRunLookupDb(true, ["puter.notes"]),
      llmManager: {},
      users: {},
      composio: {},
      puterBridge: {
        getStatus: () => puterBridgeOnlineStatus(),
      },
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
      ingestConnector: () => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      personalIntelligenceEnabled: true,
      enabledTools: ["puter.notes.personal_intelligence"],
    }];
    (service as never as {
      ingestConnector: () => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).ingestConnector = async () => {
      ingested = true;
      return { runId: "arun_puter", retainedDocumentIds: [] };
    };

    const result = await service.ingestDeferredPuterIfDue(user, {
      deviceId: "mac",
      now: new Date("2026-05-17T11:00:00.000Z"),
    });

    expect(result).toBeNull();
    expect(ingested).toBe(false);
  });

  it("does not run deferred Puter Personal Intelligence while the Mac is offline", async () => {
    const user = makeTestUser();
    let ingested = false;
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db: makeRunLookupDb(false),
      llmManager: {},
      users: {},
      composio: {},
      puterBridge: {
        getStatus: () => ({ active: false, lastSeenAt: null, access: null }),
      },
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<unknown[]>;
      ingestConnector: () => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      personalIntelligenceEnabled: true,
      enabledTools: ["puter.notes.personal_intelligence"],
    }];
    (service as never as {
      ingestConnector: () => Promise<{ runId: string; retainedDocumentIds: string[] }>;
    }).ingestConnector = async () => {
      ingested = true;
      return { runId: "arun_puter", retainedDocumentIds: [] };
    };

    const result = await service.ingestDeferredPuterIfDue(user, {
      deviceId: "mac",
      now: new Date("2026-05-17T11:00:00.000Z"),
    });

    expect(result).toBeNull();
    expect(ingested).toBe(false);
  });

  it("runs deferred Puter Personal Intelligence when newly enabled local sources were not covered", async () => {
    const user = makeTestUser();
    const ingestedToolsets: string[][] = [];
    const service = new PersonalIntelligenceService({
      config: makePersonalIntelligenceConfig(),
      db: makeRunLookupDb(true, ["puter.imessage"]),
      llmManager: {},
      users: {},
      composio: {},
      puterBridge: {
        getStatus: () => puterBridgeOnlineStatus(),
      },
    } as never);
    (service as never as {
      getEnabledPersonalIntelligenceConnectors: () => Promise<Array<{ toolkitSlug: string; connectedAccountId: string; enabledTools: string[] }>>;
      ingestPuterLive: (_user: UserContext, options: { toolsets?: Iterable<string> }) => Promise<{ runId: string; retainedDocumentIds: string[]; active: boolean }>;
    }).getEnabledPersonalIntelligenceConnectors = async () => [{
      toolkitSlug: "puter",
      connectedAccountId: "puter:mac",
      enabledTools: ["puter.imessage.personal_intelligence", "puter.notes.personal_intelligence"],
    }];
    (service as never as {
      ingestPuterLive: (_user: UserContext, options: { toolsets?: Iterable<string> }) => Promise<{ runId: string; retainedDocumentIds: string[]; active: boolean }>;
    }).ingestPuterLive = async (_user, options) => {
      ingestedToolsets.push([...(options.toolsets ?? [])]);
      return { runId: "arun_puter", retainedDocumentIds: [], active: true };
    };

    const result = await service.ingestDeferredPuterIfDue(user, {
      deviceId: "mac",
      now: new Date("2026-05-17T11:00:00.000Z"),
    });

    expect(result?.runId).toBe("arun_puter");
    expect(ingestedToolsets).toEqual([["puter.notes"]]);
  });
});

describe("personal intelligence scheduler gating", () => {
  it("runs within the scheduler window after a configured local refresh time", () => {
    const refreshTimes = [{ hour: 0, minute: 0 }];

    expect(shouldRunPersonalIntelligenceNow({
      now: new Date("2026-05-15T00:00:00.000Z"),
      timezone: "UTC",
      refreshTimes,
    })).toBe(true);
    expect(shouldRunPersonalIntelligenceNow({
      now: new Date("2026-05-15T00:09:59.000Z"),
      timezone: "UTC",
      refreshTimes,
    })).toBe(true);
    expect(shouldRunPersonalIntelligenceNow({
      now: new Date("2026-05-15T00:10:00.000Z"),
      timezone: "UTC",
      refreshTimes,
    })).toBe(false);
  });

  it("uses each user's local timezone for refresh matching", () => {
    expect(shouldRunPersonalIntelligenceNow({
      now: new Date("2026-05-15T14:00:00.000Z"),
      timezone: "Australia/Sydney",
      refreshTimes: [{ hour: 0, minute: 0 }],
    })).toBe(true);
    expect(shouldRunPersonalIntelligenceNow({
      now: new Date("2026-05-15T14:00:00.000Z"),
      timezone: "UTC",
      refreshTimes: [{ hour: 0, minute: 0 }],
    })).toBe(false);
  });

  it("dedupes scheduled runs from the start of the user's local day", () => {
    expect(getPersonalIntelligenceScheduleDayStartForTest(
      new Date("2026-05-15T12:30:00.000Z"),
      "UTC",
    )).toEqual(new Date("2026-05-15T00:00:00.000Z"));
    expect(getPersonalIntelligenceScheduleDayStartForTest(
      new Date("2026-05-15T14:00:00.000Z"),
      "Australia/Sydney",
    )).toEqual(new Date("2026-05-15T14:00:00.000Z"));
  });

  it("resolves the most recent refresh slot for deferred Puter runs", () => {
    expect(getDeferredPersonalIntelligenceRefreshSlotForTest({
      now: new Date("2026-05-17T11:00:00.000Z"),
      timezone: "UTC",
      refreshTimes: [{ hour: 0, minute: 0 }],
    })).toEqual(new Date("2026-05-17T00:00:00.000Z"));
    expect(getDeferredPersonalIntelligenceRefreshSlotForTest({
      now: new Date("2026-05-17T11:00:00.000Z"),
      timezone: "UTC",
      refreshTimes: [{ hour: 17, minute: 0 }],
    })).toEqual(new Date("2026-05-16T17:00:00.000Z"));
  });
});

describe("personal intelligence checkpoints", () => {
  it("builds connector-agnostic checkpoint scopes for enabled accounts", () => {
    const scopes = buildPersonalIntelligenceCheckpointScopesForTest([
      { toolkitSlug: "Gmail", connectedAccountId: "acct_1" },
      { toolkitSlug: "linear", connectedAccountId: "acct_2", personalIntelligenceAccountScopeId: "linear:org:org_1:user:usr_1" },
      {
        toolkitSlug: "puter",
        connectedAccountId: "puter:mac",
        enabledTools: ["puter.imessage.personal_intelligence", "puter.notes.personal_intelligence"],
      },
      { toolkitSlug: "slack", connectedAccountId: null },
    ] as never);

    expect(scopes).toEqual([
      { toolkitSlug: "linear", accountScopeId: "linear:org:org_1:user:usr_1", connectedAccountId: "acct_2", sourceType: "records" },
      { toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "imessage" },
      { toolkitSlug: "puter", accountScopeId: "puter:local", connectedAccountId: "puter:mac", sourceType: "notes" },
    ]);
  });

  it("persists the run handoff across every enabled checkpoint scope", () => {
    const runPlan = makeRunPlan();
    const selection: PersonalIntelligenceRunSelection = {
      status: "completed",
      retainedDocumentIds: ["doc_1", "doc_2"],
      retainFailures: [],
      skippedReasons: { "gmail:acct_1:email:msg_3": "duplicate_source_retained" },
      summary: "Retained relationship and project context.",
      checkpoint: {
        summary: "Looked at recent source records and explored Alex plus Project Falcon.",
        coverageEnd: new Date("2026-05-15T12:00:00.000Z"),
        lastProcessedSourceTimestamp: new Date("2026-05-15T11:55:00.000Z"),
        sourceCursor: null,
        exploredEntities: [{ label: "Alex", kind: "person", reason: "repeated collaborator" }],
        knownGaps: [],
      },
    };

    const updates = buildPersonalIntelligenceCheckpointUpdatesForTest({
      connectors: [
        { toolkitSlug: "gmail", connectedAccountId: "acct_1", personalIntelligenceAccountScopeId: "gmail:email:user@example.com" },
        { toolkitSlug: "linear", connectedAccountId: "acct_2", personalIntelligenceAccountScopeId: "linear:org:org_1:user:usr_1" },
      ] as never,
      runPlan,
      runId: "arun_123",
      selection,
    });

    expect(updates).toEqual([
      expect.objectContaining({
        toolkitSlug: "gmail",
        accountScopeId: "gmail:email:user@example.com",
        connectedAccountId: "acct_1",
        sourceType: "records",
        coverageStart: runPlan.windowStart,
        coverageEnd: new Date("2026-05-15T12:00:00.000Z"),
        lastProcessedSourceTimestamp: new Date("2026-05-15T11:55:00.000Z"),
        handoffSummary: "Looked at recent source records and explored Alex plus Project Falcon.",
        lastExploredEntities: [{ label: "Alex", kind: "person", reason: "repeated collaborator" }],
        metadata: { mode: "initial_backfill", retainedCount: 2, skippedCount: 1 },
      }),
      expect.objectContaining({
        toolkitSlug: "linear",
        accountScopeId: "linear:org:org_1:user:usr_1",
        connectedAccountId: "acct_2",
        sourceType: "records",
      }),
    ]);
  });

  it("falls back to window-end coverage when the model does not record a checkpoint", () => {
    const runPlan = makeRunPlan();
    const checkpoint = buildPersonalIntelligenceFallbackCheckpointForTest({
      summary: "",
      runPlan,
      retainedDocumentIds: ["doc_1"],
      skippedReasons: {},
    });

    expect(checkpoint).toEqual({
      summary: "Inspected initial_backfill window and retained 1 item.",
      coverageEnd: runPlan.windowEnd,
      lastProcessedSourceTimestamp: runPlan.windowEnd,
      sourceCursor: null,
      exploredEntities: [],
      knownGaps: [],
    });
  });
});

describe("personal intelligence prompt", () => {
  it("treats life context and active project context as durable intelligence without app-specific rules", () => {
    const prompt = buildPersonalIntelligenceSystemPromptForTest();

    expect(prompt).toContain("Personal Intelligence is for understanding the user's life and context, not task execution");
    expect(prompt).toContain("Use connector-native categories instead of hardcoded domain keywords");
    expect(prompt).toContain("retain as you go");
    expect(prompt).toContain("classify the relationship strength from evidence");
    expect(prompt).toContain("service provider, vendor, organization, colleague, incidental sender, or unknown");
    expect(prompt).toContain("When an email or message is interesting enough to inspect and it has attachments, inspect readable attachments too");
    expect(prompt).toContain("Use the listed image/document files APIs");
    expect(prompt).toContain("use the listed finn.files.extract API on attachment URLs or downloaded paths");
    expect(prompt).toContain("Treat Patterns, My Day todos, reminders, run history, and other Finn operational records as runtime state");
    expect(prompt).toContain("Do not stop after the first page of a broad query");
    expect(prompt).toContain("active work/project context");
    expect(prompt).toContain("project, initiative, cluster of related records, or stable workstream");
    expect(prompt).toContain("Do not dismiss work records solely because their individual tickets/tasks are complete or sprint-sized");
    expect(prompt).toContain("do not skip whole workstreams or source categories just because they look secondary");
    expect(prompt).toContain("Stay connector-agnostic");
    expect(prompt).toContain("Finn JS workspace tools are generic framework tools, not Personal Intelligence-specific tools");
    expect(prompt).toContain("use workspace_search to inspect API names and input shapes");
    expect(prompt).not.toContain("Secure Exec");
    expect(prompt).not.toContain("not a shell");
    expect(prompt).toContain("For Puter, iMessage and Notes are separate namespaces");
    expect(prompt).toContain("disabled sources must not be assumed or requested");
    expect(prompt).toContain("Exploration loop");
    expect(prompt).toContain("finish_personal_intelligence_run");
    expect(prompt).toContain("Relationship intelligence is a first-class PI goal");
    expect(prompt).toContain("repeated direct-address patterns");
    expect(prompt).toContain("evidence-backed relationship/context summary");
    expect(prompt).toContain("The retain tool performs an additional source-aware memory search before writing");
    expect(prompt).not.toContain("TOOL.md");
    expect(prompt).toContain("For mailbox/message sources, state the direction explicitly");
    expect(prompt).toContain("Do not infer family roles from school invoices, forwarded bills, claim documents, or shared household admin");
    expect(prompt).not.toContain("WorkCover");
    expect(prompt).not.toContain("Linear");
  });
});

function makeTestUser(): UserContext {
  return {
    tenantId: "tenant_test",
    userId: "usr_test",
    phoneNumber: "+10000000000",
    timezone: "UTC",
    timezoneSource: "server",
    kidsMode: false,
  };
}

function makePuterPersonalIntelligenceConnector(): UserConnectorConfig {
  const now = new Date("2026-05-14T00:00:00.000Z");
  return {
    id: "ucc_puter",
    tenantId: "tenant_test",
    userId: "usr_test",
    toolkitSlug: "puter",
    toolkitName: "Puter",
    connected: true,
    connectedAccountId: "puter:mac",
    connectionStatus: "connected",
    permissionMode: "read_only",
    myDayEnabled: false,
    personalIntelligenceEnabled: true,
    enabledTools: ["puter.imessage.personal_intelligence"],
    lastNotifiedConnectedAccountId: "puter:mac",
    createdAt: now,
    updatedAt: now,
  };
}

function makePersonalIntelligenceConfig() {
  return {
    capabilities: { integrations: { memory: true } },
    intervals: {
      personalIntelligenceRefreshTimes: [{ hour: 0, minute: 0 }],
      personalIntelligenceInitialBackfillMs: 30 * 86_400_000,
      personalIntelligenceOverlapMs: 6 * 60 * 60_000,
    },
    personalIntelligenceTimeoutMs: 30 * 60_000,
  };
}

function makeConnectorLookupDb(connector: UserConnectorConfig | null) {
  let selectCount = 0;
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          selectCount += 1;
          const rows = selectCount === 1 && connector ? [connector] : [];
          const promise = Promise.resolve(rows);
          return {
            limit: async () => rows,
            orderBy: () => ({
              limit: async () => rows,
            }),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          };
        },
      }),
    }),
  };
}

function makeRunLookupDb(hasCompletedRun: boolean, enabledLocalSources: string[] = []) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => hasCompletedRun ? [{
              id: "arun_done",
              contributorStatus: { enabledLocalSources },
            }] : [],
          }),
        }),
      }),
    }),
  };
}

function puterBridgeOnlineStatus() {
  return {
    active: true,
    lastSeenAt: "2026-05-17T11:00:00.000Z",
    access: {
      imessage: { granted: true, message: "iMessage access is ready." },
      contacts: { granted: true, message: "Contacts access is ready." },
      notes: { granted: true, message: "Notes access is ready." },
    },
  };
}

function makeRunPlan(): PersonalIntelligenceRunPlan {
  return {
    windowStart: new Date("2026-03-16T12:00:00.000Z"),
    windowEnd: new Date("2026-05-15T12:00:00.000Z"),
    mode: "initial_backfill",
    checkpoints: [],
    checkpointScopes: [],
    previousCoverageEnd: null,
  };
}
