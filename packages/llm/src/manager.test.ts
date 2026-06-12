import { describe, expect, it } from "bun:test";

import type { AppConfig } from "@finn/core";

import { LLMManager } from "./manager.js";

function createConfig(provider: "anthropic" | "openai" | "fireworks" | "deepseek" | "openai-compatible"): AppConfig {
  return {
    models: {
      default: { provider, model: `${provider}:model`, maxContextTokens: 100_000, baseUrl: provider === "openai-compatible" ? "https://models.example.com/v1" : undefined },
      hotPath: { provider, model: `${provider}:hot`, maxContextTokens: 100_000, baseUrl: provider === "openai-compatible" ? "https://models.example.com/v1" : undefined },
      worker: { provider, model: `${provider}:worker`, maxContextTokens: 100_000, baseUrl: provider === "openai-compatible" ? "https://models.example.com/v1" : undefined },
      compactor: { provider, model: `${provider}:compactor`, maxContextTokens: 100_000, baseUrl: provider === "openai-compatible" ? "https://models.example.com/v1" : undefined },
    },
    apiKeys: {
      default: "key",
      hotPath: "key",
      worker: "key",
      compactor: "key",
    },
    maxTurns: {
      hotPath: 1,
      worker: 1,
      compactor: 1,
    },
  } as AppConfig;
}

describe("LLMManager request options", () => {
  it("adds Fireworks prompt-cache affinity with the stable cache key", () => {
    const manager = new LLMManager(createConfig("fireworks"));

    expect(manager.getRequestOptions("hot-path", " conv_123 ")).toEqual({
      headers: {
        "x-session-affinity": "conv_123",
      },
      providerOptions: {
        fireworks: {
          user: "conv_123",
        },
      },
    });
  });

  it("adds Anthropic automatic prompt caching by default", () => {
    const manager = new LLMManager(createConfig("anthropic"));

    expect(manager.getRequestOptions("worker", "wrk_123")).toEqual({
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
        },
      },
    });
  });

  it("does not add provider-specific options for OpenAI-compatible providers", () => {
    const manager = new LLMManager(createConfig("openai-compatible"));

    expect(manager.getRequestOptions("worker", "wrk_123")).toEqual({});
  });

  it("adds DeepSeek thinking options when reasoning effort is configured", () => {
    const config = createConfig("deepseek");
    config.models.hotPath.reasoningEffort = "max";
    const manager = new LLMManager(config);

    expect(manager.getRequestOptions("hot-path", "conv_123")).toEqual({
      providerOptions: {
        deepseek: {
          thinking: { type: "enabled" },
          reasoningEffort: "max",
        },
      },
    });
  });

  it("does not force DeepSeek thinking options without configured reasoning effort", () => {
    const manager = new LLMManager(createConfig("deepseek"));

    expect(manager.getRequestOptions("worker", "wrk_123")).toEqual({});
  });

  it("adds Anthropic effort options alongside automatic prompt caching when reasoning effort is configured", () => {
    const config = createConfig("anthropic");
    config.models.worker.reasoningEffort = "medium";
    const manager = new LLMManager(config);

    expect(manager.getRequestOptions("worker", "wrk_123")).toEqual({
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
          effort: "medium",
        },
      },
    });
  });

  it("adds configured max output tokens to every provider", () => {
    const config = createConfig("openai");
    config.models.worker.maxOutputTokens = 384_000;
    const manager = new LLMManager(config);

    expect(manager.getRequestOptions("worker", "wrk_123")).toEqual({
      maxOutputTokens: 384_000,
    });
  });
});
