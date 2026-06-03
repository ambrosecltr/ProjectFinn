import { propagation, type AttributeValue, type Span } from "@opentelemetry/api";
import type { UserContext } from "./types.js";

export type FinnTelemetryInput = {
  functionId: string;
  user?: Pick<UserContext, "tenantId" | "userId" | "phoneNumber" | "displayName">;
  processType?: string;
  conversationId?: string;
  workerId?: string;
  runId?: string;
  metadata?: Record<string, AttributeValue>;
};

export type FinnTelemetryContext = {
  distinctId: string;
  attributes: Record<string, AttributeValue>;
};

const baggagePrefix = "finn.telemetry.";

function getDistinctId(input: Pick<FinnTelemetryInput, "functionId" | "processType" | "user">): string {
  if (input.user) {
    return `finn:${input.user.tenantId}:${input.user.userId}`;
  }

  return `finn:system:${input.processType ?? input.functionId}`;
}

function getSessionId(input: FinnTelemetryInput): string | undefined {
  return input.conversationId ?? input.workerId ?? input.runId;
}

export function isFinnTelemetryEnabled(): boolean {
  const provider = process.env["TELEMETRY_PROVIDER"];
  if (provider && provider !== "posthog") {
    return false;
  }

  return Boolean(process.env["POSTHOG_API_KEY"]);
}

export function createFinnTelemetryContext(input: FinnTelemetryInput): FinnTelemetryContext {
  const distinctId = getDistinctId(input);
  const sessionId = getSessionId(input);
  const displayName = input.user?.displayName?.trim();
  const attributes: Record<string, AttributeValue> = {
    posthog_distinct_id: distinctId,
    "ai.finn.span": true,
    ...(sessionId ? { "$ai_session_id": sessionId } : {}),
    ...(input.user ? {
      tenantId: input.user.tenantId,
      userId: input.user.userId,
      phoneNumber: input.user.phoneNumber,
      "user.id": distinctId,
      "enduser.id": distinctId,
      "user.phone": input.user.phoneNumber,
      ...(displayName ? {
        displayName,
        "user.name": displayName,
      } : {}),
      "ai.finn.tenantId": input.user.tenantId,
      "ai.finn.userId": input.user.userId,
      "ai.finn.phoneNumber": input.user.phoneNumber,
      ...(displayName ? { "ai.finn.displayName": displayName } : {}),
    } : {}),
    ...(input.processType ? {
      processType: input.processType,
      "ai.finn.processType": input.processType,
    } : {}),
    ...(input.conversationId ? {
      conversationId: input.conversationId,
      "ai.finn.conversationId": input.conversationId,
    } : {}),
    ...(input.workerId ? {
      workerId: input.workerId,
      "ai.finn.workerId": input.workerId,
    } : {}),
    ...(input.runId ? {
      runId: input.runId,
      "ai.finn.runId": input.runId,
    } : {}),
    ...Object.fromEntries(Object.entries(input.metadata ?? {}).map(([key, value]) => [`ai.finn.${key}`, value])),
  };

  return { distinctId, attributes };
}

export function createFinnTelemetry(input: FinnTelemetryInput) {
  const context = createFinnTelemetryContext(input);
  const metadata: Record<string, AttributeValue> = {
    ...input.metadata,
    ...context.attributes,
  };

  return {
    isEnabled: isFinnTelemetryEnabled(),
    functionId: input.functionId,
    recordInputs: true,
    recordOutputs: true,
    metadata,
  };
}

export function createFinnTelemetryBaggage(context: FinnTelemetryContext) {
  const entries: Record<string, { value: string }> = {};
  for (const [key, value] of Object.entries(context.attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entries[`${baggagePrefix}${key}`] = { value: String(value) };
    }
  }

  return propagation.createBaggage(entries);
}

export function getFinnTelemetryContextFromBaggage(): FinnTelemetryContext | undefined {
  const baggage = propagation.getActiveBaggage();
  if (!baggage) {
    return undefined;
  }

  const attributes: Record<string, AttributeValue> = {};
  for (const [key, entry] of baggage.getAllEntries()) {
    if (key.startsWith(baggagePrefix)) {
      attributes[key.slice(baggagePrefix.length)] = entry.value;
    }
  }

  const distinctId = typeof attributes.posthog_distinct_id === "string" ? attributes.posthog_distinct_id : undefined;
  return distinctId ? { distinctId, attributes } : undefined;
}

export function setFinnTelemetrySpanAttributes(span: Span, telemetryContext?: FinnTelemetryContext): void {
  const context = telemetryContext ?? getFinnTelemetryContextFromBaggage();
  if (!context) {
    return;
  }

  for (const [key, value] of Object.entries(context.attributes)) {
    span.setAttribute(key, value);
  }
}
