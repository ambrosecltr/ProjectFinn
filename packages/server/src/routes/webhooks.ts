import { createLogger, formatComposioUserId, getTracer, withSpan, type AppConfig, type PatternRecord, type PatternTriggerFilter } from "@finn/core";
import type { PatternScheduler, PatternStore } from "@finn/patterns";
import type { ComposioClient, ComposioIncomingTriggerPayload } from "@finn/integrations";
import { Hono } from "hono";

const logger = createLogger("webhooks");
const tracer = getTracer("webhooks");

export interface WebhookRouteDeps {
  config: AppConfig;
  composio?: ComposioClient;
  patternStore?: PatternStore;
  patternScheduler?: PatternScheduler;
}

export const webhooks = new Hono();

export function createWebhookRoutes(deps: WebhookRouteDeps): Hono {
  const app = new Hono();

  app.post("/composio", async (c) => {
    return withSpan(tracer, "webhook.composio", { "webhook.provider": "composio" }, async (span) => {
      if (!deps.composio || !deps.patternStore || !deps.patternScheduler) {
        return c.json({ error: "Composio triggers are not configured." }, 503);
      }

      const rawPayload = await c.req.text();
      const webhookSecret = deps.config.integrations?.composio?.webhookSecret;
      let payload: ComposioIncomingTriggerPayload;

      if (webhookSecret) {
        const signature = c.req.header("webhook-signature");
        const id = c.req.header("webhook-id");
        const timestamp = c.req.header("webhook-timestamp");
        if (!signature || !id || !timestamp) {
          return c.json({ error: "Missing Composio webhook signature headers." }, 401);
        }
        const verified = await deps.composio.verifyWebhook({ payload: rawPayload, signature, id, timestamp, secret: webhookSecret });
        payload = verified.payload;
      } else {
        const parsed = JSON.parse(rawPayload) as {
          metadata?: {
            trigger_id?: string;
            trigger_slug?: string;
            toolkit_slug?: string;
            user_id?: string;
            connected_account_id?: string;
            connectedAccount?: { id?: string; userId?: string };
          };
          data?: Record<string, unknown>;
          id?: string;
          type?: string;
        };
        const connectedAccountId = parsed.metadata?.connectedAccount?.id ?? parsed.metadata?.connected_account_id ?? "";
        const connectedAccountUserId = parsed.metadata?.connectedAccount?.userId ?? parsed.metadata?.user_id ?? "";
        payload = {
          id: parsed.metadata?.trigger_id ?? parsed.id ?? "",
          uuid: parsed.id ?? "",
          triggerSlug: parsed.metadata?.trigger_slug ?? "",
          toolkitSlug: parsed.metadata?.toolkit_slug ?? "",
          userId: parsed.metadata?.user_id ?? "",
          payload: parsed.data ?? {},
          originalPayload: parsed as Record<string, unknown>,
          metadata: {
            id: parsed.metadata?.trigger_id ?? parsed.id ?? "",
            uuid: parsed.id ?? "",
            triggerSlug: parsed.metadata?.trigger_slug ?? "",
            toolkitSlug: parsed.metadata?.toolkit_slug ?? "",
            triggerConfig: {},
            connectedAccount: {
              id: connectedAccountId,
              uuid: "",
              authConfigId: "",
              authConfigUUID: "",
              userId: connectedAccountUserId,
              status: "ACTIVE",
            },
          },
        };
      }

      const patterns = await findPatternsForTrigger(deps.patternStore, payload);
      const activePatterns = patterns.filter((pattern) => pattern.active);
      if (activePatterns.length === 0) {
        span.setAttribute("webhook.pattern_found", false);
        return c.json({ ok: true });
      }

      span.setAttribute("webhook.pattern_found", true);
      span.setAttribute("webhook.pattern_count", activePatterns.length);
      for (const pattern of activePatterns) {
        const triggerPayload = {
          triggerId: payload.id,
          triggerSlug: payload.triggerSlug,
          payload: payload.payload,
          originalPayload: payload.originalPayload,
        };
        if (!matchesTriggerFilters(triggerPayload, pattern.triggerFilters)) {
          await deps.patternScheduler.skipPattern(pattern, "composio", triggerPayload, "Skipped because trigger filters did not match.");
          continue;
        }

        await deps.patternScheduler.runPattern(pattern, "composio", triggerPayload);
      }
      return c.json({ ok: true });
    });
  });

  return app;
}

function getPathValue(input: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, input);
}

function extractEmailAddress(value: string): string | null {
  const match = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/.exec(value);
  return match?.[0].toLowerCase() ?? null;
}

function normalizeComparableString(value: string): string {
  return extractEmailAddress(value) ?? value.trim().toLowerCase();
}

function stringEquals(left: string, right: string): boolean {
  return left === right || normalizeComparableString(left) === normalizeComparableString(right);
}

function stringContains(value: string, expected: string): boolean {
  return value.toLowerCase().includes(expected.toLowerCase()) || normalizeComparableString(value).includes(normalizeComparableString(expected));
}

function matchesTriggerFilter(payload: Record<string, unknown>, filter: PatternTriggerFilter): boolean {
  const value = getPathValue(payload, filter.path);
  switch (filter.operator) {
    case "exists":
      return value !== undefined && value !== null;
    case "equals":
      if (typeof value === "string" && typeof filter.value === "string") return stringEquals(value, filter.value);
      return value === filter.value;
    case "not_equals":
      return value !== filter.value;
    case "contains":
      if (typeof value === "string") return stringContains(value, String(filter.value ?? ""));
      if (Array.isArray(value)) return value.includes(filter.value);
      return false;
  }
}

export function matchesTriggerFilters(payload: Record<string, unknown>, filters: PatternTriggerFilter[]): boolean {
  return filters.every((filter) => matchesTriggerFilter(payload, filter));
}

async function findPatternsForTrigger(store: PatternStore, payload: ComposioIncomingTriggerPayload): Promise<PatternRecord[]> {
  const triggerId = payload.id || payload.metadata.id;
  if (!triggerId) return [];
  const patterns = await store.getAllByComposioTriggerId(triggerId);
  return patterns.filter((pattern) => patternMatchesComposioWebhook(pattern, payload));
}

function patternMatchesComposioWebhook(pattern: PatternRecord, payload: ComposioIncomingTriggerPayload): boolean {
  if (pattern.triggerConfig.type !== "composio") {
    return false;
  }

  const metadata = payload.metadata as ComposioIncomingTriggerPayload["metadata"] & {
    toolkitSlug?: string;
    connectedAccount?: { id?: string; userId?: string };
  };
  const payloadUserId = payload.userId || metadata.connectedAccount?.userId;
  const payloadToolkitSlug = payload.toolkitSlug || metadata.toolkitSlug;
  const connectedAccountId = metadata.connectedAccount?.id;

  if (payloadUserId && payloadUserId !== pattern.userId && payloadUserId !== formatComposioUserId(pattern)) {
    return false;
  }
  if (payload.triggerSlug && payload.triggerSlug !== pattern.triggerConfig.triggerSlug) {
    return false;
  }
  if (payloadToolkitSlug && payloadToolkitSlug !== pattern.triggerConfig.toolkitSlug) {
    return false;
  }
  if (connectedAccountId && connectedAccountId !== pattern.triggerConfig.connectedAccountId) {
    return false;
  }

  return true;
}
