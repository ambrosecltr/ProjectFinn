import { describe, expect, it, mock } from "bun:test";
import type { WebRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createWebToolsetDefinition } from "./index.js";

function createWebRuntime(): WebRuntimeService {
  return {
    kind: "finn-web-runtime",
    search: mock(async () => [{
      id: "result_1",
      url: "https://example.com",
      title: "Example",
      highlights: ["highlight"],
    }]),
    fetch: mock(async () => [{
      url: "https://example.com/article",
      title: "Article",
      highlights: ["highlight"],
      text: "full text",
    }]),
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
      result: { results: [expect.objectContaining({ url: "https://example.com" })] },
    });
    expect(web.search).toHaveBeenCalledWith({
      query: "latest AI news",
      numResults: 5,
      maxAgeHours: undefined,
      vertical: undefined,
    });
  });

  it("passes freshness and vertical options through search", async () => {
    const { web, runtime } = createRuntime();

    await runtime.execute({
      toolset: "web",
      command: "search",
      args: {
        query: "series A fintech companies in Switzerland",
        numResults: 3,
        maxAgeHours: 0,
        vertical: "company",
      },
    });
    await runtime.execute({
      toolset: "web",
      command: "search",
      args: { query: "cached", maxAgeHours: -1 },
    });

    expect(web.search).toHaveBeenNthCalledWith(1, {
      query: "series A fintech companies in Switzerland",
      numResults: 3,
      maxAgeHours: 0,
      vertical: "company",
    });
    expect(web.search).toHaveBeenNthCalledWith(2, {
      query: "cached",
      numResults: 5,
      maxAgeHours: -1,
      vertical: undefined,
    });
  });

  it("maps fetch mode to Exa text retrieval and output shape", async () => {
    const { web, runtime } = createRuntime();

    const highlights = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/article" },
    });
    const text = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/article", mode: "text" },
    });
    const both = await runtime.execute({
      toolset: "web",
      command: "fetch",
      args: { url: "https://example.com/article", mode: "both" },
    });

    expect(web.fetch).toHaveBeenNthCalledWith(1, "https://example.com/article", { includeText: undefined });
    expect(web.fetch).toHaveBeenNthCalledWith(2, "https://example.com/article", { includeText: true });
    expect(web.fetch).toHaveBeenNthCalledWith(3, "https://example.com/article", { includeText: true });
    expect(highlights).toMatchObject({
      result: { mode: "highlights", contents: [expect.not.objectContaining({ text: "full text" })] },
    });
    expect(text).toMatchObject({
      result: { mode: "text", contents: [expect.not.objectContaining({ highlights: ["highlight"] })] },
    });
    expect(both).toMatchObject({
      result: { mode: "both", contents: [expect.objectContaining({ highlights: ["highlight"], text: "full text" })] },
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
    })).rejects.toThrow("Required");
  });

  it("generates gated instructions from the manifest", async () => {
    const { runtime } = createRuntime(createWebRuntime(), { fetch: false });

    const loaded = await runtime.load("web");

    expect(loaded.instructions).toContain("API: finn.web.search(input)");
    expect(loaded.instructions).toContain("numResults defaults to 5");
    expect(loaded.instructions).not.toContain("finn.web.fetch");
  });
});
