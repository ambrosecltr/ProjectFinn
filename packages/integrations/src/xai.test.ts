import { afterEach, describe, expect, it, mock } from "bun:test";
import { XaiImagineClient } from "./xai.js";

const originalFetch = globalThis.fetch;

function mockImageFetch(response: unknown) {
  const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("XaiImagineClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts JPEG image output without requesting base64 transport", async () => {
    const fetchMock = mockImageFetch({ data: [{ url: "https://example.com/image.jpg" }] });

    const client = new XaiImagineClient({ apiKey: "test-key" });
    await expect(client.generateImage({
      prompt: "a small cabin",
      outputFormat: "jpeg",
    })).resolves.toEqual([
      {
        url: "https://example.com/image.jpg",
        contentType: "image/jpeg",
      },
    ]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "a small cabin",
    });
  });

  it("rejects unsupported xAI image output formats instead of silently ignoring them", async () => {
    const client = new XaiImagineClient({ apiKey: "test-key" });

    await expect(client.generateImage({
      prompt: "a small cabin",
      outputFormat: "png",
    })).rejects.toThrow("xAI image generation only supports JPEG output");

    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("uses JPEG metadata for default URL image responses", async () => {
    const fetchMock = mockImageFetch({ data: [{ url: "https://example.com/image.jpg" }] });

    const client = new XaiImagineClient({ apiKey: "test-key" });
    await expect(client.generateImage({ prompt: "a small cabin" })).resolves.toEqual([
      {
        url: "https://example.com/image.jpg",
        contentType: "image/jpeg",
      },
    ]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("response_format");
  });

  it("parses base64 image responses when xAI returns them", async () => {
    mockImageFetch({ data: [{ b64_json: "aW1hZ2U=" }] });

    const client = new XaiImagineClient({ apiKey: "test-key" });
    await expect(client.generateImage({ prompt: "a small cabin" })).resolves.toEqual([
      {
        url: "data:image/jpeg;base64,aW1hZ2U=",
        contentType: "image/jpeg",
      },
    ]);
  });

  it("rejects unsupported xAI image edit output formats before making a request", async () => {
    const client = new XaiImagineClient({ apiKey: "test-key" });

    await expect(client.editImage({
      prompt: "draw it brighter",
      imageUrls: ["https://example.com/source.png"],
      outputFormat: "webp",
    })).rejects.toThrow("xAI image generation only supports JPEG output");

    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("passes reference images to xAI reference-to-video generation", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ request_id: "vid_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "done",
        video: { url: "https://example.com/video.mp4" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new XaiImagineClient({
      apiKey: "test-key",
      videoPollIntervalMs: 1,
      videoPollTimeoutMs: 100,
    });
    await expect(client.generateVideo({
      prompt: "make a product reveal",
      imageUrls: ["https://example.com/ref.png"],
      duration: "5",
      resolution: "720p",
      aspectRatio: "16:9",
    })).resolves.toEqual({
      url: "https://example.com/video.mp4",
      contentType: "video/mp4",
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "grok-imagine-video",
      prompt: "make a product reveal",
      reference_images: [{ url: "https://example.com/ref.png" }],
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
    });
  });
});
