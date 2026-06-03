import { describe, expect, it } from "bun:test";

import { MessageRouter } from "./router.js";

const user = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+19999999999",
  timezone: "UTC",
  timezoneSource: "server" as const,
  kidsMode: false,
};

function createMessage(content: Record<string, unknown>) {
  return {
    id: "msg_123",
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "+19999999999", __platform: "iMessage" },
    space: {} as never,
    timestamp: new Date("2026-04-21T01:02:03.000Z"),
    react: async () => undefined,
    reply: async () => undefined,
    content,
  };
}

describe("MessageRouter", () => {
  it("routes Spectrum text content", async () => {
    const router = new MessageRouter();
    const message = await router.routeSpectrumMessage(createMessage({ type: "text", text: "hey finn" }) as never, user);

    expect(message?.content).toBe("hey finn");
    expect(message?.messageId).toBe("msg_123");
  });

  it("preserves Spectrum parent ids for inbound user replies", async () => {
    const router = new MessageRouter();
    const message = await router.routeSpectrumMessage({
      ...createMessage({ type: "text", text: "yeah that one" }),
      parentId: "out_finn_123",
    } as never, user);

    expect(message?.replyToMessageId).toBe("out_finn_123");
  });

  it("recovers reply targets from raw iMessage metadata", async () => {
    const router = new MessageRouter();
    const message = await router.routeSpectrumMessage({
      ...createMessage({ type: "text", text: "yeah that one" }),
      raw: {
        thread_originator_guid: "out_finn_raw",
      },
    } as never, user);

    expect(message?.replyToMessageId).toBe("out_finn_raw");
  });

  it("routes Spectrum attachments with inline bytes", async () => {
    const router = new MessageRouter();
    const data = Buffer.from("image bytes");
    const message = await router.routeSpectrumMessage(createMessage({
      type: "attachment",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: data.length,
      read: async () => data,
      stream: async () => new ReadableStream(),
    }) as never, user);

    expect(message?.attachments?.[0]).toMatchObject({
      url: "spectrum:msg_123",
      originalUrl: "spectrum:msg_123",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: data.length,
      data,
    });
  });

  it("preserves raw caption text on Spectrum attachment content", async () => {
    const router = new MessageRouter();
    const data = Buffer.from("image bytes");
    const message = await router.routeSpectrumMessage({
      ...createMessage({
        type: "attachment",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: data.length,
        read: async () => data,
        stream: async () => new ReadableStream(),
      }),
      text: "Aren't they",
    } as never, user);

    expect(message?.content).toBe("Aren't they");
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments?.[0]?.data).toBe(data);
  });

  it("routes Spectrum grouped text and attachments into one user message", async () => {
    const router = new MessageRouter();
    const firstData = Buffer.from("first image");
    const secondData = Buffer.from("second image");
    const message = await router.routeSpectrumMessage(createMessage({
      type: "group",
      items: [
        createMessage({ type: "text", text: "look at these" }) as never,
        createMessage({
          type: "attachment",
          name: "photo-1.jpg",
          mimeType: "image/jpeg",
          size: firstData.length,
          read: async () => firstData,
          stream: async () => new ReadableStream(),
        }) as never,
        createMessage({
          type: "attachment",
          name: "photo-2.jpg",
          mimeType: "image/jpeg",
          size: secondData.length,
          read: async () => secondData,
          stream: async () => new ReadableStream(),
        }) as never,
      ],
    }) as never, user);

    expect(message?.content).toBe("look at these");
    expect(message?.attachments).toHaveLength(2);
    expect(message?.attachments?.map((attachment) => attachment.filename)).toEqual(["photo-1.jpg", "photo-2.jpg"]);
  });

  it("recovers raw caption text from Spectrum grouped attachment parents", async () => {
    const router = new MessageRouter();
    const data = Buffer.from("image bytes");
    const message = await router.routeSpectrumMessage({
      ...createMessage({
        type: "group",
        items: [
          createMessage({
            type: "attachment",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            size: data.length,
            read: async () => data,
            stream: async () => new ReadableStream(),
          }) as never,
        ],
      }),
      raw: { text: "caption from raw payload" },
    } as never, user);

    expect(message?.content).toBe("caption from raw payload");
    expect(message?.attachments).toHaveLength(1);
  });

  it("routes Spectrum voice content as voice-note audio", async () => {
    const router = new MessageRouter();
    const data = Buffer.from("voice bytes");
    const message = await router.routeSpectrumMessage(createMessage({
      type: "voice",
      name: "note.m4a",
      mimeType: "audio/mp4",
      size: data.length,
      read: async () => data,
      stream: async () => new ReadableStream(),
    }) as never, user);

    expect(message?.attachments?.[0]).toMatchObject({
      filename: "note.m4a",
      mimeType: "audio/mp4",
      audioKind: "voice_note",
      data,
    });
  });

  it("summarizes Spectrum contact cards", async () => {
    const router = new MessageRouter();
    const message = await router.routeSpectrumMessage(createMessage({
      type: "contact",
      name: { formatted: "Finn" },
      phones: [{ value: "+15550000000", type: "mobile" }],
      emails: [{ value: "finn@example.com", type: "home" }],
    }) as never, user);

    expect(message?.content).toBe("[Contact card received]\nFinn\n+15550000000\nfinn@example.com");
    expect(message?.attachments).toBeUndefined();
  });
});
