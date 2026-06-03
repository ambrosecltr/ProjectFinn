import { describe, expect, it } from "bun:test";
import { context as otelContext, propagation, type Attributes, type SpanContext } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { FinnTelemetrySpanProcessor } from "./otel-bootstrap.js";

function createSpanContext(traceId: string, spanId: string): SpanContext {
  return {
    traceId,
    spanId,
    traceFlags: 1,
  };
}

function createSpan(input: {
  name: string;
  traceId?: string;
  spanId: string;
  parentSpanContext?: SpanContext;
  attributes?: Attributes;
}): Span {
  const spanContext = createSpanContext(input.traceId ?? "11111111111111111111111111111111", input.spanId);
  return {
    name: input.name,
    attributes: input.attributes ?? {},
    parentSpanContext: input.parentSpanContext,
    spanContext: () => spanContext,
  } as Span;
}

function createDelegate(): { processor: SpanProcessor; ended: string[] } {
  const ended: string[] = [];
  return {
    ended,
    processor: {
      forceFlush: async () => undefined,
      onStart: () => undefined,
      onEnding: () => undefined,
      onEnd: (span: ReadableSpan) => {
        ended.push(span.name);
      },
      shutdown: async () => undefined,
    },
  };
}

describe("FinnTelemetrySpanProcessor", () => {
  it("exports AI SDK child spans when the parent LLM span has Finn telemetry metadata", () => {
    const delegate = createDelegate();
    const processor = new FinnTelemetrySpanProcessor(delegate.processor);
    const parent = createSpan({
      name: "ai.generateText",
      spanId: "1111111111111111",
      attributes: {
        "ai.telemetry.metadata.ai.finn.span": true,
        "ai.operationId": "ai.generateText",
      },
    });
    const child = createSpan({
      name: "ai.toolCall",
      spanId: "2222222222222222",
      parentSpanContext: parent.spanContext(),
      attributes: {
        "ai.toolCall.name": "search_memory",
      },
    });

    processor.onStart(parent, otelContext.active());
    processor.onStart(child, otelContext.active());
    processor.onEnd(child);
    processor.onEnd(parent);

    expect(delegate.ended).toEqual(["ai.toolCall", "ai.generateText"]);
  });

  it("exports spans started under Finn telemetry baggage before direct attributes are set", () => {
    const delegate = createDelegate();
    const processor = new FinnTelemetrySpanProcessor(delegate.processor);
    const parentContext = propagation.setBaggage(
      otelContext.active(),
      propagation.createBaggage({ "finn.telemetry.ai.finn.span": { value: "true" } }),
    );
    const processSpan = createSpan({
      name: "personal-intelligence.run",
      spanId: "3333333333333333",
    });
    const child = createSpan({
      name: "ai.generateText.doGenerate",
      spanId: "4444444444444444",
      parentSpanContext: processSpan.spanContext(),
      attributes: {
        "gen_ai.request.model": "test-model",
      },
    });

    processor.onStart(processSpan, parentContext);
    processor.onStart(child, otelContext.active());
    processor.onEnd(child);
    processor.onEnd(processSpan);

    expect(delegate.ended).toEqual(["ai.generateText.doGenerate", "personal-intelligence.run"]);
  });

  it("does not export unrelated AI spans without Finn telemetry", () => {
    const delegate = createDelegate();
    const processor = new FinnTelemetrySpanProcessor(delegate.processor);
    const span = createSpan({
      name: "ai.generateText",
      spanId: "5555555555555555",
      attributes: {
        "ai.operationId": "ai.generateText",
      },
    });

    processor.onStart(span, otelContext.active());
    processor.onEnd(span);

    expect(delegate.ended).toEqual([]);
  });
});
