import { createLogger, type AppConfig, type InboundMessage, type UserMessage, type UserMessagePart } from "@finn/core";

const logger = createLogger("hot-path-ingress");

type NonUserInboundMessage = Exclude<InboundMessage, UserMessage>;

type MessageHandler = {
  handleMessage(message: InboundMessage): Promise<string | null>;
};

type UserTurnAcceptedHandler = (message: UserMessage) => Promise<void> | void;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface HotPathIngressCoordinatorDeps {
  config: Pick<AppConfig, "hotPathIngress">;
  handler: MessageHandler;
  onUserTurnAccepted?: UserTurnAcceptedHandler;
}

export class HotPathIngressCoordinator {
  private readonly handler: MessageHandler;
  private readonly onUserTurnAccepted?: UserTurnAcceptedHandler;
  private readonly userGroupingWindowMs: number;
  private readonly maxCoalesceMessages: number;

  private readonly pendingUserParts: UserMessagePart[] = [];
  private readonly pendingInternalMessages: NonUserInboundMessage[] = [];
  private pendingUserMeta: Pick<UserMessage, "tenantId" | "userId" | "phoneNumber"> | null = null;

  private groupingTimer: TimerHandle | null = null;
  private turnInFlight = false;
  private drainScheduled = false;

  constructor(deps: HotPathIngressCoordinatorDeps) {
    this.handler = deps.handler;
    this.onUserTurnAccepted = deps.onUserTurnAccepted;
    this.userGroupingWindowMs = deps.config.hotPathIngress.userGroupingWindowMs;
    this.maxCoalesceMessages = deps.config.hotPathIngress.maxCoalesceMessages;
  }

  enqueueUser(message: UserMessage): void {
    const parts = message.parts ?? [this.toPart(message)];
    this.pendingUserMeta ??= {
      tenantId: message.tenantId,
      userId: message.userId,
      phoneNumber: message.phoneNumber,
    };
    this.pendingUserParts.push(...parts);

    if (this.pendingUserParts.length >= this.maxCoalesceMessages) {
      this.clearGroupingTimer();
      this.scheduleDrain();
      return;
    }

    if (!this.turnInFlight) {
      this.startGroupingTimer();
    }
  }

  enqueueInternal(message: NonUserInboundMessage): void {
    this.pendingInternalMessages.push(message);
    this.scheduleDrain();
  }

  updateUser(user: Pick<UserMessage, "phoneNumber">): void {
    if (this.pendingUserMeta) {
      this.pendingUserMeta.phoneNumber = user.phoneNumber;
    }
  }

  private startGroupingTimer(): void {
    this.clearGroupingTimer();
    this.groupingTimer = setTimeout(() => {
      this.groupingTimer = null;
      this.scheduleDrain();
    }, this.userGroupingWindowMs);
  }

  private clearGroupingTimer(): void {
    if (this.groupingTimer) {
      clearTimeout(this.groupingTimer);
      this.groupingTimer = null;
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.turnInFlight) {
      return;
    }

    const nextMessage = this.takeNextMessage();
    if (!nextMessage) {
      return;
    }

    this.turnInFlight = true;

    try {
      this.notifyUserTurnAccepted(nextMessage);
      await this.handler.handleMessage(nextMessage);
    } catch (error) {
      logger.error({ error, source: nextMessage.source }, "Failed to process queued inbound message");
    } finally {
      this.turnInFlight = false;
    }

    if (this.hasPendingWork()) {
      this.scheduleDrain();
    }
  }

  private notifyUserTurnAccepted(message: InboundMessage): void {
    if (message.source !== "user" || !this.onUserTurnAccepted) {
      return;
    }

    try {
      void Promise.resolve(this.onUserTurnAccepted(message)).catch((error) => {
        logger.warn({ error, messageId: message.messageId }, "Failed to mark accepted user turn as read");
      });
    } catch (error) {
      logger.warn({ error, messageId: message.messageId }, "Failed to mark accepted user turn as read");
    }
  }

  private takeNextMessage(): InboundMessage | null {
    const userReady = this.pendingUserParts.length > 0 && this.groupingTimer === null;

    if (userReady) {
      return this.buildCoalescedUserMessage();
    }

    if (this.pendingUserParts.length > 0) {
      return null;
    }

    if (this.pendingInternalMessages.length > 0) {
      return this.pendingInternalMessages.shift() ?? null;
    }

    return null;
  }

  private hasPendingWork(): boolean {
    return this.pendingUserParts.length > 0 || this.pendingInternalMessages.length > 0;
  }

  private buildCoalescedUserMessage(): UserMessage {
    const parts = this.pendingUserParts.splice(0, this.maxCoalesceMessages);
    const meta = this.pendingUserMeta;
    const attachments = parts.flatMap((part) => part.attachments ?? []);
    const latestPart = parts.at(-1) ?? parts[0];

    if (!latestPart || !meta) {
      throw new Error("Cannot build a coalesced user message without parts.");
    }

    if (this.pendingUserParts.length === 0) {
      this.pendingUserMeta = null;
    }

    return {
      source: "user",
      ...meta,
      content: parts.map((part) => part.content).join("\n\n"),
      ...(attachments.length > 0 ? { attachments } : {}),
      messageId: latestPart.messageId,
      ...(latestPart.replyToMessageId ? { replyToMessageId: latestPart.replyToMessageId } : {}),
      timestamp: latestPart.timestamp,
      parts,
    };
  }

  private toPart(message: UserMessage): UserMessagePart {
    return {
      content: message.content,
      attachments: message.attachments,
      messageId: message.messageId,
      replyToMessageId: message.replyToMessageId,
      timestamp: message.timestamp,
    };
  }
}
