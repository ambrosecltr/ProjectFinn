/**
 * PostHog AI SDK telemetry bootstrap — import this FIRST in your entry point.
 *
 * Telemetry is optional. It starts only when PostHog is configured with
 * POSTHOG_API_KEY and TELEMETRY_PROVIDER is unset or set to posthog.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { propagation, type AttributeValue, type Context, type SpanContext } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const telemetryProviders = ["none", "posthog"] as const;
type TelemetryProvider = typeof telemetryProviders[number];
const finnSpanAttributeKeys = ["ai.finn.span", "ai.telemetry.metadata.ai.finn.span"] as const;
const finnBaggageSpanKey = "finn.telemetry.ai.finn.span";
const maxTrackedFinnTraces = 10_000;

function isTestRuntime(): boolean {
  return process.argv.some((arg) => arg.includes("bun-debug") || arg.endsWith("/bun") && process.env["BUN_TEST"] === "true")
    || process.argv.some((arg) => arg.includes("/bun-test"))
    || process.env["NODE_ENV"] === "test";
}

function createResource(serviceName: string) {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env["OTEL_SERVICE_VERSION"] ?? "1.0.0",
    "deployment.environment": process.env["NODE_ENV"] ?? "production",
  });
}

function registerShutdown(): void {
  const gracefulShutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      // Best-effort flush only; process shutdown should not fail because telemetry did.
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown());
  process.on("SIGINT", () => void gracefulShutdown());
}

function isTruthyTelemetryMarker(value: AttributeValue | undefined): boolean {
  return value === true || value === "true";
}

function hasFinnTelemetryAttribute(span: Pick<ReadableSpan, "attributes">): boolean {
  return finnSpanAttributeKeys.some((key) => isTruthyTelemetryMarker(span.attributes[key]));
}

function hasFinnTelemetryBaggage(parentContext: Context): boolean {
  return propagation.getBaggage(parentContext)?.getEntry(finnBaggageSpanKey)?.value === "true";
}

function spanKey(spanContext: SpanContext): string {
  return `${spanContext.traceId}:${spanContext.spanId}`;
}

export class FinnTelemetrySpanProcessor implements SpanProcessor {
  private readonly finnSpanKeys = new Set<string>();
  private readonly finnTraceIds = new Set<string>();
  private readonly finnTraceQueue: string[] = [];

  constructor(private readonly delegate: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    if (this.isFinnSpan(span, parentContext)) {
      this.markFinnSpan(span);
    }
    this.delegate.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    if (this.isFinnSpan(span)) {
      this.markFinnSpan(span);
    }
    this.delegate.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    if (this.isFinnSpan(span)) {
      this.markFinnSpan(span);
    }

    if (this.shouldExport(span)) {
      this.delegate.onEnd(span);
    }
    this.finnSpanKeys.delete(spanKey(span.spanContext()));
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  private isFinnSpan(span: ReadableSpan, parentContext?: Context): boolean {
    if (hasFinnTelemetryAttribute(span)) {
      return true;
    }
    if (parentContext && hasFinnTelemetryBaggage(parentContext)) {
      return true;
    }

    const context = span.spanContext();
    if (this.finnTraceIds.has(context.traceId)) {
      return true;
    }
    if (span.parentSpanContext && this.finnSpanKeys.has(spanKey(span.parentSpanContext))) {
      return true;
    }

    return false;
  }

  private markFinnSpan(span: ReadableSpan): void {
    const context = span.spanContext();
    this.finnSpanKeys.add(spanKey(context));
    this.rememberFinnTrace(context.traceId);
  }

  private shouldExport(span: ReadableSpan): boolean {
    const context = span.spanContext();
    return this.finnTraceIds.has(context.traceId) || hasFinnTelemetryAttribute(span);
  }

  private rememberFinnTrace(traceId: string): void {
    if (this.finnTraceIds.has(traceId)) {
      return;
    }

    this.finnTraceIds.add(traceId);
    this.finnTraceQueue.push(traceId);
    while (this.finnTraceQueue.length > maxTrackedFinnTraces) {
      const expiredTraceId = this.finnTraceQueue.shift();
      if (expiredTraceId) {
        this.finnTraceIds.delete(expiredTraceId);
      }
    }
  }
}

function resolveTelemetryProvider(raw?: string): TelemetryProvider {
  if (!raw) return process.env["POSTHOG_API_KEY"] ? "posthog" : "none";

  if (telemetryProviders.includes(raw as TelemetryProvider)) {
    return raw as TelemetryProvider;
  }

  console.warn(`[otel-bootstrap] unsupported TELEMETRY_PROVIDER=${raw}; only posthog is supported, telemetry disabled`);
  return "none";
}

let sdk: NodeSDK | undefined;
const telemetryProvider = isTestRuntime() ? "none" : resolveTelemetryProvider(process.env["TELEMETRY_PROVIDER"]);

if (telemetryProvider === "posthog") {
  const apiKey = process.env["POSTHOG_API_KEY"];
  if (!apiKey) {
    console.warn("[otel-bootstrap] POSTHOG_API_KEY not set — telemetry disabled");
  } else {
    const serviceName = process.env["OTEL_SERVICE_NAME"] ?? "finn";
    const host = process.env["POSTHOG_HOST"] ?? "https://us.i.posthog.com";

    console.log("[otel-bootstrap] initializing", {
      provider: telemetryProvider,
      serviceName,
      host,
    });

    try {
      sdk = new NodeSDK({
        resource: createResource(serviceName),
        spanProcessors: [new FinnTelemetrySpanProcessor(new PostHogSpanProcessor({ apiKey, host }))],
      });

      sdk.start();
      console.log("[otel-bootstrap] SDK started successfully");
    } catch (err) {
      console.error("[otel-bootstrap] SDK failed to start:", err);
      sdk = undefined;
    }

    registerShutdown();
  }
} else {
  console.log("[otel-bootstrap] telemetry disabled");
}

export { sdk as otelSdk };
