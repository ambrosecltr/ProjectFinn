import { createLogger, generateId, type ActivityFeedEvent, type ActivityFeedPatternAction, type EventBus, type PatternRecord } from "@finn/core";
import type { MemoryRuntimeService } from "@finn/runtime";

const logger = createLogger("activity-feed");

export type ActivityFeedPatternOrigin = ActivityFeedEvent["origin"];

export function buildPatternActivityFeedEvent(input: {
  pattern: PatternRecord;
  action: ActivityFeedPatternAction;
  origin: ActivityFeedPatternOrigin;
  occurredAt?: Date;
  eventId?: string;
}): ActivityFeedEvent {
  const occurredAt = input.occurredAt ?? new Date();
  return {
    type: "activity_feed_event",
    tenantId: input.pattern.tenantId,
    userId: input.pattern.userId,
    eventId: input.eventId ?? generateId("act"),
    occurredAt: occurredAt.toISOString(),
    source: "finn",
    origin: input.origin,
    entityType: "pattern",
    action: input.action,
    summary: `Pattern ${input.action}: ${input.pattern.name}`,
    details: {
      patternId: input.pattern.id,
      patternName: input.pattern.name,
      workerType: input.pattern.workerType,
      triggerType: input.pattern.triggerType,
      active: input.pattern.active,
      userDescription: input.pattern.userDescription,
      nextRunAt: input.pattern.nextRunAt?.toISOString() ?? null,
    },
  };
}

export function emitPatternActivity(input: {
  eventBus: EventBus;
  pattern: PatternRecord;
  action: ActivityFeedPatternAction;
  origin: ActivityFeedPatternOrigin;
}): void {
  void input.eventBus.emit(buildPatternActivityFeedEvent(input)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, patternId: input.pattern.id, action: input.action, origin: input.origin }, "Activity feed event emit failed");
  });
}

export function wireMemoryActivityFeed(eventBus: EventBus, input: {
  getMemoryRuntime: (event: ActivityFeedEvent) => Promise<MemoryRuntimeService | undefined>;
}): void {
  eventBus.on("activity_feed_event", async (event) => {
    try {
      await (await input.getMemoryRuntime(event))?.recorder.recordActivityFeedEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, eventId: event.eventId, userId: event.userId, tenantId: event.tenantId }, "Activity feed memory retain failed");
    }
  });
}
