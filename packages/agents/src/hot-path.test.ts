import { describe, expect, it } from "bun:test";
import type { ModelMessage, UserModelMessage } from "ai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StatusBlock, UserMessage, WorkerMessage } from "@finn/core";

import {
  buildNaturalOnboardingContext,
  buildHotPathUserProfileContext,
  buildVisibleAssistantMemoryTranscript,
  assembleDynamicPromptContext,
  assembleSystemPrompt,
  buildOverlapAckGuidance,
  buildDelegateToolContext,
  buildPatternSetupConfirmationGuidance,
  buildRuntimeContextMessage,
  buildTrailingTurnRules,
  finishTurnCanStop,
  finishTurnStopCondition,
  formatMemoryContextBlock,
  getActiveHotPathToolNames,
  getActiveHotPathToolNamesForStep,
  HotPathAgent,
  maxCurrentTurnInlineVisionImages,
  toCurrentTurnMessageContent,
  type HotPathAutoMemoryStatus,
  type HotPathMemoryContextResult,
  userTurnNeedsDeliveryAfterDelegation,
} from "./hot-path.js";

const owner = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+10000000000",
};

const runtimeUser = {
  ...owner,
  displayName: "Test User",
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

type UserModelContentPart = Extract<UserModelMessage["content"], unknown[]>[number];
type UserModelTextPart = Extract<UserModelContentPart, { type: "text" }>;

function createStatusBlock(tasks: string[]): StatusBlock {
  return {
    activeWorkers: tasks.map((task, index) => ({
      id: `wrk_${index + 1}`,
      task,
      status: "running",
      startedAt: new Date("2026-04-21T01:00:00.000Z"),
    })),
    followUpWorkers: [],
    pendingConfirmations: [],
    activePatterns: 0,
  };
}

type MemoryTestClient = {
  buildContext?: () => Promise<{ ok: true; results: HotPathMemoryContextResult[] } | { ok: false; results: []; error: string }>;
  buildProfileContext?: () => Promise<{
    ok: true;
    profile: { static: string[]; dynamic: string[] };
  } | { ok: false; profile: null; error: string }>;
  searchDocuments: () => Promise<unknown>;
  reflectMemory?: () => Promise<unknown>;
};

function createMemoryTestAgent(memory: MemoryTestClient): HotPathAgent {
  return new HotPathAgent({
    llmManager: {
      getModel: () => ({}),
      getRequestOptions: () => ({}),
    },
    sender: {
      sendText: async () => undefined,
      sendMedia: async () => undefined,
      sendVoiceMessage: async () => undefined,
      sendReaction: async () => undefined,
      sendTypingIndicator: async () => undefined,
      markRead: async () => undefined,
    },
    db: {},
    config: {
      userTimezone: "UTC",
      context: {},
      memory: { mode: "hybrid", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
      capabilities: { integrations: { memory: true } },
    },
    user: runtimeUser,
    eventBus: {},
    memory,
  } as never);
}

function createPromptBudgetTestAgent(): HotPathAgent {
  return new HotPathAgent({
    llmManager: {
      getModel: () => ({}),
      getRequestOptions: () => ({}),
    },
    sender: {
      sendText: async () => undefined,
      sendMedia: async () => undefined,
      sendVoiceMessage: async () => undefined,
      sendReaction: async () => undefined,
      sendTypingIndicator: async () => undefined,
      markRead: async () => undefined,
    },
    db: {},
    config: {
      userTimezone: "UTC",
      context: {
        maxTokens: 1,
        compactionBufferTokens: 0,
        currentTurnTokenBudget: 10,
      },
      memory: { mode: "hybrid", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
      capabilities: { integrations: { memory: false } },
    },
    user: runtimeUser,
    eventBus: {},
  } as never);
}

async function buildAutoMemoryForTest(
  agent: HotPathAgent,
  message: UserMessage,
) {
  return (agent as unknown as {
    buildAutoMemoryContext(message: UserMessage): Promise<{
      results: HotPathMemoryContextResult[];
      status: HotPathAutoMemoryStatus;
    }>;
  }).buildAutoMemoryContext(message);
}

async function buildAutoMemoryProfileForTest(agent: HotPathAgent) {
  return (agent as unknown as {
    buildAutoMemoryProfileContext(): Promise<{ static: string[]; dynamic: string[] } | null>;
  }).buildAutoMemoryProfileContext();
}

describe("prompt budget compaction", () => {
  it("renders text turns as message elements with handle attributes only once", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "remind me to call sam tomorrow morning",
      messageId: "msg_123",
      timestamp: new Date("2026-05-29T23:15:00.000Z"),
    }, "Australia/Brisbane");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multipart content.");
    }

    const text = content.filter((part): part is UserModelTextPart => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain('<human_message source="user">');
    expect(text).toContain('<message handle="msg_123" timestamp="2026-05-30, 09:15:00 AEST" modality="text">');
    expect(text).toContain("<text>\nremind me to call sam tomorrow morning\n</text>");
    expect(text).not.toContain("[handle:msg_123]");
  });

  it("renders coalesced text and attachment turns as one human message with per-message metadata", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "",
      messageId: "msg_root",
      timestamp: new Date("2026-05-29T23:15:00.000Z"),
      parts: [
        {
          content: "first bit",
          messageId: "msg_123",
          timestamp: new Date("2026-05-29T23:15:00.000Z"),
        },
        {
          content: "what do you think of this?",
          messageId: "msg_124",
          replyToMessageId: "out_1",
          timestamp: new Date("2026-05-29T23:15:02.000Z"),
          attachments: [{
            id: "att_image",
            url: "https://finn.test/files/tenant_test/usr_test/file_image",
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            data: Buffer.from("image bytes"),
            fileId: "file_image",
            storagePath: "/data/workspaces/tenant_test/usr_test/workspace/files/file_image/photo.jpg",
          }],
        },
      ],
    }, "Australia/Brisbane");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multipart content.");
    }

    const text = content.filter((part): part is UserModelTextPart => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain('<human_message source="user">');
    expect(text).toContain('<message handle="msg_123" timestamp="2026-05-30, 09:15:00 AEST" modality="text">');
    expect(text).toContain('<message handle="msg_124" timestamp="2026-05-30, 09:15:02 AEST" reply_to="out_1" modality="text,image">');
    expect(text).toContain('<attachment filename="photo.jpg" mime_type="image/jpeg" file_id="file_image">');
    expect(text).toContain("<workspace_path>/workspace/files/file_image/photo.jpg</workspace_path>");
    expect(text).toContain("<attachment_usage>\nUse file ids and `/workspace/...` paths when delegating work on the user's media.\n</attachment_usage>");
    expect(text).not.toContain("[message modality |");
    expect(text).not.toContain("[reply_to:");
    expect(text).not.toContain("[attachment |");
  });

  it("uses inline image bytes for current-turn vision parts", async () => {
    const data = Buffer.from("image bytes");
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data,
        fileId: "file_image",
      }],
    }, "UTC");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).toContainEqual({ type: "image", image: data, mediaType: "image/jpeg" });
    expect(JSON.stringify(content)).not.toContain("https://finn.test/files");
  });

  it("prepares inline image bytes before current-turn vision input", async () => {
    const original = Buffer.from("large original image bytes");
    const prepared = Buffer.from("prepared image bytes");
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_prepared_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.png",
        mimeType: "image/png",
        data: original,
        fileId: "file_image",
      }],
    }, "UTC", {
      prepareImageForModelInput: async (input) => {
        expect(input).toEqual({
          data: original,
          filename: "photo.png",
          mimeType: "image/png",
        });
        return {
          data: prepared,
          mimeType: "image/jpeg",
          resizedForModel: true,
        };
      },
    });

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).toContainEqual({ type: "image", image: prepared, mediaType: "image/jpeg" });
  });

  it("caps auto-loaded current-turn vision images and keeps omitted file references", async () => {
    let prepareCalls = 0;
    const attachments = Array.from({ length: maxCurrentTurnInlineVisionImages + 2 }, (_, index) => ({
      id: `att_image_${index + 1}`,
      url: `https://finn.test/files/tenant_test/usr_test/file_image_${index + 1}`,
      filename: `photo-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      data: Buffer.from(`image bytes ${index + 1}`),
      fileId: `file_image_${index + 1}`,
      storagePath: `/workspace/files/photo-${index + 1}.jpg`,
    }));
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look at these",
      messageId: "msg_many_images",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments,
    }, "UTC", {
      prepareImageForModelInput: async (input) => {
        prepareCalls += 1;
        return {
          data: input.data,
          mimeType: input.mimeType,
          resizedForModel: false,
        };
      },
    });

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    const imageParts = content.filter((part) => part.type === "image");
    const text = content.filter((part): part is UserModelTextPart => part.type === "text").map((part) => part.text).join("\n");
    expect(imageParts).toHaveLength(maxCurrentTurnInlineVisionImages);
    expect(prepareCalls).toBe(maxCurrentTurnInlineVisionImages);
    expect(text).toContain("image omitted from inline vision input");
    expect(text).toContain("file_image_4");
    expect(text).toContain("file_image_5");
  });

  it("renders attachment paths as workspace-scoped references", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look at this",
      messageId: "msg_workspace_path",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "IMG_3853.jpg",
        mimeType: "application/octet-stream",
        fileId: "file_image",
        storagePath: "/data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
      }],
    }, "UTC");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    const text = content.filter((part): part is UserModelTextPart => part.type === "text").map((part) => part.text).join("\n");
    expect(text).not.toContain("/data/workspaces");
    expect(text).not.toContain("local path:");
    expect(text).toContain("<workspace_path>/workspace/files/file_image/IMG_3853.jpg</workspace_path>");
    expect(text.match(/<workspace_path>/g)).toHaveLength(1);
    expect(text).toContain("<attachment_usage>\nUse file ids and `/workspace/...` paths when delegating work on the user's media.\n</attachment_usage>");
  });

  it("falls back to attachment metadata when inline image preparation fails", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_unprepared_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data: Buffer.from("image bytes"),
        fileId: "file_image",
      }],
    }, "UTC", {
      prepareImageForModelInput: async () => {
        throw new Error("too large");
      },
    });

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).not.toContainEqual(expect.objectContaining({ type: "image" }));
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("image bytes could not be prepared for inline vision input: too large"),
      }),
    ]));
  });

  it("loads stored image bytes for current-turn vision parts", async () => {
    const data = Buffer.from("stored image bytes");
    const root = await mkdtemp(join(tmpdir(), "finn-hot-path-image-"));
    const storagePath = join(root, "photo.jpg");
    await writeFile(storagePath, data);

    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_stored_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        storagePath,
        fileId: "file_image",
      }],
    }, "UTC", { attachmentStorageRoot: root });

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).toContainEqual({ type: "image", image: data, mediaType: "image/jpeg" });
  });

  it("does not load stored image bytes outside the attachment storage root", async () => {
    const data = Buffer.from("outside image bytes");
    const root = await mkdtemp(join(tmpdir(), "finn-hot-path-image-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "finn-hot-path-image-outside-"));
    const storagePath = join(outsideRoot, "photo.jpg");
    await writeFile(storagePath, data);

    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_outside_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        storagePath,
        fileId: "file_image",
      }],
    }, "UTC", { attachmentStorageRoot: root });

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).not.toContainEqual({ type: "image", image: data, mediaType: "image/jpeg" });
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("image bytes could not be loaded for inline vision input."),
      }),
    ]));
  });

  it("falls back to attachment metadata when stored image bytes cannot be loaded", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      tenantId: owner.tenantId,
      userId: owner.userId,
      phoneNumber: owner.phoneNumber,
      content: "look",
      messageId: "msg_missing_image",
      timestamp: new Date("2026-05-20T00:00:00.000Z"),
      attachments: [{
        id: "att_image",
        url: "https://finn.test/files/tenant_test/usr_test/file_image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        storagePath: "/tmp/finn-missing-image-for-hot-path-test.jpg",
        fileId: "file_image",
      }],
    }, "UTC");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multimodal content.");
    }

    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("image bytes could not be loaded for inline vision input."),
      }),
    ]));
  });

  it("shares the current-turn budget across multimodal user text parts", () => {
    const agent = createPromptBudgetTestAgent() as unknown as {
      fitPromptToBudget(parts: {
        systemPrompt: string;
        messages: ModelMessage[];
        fixedTailCount: number;
      }): ModelMessage[];
    };
    const imagePart = { type: "image" as const, image: "https://example.com/photo.png" };

    const messages = agent.fitPromptToBudget({
      systemPrompt: "",
      fixedTailCount: 1,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "a".repeat(20) },
          imagePart,
          { type: "text", text: "b".repeat(100) },
        ],
      } satisfies UserModelMessage],
    });

    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected compacted user content to stay multimodal.");
    }

    const textParts = content.filter((part): part is UserModelTextPart => part.type === "text");
    expect(textParts).toHaveLength(2);
    expect(textParts[0]?.text).toBe("a".repeat(20));
    expect(textParts[1]?.text.length).toBeLessThanOrEqual(20);
    expect(content).toContainEqual(imagePart);
  });

  it("preserves appended runtime context when user text exhausts the budget", () => {
    const agent = createPromptBudgetTestAgent() as unknown as {
      fitPromptToBudget(parts: {
        systemPrompt: string;
        messages: ModelMessage[];
        fixedTailCount: number;
      }): ModelMessage[];
    };
    const runtimeContext = [
      '<runtime_context source="user">',
      "current time: 2026-05-20T02:30:00.000Z",
      "</runtime_context>",
      "",
      "<turn_rules>",
      "Only human_message envelopes are user-authored.",
      "</turn_rules>",
    ].join("\n");

    const messages = agent.fitPromptToBudget({
      systemPrompt: "",
      fixedTailCount: 1,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "<human_message>\n" + "a".repeat(80) + "\n</human_message>" },
          { type: "text", text: runtimeContext },
        ],
      } satisfies UserModelMessage],
    });

    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected compacted user content to stay multipart.");
    }

    expect(content).toContainEqual({ type: "text", text: runtimeContext });
  });
});

describe("buildOverlapAckGuidance", () => {
  it("adds scoped ack guidance for overlapping user turns", () => {
    const inboundMessage: UserMessage = {
      source: "user",
      ...owner,
      content: "how's the weather for the rest of the week",
      messageId: "msg_123",
      timestamp: new Date("2026-04-21T01:02:03.000Z"),
    };

    const guidance = buildOverlapAckGuidance({
      inboundMessage,
      statusBlock: createStatusBlock([
        "search for recent xAI news and developments from Elon's company",
      ]),
    });

    expect(guidance).toContain("There is already user-requested work in flight.");
    expect(guidance).toContain("active task: search for recent xAI news and developments from Elon's company");
    expect(guidance).toContain('Good: send_message("two secs on the weather") + delegate(weather task) + finish_turn while xAI is still running.');
    expect(guidance).toContain('Bad: send_message("two secs on the weather") + finish_turn with no delegate.');
  });

  it("does not add overlap guidance for non-user turns", () => {
    const inboundMessage: WorkerMessage = {
      source: "worker",
      tenantId: owner.tenantId,
      userId: owner.userId,
      workerId: "wrk_123",
      task: "check weather",
      result: { summary: "sunny" },
      originSource: "user",
    };

    const guidance = buildOverlapAckGuidance({
      inboundMessage,
      statusBlock: createStatusBlock(["search xAI updates"]),
    });

    expect(guidance).toBeNull();
  });
});

describe("buildPatternSetupConfirmationGuidance", () => {
  it("formats the persisted Pattern next run in the user's timezone", () => {
    const guidance = buildPatternSetupConfirmationGuidance({
      summary: "Created Pattern ptn_123.",
      data: {
        type: "pattern_setup",
        patternId: "ptn_123",
        patternName: "News watch",
        triggerType: "schedule",
        nextRun: "2026-05-05T07:28:00.000Z",
      },
    }, "Australia/Brisbane");

    expect(guidance).toContain("Pattern name: News watch");
    expect(guidance).toContain("Trigger type: schedule");
    expect(guidance).toContain("Persisted next run: 2026-05-05, 17:28:00 AEST (Australia/Brisbane)");
    expect(guidance).toContain("Do not recalculate or infer the next run from schedule details.");
  });

  it("tells the hot path not to claim a next run when none was persisted", () => {
    const guidance = buildPatternSetupConfirmationGuidance({
      summary: "Created Pattern ptn_123.",
      data: {
        type: "pattern_setup",
        patternId: "ptn_123",
        patternName: "News watch",
        nextRun: null,
      },
    }, "Australia/Brisbane");

    expect(guidance).toContain("No persisted next run is available; do not claim a next run time.");
  });

  it("describes toolkit-triggered Patterns without a scheduled next run", () => {
    const guidance = buildPatternSetupConfirmationGuidance({
      summary: "Created Pattern ptn_123.",
      data: {
        type: "pattern_setup",
        patternId: "ptn_123",
        patternName: "Email watch",
        triggerType: "composio",
        nextRun: null,
      },
    }, "Australia/Brisbane");

    expect(guidance).toContain("Trigger type: composio");
    expect(guidance).toContain("This is toolkit/event-triggered; do not claim a scheduled next run time.");
  });
});

describe("buildVisibleAssistantMemoryTranscript", () => {
  it("combines delivered text, sent media, and tapbacks", () => {
    expect(buildVisibleAssistantMemoryTranscript({
      deliveredAssistantText: "[handle:out_1]\nthere you go",
      sentMediaText: "[sent media file_123] receipt",
      reactions: [{ reaction: "like", messageHandle: "msg_123" }],
    })).toBe([
      "[handle:out_1]\nthere you go",
      "[sent media file_123] receipt",
      "[tapback: like | target_handle: msg_123]",
    ].join("\n\n"));
  });

  it("can represent reaction-only visible outcomes", () => {
    expect(buildVisibleAssistantMemoryTranscript({
      deliveredAssistantText: "",
      sentMediaText: null,
      reactions: [{ reaction: "love", messageHandle: "msg_photo" }],
    })).toBe("[tapback: love | target_handle: msg_photo]");
  });

  it("returns an empty transcript for wait-only or internal-only turns", () => {
    expect(buildVisibleAssistantMemoryTranscript({
      deliveredAssistantText: "",
      sentMediaText: null,
      reactions: [],
    })).toBe("");
  });
});

describe("finishTurnCanStop", () => {
  it("stops a user turn after acknowledged delegation and finish_turn", () => {
    expect(finishTurnCanStop("user", [
      { toolName: "send_message" },
      { toolName: "delegate" },
      { toolName: "finish_turn" },
    ])).toBe(true);
  });

  it("keeps a user turn alive when delegation finishes without delivery", () => {
    expect(finishTurnCanStop("user", [
      { toolName: "delegate" },
      { toolName: "finish_turn" },
    ])).toBe(false);
  });

  it("allows delegate-then-wait user turns to finish silently", () => {
    expect(finishTurnCanStop("user", [
      { toolName: "delegate" },
      { toolName: "wait" },
      { toolName: "finish_turn" },
    ])).toBe(true);
  });

  it("allows internal worker turns to finish silently", () => {
    expect(finishTurnCanStop("worker", [
      { toolName: "wait" },
      { toolName: "finish_turn" },
    ])).toBe(true);
  });

  it("matches latest-step tool calls through the AI SDK stop condition", async () => {
    const shouldStop = finishTurnStopCondition("user");

    expect(await shouldStop({
      steps: [{
        toolCalls: [
          { toolName: "send_message" },
          { toolName: "delegate" },
          { toolName: "finish_turn" },
        ],
      } as never],
    })).toBe(true);
  });
});

describe("buildRuntimeContextMessage", () => {
  it("includes active Pattern IDs and descriptions in runtime status", () => {
    const context = buildRuntimeContextMessage({
      currentTime: new Date("2026-05-09T14:00:00.000Z"),
      inboundMessage: {
        source: "user",
        ...owner,
        content: "move my hantavirus updates to 8:30",
        messageId: "msg_123",
        timestamp: new Date("2026-05-09T14:00:00.000Z"),
      },
      statusBlock: {
        activeWorkers: [],
        followUpWorkers: [],
        pendingConfirmations: [],
        activePatterns: 1,
        activePatternSummaries: [{
          id: "ptn_hanta",
          name: "Hantavirus Outbreak News Monitor",
          workerType: "pattern_worker",
          triggerType: "schedule",
          scheduleType: "interval",
          nextRunAt: new Date("2026-05-10T01:28:18.255Z"),
          userDescription: "Monitors for hantavirus news updates.",
        }],
      },
      user: runtimeUser,
    }, "Australia/Brisbane");

    expect(context).toContain("<active_patterns count=\"1\">");
    expect(context).toContain('<pattern id="ptn_hanta" name="Hantavirus Outbreak News Monitor"');
    expect(context).toContain("Monitors for hantavirus news updates.");
  });
});

describe("userTurnNeedsDeliveryAfterDelegation", () => {
  it("requires a follow-up delivery step when a user turn only delegated", () => {
    expect(userTurnNeedsDeliveryAfterDelegation([{ toolName: "delegate" }])).toBe(true);
  });

  it("does not require a follow-up delivery step when the delegation was already acknowledged", () => {
    expect(userTurnNeedsDeliveryAfterDelegation([
      { toolName: "send_message" },
      { toolName: "delegate" },
    ])).toBe(false);
  });
});

describe("buildDelegateToolContext", () => {
  it("preserves My Day handoff delegate hooks", async () => {
    const delegatedWorkerIds: string[] = [];
    const message: UserMessage = {
      source: "user",
      ...owner,
      content: "handoff",
      messageId: "myday_handoff_123",
      timestamp: new Date("2026-05-12T00:00:00.000Z"),
      context: { myDayHandoffTodoId: "todo_123" },
    };

    const context = buildDelegateToolContext({
      message,
      extra: { onDelegated: async (workerId) => { delegatedWorkerIds.push(workerId); } },
    });
    await context.onDelegated?.("wrk_123");

    expect(context.originMessageId).toBe("myday_handoff_123");
    expect(context.originSource).toBe("user");
    expect(delegatedWorkerIds).toEqual(["wrk_123"]);
  });
});

describe("getActiveHotPathToolNames", () => {
  const scopedTools = {
    send_message: {},
    send_media: {},
    react: {},
    wait: {},
    delegate: {},
    cancel_worker: {},
    display_draft: {},
    search_memory: {},
    reflect_memory: {},
    workspace_search: {},
    workspace_execute: {},
    view_image: {},
    update_user_profile: {},
    list_active_patterns: {},
    list_reminders: {},
    create_reminder: {},
    inspect_reminder: {},
    edit_reminder: {},
    delete_reminder: {},
    list_my_day_todos: {},
    add_my_day_todo: {},
    update_my_day_todo: {},
    delete_my_day_todo: {},
    finish_turn: {},
  } as never;

  it("makes search_memory available on user turns when present", () => {
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("search_memory");
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("reflect_memory");
  });

  it("makes profile updates available on user turns when present", () => {
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("update_user_profile");
  });

  it("makes active Pattern listing available on user turns when present", () => {
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("list_active_patterns");
  });

  it("makes file context available across hot-path origins when present", () => {
    for (const tools of [
      getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 }),
      getActiveHotPathToolNames({ source: "worker", scopedTools, stepNumber: 0, workerOriginSource: "pattern" }),
      getActiveHotPathToolNames({ source: "trigger", scopedTools, stepNumber: 0 }),
    ]) {
      expect(tools).toContain("workspace_search");
      expect(tools).toContain("workspace_execute");
      expect(tools).toContain("view_image");
    }
  });

  it("makes reminder management available on user turns when present", () => {
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("create_reminder");
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("edit_reminder");
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("delete_reminder");
  });

  it("keeps hot-path native delivery and control tools on user turns", () => {
    const tools = getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 });

    expect(tools).toEqual(expect.arrayContaining([
      "send_message",
      "send_media",
      "display_draft",
      "react",
      "wait",
      "finish_turn",
      "delegate",
      "cancel_worker",
      "update_user_profile",
      "list_active_patterns",
    ]));
    expect(tools).toContain("workspace_search");
    expect(tools).toContain("workspace_execute");
    expect(tools).toContain("view_image");
  });

  it("restricts post-delegation acknowledgement to native ack tools", () => {
    const tools = getActiveHotPathToolNames({
      source: "user",
      scopedTools,
      stepNumber: 1,
      previousStepToolCalls: [{ toolName: "delegate" }],
    });

    expect(tools).toEqual(["send_message", "wait", "finish_turn"]);
  });

  it("makes My Day todo management available on user turns when present", () => {
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("add_my_day_todo");
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("update_my_day_todo");
    expect(getActiveHotPathToolNames({ source: "user", scopedTools, stepNumber: 0 })).toContain("delete_my_day_todo");
  });

  it("allows user-origin worker completions to update My Day todos", () => {
    const tools = getActiveHotPathToolNames({ source: "worker", scopedTools, stepNumber: 0, workerOriginSource: "user" });

    expect(tools).toContain("delegate");
    expect(tools).toContain("list_reminders");
    expect(tools).toContain("inspect_reminder");
    expect(tools).toContain("list_my_day_todos");
    expect(tools).toContain("update_my_day_todo");
    expect(tools).not.toContain("react");
    expect(tools).not.toContain("cancel_worker");
    expect(tools).not.toContain("update_user_profile");
    expect(tools).not.toContain("create_reminder");
    expect(tools).not.toContain("add_my_day_todo");
    expect(tools).not.toContain("delete_my_day_todo");
  });

  it("makes delegate and read-only context tools available on pattern worker and trigger turns", () => {
    const workerTools = getActiveHotPathToolNames({ source: "worker", scopedTools, stepNumber: 0, workerOriginSource: "pattern" });
    const triggerTools = getActiveHotPathToolNames({ source: "trigger", scopedTools, stepNumber: 0 });

    for (const tools of [workerTools, triggerTools]) {
      expect(tools).toContain("delegate");
      expect(tools).toContain("workspace_search");
      expect(tools).toContain("workspace_execute");
      expect(tools).toContain("view_image");
      expect(tools).toContain("list_active_patterns");
      expect(tools).toContain("list_reminders");
      expect(tools).toContain("inspect_reminder");
      expect(tools).toContain("list_my_day_todos");
      expect(tools).not.toContain("react");
      expect(tools).not.toContain("cancel_worker");
      expect(tools).not.toContain("update_user_profile");
      expect(tools).not.toContain("create_reminder");
      expect(tools).not.toContain("edit_reminder");
      expect(tools).not.toContain("delete_reminder");
      expect(tools).not.toContain("add_my_day_todo");
      expect(tools).not.toContain("update_my_day_todo");
      expect(tools).not.toContain("delete_my_day_todo");
    }
  });

  it("makes search_memory available for worker result novelty checks", () => {
    expect(getActiveHotPathToolNames({ source: "worker", scopedTools, stepNumber: 0, workerOriginSource: "pattern" })).toContain("search_memory");
    expect(getActiveHotPathToolNames({ source: "worker", scopedTools, stepNumber: 0, workerOriginSource: "pattern" })).toContain("reflect_memory");
  });

  it("omits unavailable optional tools from active tool lists", () => {
    expect(getActiveHotPathToolNames({
      source: "user",
      scopedTools: { send_message: {}, finish_turn: {} } as never,
      stepNumber: 0,
    })).toEqual(["send_message", "finish_turn"]);
  });

  it("does not force active tool selection when forced tool choice is disabled", () => {
    expect(getActiveHotPathToolNames({
      source: "user",
      scopedTools,
      stepNumber: 0,
      forceToolChoice: false,
    })).toBeNull();
  });

  it("keeps delivery tools available on later worker-result steps", () => {
    const tools = getActiveHotPathToolNamesForStep({
      source: "worker",
      scopedTools,
      stepNumber: 1,
      workerOriginSource: "pattern",
      steps: [{ toolCalls: [{ toolName: "send_message" }] }],
    });

    expect(tools).toContain("send_message");
    expect(tools).toContain("send_media");
    expect(tools).toContain("display_draft");
    expect(tools).toContain("delegate");
    expect(tools).toContain("search_memory");
    expect(tools).toContain("finish_turn");
  });

  it("keeps delivery tools available after semantic non-delivery tool results", () => {
    const tools = getActiveHotPathToolNamesForStep({
      source: "worker",
      scopedTools,
      stepNumber: 2,
      workerOriginSource: "pattern",
      steps: [
        { toolCalls: [{ toolName: "send_message" }] },
        { toolCalls: [{ toolName: "search_memory" }] },
      ],
    });

    expect(tools).toContain("send_message");
    expect(tools).toContain("send_media");
    expect(tools).toContain("display_draft");
  });

  it("does not force active tool selection when forced tool choice is disabled on later steps", () => {
    const tools = getActiveHotPathToolNamesForStep({
      source: "user",
      scopedTools,
      stepNumber: 1,
      forceToolChoice: false,
      steps: [{ toolCalls: [{ toolName: "display_draft" }] }],
    });

    expect(tools).toBeNull();
  });
});

describe("runtime context assembly", () => {
  it("keeps per-user and chapter context out of the stable system prompt", () => {
    const contextParts = {
      identity: {
        finn: "static finn identity",
        user: "name: Alex",
      },
      chapterSummary: "Previous chapter handoff",
      memoryProfile: {
        static: ["User prefers short morning updates."],
        dynamic: ["User is currently planning a mobile onboarding project."],
      },
    };

    expect(assembleSystemPrompt(contextParts)).toBe("static finn identity");
    expect(assembleDynamicPromptContext(contextParts)).toContain("<user_profile>");
    expect(assembleDynamicPromptContext(contextParts)).toContain("name: Alex");
    expect(assembleDynamicPromptContext(contextParts)).toContain("<memory_profile>");
    expect(assembleDynamicPromptContext(contextParts)).toContain("Provider-maintained user profile:");
    expect(assembleDynamicPromptContext(contextParts)).toContain("User prefers short morning updates.");
    expect(assembleDynamicPromptContext(contextParts)).toContain("User is currently planning a mobile onboarding project.");
    expect(assembleDynamicPromptContext(contextParts)).toContain("<chapter_summary>");
    expect(assembleDynamicPromptContext(contextParts)).toContain("Previous chapter handoff");
    expect(assembleDynamicPromptContext(contextParts)).not.toContain("## User Profile");
    expect(assembleDynamicPromptContext(contextParts)).not.toContain("## Current Chapter Summary");
  });

  it("keeps status context without injecting long-term memory context", () => {
    const runtimeContext = buildRuntimeContextMessage({
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      statusBlock: createStatusBlock(["search xAI updates"]),
      inboundMessage: {
        source: "user",
        ...owner,
        content: "weather this week",
        messageId: "msg_123",
        timestamp: new Date("2026-04-21T01:02:03.000Z"),
      } satisfies UserMessage,
      user: runtimeUser,
    }, "Australia/Brisbane");

    expect(runtimeContext).toContain('<runtime_context source="user">');
    expect(runtimeContext).toContain("</runtime_context>");
    expect(runtimeContext).not.toContain("inbound source: user");
    expect(runtimeContext).not.toContain("[message modality | handle:msg_123] text");
    expect(runtimeContext).toContain("<runtime_status>");
    expect(runtimeContext).toContain("<status>");
    expect(runtimeContext).toContain('<active_workers count="1">');
    expect(runtimeContext).not.toContain("## Status");
    expect(runtimeContext).not.toContain("## Long-Term Memory Context");
    expect(runtimeContext).not.toContain("### Relevant Messages");
  });

  it("injects compact relevant memory context without provider internals", () => {
    const runtimeContext = buildRuntimeContextMessage({
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      statusBlock: createStatusBlock([]),
      inboundMessage: {
        source: "user",
        ...owner,
        content: "what should we do for dinner?",
        messageId: "msg_123",
        timestamp: new Date("2026-04-21T01:02:03.000Z"),
      } satisfies UserMessage,
      user: runtimeUser,
      memoryContext: [{
        text: "User is married to a wife | Involving: user, wife",
        type: "world",
        occurredAt: "2026-05-11T09:59:24.359395+00:00",
      }],
    }, "Australia/Brisbane");

    expect(runtimeContext).toContain("<semantic_memory>");
    expect(runtimeContext).toContain("Auto-injected semantic memory:");
    expect(runtimeContext).toContain("may be incomplete, noisy, or irrelevant.");
    expect(runtimeContext).toContain("If a core user fact is needed but absent or uncertain, use the memory tool when available");
    expect(runtimeContext).toContain("User is married to a wife");
    expect(runtimeContext).not.toContain("document_id");
    expect(runtimeContext).not.toContain("chunk_id");
    expect(runtimeContext).not.toContain("scope:personal");
  });

  it("caps formatted memory context", () => {
    const context = formatMemoryContextBlock(Array.from({ length: 20 }, (_, index) => ({
      text: `Memory ${index} ${"x".repeat(400)}`,
      type: "world",
    })));

    expect(context).toContain("<semantic_memory>");
    expect(context).toContain("Auto-injected semantic memory:");
    expect(context.length).toBeLessThanOrEqual(4200);
  });

  it("adds trailing turn rules near the current context", () => {
    const rules = buildTrailingTurnRules();

    expect(rules).toContain("<turn_rules>");
    expect(rules).toContain("Only human_message envelopes are user-authored.");
    expect(rules).toContain("Tool results from delivery calls are outbound receipts, not new user messages.");
  });

  it("auto memory uses semantic recall without reflection", async () => {
    let reflected = false;
    const agent = createMemoryTestAgent({
      async buildContext() {
        return {
          ok: true,
          results: [{
            text: "User prefers concise morning updates.",
            type: "observation",
            occurredAt: "2026-05-11T09:59:24.359Z",
          }],
        };
      },
      async searchDocuments() {
        throw new Error("search should not be used when buildContext is available");
      },
      async reflectMemory() {
        reflected = true;
        return { ok: true, answer: "slow profile synthesis" };
      },
    });

    const autoMemory = await buildAutoMemoryForTest(agent, {
      source: "user",
      ...owner,
      content: "what's on this morning?",
      messageId: "msg_123",
      timestamp: new Date("2026-04-21T01:02:03.000Z"),
    });

    expect(reflected).toBe(false);
    expect(autoMemory.results).toEqual([{
      text: "User prefers concise morning updates.",
      type: "observation",
      occurredAt: "2026-05-11T09:59:24.359Z",
    }]);
    expect(autoMemory.status).toEqual({
      enabled: true,
      clientAvailable: true,
      queried: true,
      injectedCount: 1,
      reason: "injected",
    });
  });

  it("auto memory profile uses provider profile context without query-specific recall", async () => {
    let searched = false;
    const agent = createMemoryTestAgent({
      async buildProfileContext() {
        return {
          ok: true,
          profile: {
            static: ["User prefers concise morning updates."],
            dynamic: ["User is currently planning a launch brief."],
          },
        };
      },
      async searchDocuments() {
        searched = true;
        return { ok: true, results: [] };
      },
    });

    const profile = await buildAutoMemoryProfileForTest(agent);

    expect(searched).toBe(false);
    expect(profile).toEqual({
      static: ["User prefers concise morning updates."],
      dynamic: ["User is currently planning a launch brief."],
    });
  });

  it("auto memory fails open when semantic recall fails", async () => {
    const agent = createMemoryTestAgent({
      async buildContext() {
        throw new Error("provider unavailable");
      },
      async searchDocuments() {
        throw new Error("provider unavailable");
      },
    });

    const autoMemory = await buildAutoMemoryForTest(agent, {
      source: "user",
      ...owner,
      content: "what's on this morning?",
      messageId: "msg_123",
      timestamp: new Date("2026-04-21T01:02:03.000Z"),
    });

    expect(autoMemory.results).toEqual([]);
    expect(autoMemory.status).toEqual({
      enabled: true,
      clientAvailable: true,
      queried: true,
      injectedCount: 0,
      reason: "timeout_or_exception",
    });
  });

  it("includes follow-up enabled worker ids in status context", () => {
    const statusBlock = createStatusBlock([]);
    statusBlock.followUpWorkers = [{
      id: "wrk_followup",
      task: "research flights",
      status: "found three options",
      completedAt: new Date("2026-04-21T01:03:00.000Z"),
      expiresAt: new Date("2026-04-21T01:08:00.000Z"),
    }];

    const runtimeContext = buildRuntimeContextMessage({
      currentTime: new Date("2026-04-21T01:04:00.000Z"),
      statusBlock,
      inboundMessage: {
        source: "user",
        ...owner,
        content: "what about business class?",
        messageId: "msg_123",
        timestamp: new Date("2026-04-21T01:04:00.000Z"),
      } satisfies UserMessage,
      user: runtimeUser,
    }, "UTC");

    expect(runtimeContext).toContain('<follow_up_workers count="1">');
    expect(runtimeContext).toContain('<worker id="wrk_followup" status="found three options"');
    expect(runtimeContext).toContain("research flights");
  });

  it("keeps inbound modality metadata out of runtime context", () => {
    const runtimeContext = buildRuntimeContextMessage({
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      statusBlock: createStatusBlock([]),
      inboundMessage: {
        source: "user",
        ...owner,
        content: "voice transcript",
        messageId: "msg_123",
        timestamp: new Date("2026-04-21T01:02:03.000Z"),
        attachments: [{
          id: "att_1",
          url: "https://files.example.com/voice.caf",
          mimeType: "audio/x-caf",
          filename: "voice.caf",
          audioKind: "voice_note",
          contextText: "voice transcript",
        }],
      } satisfies UserMessage,
      user: runtimeUser,
    }, "Australia/Brisbane");

    expect(runtimeContext).not.toContain("[message modality |");
    expect(runtimeContext).not.toContain("transcribed voice");
  });

  it("keeps inbound reply target metadata out of runtime context", () => {
    const runtimeContext = buildRuntimeContextMessage({
      currentTime: new Date("2026-04-21T01:02:03.000Z"),
      statusBlock: createStatusBlock([]),
      inboundMessage: {
        source: "user",
        ...owner,
        content: "yeah that one",
        messageId: "msg_123",
        replyToMessageId: "out_finn_123",
        timestamp: new Date("2026-04-21T01:02:03.000Z"),
      } satisfies UserMessage,
      user: runtimeUser,
    }, "Australia/Brisbane");

    expect(runtimeContext).not.toContain("[message reply |");
    expect(runtimeContext).not.toContain("reply_to:out_finn_123");
  });

  it("distinguishes untranscribed voice messages from ordinary audio files in message attributes", async () => {
    const content = await toCurrentTurnMessageContent({
      source: "user",
      ...owner,
      content: "",
      messageId: "msg_123",
      timestamp: new Date("2026-04-21T01:02:03.000Z"),
      parts: [
        {
          content: "[The user sent a voice message, but speech-to-text is not configured. Finn cannot hear what they said.]",
          messageId: "msg_voice",
          timestamp: new Date("2026-04-21T01:02:03.000Z"),
          attachments: [{
            id: "att_voice",
            url: "https://files.example.com/voice.caf",
            mimeType: "audio/x-caf",
            filename: "voice.caf",
            audioKind: "voice_note",
            contextText: "[The user sent a voice message, but speech-to-text is not configured. Finn cannot hear what they said.]",
          }],
        },
        {
          content: "[The user sent an audio file, but speech-to-text is not configured. Finn cannot hear its contents.]",
          messageId: "msg_audio",
          timestamp: new Date("2026-04-21T01:02:04.000Z"),
          attachments: [{
            id: "att_audio",
            url: "https://files.example.com/song.mp3",
            mimeType: "audio/mpeg",
            filename: "song.mp3",
            audioKind: "audio",
            contextText: "[The user sent an audio file, but speech-to-text is not configured. Finn cannot hear its contents.]",
          }],
        },
      ],
    }, "Australia/Brisbane");

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multipart content.");
    }

    const text = content.filter((part): part is UserModelTextPart => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain('<message handle="msg_voice" timestamp="2026-04-21, 11:02:03 AEST" modality="text,voice_message">');
    expect(text).toContain('<message handle="msg_audio" timestamp="2026-04-21, 11:02:04 AEST" modality="text,audio">');
  });
});

describe("buildHotPathUserProfileContext", () => {
  it("includes only the requested user fields with mobile label", () => {
    expect(buildHotPathUserProfileContext({
      ...owner,
      displayName: "Alex",
      timezone: "Australia/Brisbane",
      timezoneSource: "manual",
      location: "Brisbane, Australia",
      kidsMode: false,
    })).toBe([
      "name: Alex",
      "timezone: Australia/Brisbane",
      "location: Brisbane, Australia",
      "mobile: +10000000000",
    ].join("\n"));
  });

  it("omits missing optional fields", () => {
    expect(buildHotPathUserProfileContext({
      ...owner,
      displayName: "  ",
      timezone: "UTC",
      timezoneSource: "server",
      location: null,
      kidsMode: false,
    })).toBe([
      "timezone: UTC",
      "mobile: +10000000000",
    ].join("\n"));
  });
});

describe("buildNaturalOnboardingContext", () => {
  it("adds natural name guidance while display name is missing", () => {
    expect(buildNaturalOnboardingContext({ ...runtimeUser, displayName: null })).toContain("name is not set yet");
  });

  it("omits guidance once display name exists", () => {
    expect(buildNaturalOnboardingContext(runtimeUser)).toBe("");
  });
});
