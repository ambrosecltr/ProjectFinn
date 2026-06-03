import { describe, expect, it } from "bun:test";
import type { InboundMessage, UserMessage } from "@finn/core";
import { HotPathIngressCoordinator } from "./hot-path-ingress.js";

const owner = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+10000000000",
};

function createUserMessage(messageId: string, content: string): UserMessage {
  return {
    source: "user",
    ...owner,
    messageId,
    content,
    timestamp: new Date(`2026-01-01T00:00:0${messageId.at(-1) ?? "0"}Z`),
  };
}

async function flush(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HotPathIngressCoordinator", () => {
  it("coalesces user messages within the grouping window", async () => {
    const handled: InboundMessage[] = [];
    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 20,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message);
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    ingress.enqueueUser(createUserMessage("msg2", "second"));

    await flush(35);

    expect(handled).toHaveLength(1);
    expect(handled[0]?.source).toBe("user");
    const userMessage = handled[0] as UserMessage;
    expect(userMessage.parts?.map((part) => part.messageId)).toEqual(["msg1", "msg2"]);
    expect(userMessage.messageId).toBe("msg2");
  });

  it("preserves per-part reply targets when coalescing user messages", async () => {
    const handled: InboundMessage[] = [];
    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 20,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message);
          return null;
        },
      },
    });

    ingress.enqueueUser({
      ...createUserMessage("msg1", "that one"),
      replyToMessageId: "out_123",
    });
    ingress.enqueueUser(createUserMessage("msg2", "also this"));

    await flush(35);

    const userMessage = handled[0] as UserMessage;
    expect(userMessage.parts?.map((part) => part.replyToMessageId)).toEqual(["out_123", undefined]);
  });

  it("resets the grouping window for each idle user message", async () => {
    const handled: InboundMessage[] = [];
    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 25,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message);
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    await flush(15);
    ingress.enqueueUser(createUserMessage("msg2", "second"));
    await flush(15);

    expect(handled).toEqual([]);

    await flush(20);

    expect(handled).toHaveLength(1);
    const userMessage = handled[0] as UserMessage;
    expect(userMessage.parts?.map((part) => part.messageId)).toEqual(["msg1", "msg2"]);
  });

  it("runs a queued user turn immediately after the active turn finishes", async () => {
    const handled: InboundMessage[] = [];
    let releaseFirstTurn!: () => void;
    const firstTurnDone = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 5,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message);
          if (handled.length === 1) {
            await firstTurnDone;
          }
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    await flush(10);
    ingress.enqueueUser(createUserMessage("msg2", "second"));
    await flush(10);

    expect(handled).toHaveLength(1);

    releaseFirstTurn();
    await flush(20);

    expect(handled).toHaveLength(2);
    const secondTurn = handled[1] as UserMessage;
    expect(secondTurn.parts?.map((part) => part.messageId)).toEqual(["msg2"]);
  });

  it("flushes user messages queued during an active turn together once the turn ends", async () => {
    const handled: InboundMessage[] = [];
    let releaseFirstTurn!: () => void;
    const firstTurnDone = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 25,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message);
          if (handled.length === 1) {
            await firstTurnDone;
          }
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    await flush(30);
    ingress.enqueueUser(createUserMessage("msg2", "second"));
    await flush(30);

    expect(handled).toHaveLength(1);

    releaseFirstTurn();
    ingress.enqueueUser(createUserMessage("msg3", "third"));
    await flush(5);

    expect(handled).toHaveLength(2);
    const secondTurn = handled[1] as UserMessage;
    expect(secondTurn.parts?.map((part) => part.messageId)).toEqual(["msg2", "msg3"]);
  });

  it("prioritizes a pending user batch before internal events once the active turn ends", async () => {
    const handled: Array<InboundMessage["source"]> = [];
    let releaseFirstTurn!: () => void;
    const firstTurnDone = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 5,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push(message.source);
          if (handled.length === 1) {
            await firstTurnDone;
          }
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    await flush(10);
    ingress.enqueueInternal({
      source: "worker",
      tenantId: owner.tenantId,
      userId: owner.userId,
      workerId: "wrk1",
      task: "check something",
      result: { summary: "done" },
      originSource: "user",
    });
    ingress.enqueueUser(createUserMessage("msg2", "second"));
    await flush(10);

    releaseFirstTurn();
    await flush(30);

    expect(handled).toEqual(["user", "user", "worker"]);
  });

  it("delivers internal events between separate user turns when no user input is pending", async () => {
    const handled: Array<{ source: InboundMessage["source"]; id: string }> = [];
    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 5,
          maxCoalesceMessages: 1,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push({
            source: message.source,
            id: message.source === "user"
              ? message.messageId
              : message.source === "worker"
                ? message.workerId
                : "other",
          });
          return null;
        },
      },
    });

    ingress.enqueueUser(createUserMessage("msg1", "first"));
    await flush(10);
    ingress.enqueueInternal({
      source: "worker",
      tenantId: owner.tenantId,
      userId: owner.userId,
      workerId: "wrk1",
      task: "worker task",
      result: { summary: "done" },
      originSource: "user",
    });
    ingress.enqueueUser(createUserMessage("msg2", "second"));
    await flush(10);
    ingress.enqueueUser(createUserMessage("msg3", "third"));
    await flush(20);

    expect(handled).toEqual([
      { source: "user", id: "msg1" },
      { source: "user", id: "msg2" },
      { source: "worker", id: "wrk1" },
      { source: "user", id: "msg3" },
    ]);
  });

  it("waits for the grouping window before delivering internal events behind pending user input", async () => {
    const handled: Array<{ source: InboundMessage["source"]; id: string }> = [];
    const ingress = new HotPathIngressCoordinator({
      config: {
        hotPathIngress: {
          userGroupingWindowMs: 25,
          maxCoalesceMessages: 5,
        },
      },
      handler: {
        async handleMessage(message) {
          handled.push({
            source: message.source,
            id: message.source === "user"
              ? message.messageId
              : message.source === "worker"
                ? message.workerId
                : "other",
          });
          return null;
        },
      },
    });

    ingress.enqueueInternal({
      source: "worker",
      tenantId: owner.tenantId,
      userId: owner.userId,
      workerId: "wrk1",
      task: "worker task",
      result: { summary: "done" },
      originSource: "user",
    });
    ingress.enqueueUser(createUserMessage("msg1", "follow-up"));

    await flush(10);

    expect(handled).toEqual([]);

    await flush(30);

    expect(handled).toEqual([
      { source: "user", id: "msg1" },
      { source: "worker", id: "wrk1" },
    ]);
  });
});
