import { createLogger, generateId } from "@finn/core";
import type { Attachment, UserContext, UserMessage } from "@finn/core";
import type { Contact, SpectrumInboundMessage } from "./adapter.js";

const logger = createLogger("messaging:router");

type SpectrumInboundMessageWithParent = SpectrumInboundMessage & {
  parentId?: string;
  threadOriginatorGuid?: string;
};

type SpectrumMessageLike = Pick<SpectrumInboundMessageWithParent, "id" | "content" | "timestamp" | "parentId" | "threadOriginatorGuid">;

type SpectrumContent = SpectrumInboundMessage["content"];

type SpectrumAttachmentContent = {
  type: "attachment";
  name: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
};

type SpectrumVoiceContent = {
  type: "voice";
  name?: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
};

type SpectrumGroupContent = {
  type: "group";
  items: SpectrumMessageLike[];
};

type SpectrumCustomContent = {
  type: "custom";
  raw: unknown;
};

type RoutedContent = {
  text: string;
  attachments: Attachment[];
};

export class MessageRouter {
  async routeSpectrumMessage(message: SpectrumInboundMessageWithParent, user: UserContext): Promise<UserMessage | null> {
    const content = await this.getContent(message);
    if (!content) {
      return null;
    }

    const routedMessage: UserMessage = {
      source: "user",
      tenantId: user.tenantId,
      userId: user.userId,
      phoneNumber: user.phoneNumber,
      content: content.text,
      ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      messageId: message.id || generateId("msg"),
      ...(this.getReplyToMessageId(message) ? { replyToMessageId: this.getReplyToMessageId(message) } : {}),
      timestamp: message.timestamp,
    };

    return routedMessage;
  }

  private async getContent(message: SpectrumInboundMessage): Promise<RoutedContent | null> {
    const content = await this.getMessageContent(message);
    if (!content) {
      return null;
    }

    // Spectrum iMessage attachment messages rely on Finn's SDK patch to retain
    // caption text as provider metadata until upstream preserves it.
    const rawText = this.extractRawText(message);
    if (!rawText || content.text.includes(rawText)) {
      return content;
    }

    return {
      ...content,
      text: this.joinText([content.text, rawText]),
    };
  }

  private async getMessageContent(message: SpectrumMessageLike): Promise<RoutedContent | null> {
    switch (message.content.type) {
      case "text":
        return { text: message.content.text, attachments: [] };
      case "attachment":
        return this.getAttachmentContent(message, message.content);
      case "voice":
        return this.getVoiceContent(message, message.content);
      case "contact":
        return {
          text: this.summarizeContact(message.content),
          attachments: [],
        };
      case "custom":
        return this.getCustomContent(message.content);
      case "group":
        return this.getGroupContent(message, message.content);
      default:
        logger.debug({ messageId: message.id, contentType: this.getContentType(message.content) }, "Skipping unsupported Spectrum content");
        return null;
    }
  }

  private getReplyToMessageId(message: SpectrumMessageLike): string {
    const direct = this.firstPresentString([
      message.parentId,
      message.threadOriginatorGuid,
    ]);
    return direct || this.extractReplyToMessageId(message) || "";
  }

  private extractReplyToMessageId(value: unknown): string {
    const record = this.asRecord(value);
    if (!record) {
      return "";
    }

    const direct = this.firstString(record, [
      "parentId",
      "threadOriginatorGuid",
      "thread_originator_guid",
      "replyToGuid",
      "reply_to_guid",
      "replyToId",
      "reply_to_id",
    ]);
    if (direct) {
      return direct;
    }

    const raw = this.extractReplyToMessageId(record["raw"]);
    if (raw) {
      return raw;
    }

    return this.extractReplyToMessageId(record["_raw"]);
  }

  private async getAttachmentContent(
    message: SpectrumMessageLike,
    content: SpectrumAttachmentContent,
  ): Promise<RoutedContent> {
    return {
      text: this.extractRawText(message),
      attachments: [await this.createAttachment({
        id: message.id,
        filename: content.name,
        mimeType: content.mimeType,
        size: content.size,
        data: await content.read(),
      })],
    };
  }

  private async getVoiceContent(message: SpectrumMessageLike, content: SpectrumVoiceContent): Promise<RoutedContent> {
    return {
      text: this.extractRawText(message),
      attachments: [await this.createAttachment({
        id: message.id,
        filename: content.name ?? "voice-message.m4a",
        mimeType: content.mimeType,
        size: content.size,
        data: await content.read(),
        audioKind: "voice_note",
      })],
    };
  }

  private getCustomContent(content: SpectrumCustomContent): RoutedContent | null {
    const text = this.extractRawText(content.raw);
    return text ? { text, attachments: [] } : null;
  }

  private async getGroupContent(message: SpectrumMessageLike, content: SpectrumGroupContent): Promise<RoutedContent | null> {
    const textParts: string[] = [];
    const attachments: Attachment[] = [];

    const parentText = this.extractRawText(message);
    if (parentText) {
      textParts.push(parentText);
    }

    for (const item of content.items) {
      const routedItem = await this.getMessageContent(item);
      if (!routedItem) {
        continue;
      }

      if (routedItem.text) {
        textParts.push(routedItem.text);
      }
      attachments.push(...routedItem.attachments);
    }

    const text = this.joinText(textParts);
    if (!text && attachments.length === 0) {
      return null;
    }

    return { text, attachments };
  }

  private joinText(parts: string[]): string {
    const seen = new Set<string>();
    const uniqueParts: string[] = [];

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      uniqueParts.push(trimmed);
    }

    return uniqueParts.join("\n");
  }

  private extractRawText(value: unknown): string {
    const record = this.asRecord(value);
    if (!record) {
      return "";
    }

    const direct = this.firstString(record, ["text", "caption", "body", "messageText"]);
    if (direct) {
      return direct;
    }

    const content = this.asRecord(record["content"]);
    if (content) {
      const contentText = this.firstString(content, ["text", "caption", "body", "messageText"]);
      if (contentText) {
        return contentText;
      }

      const rawContentText = this.extractRawText(content["raw"]);
      if (rawContentText) {
        return rawContentText;
      }
    }

    return this.extractRawText(record["raw"]) || this.extractRawText(record["_raw"]);
  }

  private firstString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return "";
  }

  private firstPresentString(values: Array<string | undefined>): string {
    for (const value of values) {
      if (value?.trim()) {
        return value.trim();
      }
    }

    return "";
  }

  private getContentType(content: SpectrumContent): string {
    return "type" in content ? String(content.type) : "unknown";
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  }

  private createAttachment(input: {
    id: string;
    filename: string;
    mimeType: string;
    size?: number;
    data: Buffer;
    audioKind?: "voice_note" | "audio";
  }): Attachment {
    return {
      id: generateId("att"),
      url: `spectrum:${input.id}`,
      mimeType: input.mimeType,
      filename: input.filename,
      size: input.size ?? input.data.length,
      data: input.data,
      originalUrl: `spectrum:${input.id}`,
      ...(input.audioKind ? { audioKind: input.audioKind } : {}),
    };
  }

  private summarizeContact(contact: Contact): string {
    const fields = [
      contact.name?.formatted ?? [contact.name?.first, contact.name?.last].filter(Boolean).join(" "),
      ...(contact.phones ?? []).map((phone) => phone.value),
      ...(contact.emails ?? []).map((email) => email.value),
      ...(contact.urls ?? []),
      contact.org?.name,
      contact.note,
    ].filter((value): value is string => Boolean(value?.trim()));

    return fields.length > 0
      ? `[Contact card received]\n${fields.join("\n")}`
      : "[Contact card received]";
  }
}
