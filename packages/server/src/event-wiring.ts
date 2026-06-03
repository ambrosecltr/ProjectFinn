import {
  createLogger,
  generateId,
  getTracer,
  sanitizePostgresJson,
  withSpan,
  type EventBus,
  type ProcessEvent,
  type TriggerMessage,
  type InboundMessage,
  type WorkerMessage,
} from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";

interface HotPathIngress {
  enqueueInternal(message: Exclude<InboundMessage, { source: "user" }>): void | Promise<void>;
}

interface WorkerDeliveryOptions {
  markPatternRunSurfaced?: (runId: string, surfacedAt?: Date) => Promise<unknown> | unknown;
}

const logger = createLogger("event-wiring");
const tracer = getTracer("event-wiring");

const persistableEventTypes: ProcessEvent["type"][] = [
  "worker_started",
  "worker_status",
  "worker_completed",
  "worker_failed",
  "worker_cancelled",
  "compaction_complete",
  "trigger_received",
  "connector_enabled",
  "reminder_triggered",
  "pattern_run_started",
  "pattern_run_completed",
  "pattern_run_failed",
  "activity_feed_event",
  "hot_path_turn",
];

async function persistEvent(db: Database, event: ProcessEvent): Promise<void> {
  try {
    await db.insert(schema.events).values({
      id: generateId("evt"),
      tenantId: "tenantId" in event ? event.tenantId : null,
      userId: "userId" in event ? event.userId : null,
      type: event.type,
      payload: sanitizePostgresJson(event),
      processed: false,
      createdAt: new Date(),
    });
  } catch (error) {
    logger.error({ error, eventType: event.type, event }, "failed to persist event");
  }
}

export function wireEventPersistence(eventBus: EventBus, db: Database): void {
  for (const eventType of persistableEventTypes) {
    eventBus.on(eventType, async (event) => {
      await persistEvent(db, event);
    });
  }
}

export function wireWorkerDelivery(eventBus: EventBus, ingress: HotPathIngress, options: WorkerDeliveryOptions = {}): void {
  eventBus.on("worker_completed", async (event) => {
    if (event.source === "pattern") return;
    return withSpan(tracer, "delivery.worker.completed", { "worker.id": event.workerId, "worker.task": event.task }, async () => {
    try {
        const message: WorkerMessage = {
          source: "worker",
          tenantId: event.tenantId,
          userId: event.userId,
          workerId: event.workerId,
          task: event.task,
          result: event.result,
          originSource: event.originSource ?? (event.source === "user" || event.source === "pattern"
            ? event.source
            : undefined),
          originMessageId: event.originMessageId,
        };

      await ingress.enqueueInternal(message);
    } catch (error) {
      logger.error({ error, workerId: event.workerId, task: event.task }, "failed to deliver worker completion");
    }
    });
  });

  eventBus.on("worker_failed", async (event) => {
    if (event.source === "pattern") return;
    return withSpan(tracer, "delivery.worker.failed", { "worker.id": event.workerId }, async () => {
    try {
      const message: WorkerMessage = {
        source: "worker",
        tenantId: event.tenantId,
        userId: event.userId,
        workerId: event.workerId,
        task: event.task,
        result: {
          summary: "Worker failed.",
          error: event.error,
        },
        originSource: event.originSource ?? (event.source === "user" || event.source === "pattern"
          ? event.source
          : undefined),
        originMessageId: event.originMessageId,
      };

      await ingress.enqueueInternal(message);
    } catch (error) {
      logger.error({ error, workerId: event.workerId }, "failed to deliver worker failure");
    }
    });
  });

  eventBus.on("pattern_run_completed", async (event) => {
    return withSpan(tracer, "delivery.pattern.completed", { "worker.id": event.workerId, "pattern.id": event.patternId }, async () => {
      try {
        if (!event.notifyOutcome.notify) {
          logger.info({ workerId: event.workerId, patternId: event.patternId, runId: event.runId }, "suppressing pattern completion with notify=false");
          return;
        }

        const message: WorkerMessage = {
          source: "worker",
          tenantId: event.tenantId,
          userId: event.userId,
          workerId: event.workerId,
          task: event.task,
          result: event.result,
          originSource: "pattern",
          pattern: {
            id: event.patternId,
            name: event.patternName,
            triggeredBy: event.triggeredBy,
            triggerPayload: event.triggerPayload,
            notifyOutcome: event.notifyOutcome,
          },
        };

        await ingress.enqueueInternal(message);
        await options.markPatternRunSurfaced?.(event.runId);
      } catch (error) {
        logger.error({ error, workerId: event.workerId, patternId: event.patternId }, "failed to deliver pattern completion");
      }
    });
  });
}

export function wireTriggerDelivery(eventBus: EventBus, ingress: HotPathIngress, options: WorkerDeliveryOptions = {}): void {
  eventBus.on("reminder_triggered", async (event) => {
    return withSpan(tracer, "delivery.reminder", { "pattern.id": event.patternId, "pattern.run_id": event.runId }, async () => {
      try {
        const message: TriggerMessage = {
          source: "trigger",
          tenantId: event.tenantId,
          userId: event.userId,
          triggerId: event.runId,
          triggerType: "reminder",
          details: {
            patternId: event.patternId,
            patternName: event.patternName,
            runId: event.runId,
            triggeredBy: event.triggeredBy,
            triggerPayload: event.triggerPayload ?? null,
            reminder: event.reminder,
            summary: event.summary,
          },
        };
        await ingress.enqueueInternal(message);
        await options.markPatternRunSurfaced?.(event.runId);
      } catch (error) {
        logger.error({ error, patternId: event.patternId, runId: event.runId }, "failed to deliver reminder trigger");
      }
    });
  });

  eventBus.on("trigger_received", async (event) => {
    if (!event.urgent) return;
    return withSpan(tracer, "delivery.trigger", { "trigger.id": event.triggerId, "trigger.type": event.triggerType }, async () => {
    try {
      const message: TriggerMessage = {
        source: "trigger",
        tenantId: event.tenantId,
        userId: event.userId,
        triggerId: event.triggerId,
        triggerType: event.triggerType,
        details: event.details,
      };
      await ingress.enqueueInternal(message);
    } catch (error) {
      logger.error({ error, triggerId: event.triggerId }, "failed to deliver urgent trigger");
    }
    });
  });

  eventBus.on("connector_enabled", async (event) => {
    return withSpan(tracer, "delivery.connector", { "trigger.id": event.triggerId, "connector.toolkit": event.toolkitSlug }, async () => {
      try {
        const message: TriggerMessage = {
          source: "trigger",
          tenantId: event.tenantId,
          userId: event.userId,
          triggerId: event.triggerId,
          triggerType: "connector_enabled",
          details: {
            toolkitSlug: event.toolkitSlug,
            ...(event.toolkitName ? { toolkitName: event.toolkitName } : {}),
            ...(event.connectedAccountId ? { connectedAccountId: event.connectedAccountId } : {}),
            ...(event.connectionStatus ? { connectionStatus: event.connectionStatus } : {}),
          },
        };
        await ingress.enqueueInternal(message);
      } catch (error) {
        logger.error({ error, triggerId: event.triggerId, toolkitSlug: event.toolkitSlug }, "failed to deliver connector notification");
      }
    });
  });
}
