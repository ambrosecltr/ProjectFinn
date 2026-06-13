import { describe, expect, it, mock } from "bun:test";

import { MessageSender } from "./sender.js";

describe("MessageSender", () => {
  it("sends voice notes from the stored file path", async () => {
    const client = {
      sendVoice: mock(async () => undefined),
    };
    const fileStorage = {
      getMetadata: mock(async () => ({
        id: "file_voice",
        tenantId: "tenant_test",
        userId: "usr_test",
        filename: "voice.caf",
        mimeType: "audio/x-caf",
        size: 4,
        storagePath: "/workspace/files/file_voice/voice.caf",
        createdAt: new Date(),
      })),
    };

    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: fileStorage as never,
    });

    await sender.sendVoiceMessage("file_voice");

    expect(client.sendVoice).toHaveBeenCalledWith("+15557654321", {
      path: "/workspace/files/file_voice/voice.caf",
      filename: "voice.caf",
      mimeType: "audio/x-caf",
    }, {});
  });

  it("rejects media sends for files outside the current user storage", async () => {
    const client = {
      sendAttachment: mock(async () => undefined),
    };
    const fileStorage = {
      getMetadata: mock(async () => null),
    };

    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: fileStorage as never,
    });

    await expect(sender.sendMedia("file_other")).rejects.toThrow("Stored file not found for current user: file_other");
    expect(client.sendAttachment).not.toHaveBeenCalled();
  });

  it("sends media from the stored file path with captions", async () => {
    const client = {
      sendAttachment: mock(async () => undefined),
    };
    const fileStorage = {
      getMetadata: mock(async () => ({
        id: "file_photo",
        tenantId: "tenant_test",
        userId: "usr_test",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 4,
        storagePath: "/workspace/files/file_photo/photo.jpg",
        createdAt: new Date(),
      })),
    };

    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: fileStorage as never,
    });

    await sender.sendMedia("file_photo", "look at this");

    expect(client.sendAttachment).toHaveBeenCalledWith("+15557654321", {
      path: "/workspace/files/file_photo/photo.jpg",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    }, "look at this");
  });

  it("delegates reactions and typing indicators to Spectrum", async () => {
    const client = {
      sendReaction: mock(async () => undefined),
      startTyping: mock(async () => undefined),
      stopTyping: mock(async () => undefined),
    };
    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: { getMetadata: mock(async () => null) } as never,
    });

    await sender.sendReaction("msg_123", "like");
    await sender.sendTypingIndicator();
    await sender.stopTyping();

    expect(client.sendReaction).toHaveBeenCalledWith("+15557654321", "msg_123", "like");
    expect(client.startTyping).toHaveBeenCalledWith("+15557654321");
    expect(client.stopTyping).toHaveBeenCalledWith("+15557654321");
  });

  it("passes reply targets through text and voice sends", async () => {
    const client = {
      sendText: mock(async () => ({ messageIds: ["out_text"], threaded: true, fallback: false })),
      sendVoice: mock(async () => ({ messageIds: ["out_voice"], threaded: true, fallback: false })),
    };
    const fileStorage = {
      getMetadata: mock(async () => ({
        id: "file_voice",
        tenantId: "tenant_test",
        userId: "usr_test",
        filename: "voice.caf",
        mimeType: "audio/x-caf",
        size: 4,
        storagePath: "/workspace/files/file_voice/voice.caf",
        createdAt: new Date(),
      })),
    };
    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: fileStorage as never,
    });

    await sender.sendText("weather's back", { replyToMessageHandle: "msg_weather" });
    await sender.sendVoiceMessage("file_voice", { replyToMessageHandle: "msg_weather" });

    expect(client.sendText).toHaveBeenCalledWith("+15557654321", "weather's back", { replyToMessageHandle: "msg_weather" });
    expect(client.sendVoice).toHaveBeenCalledWith("+15557654321", {
      path: "/workspace/files/file_voice/voice.caf",
      filename: "voice.caf",
      mimeType: "audio/x-caf",
    }, { replyToMessageHandle: "msg_weather" });
  });

  it("marks read through the current recipient", async () => {
    const client = {
      markRead: mock(async () => undefined),
    };
    const sender = new MessageSender(client as never, {
      recipientPhoneNumber: "+15557654321",
      fileStorage: { getMetadata: mock(async () => null) } as never,
    });

    await sender.markRead();

    expect(client.markRead).toHaveBeenCalledWith("+15557654321");
  });
});
