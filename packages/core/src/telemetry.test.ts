import { afterEach, describe, expect, it } from "bun:test";

import { createFinnTelemetry, createFinnTelemetryContext, isFinnTelemetryEnabled, setFinnTelemetrySpanAttributes } from "./telemetry.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createFinnTelemetry", () => {
  it("binds user-scoped telemetry to a stable Finn distinct id", () => {
    process.env["POSTHOG_API_KEY"] = "phc_test";
    process.env["TELEMETRY_PROVIDER"] = "posthog";

    const telemetry = createFinnTelemetry({
      functionId: "hot-path.stream",
      processType: "hot-path",
      conversationId: "conv_123",
      user: {
        tenantId: "tenant_test",
        userId: "usr_test",
        phoneNumber: "+15551234567",
        displayName: "Finn User",
      },
    });

    expect(telemetry).toEqual({
      isEnabled: true,
      functionId: "hot-path.stream",
      recordInputs: true,
      recordOutputs: true,
      metadata: {
        posthog_distinct_id: "finn:tenant_test:usr_test",
        "$ai_session_id": "conv_123",
        "ai.finn.span": true,
        tenantId: "tenant_test",
        userId: "usr_test",
        phoneNumber: "+15551234567",
        displayName: "Finn User",
        "user.id": "finn:tenant_test:usr_test",
        "enduser.id": "finn:tenant_test:usr_test",
        "user.phone": "+15551234567",
        "user.name": "Finn User",
        processType: "hot-path",
        conversationId: "conv_123",
        "ai.finn.tenantId": "tenant_test",
        "ai.finn.userId": "usr_test",
        "ai.finn.phoneNumber": "+15551234567",
        "ai.finn.displayName": "Finn User",
        "ai.finn.processType": "hot-path",
        "ai.finn.conversationId": "conv_123",
      },
    });
  });

  it("keeps custom metadata and adds AI-prefixed Finn metadata for PostHog export", () => {
    const telemetry = createFinnTelemetry({
      functionId: "hot-path.stream",
      processType: "hot-path",
      user: { tenantId: "tenant_123", userId: "usr_123", phoneNumber: "+15557654321" },
      conversationId: "cnv_123",
      metadata: { source: "user", messageId: "msg_123" },
    });

    expect(telemetry.metadata).toEqual(expect.objectContaining({
      posthog_distinct_id: "finn:tenant_123:usr_123",
      "$ai_session_id": "cnv_123",
      tenantId: "tenant_123",
      userId: "usr_123",
      phoneNumber: "+15557654321",
      "user.id": "finn:tenant_123:usr_123",
      "enduser.id": "finn:tenant_123:usr_123",
      "user.phone": "+15557654321",
      processType: "hot-path",
      conversationId: "cnv_123",
      source: "user",
      messageId: "msg_123",
      "ai.finn.span": true,
      "ai.finn.tenantId": "tenant_123",
      "ai.finn.userId": "usr_123",
      "ai.finn.phoneNumber": "+15557654321",
      "ai.finn.processType": "hot-path",
      "ai.finn.conversationId": "cnv_123",
      "ai.finn.source": "user",
      "ai.finn.messageId": "msg_123",
    }));
    expect(telemetry.recordInputs).toBe(true);
    expect(telemetry.recordOutputs).toBe(true);
  });

  it("uses a stable system distinct id when no user exists", () => {
    const telemetry = createFinnTelemetry({
      functionId: "compactor.generate",
      processType: "compactor",
    });

    expect(telemetry.metadata.posthog_distinct_id).toBe("finn:system:compactor");
    expect(telemetry.metadata["ai.finn.processType"]).toBe("compactor");
  });

  it("keeps telemetry disabled unless PostHog is configured", () => {
    process.env["POSTHOG_API_KEY"] = undefined;
    process.env["TELEMETRY_PROVIDER"] = undefined;

    expect(isFinnTelemetryEnabled()).toBe(false);
    expect(createFinnTelemetry({ functionId: "worker.generate", processType: "worker" }).isEnabled).toBe(false);
  });

  it("builds baggage-safe runtime span context", () => {
    const context = createFinnTelemetryContext({
      functionId: "worker.generate",
      processType: "worker",
      user: { tenantId: "tenant_123", userId: "usr_123", phoneNumber: "+15550000000" },
      workerId: "wrk_123",
      metadata: { source: "pattern", enabled: true },
    });

    expect(context).toEqual({
      distinctId: "finn:tenant_123:usr_123",
      attributes: expect.objectContaining({
        posthog_distinct_id: "finn:tenant_123:usr_123",
        "$ai_session_id": "wrk_123",
        workerId: "wrk_123",
        "ai.finn.workerId": "wrk_123",
        "ai.finn.source": "pattern",
        "ai.finn.enabled": true,
      }),
    });
  });

  it("does not mark unrelated spans for export without Finn telemetry context", () => {
    process.env["POSTHOG_API_KEY"] = "phc_test";
    process.env["TELEMETRY_PROVIDER"] = "posthog";
    const attributes: Record<string, unknown> = {};

    setFinnTelemetrySpanAttributes({
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value;
        return {} as never;
      },
    } as never);

    expect(attributes).toEqual({});
  });
});
