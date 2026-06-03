import { createLogger, getTracer, normalizePhoneNumber, withSpan, type AppConfig, type UserContext, type UserMessage } from "@finn/core";
import { getIMessageSpacePhone, isIMessageDmSpace, MessageRouter, SpectrumClient, type SpectrumInboundMessage } from "@finn/messaging";
import type { Space } from "spectrum-ts";
import type { UserRegistry } from "./user-registry.js";

const logger = createLogger("spectrum-ingress");
const tracer = getTracer("spectrum-ingress");

type SpectrumIngressDeps = {
  config: AppConfig;
  client: SpectrumClient;
  router: MessageRouter;
  users: UserRegistry;
  agent: {
    enqueueUser(message: UserMessage): void | Promise<void>;
  };
  sendContactCard?: (user: UserContext) => Promise<void>;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
};

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

export class SpectrumIngress {
  private stopped = false;
  private runPromise?: Promise<void>;
  private failures = 0;
  private reconnectSleep?: {
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  };

  constructor(private readonly deps: SpectrumIngressDeps) {}

  start(): void {
    if (this.runPromise) {
      return;
    }

    this.stopped = false;
    this.runPromise = this.run().catch((error: unknown) => {
      if (!this.stopped) {
        logger.error({ error }, "Spectrum ingress stopped unexpectedly");
      }
    }).finally(() => {
      this.runPromise = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelReconnectSleep();
    await this.deps.client.stop();
    await this.runPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.deps.client.start();
        await this.consumeMessages();
        if (!this.stopped) {
          throw new Error("Spectrum message stream ended");
        }
      } catch (error) {
        if (this.stopped) {
          return;
        }

        this.failures += 1;
        const delayMs = this.nextReconnectDelayMs();
        logger.error({ error, failures: this.failures, delayMs }, "Spectrum ingress stream failed; restarting");
        await this.sleepBeforeReconnect(delayMs);
        await this.restartClient();
      }
    }
  }

  private async consumeMessages(): Promise<void> {
    for await (const [space, message] of this.deps.client.messages) {
      if (this.stopped) {
        return;
      }
      await this.handleMessage(space, message);
      this.failures = 0;
    }
  }

  private async restartClient(): Promise<void> {
    try {
      await this.deps.client.restart();
    } catch (error) {
      logger.error({ error }, "Spectrum client restart failed");
    }
  }

  private nextReconnectDelayMs(): number {
    const initialDelayMs = this.deps.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    const maxDelayMs = this.deps.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    return Math.min(initialDelayMs * 2 ** Math.max(this.failures - 1, 0), maxDelayMs);
  }

  private async sleepBeforeReconnect(delayMs: number): Promise<void> {
    if (delayMs <= 0 || this.stopped) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.reconnectSleep = undefined;
        resolve();
      }, delayMs);
      this.reconnectSleep = { timer, resolve };
    });
  }

  private cancelReconnectSleep(): void {
    const sleep = this.reconnectSleep;
    if (!sleep) {
      return;
    }

    clearTimeout(sleep.timer);
    this.reconnectSleep = undefined;
    sleep.resolve();
  }

  private async handleMessage(space: Space, message: SpectrumInboundMessage): Promise<void> {
    await withSpan(tracer, "spectrum.ingress.message", {
      "message.id": message.id,
      "message.platform": message.platform,
      "message.content_type": message.content.type,
    }, async (span) => {
      if (message.platform !== "iMessage" || space.__platform !== "iMessage") {
        span.setAttribute("spectrum.skipped", "unsupported_platform");
        return;
      }

      if (!isIMessageDmSpace(space)) {
        logger.info({ spaceId: space.id }, "Skipping non-DM Spectrum iMessage space");
        span.setAttribute("spectrum.skipped", "non_dm_space");
        return;
      }

      const sender = normalizePhoneNumber(message.sender.id);
      const allowedNumbers = this.deps.config.spectrum.allowedNumbers?.map(normalizePhoneNumber);
      if (allowedNumbers?.length && !allowedNumbers.includes(sender)) {
        logger.info({ sender }, "Rejected Spectrum message from non-allowed sender");
        span.setAttribute("spectrum.skipped", "number_not_allowed");
        return;
      }

      const { user, created } = await this.deps.users.getOrCreateByPhone(sender);
      this.deps.client.rememberInboundMessage(user.phoneNumber, space, message);
      const routed = await this.deps.router.routeSpectrumMessage(message, user);
      if (!routed) {
        logger.info({ messageId: message.id, contentType: message.content.type }, "Skipping unsupported Spectrum content type");
        span.setAttribute("spectrum.skipped", "unsupported_content");
        return;
      }

      if (created) {
        await this.deps.sendContactCard?.(user);
      }

      span.setAttribute("spectrum.routed", true);
      span.setAttribute("spectrum.line_phone", getIMessageSpacePhone(space) ?? "unknown");
      await this.deps.agent.enqueueUser(routed);
    });
  }
}
