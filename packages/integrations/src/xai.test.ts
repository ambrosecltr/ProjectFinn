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

  it("requests base64 delivery for JPEG image output", async () => {
    const fetchMock = mockImageFetch({ data: [{ b64_json: "aW1hZ2U=" }] });

    const client = new XaiImagineClient({ apiKey: "test-key" });
    await expect(client.generateImage({
      prompt: "a small cabin",
      outputFormat: "jpeg",
    })).resolves.toEqual([
      {
        url: "data:image/jpeg;base64,aW1hZ2U=",
        contentType: "image/jpeg",
      },
    ]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "grok-imagine-image-quality",
      prompt: "a small cabin",
      response_format: "b64_json",
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
});
