import { getTracer, withSpan } from "@finn/core";
import type { TapbackType } from "@finn/core";
import type { FileStorage } from "@finn/media";
import { SpectrumClient, type SendMessageOptions, type SendMessageResult } from "./adapter.js";

const tracer = getTracer("messaging");

type MessageSenderConfig = {
  recipientPhoneNumber: string;
  fileStorage: FileStorage;
};

export class MessageSender {
  private recipientPhoneNumber: string;

  constructor(
    private readonly client: SpectrumClient,
    private readonly config: MessageSenderConfig,
  ) {
    this.recipientPhoneNumber = config.recipientPhoneNumber;
  }

  setRecipient(phoneNumber: string): void {
    this.recipientPhoneNumber = phoneNumber;
  }

  async sendText(text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
    return withSpan(tracer, "sender.sendText", {
      "message.parts": 1,
      "message.length": text.length,
      "message.reply_to": options.replyToMessageHandle ?? "",
    }, async () => {
      return this.client.sendText(this.recipientPhoneNumber, text, options);
    });
  }

  async sendMedia(fileId: string, caption?: string): Promise<void> {
    return withSpan(tracer, "sender.sendMedia", { "media.fileId": fileId }, async () => {
      const file = await this.requireOwnedFile(fileId);
      await this.client.sendAttachment(this.recipientPhoneNumber, {
        path: file.storagePath,
        filename: file.filename,
        mimeType: file.mimeType,
      }, caption);
    });
  }

  async sendVoiceMessage(fileId: string, options: SendMessageOptions & { duration?: number } = {}): Promise<SendMessageResult> {
    return withSpan(tracer, "sender.sendVoiceMessage", { "media.fileId": fileId }, async () => {
      const file = await this.requireOwnedFile(fileId);
      return this.client.sendVoice(this.recipientPhoneNumber, {
        path: file.storagePath,
        filename: file.filename,
        mimeType: file.mimeType,
        ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
      }, options);
    });
  }

  async sendReaction(messageHandle: string, reaction: TapbackType): Promise<void> {
    await this.client.sendReaction(this.recipientPhoneNumber, messageHandle, reaction);
  }

  async sendTypingIndicator(): Promise<void> {
    await this.startTyping();
  }

  async startTyping(): Promise<void> {
    await this.client.startTyping(this.recipientPhoneNumber);
  }

  async stopTyping(): Promise<void> {
    await this.client.stopTyping(this.recipientPhoneNumber);
  }

  async markRead(): Promise<void> {
    await this.client.markRead(this.recipientPhoneNumber);
  }

  private async requireOwnedFile(fileId: string) {
    const file = await this.config.fileStorage.getMetadata(fileId);
    if (!file) {
      throw new Error(`Stored file not found for current user: ${fileId}`);
    }

    return file;
  }
}
