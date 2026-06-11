import { MessagingError, RateLimiter, createLogger, getTracer, withSpan } from "@finn/core";
import type { AppConfig, TapbackType } from "@finn/core";
import { Spectrum, attachment, contact, voice, type Contact, type Message, type Space, type SpectrumInstance } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const logger = createLogger("messaging:spectrum");
const tracer = getTracer("spectrum");

type SpectrumClientConfig = Pick<AppConfig["spectrum"], "projectId" | "projectSecret" | "dedicatedLinePhone">;

type SendFileInput = {
  path: string;
  filename: string;
  mimeType: string;
};

type SendVoiceInput = SendFileInput & {
  duration?: number;
};

export type SendMessageOptions = {
  replyToMessageHandle?: string;
};

export type SendMessageResult = {
  messageIds: string[];
  replyToMessageHandle?: string;
  threaded: boolean;
  fallback: boolean;
};

type ContactCardInput = {
  name: string;
  phoneNumber?: string;
  photo?: {
    mimeType: string;
    data: Buffer;
  };
};

export type SpectrumCloudUserType = "shared" | "dedicated";

export type SpectrumCloudUser = {
  id: string;
  type: SpectrumCloudUserType;
  phoneNumber: string;
  assignedPhoneNumber: string;
};

type IMessageSpace = Space & {
  type?: "dm" | "group";
  phone?: string;
};

export type SpectrumInboundMessage = Message & {
  direction: "inbound";
  sender: NonNullable<Message["sender"]>;
};
export type { Contact };

export class SpectrumClient {
  private app?: SpectrumInstance;
  private readonly rateLimiter: RateLimiter;
  private readonly spacesByRecipient = new Map<string, Space>();
  private readonly linePhonesByRecipient = new Map<string, string>();
  private readonly messagesById = new Map<string, Message>();
  private readonly sendQueuesByRecipient = new Map<string, Promise<void>>();

  constructor(private readonly config: SpectrumClientConfig) {
    this.rateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 1000, name: "spectrum" });
  }

  async start(): Promise<SpectrumInstance> {
    if (this.app) {
      return this.app;
    }

    this.app = await withSpan(tracer, "spectrum.start", {}, async () => Spectrum({
      projectId: this.config.projectId,
      projectSecret: this.config.projectSecret,
      providers: [imessage.config()],
    }));

    logger.info("Spectrum iMessage client started");
    return this.app;
  }

  async stop(): Promise<void> {
    await this.closeApp({ clearRecipientLines: true });
  }

  async restart(): Promise<SpectrumInstance> {
    await this.closeApp({ clearRecipientLines: false });
    return this.start();
  }

  private async closeApp(options: { clearRecipientLines: boolean }): Promise<void> {
    const app = this.app;
    if (!app) {
      return;
    }

    this.app = undefined;
    try {
      await app.stop();
    } finally {
      this.spacesByRecipient.clear();
      this.messagesById.clear();
      if (options.clearRecipientLines) {
        this.linePhonesByRecipient.clear();
      }
    }

    logger.info("Spectrum iMessage client stopped");
  }

  get messages(): AsyncIterable<[Space, SpectrumInboundMessage]> {
    if (!this.app) {
      throw new Error("Spectrum client has not started.");
    }

    return this.app.messages as AsyncIterable<[Space, SpectrumInboundMessage]>;
  }

  rememberInboundMessage(recipient: string, space: Space, message: SpectrumInboundMessage): void {
    this.spacesByRecipient.set(recipient, space);
    const linePhone = getIMessageSpacePhone(space);
    if (linePhone) {
      this.linePhonesByRecipient.set(recipient, linePhone);
    }
    this.messagesById.set(message.id, message);
  }

  rememberRecipientLine(recipient: string, linePhone: string | null | undefined): void {
    if (linePhone) {
      this.linePhonesByRecipient.set(recipient, linePhone);
    }
  }

  async provisionUser(phoneNumber: string): Promise<SpectrumCloudUser> {
    const dedicatedLinePhone = this.config.dedicatedLinePhone;
    const body = dedicatedLinePhone
      ? { type: "dedicated", phoneNumber, assignedPhoneNumber: dedicatedLinePhone }
      : { type: "shared", phoneNumber };

    const response = await fetch(`https://spectrum.photon.codes/projects/${encodeURIComponent(this.config.projectId)}/users/`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${this.config.projectId}:${this.config.projectSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as {
      succeed?: boolean;
      data?: SpectrumCloudUser;
      error?: string;
      message?: string;
    } | null;

    if (!response.ok || payload?.succeed !== true || !payload.data) {
      const detail = payload?.error ?? payload?.message ?? response.statusText;
      throw new MessagingError(`Spectrum user provisioning failed: ${detail}`, "spectrum");
    }

    this.rememberRecipientLine(phoneNumber, payload.data.assignedPhoneNumber);
    return payload.data;
  }

  async sendText(to: string, text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
    return this.withSendSlot("sendText", to, {
      to,
      length: text.length,
      replyToMessageHandle: options.replyToMessageHandle,
    }, async () => {
      const space = await this.resolveDmSpace(to);
      const replyToMessageHandle = options.replyToMessageHandle?.trim();

      if (replyToMessageHandle) {
        const target = await this.tryResolveMessage(to, replyToMessageHandle);
        const reply = target ? await target.reply(text) : undefined;

        if (reply) {
          this.messagesById.set(reply.id, reply);
          return {
            messageIds: [reply.id],
            replyToMessageHandle,
            threaded: true,
            fallback: false,
          };
        }

        const fallback = await space.send(text);
        if (fallback) {
          this.messagesById.set(fallback.id, fallback);
        }

        return {
          messageIds: fallback ? [fallback.id] : [],
          replyToMessageHandle,
          threaded: false,
          fallback: true,
        };
      }

      const sent = await space.send(text);
      if (sent) {
        this.messagesById.set(sent.id, sent);
      }

      return {
        messageIds: sent ? [sent.id] : [],
        threaded: false,
        fallback: false,
      };
    });
  }

  async sendAttachment(to: string, input: SendFileInput, caption?: string): Promise<void> {
    await this.withSendSlot("sendAttachment", to, { to, filename: input.filename, mimeType: input.mimeType }, async () => {
      const space = await this.resolveDmSpace(to);
      if (caption?.trim()) {
        await space.send(caption.trim());
      }
      await space.send(attachment(input.path, { name: input.filename, mimeType: input.mimeType }));
    });
  }

  async sendVoice(to: string, input: SendVoiceInput, options: SendMessageOptions = {}): Promise<SendMessageResult> {
    return this.withSendSlot("sendVoice", to, {
      to,
      filename: input.filename,
      mimeType: input.mimeType,
      replyToMessageHandle: options.replyToMessageHandle,
    }, async () => {
      const space = await this.resolveDmSpace(to);
      const content = voice(input.path, {
        name: input.filename,
        mimeType: input.mimeType,
        ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
      });
      const replyToMessageHandle = options.replyToMessageHandle?.trim();

      if (replyToMessageHandle) {
        const target = await this.tryResolveMessage(to, replyToMessageHandle);
        const reply = target ? await target.reply(content) : undefined;

        if (reply) {
          this.messagesById.set(reply.id, reply);
          return {
            messageIds: [reply.id],
            replyToMessageHandle,
            threaded: true,
            fallback: false,
          };
        }

        const fallback = await space.send(content);
        if (fallback) {
          this.messagesById.set(fallback.id, fallback);
        }

        return {
          messageIds: fallback ? [fallback.id] : [],
          replyToMessageHandle,
          threaded: false,
          fallback: true,
        };
      }

      const sent = await space.send(content);
      if (sent) {
        this.messagesById.set(sent.id, sent);
      }

      return {
        messageIds: sent ? [sent.id] : [],
        threaded: false,
        fallback: false,
      };
    });
  }

  async sendContactCard(to: string, input: ContactCardInput): Promise<void> {
    await this.withSendSlot("sendContactCard", to, { to, name: input.name }, async () => {
      const space = await this.resolveDmSpace(to);
      const photo = input.photo;
      await space.send(contact({
        name: { formatted: input.name, first: input.name },
        ...(input.phoneNumber ? { phones: [{ value: input.phoneNumber, type: "mobile" as const }] } : {}),
        ...(photo ? { photo: { mimeType: photo.mimeType, read: async () => photo.data } } : {}),
      }));
    });
  }

  async sendReaction(to: string, messageId: string, reaction: TapbackType): Promise<void> {
    await this.withSendSlot("sendReaction", to, { to, messageId, reaction }, async () => {
      const message = await this.resolveMessage(to, messageId);
      await message.react(toTapbackEmoji(reaction));
    });
  }

  async startTyping(to: string): Promise<void> {
    const space = await this.resolveDmSpace(to);
    await space.startTyping();
  }

  async stopTyping(to: string): Promise<void> {
    const space = await this.resolveDmSpace(to);
    await space.stopTyping();
  }

  async markRead(_to: string): Promise<void> {
    // Spectrum's public Space API does not expose mark-read for iMessage.
  }

  private async resolveMessage(to: string, messageId: string): Promise<Message> {
    const message = await this.tryResolveMessage(to, messageId);
    if (!message) {
      throw new MessagingError(`Spectrum message not found for reaction target: ${messageId}`, "spectrum");
    }

    return message;
  }

  private async tryResolveMessage(to: string, messageId: string): Promise<Message | undefined> {
    const remembered = this.messagesById.get(messageId);
    if (remembered) {
      return remembered;
    }

    const space = await this.resolveDmSpace(to);
    const message = await space.getMessage(messageId);
    if (message) {
      this.messagesById.set(message.id, message);
    }

    return message;
  }

  private async resolveDmSpace(to: string): Promise<Space> {
    const remembered = this.spacesByRecipient.get(to);
    if (remembered) {
      return remembered;
    }

    const app = await this.start();
    const im = imessage(app);
    const user = await im.user(to);
    const linePhone = this.linePhonesByRecipient.get(to) ?? this.config.dedicatedLinePhone;
    const space = linePhone
      ? await im.space(user, { phone: linePhone })
      : await im.space(user);
    this.spacesByRecipient.set(to, space);
    return space;
  }

  private async withSendSlot<T>(operation: string, to: string, meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const previous = this.sendQueuesByRecipient.get(to) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.sendQueuesByRecipient.set(to, queued);

    await previous.catch(() => undefined);

    try {
      return await withSpan(tracer, `spectrum.${operation}`, {}, async () => {
        const waitedMs = await this.rateLimiter.waitForSlot();
        if (waitedMs > 0) {
          logger.debug({ operation, waitedMs, ...meta }, "Waited for Spectrum rate limiter slot");
        }

        try {
          return await fn();
        } catch (error) {
          logger.error({ error, operation, ...meta }, "Spectrum messaging operation failed");
          throw new MessagingError(
            `Spectrum ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
            "spectrum",
          );
        }
      });
    } finally {
      releaseCurrent();
      if (this.sendQueuesByRecipient.get(to) === queued) {
        this.sendQueuesByRecipient.delete(to);
      }
    }
  }
}

export function isIMessageDmSpace(space: Space): boolean {
  if (space.__platform !== "iMessage") {
    return false;
  }

  const imessageSpace = space as IMessageSpace;
  return imessageSpace.type === "dm";
}

export function getIMessageSpacePhone(space: Space): string | null {
  if (space.__platform !== "iMessage") {
    return null;
  }

  const imessageSpace = space as IMessageSpace;
  return imessageSpace.phone ?? null;
}

function toTapbackEmoji(reaction: TapbackType): string {
  switch (reaction) {
    case "love":
      return "❤️";
    case "like":
      return "👍";
    case "dislike":
      return "👎";
    case "laugh":
      return "😂";
    case "emphasize":
      return "‼️";
    case "question":
      return "❓";
  }
}
