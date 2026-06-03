import { beforeEach, describe, expect, it, mock } from "bun:test";

const subscribeMock = mock();
const uploadMock = mock();

mock.module("@fal-ai/client", () => ({
  createFalClient: () => ({
    subscribe: subscribeMock,
    storage: {
      upload: uploadMock,
    },
  }),
}));

import { FalClient } from "./fal.js";

describe("FalClient", () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    uploadMock.mockReset();
  });

  it("uploads local media bytes to FAL storage", async () => {
    uploadMock.mockResolvedValue("https://fal.media/uploaded-photo.png");

    const client = new FalClient({ apiKey: "test-key" });
    await expect(client.uploadMedia({
      data: Buffer.from("image"),
      filename: "photo.png",
      mimeType: "image/png",
    })).resolves.toBe("https://fal.media/uploaded-photo.png");

    expect(uploadMock).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("uses GPT Image 2 edit endpoint with image_urls", async () => {
    subscribeMock.mockResolvedValue({
      requestId: "req_123",
      data: {
        images: [{ url: "https://example.com/out.png", width: 1024, height: 1024, content_type: "image/png" }],
      },
    });

    const client = new FalClient({ apiKey: "test-key" });
    await client.editImage({
      prompt: "add a chair",
      imageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      imageSize: "auto",
    });

    expect(subscribeMock).toHaveBeenCalledWith("openai/gpt-image-2/edit", {
      input: {
        prompt: "add a chair",
        image_urls: ["https://example.com/a.png", "https://example.com/b.png"],
        image_size: "auto",
      },
      logs: true,
    });
  });

  it("uses Seedance 2 text-to-video parameters", async () => {
    subscribeMock.mockResolvedValue({
      requestId: "req_234",
      data: {
        video: { url: "https://example.com/out.mp4", content_type: "video/mp4" },
      },
    });

    const client = new FalClient({ apiKey: "test-key" });
    await client.generateVideo({
      prompt: "a person sits on a chair",
      duration: "5",
      resolution: "720p",
      aspectRatio: "16:9",
      generateAudio: true,
    });

    expect(subscribeMock).toHaveBeenCalledWith("bytedance/seedance-2.0/text-to-video", {
      input: {
        prompt: "a person sits on a chair",
        duration: "5",
        resolution: "720p",
        aspect_ratio: "16:9",
        generate_audio: true,
      },
      logs: true,
    });
  });

  it("uses Seedance 2 reference-to-video for video edits", async () => {
    subscribeMock.mockResolvedValue({
      requestId: "req_345",
      data: {
        video: { url: "https://example.com/out.mp4", content_type: "video/mp4" },
      },
    });

    const client = new FalClient({ apiKey: "test-key" });
    await client.editVideo({
      prompt: "make them jump up after they sit down",
      videoUrl: "https://example.com/input.mp4",
      imageUrls: ["https://example.com/reference.png"],
    });

    expect(subscribeMock).toHaveBeenCalledWith("bytedance/seedance-2.0/reference-to-video", {
      input: {
        prompt: "make them jump up after they sit down",
        video_urls: ["https://example.com/input.mp4"],
        image_urls: ["https://example.com/reference.png"],
      },
      logs: true,
    });
  });

  it("accepts image results without width and height", async () => {
    subscribeMock.mockResolvedValue({
      requestId: "req_456",
      data: {
        images: [{ url: "https://example.com/out.png", content_type: "image/png" }],
      },
    });

    const client = new FalClient({ apiKey: "test-key" });
    await expect(client.generateImage({ prompt: "test" })).resolves.toEqual([
      {
        url: "https://example.com/out.png",
        contentType: "image/png",
      },
    ]);
  });
});
