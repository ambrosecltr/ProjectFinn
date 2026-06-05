import { describe, expect, it, mock } from "bun:test";
import type { WebRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createWebToolsetDefinition } from "./index.js";

function createWebRuntime(): WebRuntimeService {
  return {
    kind: "finn-web-runtime",
    provider: "parallel",
    search: mock(async () => ({
      provider: "parallel" as const,
      searchId: "search_123",
      sessionId: "session_123",
      results: [{
        url: "https://example.com",
        title: "Example",
        excerpts: ["excerpt"],
      }],
    })),
    fetch: mock(async () => ({
      provider: "parallel" as const,
      extractId: "extract_123",
      sessionId: "session_123",
      errors: [],
      contents: [{
        url: "https://example.com/article",
        title: "Article",
        excerpts: ["excerpt"],
        highlights: ["highlight"],
        text: "full text",
        fullContent: "full text",
      }],
    })),
  };
}

function createRuntime(web = createWebRuntime(), options: { search?: boolean; fetch?: boolean } = {}) {
  return {
    web,
    runtime: createToolsetRuntime({
      processType: "worker",
      enabledTools: ["web"],
      includeBuiltInToolsets: false,
      toolsetGrants: { web: "read" },
      definitions: [createWebToolsetDefinition({
        processTypes: ["worker", "pattern_worker"],
        runtime: web,
        ...options,
      })],
      context: {},
    }),
  };
}

describe("web toolset", () => {
  it("searches with the default result count", async () => {
    const { web, runtime } = createRuntime();

    const result = await runtime.execute({
      toolset: "web",
      command: "search",
      args: { query: "latest AI news" },
    });

    expect(result).toMatchObject({
      toolset: "web",
      command: "search",
      result: {
        provider: "parallel",
        sessionId: "session_123",
        results: [expect.objectContaining({ url: "https://example.com" })],
      },
    });
    expect(web.search).toHaveBeenCalledWith({
      query: "latest AI news",
      objective: undefined,
      searchQueries: undefined,
      numResults: 5,
      maxAgeHours: undefined,
      vertical: undefined,
      mode: undefined,
      maxCharsTotal: undefined,
      sessionId: undefined,
      sourcePolicy: undefined,
      fetchPolicy: undefined,
      maxCharsPerResult: undefined,
      location: undefined,
    });
  });

  it("passes rich web search options through search", async () => {
    const { web, runtime } = createRuntime();

    await runtime.execute({
      toolset: "web",
      command: "search",
      args: {
        objective: "Find recent Series A fintech companies in Switzerland",
        searchQueries: ["Swiss fintech Series A", "Switzerland fintech funding"],
        numResults: 3,
        mode: "basic",
        maxCharsTotal: 4000,
        sessionId: "session_123",
        sourcePolicy: { includeDomains: [".ch"], afterDate: "2026-01-01" },
        fetchPolicy: { maxAgeSeconds: 3600, timeoutSeconds: 20, disableCacheFallback: true },
        maxCharsPerResult: 1200,
        location: "ch",
      },
    });
    await runtime.execute({
      toolset: "web",
      command: "search",
      args: { query: "cached", maxAgeHours: -1 },
    });

    expect(web.search).toHaveBeenNthCalledWith(1, {
      query: undefined,
      objective: "Find recent Series A fintech companies in Switzerland",
      searchQueries: ["Swiss fintech Series A", "Switzerland fintech funding"],
      numResults: 3,
      maxAgeHours: undefined,
      vertical: undefined,
      mode: "basic",
      maxCharsTotal: 4000,
      sessionId: "session_123",
      sourcePolicy: { includeDomains: [".ch"], afterDate: "2026-01-01" },
      fetchPolicy: { maxAgeSeconds: 3600, timeoutSeconds: 20, disableCacheFallback: true },
      maxCharsPerResult: 1200,
      location: "ch",
    });
    expect(web.search).toHaveBeenNthCalledWith(2, {
      query: "cached",
      objective: undefined,
      searchQueries: undefined,
      numResults: 5,
      maxAgeHours: -1,
      vertical: undefined,
      mode: undefined,
      maxCharsTotal: undefined,
      sessionId: undefined,
      sourcePolicy: undefined,
      fetchPolicy: undefined,
      maxCharsPerResult: undefined,
      location: undefined,
    });
  });

  it("maps fetch mode to content retrieval and output shape", async () => {
    const { web, runtime } = createRuntime();

    const excerpts = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/article" },
    });
    const text = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/article", mode: "full" },
    });
    const both = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: {
        urls: ["https://example.com/article", "https://example.com/other"],
        mode: "both",
        objective: "Extract launch dates",
        searchQueries: ["launch date"],
        sessionId: "session_123",
        fullContent: { maxCharsPerResult: 12000 },
      },
    });

    expect(web.fetch).toHaveBeenNthCalledWith(1, "https://example.com/article", {
      includeText: false,
      objective: undefined,
      searchQueries: undefined,
      maxCharsTotal: undefined,
      sessionId: undefined,
      fetchPolicy: undefined,
      maxCharsPerResult: undefined,
      fullContent: undefined,
    });
    expect(web.fetch).toHaveBeenNthCalledWith(2, "https://example.com/article", expect.objectContaining({ includeText: true }));
    expect(web.fetch).toHaveBeenNthCalledWith(3, ["https://example.com/article", "https://example.com/other"], expect.objectContaining({
      includeText: true,
      objective: "Extract launch dates",
      searchQueries: ["launch date"],
      sessionId: "session_123",
      fullContent: { maxCharsPerResult: 12000 },
    }));
    expect(excerpts).toMatchObject({
      result: { mode: "excerpts", contents: [expect.not.objectContaining({ text: "full text" })] },
    });
    expect(text).toMatchObject({
      result: { mode: "full", contents: [expect.not.objectContaining({ excerpts: ["excerpt"] })] },
    });
    expect(both).toMatchObject({
      result: { mode: "both", provider: "parallel", contents: [expect.objectContaining({ excerpts: ["excerpt"], text: "full text" })] },
    });
  });

  it("rejects invalid JS workspace inputs", async () => {
    const { runtime } = createRuntime();

    await expect(runtime.execute({
      toolset: "web",
      command: "search",
      args: { query: "companies", vertical: "news" },
    })).rejects.toThrow("Invalid enum value");
    await expect(runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { urls: "https://example.com/old-shape" },
    })).rejects.toThrow("Expected array");
    await expect(runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/a", urls: ["https://example.com/b"] },
    })).rejects.toThrow("Provide exactly one");
  });

  it("generates gated instructions from the manifest", async () => {
    const { runtime } = createRuntime(createWebRuntime(), { fetch: false });

    const loaded = await runtime.load("web");

    expect(loaded.instructions).toContain("API: finn.web.search(input)");
    expect(loaded.instructions).toContain("numResults defaults to 5");
    expect(loaded.instructions).toContain("sourcePolicy");
    expect(loaded.instructions).not.toContain("finn.web.fetch");
  });
});
