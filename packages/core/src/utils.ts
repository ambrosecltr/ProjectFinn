import { nanoid } from "nanoid";
import { context } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a prefixed nanoid: e.g. "msg_V1StGXR8_Z5jdHi" */
export function generateId(prefix: string, size = 16): string {
  return `${prefix}_${nanoid(size)}`;
}

// ---------------------------------------------------------------------------
// Delay / sleep
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random integer in [min, max] inclusive */
export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/** Truncate string to maxLen, appending "…" if truncated */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

// ---------------------------------------------------------------------------
// Internal message formatting (for messages from workers/triggers)
// ---------------------------------------------------------------------------

export function formatInternalMessage(
  source: "worker" | "trigger",
  data: Record<string, unknown>,
): string {
  switch (source) {
    case "worker":
      return [
        `[Internal — message from background worker, not the user]`,
        `Task: "${data["task"]}"`,
        `Status: ${data["status"] ?? "Completed"}`,
        `Result: ${data["result"]}`,
      ].join("\n");

    case "trigger":
      return [
        `[Internal — trigger fired, not the user]`,
        `Type: ${data["triggerType"]}`,
        `Details: ${JSON.stringify(data["details"])}`,
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Event bus — simple typed EventEmitter for in-process communication
// ---------------------------------------------------------------------------

import type { ProcessEvent, UserContext } from "./types.js";

export function formatUserProfileContext(user: UserContext): string {
  return [
    "## User Profile",
    `name: ${user.displayName?.trim() || "not set"}`,
    `phone: ${user.phoneNumber}`,
    `timezone: ${user.timezone}`,
    `location: ${user.location?.trim() || "not set"}`,
  ].join("\n");
}

export function formatComposioUserId(user: Pick<UserContext, "tenantId" | "userId">): string {
  return `${user.tenantId}_${user.userId}`;
}

type AnyHandler = (event: ProcessEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<AnyHandler>>();

  on<T extends ProcessEvent["type"]>(
    type: T,
    handler: (event: Extract<ProcessEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const handlerSet = this.handlers.get(type)!;
    const wrapped: AnyHandler = (event) => handler(event as Extract<ProcessEvent, { type: T }>);
    handlerSet.add(wrapped);

    return () => {
      handlerSet.delete(wrapped);
    };
  }

  async emit(event: ProcessEvent): Promise<void> {
    const handlerSet = this.handlers.get(event.type);
    if (!handlerSet) return;

    // Capture the active OTel context at emit time so handlers
    // execute within the same trace as the emitter.
    const activeContext = context.active();

    const promises: Promise<void>[] = [];
    for (const handler of handlerSet) {
      const boundHandler = context.bind(activeContext, handler);
      const result = boundHandler(event);
      if (result instanceof Promise) {
        promises.push(result);
      }
    }
    await Promise.allSettled(promises);
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}
