import { describe, expect, it, mock } from "bun:test";

import { SpectrumClient } from "./adapter.js";

describe("SpectrumClient replies", () => {
  it("serializes concurrent sends to the same recipient", async () => {
    let releaseFirstSend = () => {};
    let markFirstSendStarted = () => {};
    const firstSendStarted = new Promise<void>((resolve) => {
      markFirstSendStarted = resolve;
    });
    const sendStarts: string[] = [];
    const space = {
      __platform: "iMessage",
      id: "space_123",
      phone: "+15550000000",
      getMessage: mock(async () => undefined),
      send: mock(async (text: string) => {
        sendStarts.push(text);
        if (text === "first") {
          markFirstSendStarted();
          await new Promise<void>((resolve) => {
            releaseFirstSend = resolve;
          });
        }
        return { id: `out_${text}` };
      }),
    };
    const client = new SpectrumClient({ projectId: "project", projectSecret: "secret", dedicatedLinePhone: undefined });
    client.rememberInboundMessage("+15551234567", space as never, {
      id: "msg_inbound",
      content: { type: "text", text: "hello" },
      timestamp: new Date("2026-05-09T00:00:00.000Z"),
    } as never);

    const first = client.sendText("+15551234567", "first");
    await firstSendStarted;
    const second = client.sendText("+15551234567", "second");

    await Promise.resolve();
    expect(sendStarts).toEqual(["first"]);

    releaseFirstSend();
    const results = await Promise.all([first, second]);

    expect(sendStarts).toEqual(["first", "second"]);
    expect(results.map((result) => result.messageIds[0])).toEqual(["out_first", "out_second"]);
  });

  it("sends threaded text replies when the target can be resolved", async () => {
    const target = {
      id: "msg_target",
      content: { type: "text", text: "how's the weather" },
      timestamp: new Date("2026-05-09T00:00:00.000Z"),
      reply: mock(async () => ({ id: "out_reply" })),
    };
    const space = {
      __platform: "iMessage",
      id: "space_123",
      phone: "+15550000000",
      getMessage: mock(async () => target),
      send: mock(async () => ({ id: "out_send" })),
    };
    const client = new SpectrumClient({ projectId: "project", projectSecret: "secret", dedicatedLinePhone: undefined });
    client.rememberInboundMessage("+15551234567", space as never, target as never);

    const result = await client.sendText("+15551234567", "weather's back", { replyToMessageHandle: "msg_target" });

    expect(target.reply).toHaveBeenCalledWith("weather's back");
    expect(space.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      messageIds: ["out_reply"],
      replyToMessageHandle: "msg_target",
      threaded: true,
      fallback: false,
    });
  });

  it("falls back to normal text sends when reply target resolution misses", async () => {
    const inbound = {
      id: "msg_inbound",
      content: { type: "text", text: "how's the weather" },
      timestamp: new Date("2026-05-09T00:00:00.000Z"),
      reply: mock(async () => ({ id: "unused" })),
    };
    const space = {
      __platform: "iMessage",
      id: "space_123",
      phone: "+15550000000",
      getMessage: mock(async () => undefined),
      send: mock(async () => ({ id: "out_fallback" })),
    };
    const client = new SpectrumClient({ projectId: "project", projectSecret: "secret", dedicatedLinePhone: undefined });
    client.rememberInboundMessage("+15551234567", space as never, inbound as never);

    const result = await client.sendText("+15551234567", "weather's back", { replyToMessageHandle: "missing_msg" });

    expect(space.getMessage).toHaveBeenCalledWith("missing_msg");
    expect(space.send).toHaveBeenCalledWith("weather's back");
    expect(result).toEqual({
      messageIds: ["out_fallback"],
      replyToMessageHandle: "missing_msg",
      threaded: false,
      fallback: true,
    });
  });

  it("preserves assigned line routing while recreating the Spectrum app", async () => {
    const initialApp = { stop: mock(async () => undefined) };
    const restartedApp = { stop: mock(async () => undefined) };
    const client = new SpectrumClient({ projectId: "project", projectSecret: "secret", dedicatedLinePhone: undefined });
    const internals = client as unknown as {
      app?: unknown;
      spacesByRecipient: Map<string, unknown>;
      linePhonesByRecipient: Map<string, string>;
      messagesById: Map<string, unknown>;
      start: () => Promise<unknown>;
    };
    internals.app = initialApp;
    internals.spacesByRecipient.set("+15551234567", { id: "stale_space" });
    internals.messagesById.set("msg_stale", { id: "msg_stale" });
    client.rememberRecipientLine("+15551234567", "+15550001111");
    internals.start = mock(async () => {
      internals.app = restartedApp;
      return restartedApp;
    });

    await client.restart();

    expect(initialApp.stop).toHaveBeenCalledTimes(1);
    expect(internals.start).toHaveBeenCalledTimes(1);
    expect(internals.linePhonesByRecipient.get("+15551234567")).toBe("+15550001111");
    expect(internals.spacesByRecipient.size).toBe(0);
    expect(internals.messagesById.size).toBe(0);
  });
});
