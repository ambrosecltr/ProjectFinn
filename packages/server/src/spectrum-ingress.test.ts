import { describe, expect, it, mock } from "bun:test";
import { MessageRouter } from "@finn/messaging";
import { SpectrumIngress } from "./spectrum-ingress.js";

const config = {
  spectrum: {
    allowedNumbers: ["+15551234567"],
  },
} as never;

function createSpace(overrides: Record<string, unknown> = {}) {
  return {
    __platform: "iMessage",
    id: "space_123",
    type: "dm",
    phone: "+15550000000",
    ...overrides,
  } as never;
}

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_123",
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "+15551234567", __platform: "iMessage" },
    timestamp: new Date("2026-05-08T04:00:00.000Z"),
    content: { type: "text", text: "hey finn" },
    react: async () => undefined,
    reply: async () => undefined,
    ...overrides,
  } as never;
}

async function handleMessage(ingress: SpectrumIngress, space = createSpace(), message = createMessage()): Promise<void> {
  await (ingress as unknown as {
    handleMessage(space: never, message: never): Promise<void>;
  }).handleMessage(space, message);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("SpectrumIngress", () => {
  it("routes allowed iMessage DM text to the hot path", async () => {
    const enqueueUser = mock(async () => undefined);
    const rememberInboundMessage = mock(() => undefined);
    const getOrCreateByPhone = mock(async () => ({
      user: {
        tenantId: "tenant_test",
        userId: "usr_test",
        phoneNumber: "+15551234567",
        timezone: "UTC",
        timezoneSource: "server",
        kidsMode: false,
      },
      created: false,
    }));
    const ingress = new SpectrumIngress({
      config,
      client: { rememberInboundMessage } as never,
      router: new MessageRouter(),
      users: { getOrCreateByPhone } as never,
      agent: { enqueueUser },
    });

    await handleMessage(ingress);

    expect(getOrCreateByPhone).toHaveBeenCalledWith("+15551234567");
    expect(rememberInboundMessage).toHaveBeenCalledTimes(1);
    expect(enqueueUser).toHaveBeenCalledWith(expect.objectContaining({
      content: "hey finn",
      messageId: "msg_123",
      phoneNumber: "+15551234567",
    }));
  });

  it("skips non-DM iMessage spaces", async () => {
    const enqueueUser = mock(async () => undefined);
    const getOrCreateByPhone = mock(async () => ({ user: {}, created: false }));
    const ingress = new SpectrumIngress({
      config,
      client: { rememberInboundMessage: mock(() => undefined) } as never,
      router: new MessageRouter(),
      users: { getOrCreateByPhone } as never,
      agent: { enqueueUser },
    });

    await handleMessage(ingress, createSpace({ type: "group" }));

    expect(getOrCreateByPhone).not.toHaveBeenCalled();
    expect(enqueueUser).not.toHaveBeenCalled();
  });

  it("rejects senders outside the configured allowlist", async () => {
    const enqueueUser = mock(async () => undefined);
    const getOrCreateByPhone = mock(async () => ({ user: {}, created: false }));
    const ingress = new SpectrumIngress({
      config,
      client: { rememberInboundMessage: mock(() => undefined) } as never,
      router: new MessageRouter(),
      users: { getOrCreateByPhone } as never,
      agent: { enqueueUser },
    });

    await handleMessage(ingress, createSpace(), createMessage({ sender: { id: "+15557654321", __platform: "iMessage" } }));

    expect(getOrCreateByPhone).not.toHaveBeenCalled();
    expect(enqueueUser).not.toHaveBeenCalled();
  });

  it("restarts the Spectrum client when the message stream fails", async () => {
    let releaseSecondStream: () => void = () => undefined;
    let streamReads = 0;

    async function* failingStream(): AsyncIterable<[never, never]> {
      throw new Error("stream dropped");
    }

    async function* recoveredStream(): AsyncIterable<[never, never]> {
      yield [createSpace(), createMessage()] as [never, never];
      await new Promise<void>((resolve) => {
        releaseSecondStream = resolve;
      });
    }

    const enqueueUser = mock(async () => undefined);
    const rememberInboundMessage = mock(() => undefined);
    const getOrCreateByPhone = mock(async () => ({
      user: {
        tenantId: "tenant_test",
        userId: "usr_test",
        phoneNumber: "+15551234567",
        timezone: "UTC",
        timezoneSource: "server",
        kidsMode: false,
      },
      created: false,
    }));
    const client = {
      start: mock(async () => undefined),
      restart: mock(async () => undefined),
      stop: mock(async () => {
        releaseSecondStream();
      }),
      rememberInboundMessage,
      get messages(): AsyncIterable<[never, never]> {
        streamReads += 1;
        return streamReads === 1 ? failingStream() : recoveredStream();
      },
    };
    const ingress = new SpectrumIngress({
      config,
      client: client as never,
      router: new MessageRouter(),
      users: { getOrCreateByPhone } as never,
      agent: { enqueueUser },
      reconnect: { initialDelayMs: 0, maxDelayMs: 0 },
    });

    ingress.start();
    await waitFor(() => enqueueUser.mock.calls.length === 1);
    await ingress.stop();

    expect(client.restart).toHaveBeenCalledTimes(1);
    expect(rememberInboundMessage).toHaveBeenCalledTimes(1);
    expect(enqueueUser).toHaveBeenCalledWith(expect.objectContaining({
      content: "hey finn",
      messageId: "msg_123",
    }));
  });
});
