import { describe, expect, it } from "bun:test";

import { getProvider } from "./providers.js";

describe("getProvider", () => {
  it("constructs OpenAI-compatible providers without requiring an API key", () => {
    const provider = getProvider("openai-compatible", undefined, "http://localhost:1234/v1");

    expect(provider("local-model")).toBeTruthy();
  });

  it("requires a base URL for OpenAI-compatible providers", () => {
    expect(() => getProvider("openai-compatible", undefined)).toThrow("Missing base URL");
  });

  it("still requires API keys for hosted providers", () => {
    expect(() => getProvider("openai", undefined)).toThrow("Missing API key");
  });
});
