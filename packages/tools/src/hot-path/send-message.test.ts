import { describe, expect, it, mock } from "bun:test";

import { createSendMediaTool, createSendMessageTool } from "./send-message.js";
import { createDisplayDraftTool, formatDraftForDisplay } from "./display-draft.js";

describe("createSendMessageTool", () => {
  it("describes reply handles as message handle attributes", () => {
    const sender = {
      sendText: mock(async () => ({ messageIds: ["out_123"], threaded: true, fallback: false })),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
    };
    const sendMessageTool = createSendMessageTool({ sender });
    const inputSchemaDescription = (sendMessageTool.inputSchema as unknown as {
      shape: { replyToMessageHandle: { description?: string } };
    }).shape.replyToMessageHandle.description;

    expect(inputSchemaDescription).toContain("handle attribute");
    expect(inputSchemaDescription).toContain("<message");
    expect(inputSchemaDescription).not.toContain("[handle:");
  });

  it("passes threaded reply handles to text sends", async () => {
    const sender = {
      sendText: mock(async () => ({ messageIds: ["out_123"], threaded: true, fallback: false })),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
    };
    const sendMessageTool = createSendMessageTool({ sender });
    const execute = sendMessageTool.execute as unknown as (input: { text: string; replyToMessageHandle: string }, options: never) => Promise<unknown>;

    const result = await execute({ text: "weather's back", replyToMessageHandle: "msg_weather" }, { toolCallId: "call_1", messages: [] } as never);

    expect(sender.sendText).toHaveBeenCalledWith("weather's back", { replyToMessageHandle: "msg_weather" });
    expect(result).toEqual({
      sent: true,
      deliveredToUser: true,
      userReplyReceived: false,
      receiptType: "outbound_delivery_receipt",
      messageCount: 1,
      voiceMessage: false,
      outboundMessageHandles: ["out_123"],
      replyToMessageHandle: "msg_weather",
      sendResult: { messageIds: ["out_123"], threaded: true, fallback: false },
      instruction: "This is an outbound delivery receipt, not a user reply. Continue only if this same response still has unsent content; otherwise call finish_turn.",
    });
  });

  it("sends voice replies as caf media-only messages", async () => {
    const sender = {
      sendText: mock(async () => {}),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
      sendReaction: mock(async () => {}),
      sendTypingIndicator: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const files = {
      storedFiles: {
        store: mock(async (input: { filename: string; mimeType: string; data: Buffer }) => ({
          id: "file_voice",
          ...input,
        })),
      },
    };
    const elevenlabs = {
      synthesize: mock(async () => Buffer.from("mp3")),
    };
    const convertAudioToCaf = mock(async () => Buffer.from("caf"));

    const sendMessageTool = createSendMessageTool({
      sender,
      voice: { elevenlabs: elevenlabs as never, files: files as never, tempRoot: "/tmp/finn-test", convertAudioToCaf },
    });

    const execute = sendMessageTool.execute as unknown as (input: { text: string; voice_message: true }, options: never) => Promise<unknown>;
    const result = await execute({ text: "talk soon", voice_message: true }, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual({
      sent: true,
      deliveredToUser: true,
      userReplyReceived: false,
      receiptType: "outbound_delivery_receipt",
      messageCount: 1,
      voiceMessage: true,
      fileId: "file_voice",
      outboundMessageHandles: [],
      instruction: "This is an outbound delivery receipt, not a user reply. Continue only if this same response still has unsent content; otherwise call finish_turn.",
    });
    expect(elevenlabs.synthesize).toHaveBeenCalledWith("talk soon");
    expect(convertAudioToCaf).toHaveBeenCalledWith(Buffer.from("mp3"));
    expect(files.storedFiles.store.mock.calls[0]?.[0].filename.endsWith(".caf")).toBe(true);
    expect(files.storedFiles.store.mock.calls[0]?.[0].mimeType).toBe("audio/x-caf");
    expect(sender.sendVoiceMessage).toHaveBeenCalledWith("file_voice", { replyToMessageHandle: undefined });
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});

describe("createSendMediaTool", () => {
  it("checks current-user file storage before sending media", async () => {
    const sender = {
      sendText: mock(async () => {}),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
    };
    const files = {
      storedFiles: {
        getMetadata: mock(async () => ({ id: "file_ok" })),
        setUserVisible: mock(async () => ({ id: "file_ok", userVisible: true })),
      },
    };

    const sendMediaTool = createSendMediaTool(sender, files as never);
    const execute = sendMediaTool.execute as unknown as (input: { fileId: string }, options: never) => Promise<unknown>;
    const result = await execute({ fileId: "file_ok" }, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual({ sent: true, fileId: "file_ok" });
    expect(files.storedFiles.setUserVisible).toHaveBeenCalledWith("file_ok", true);
    expect(sender.sendMedia).toHaveBeenCalledWith("file_ok", undefined);
  });

  it("does not send media when the file is not in current-user storage", async () => {
    const sender = {
      sendText: mock(async () => {}),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
    };
    const files = {
      storedFiles: {
        getMetadata: mock(async () => null),
        setUserVisible: mock(async () => null),
      },
    };

    const sendMediaTool = createSendMediaTool(sender, files as never);
    const execute = sendMediaTool.execute as unknown as (input: { fileId: string }, options: never) => Promise<unknown>;
    const result = await execute({ fileId: "file_other" }, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual({
      sent: false,
      fileId: "file_other",
      error: "Stored file not found for current user: file_other",
    });
    expect(files.storedFiles.setUserVisible).not.toHaveBeenCalled();
    expect(sender.sendMedia).not.toHaveBeenCalled();
  });

  it("does not send media when stored file runtime is unavailable", async () => {
    const sender = {
      sendText: mock(async () => {}),
      sendMedia: mock(async () => {}),
      sendVoiceMessage: mock(async () => {}),
    };

    const sendMediaTool = createSendMediaTool(sender, {} as never);
    const execute = sendMediaTool.execute as unknown as (input: { fileId: string }, options: never) => Promise<unknown>;
    const result = await execute({ fileId: "file_missing" }, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual({
      sent: false,
      fileId: "file_missing",
      error: "Stored file runtime is not available.",
    });
    expect(sender.sendMedia).not.toHaveBeenCalled();
  });
});

describe("createDisplayDraftTool", () => {
  it("sends the formatted draft to the user", async () => {
    const sender = { sendText: mock(async () => undefined) };
    const displayDraftTool = createDisplayDraftTool(sender);
    const execute = displayDraftTool.execute as unknown as (input: { type: "email"; to: string; subject: string; body: string }, options: never) => Promise<unknown>;

    const result = await execute({
      type: "email",
      to: "sam@example.com",
      subject: "Quick update",
      body: "Hi Sam,\n\nHere is the update.",
    }, { toolCallId: "call_1", messages: [] } as never);

    expect(sender.sendText).toHaveBeenCalledWith([
      "draft email",
      "to: sam@example.com",
      "subject: Quick update",
      "",
      "Hi Sam,\n\nHere is the update.",
    ].join("\n"));
    expect(result).toMatchObject({ displayed: true, type: "email", body: "Hi Sam,\n\nHere is the update." });
  });

  it("formats message drafts without empty metadata rows", () => {
    expect(formatDraftForDisplay({ type: "message", body: "looks good" })).toBe([
      "draft message",
      "",
      "looks good",
    ].join("\n"));
  });
});
