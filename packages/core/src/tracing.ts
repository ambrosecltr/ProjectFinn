import { context, propagation, trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { createFinnTelemetryBaggage, setFinnTelemetrySpanAttributes, type FinnTelemetryContext } from "./telemetry.js";

const TRACER_NAME = "finn";
const TRACER_VERSION = "1.0.0";

/**
 * Get a scoped OpenTelemetry tracer for a Finn module.
 *
 * Returns a no-op tracer when no OTEL SDK is registered, so call sites are
 * always safe — zero overhead in the default (un-instrumented) deployment.
 */
export function getTracer(scope: string): Tracer {
  return trace.getTracer(`${TRACER_NAME}.${scope}`, TRACER_VERSION);
}

/**
 * Run an async function inside an OTEL span.  Automatically records
 * exceptions and sets the span status to ERROR on failure.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  telemetryContext?: FinnTelemetryContext,
): Promise<T> {
  const run = () => tracer.startActiveSpan(name, async (span) => {
    setFinnTelemetrySpanAttributes(span, telemetryContext);
    if (name.startsWith("tool.")) {
      const toolName = name.slice("tool.".length);
      span.setAttribute("$ai_span_type", "tool");
      span.setAttribute("ai.tool.name", toolName);
      span.setAttribute("tool.name", toolName);
    }

    for (const [key, value] of Object.entries(attrs)) {
      span.setAttribute(key, value);
    }

    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : "Unknown error" });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.end();
      throw error;
    }
  });

  if (!telemetryContext) {
    return run();
  }

  const nextContext = propagation.setBaggage(context.active(), createFinnTelemetryBaggage(telemetryContext));
  return context.with(nextContext, run);
}

export { SpanStatusCode } from "@opentelemetry/api";
export type { Span, Tracer } from "@opentelemetry/api";
