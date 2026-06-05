import { afterEach, describe, expect, it } from "bun:test";

import { buildCapabilities, loadConfig, requiredComposioToolkits, resetConfig, resolveConfiguredWebSearchProvider, resolveMemoryProvider } from "./config.js";

const models = {
  default: { model: "openai:gpt-4o-mini", provider: "openai" as const, maxContextTokens: 128_000 },
  hotPath: { model: "openai:gpt-4o-mini", provider: "openai" as const, maxContextTokens: 128_000 },
  worker: { model: "openai:gpt-4o-mini", provider: "openai" as const, maxContextTokens: 128_000 },
  compactor: { model: "openai:gpt-4o-mini", provider: "openai" as const, maxContextTokens: 128_000 },
};

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetConfig();
});

function setRequiredEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env = {
    ...originalEnv,
    MEMORY_PROVIDER: undefined,
    MEMORY_MODE: undefined,
    MEMORY_AUTO_RECALL_TIMEOUT_MS: undefined,
    SUPERMEMORY_API_KEY: undefined,
    SUPERMEMORY_BASE_URL: undefined,
    HINDSIGHT_API_KEY: undefined,
    HINDSIGHT_BASE_URL: undefined,
    HONCHO_API_KEY: undefined,
    HONCHO_BASE_URL: undefined,
    HONCHO_WORKSPACE_PREFIX: undefined,
    HONCHO_TIMEOUT_MS: undefined,
    MEM0_API_KEY: undefined,
    MEM0_BASE_URL: undefined,
    WEB_SEARCH_PROVIDER: undefined,
    EXA_API_KEY: undefined,
    PARALLEL_API_KEY: undefined,
    PARALLEL_BASE_URL: undefined,
    PARALLEL_TIMEOUT_MS: undefined,
    PARALLEL_MAX_RETRIES: undefined,
    SPECTRUM_PROJECT_ID: "spectrum-project",
    SPECTRUM_PROJECT_SECRET: "spectrum-secret",
    PUBLIC_URL: "https://finn.example.com",
    DATABASE_URL: "postgres://user:pass@localhost:5432/finn",
    DEFAULT_PROVIDER: "openai",
    DEFAULT_MODEL: "openai:gpt-4o-mini",
    DEFAULT_API_KEY: "test-key",
    DEFAULT_BASE_URL: undefined,
    DEFAULT_REASONING_EFFORT: undefined,
    DEFAULT_MAX_CONTEXT_TOKENS: undefined,
    DEFAULT_MAX_OUTPUT_TOKENS: undefined,
    LLM_FORCE_TOOL_CHOICE: undefined,
    HOT_PATH_PROVIDER: undefined,
    HOT_PATH_MODEL: undefined,
    HOT_PATH_API_KEY: undefined,
    HOT_PATH_BASE_URL: undefined,
    HOT_PATH_REASONING_EFFORT: undefined,
    HOT_PATH_MAX_CONTEXT_TOKENS: undefined,
    HOT_PATH_MAX_OUTPUT_TOKENS: undefined,
    WORKER_PROVIDER: undefined,
    WORKER_MODEL: undefined,
    WORKER_API_KEY: undefined,
    WORKER_BASE_URL: undefined,
    WORKER_REASONING_EFFORT: undefined,
    WORKER_MAX_CONTEXT_TOKENS: undefined,
    WORKER_MAX_OUTPUT_TOKENS: undefined,
    COMPACTOR_PROVIDER: undefined,
    COMPACTOR_MODEL: undefined,
    COMPACTOR_API_KEY: undefined,
    COMPACTOR_BASE_URL: undefined,
    COMPACTOR_REASONING_EFFORT: undefined,
    COMPACTOR_MAX_CONTEXT_TOKENS: undefined,
    COMPACTOR_MAX_OUTPUT_TOKENS: undefined,
    POSTHOG_HOST: "https://us.i.posthog.com",
    POSTHOG_API_KEY: undefined,
    TELEMETRY_PROVIDER: undefined,
    MY_DAY_REFRESH_TIMES: undefined,
    PERSONAL_INTELLIGENCE_REFRESH_TIMES: undefined,
    PERSONAL_INTELLIGENCE_INITIAL_BACKFILL_MS: undefined,
    PERSONAL_INTELLIGENCE_INCREMENTAL_OVERLAP_MS: undefined,
    BACKGROUND_LLM_TIMEOUT_MS: undefined,
    PERSONAL_INTELLIGENCE_TIMEOUT_MS: undefined,
    PERSONAL_INTELLIGENCE_MAX_STEPS: undefined,
    GRAPHILE_WORKER_CONCURRENCY: undefined,
    GRAPHILE_WORKER_MAX_POOL_SIZE: undefined,
    GRAPHILE_WORKER_POLL_INTERVAL_MS: undefined,
    SCHEDULER_PATTERN_TICK_MS: undefined,
    SCHEDULER_MY_DAY_TICK_MS: undefined,
    SCHEDULER_PERSONAL_INTELLIGENCE_TICK_MS: undefined,
    SCHEDULER_MY_DAY_JITTER_MS: undefined,
    SCHEDULER_PERSONAL_INTELLIGENCE_JITTER_MS: undefined,
    COMPOSIO_API_KEY: undefined,
    COMPOSIO_CALLBACK_URL: undefined,
    COMPOSIO_ALLOWED_TOOLKITS: undefined,
    COMPOSIO_WEBHOOK_SECRET: undefined,
    ...overrides,
  };
}

describe("buildCapabilities", () => {
  it("keeps memory capabilities disabled when unconfigured", () => {
    const capabilities = buildCapabilities({ models, integrations: {} });

    expect(capabilities.integrations.web).toBe(false);
    expect(capabilities.integrations.exa).toBe(false);
    expect(capabilities.integrations.parallel).toBe(false);
    expect(capabilities.integrations.memory).toBe(false);
    expect(capabilities.integrations.supermemory).toBe(false);
    expect(capabilities.integrations.honcho).toBe(false);
    expect(capabilities.integrations.mem0).toBe(false);
    expect(capabilities.tools.hotPath.search_memory).toBe(false);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.hotPath.files).toBe(true);
    expect(capabilities.tools.hotPath.my_day).toBe(true);
    expect(capabilities.tools.worker.memory).toBe(false);
    expect(capabilities.tools.worker.memory_reflect).toBe(false);
    expect(capabilities.tools.worker.web_search).toBe(false);
    expect(capabilities.tools.worker.get_page_contents).toBe(false);
  });

  it("enables web tools from the selected web provider", () => {
    const exaCapabilities = buildCapabilities({
      models,
      integrations: {
        exa: { apiKey: "exa-key" },
        parallel: { apiKey: "parallel-key" },
      },
    });
    const parallelCapabilities = buildCapabilities({
      models,
      integrations: {
        exa: { apiKey: "exa-key" },
        parallel: { apiKey: "parallel-key" },
      },
      webSearchProvider: "parallel",
    });
    const disabledCapabilities = buildCapabilities({
      models,
      integrations: { parallel: { apiKey: "parallel-key" } },
      webSearchProvider: "none",
    });

    expect(exaCapabilities.integrations.web).toBe(true);
    expect(exaCapabilities.integrations.exa).toBe(true);
    expect(exaCapabilities.integrations.parallel).toBe(false);
    expect(resolveConfiguredWebSearchProvider({ integrations: { exa: { apiKey: "exa-key" }, parallel: { apiKey: "parallel-key" } } })).toBe("exa");
    expect(parallelCapabilities.integrations.web).toBe(true);
    expect(parallelCapabilities.integrations.exa).toBe(false);
    expect(parallelCapabilities.integrations.parallel).toBe(true);
    expect(parallelCapabilities.tools.worker.web_search).toBe(true);
    expect(parallelCapabilities.tools.worker.get_page_contents).toBe(true);
    expect(disabledCapabilities.integrations.web).toBe(false);
    expect(disabledCapabilities.integrations.parallel).toBe(false);
    expect(disabledCapabilities.tools.worker.web_search).toBe(false);
  });

  it("enables memory search and storage capabilities when Supermemory is selected", () => {
    const capabilities = buildCapabilities({ models, integrations: { supermemory: { apiKey: "test" } }, memoryMode: "tools" });

    expect(capabilities.integrations.memory).toBe(true);
    expect(capabilities.integrations.supermemory).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(true);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.worker.memory).toBe(true);
    expect(capabilities.tools.worker.memory_reflect).toBe(false);
  });

  it("enables memory search and storage capabilities when Hindsight is selected", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { hindsight: { baseUrl: "https://hindsight.example.com" } },
      memoryMode: "tools",
    });

    expect(capabilities.integrations.memory).toBe(true);
    expect(capabilities.integrations.hindsight).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(true);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(true);
    expect(capabilities.tools.worker.memory).toBe(true);
    expect(capabilities.tools.worker.memory_reflect).toBe(true);
  });

  it("enables memory search, profile, and reflection capabilities when Honcho is selected", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { honcho: { apiKey: "test" } },
      memoryMode: "tools",
    });

    expect(capabilities.integrations.memory).toBe(true);
    expect(capabilities.integrations.honcho).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(true);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(true);
    expect(capabilities.tools.worker.memory).toBe(true);
    expect(capabilities.tools.worker.memory_reflect).toBe(true);
  });

  it("enables memory search and storage capabilities when Mem0 is selected", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { mem0: { apiKey: "test" } },
      memoryMode: "tools",
    });

    expect(capabilities.integrations.memory).toBe(true);
    expect(capabilities.integrations.mem0).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(true);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.worker.memory).toBe(true);
    expect(capabilities.tools.worker.memory_reflect).toBe(false);
  });

  it("does not enable Hindsight memory capabilities from API key without base URL", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { hindsight: { apiKey: "test" } },
    });

    expect(capabilities.integrations.memory).toBe(false);
    expect(capabilities.integrations.hindsight).toBe(false);
    expect(capabilities.tools.hotPath.search_memory).toBe(false);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.worker.memory).toBe(false);
    expect(capabilities.tools.worker.memory_reflect).toBe(false);
  });

  it("keeps memory capabilities disabled when provider is none", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { supermemory: { apiKey: "test" } },
      memoryProvider: "none",
    });

    expect(capabilities.integrations.memory).toBe(false);
    expect(capabilities.integrations.supermemory).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(false);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.worker.memory).toBe(false);
    expect(capabilities.tools.worker.memory_reflect).toBe(false);
  });

  it("keeps hot-path memory tools disabled in context mode while storage stays enabled", () => {
    const capabilities = buildCapabilities({
      models,
      integrations: { hindsight: { baseUrl: "https://hindsight.example.com" } },
      memoryMode: "context",
    });

    expect(capabilities.integrations.memory).toBe(true);
    expect(capabilities.tools.hotPath.search_memory).toBe(false);
    expect(capabilities.tools.hotPath.reflect_memory).toBe(false);
    expect(capabilities.tools.worker.memory).toBe(true);
    expect(capabilities.tools.worker.memory_reflect).toBe(true);
  });
});

describe("loadConfig automation intervals", () => {
  it("loads Parallel web provider configuration from env", () => {
    setRequiredEnv({
      WEB_SEARCH_PROVIDER: "parallel",
      PARALLEL_API_KEY: "parallel-key",
      PARALLEL_BASE_URL: "https://api.parallel.ai",
      PARALLEL_TIMEOUT_MS: "45000",
      PARALLEL_MAX_RETRIES: "1",
    });

    const config = loadConfig();

    expect(config.webSearchProvider).toBe("parallel");
    expect(config.integrations?.parallel).toEqual({
      apiKey: "parallel-key",
      baseUrl: "https://api.parallel.ai",
      timeoutMs: 45_000,
      maxRetries: 1,
    });
    expect(config.capabilities.integrations.web).toBe(true);
    expect(config.capabilities.integrations.parallel).toBe(true);
    expect(config.capabilities.tools.worker.web_search).toBe(true);
    expect(config.capabilities.tools.worker.get_page_contents).toBe(true);
  });

  it("rejects explicit web provider selection without the matching API key", () => {
    setRequiredEnv({ WEB_SEARCH_PROVIDER: "parallel" });

    expect(() => loadConfig()).toThrow("PARALLEL_API_KEY");
  });

  it("always scopes Composio to Finn's required mail toolkits by default", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.integrations?.composio?.allowedToolkits).toEqual([...requiredComposioToolkits]);
  });

  it("preserves configured Composio toolkits while requiring Gmail and Outlook", () => {
    setRequiredEnv({ COMPOSIO_ALLOWED_TOOLKITS: "slack,gmail,github" });

    const config = loadConfig();

    expect(config.integrations?.composio?.allowedToolkits).toEqual(["gmail", "outlook", "slack", "github"]);
  });

  it("sets conservative My Day and personal intelligence defaults", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.intervals.myDayRefreshTimes).toEqual([
      { hour: 5, minute: 0 },
      { hour: 11, minute: 0 },
      { hour: 17, minute: 0 },
    ]);
    expect(config.intervals.personalIntelligenceRefreshTimes).toEqual([{ hour: 0, minute: 0 }]);
    expect(config.intervals.personalIntelligenceInitialBackfillMs).toBe(30 * 24 * 60 * 60_000);
    expect(config.intervals.personalIntelligenceOverlapMs).toBe(6 * 60 * 60_000);
    expect(config.workerLimits.timeoutMs).toBe(15 * 60_000);
    expect(config.workerTimeoutMs).toBe(15 * 60_000);
    expect(config.backgroundLlmTimeoutMs).toBe(15 * 60_000);
    expect(config.personalIntelligenceTimeoutMs).toBe(30 * 60_000);
    expect(config.personalIntelligenceMaxSteps).toBe(120);
    expect(config.scheduler.graphile).toEqual({
      concurrency: 4,
      maxPoolSize: 10,
      pollIntervalMs: 1_000,
      patternTickMs: 60_000,
      myDayTickMs: 60_000,
      personalIntelligenceTickMs: 5 * 60_000,
      myDayScheduledJitterMs: 20 * 60_000,
      personalIntelligenceScheduledJitterMs: 60 * 60_000,
    });
  });

  it("parses Personal Intelligence backfill and overlap windows", () => {
    setRequiredEnv({
      PERSONAL_INTELLIGENCE_INITIAL_BACKFILL_MS: "86400000",
      PERSONAL_INTELLIGENCE_INCREMENTAL_OVERLAP_MS: "1800000",
    });

    const config = loadConfig();

    expect(config.intervals.personalIntelligenceInitialBackfillMs).toBe(86_400_000);
    expect(config.intervals.personalIntelligenceOverlapMs).toBe(1_800_000);
  });

  it("parses configured My Day refresh times", () => {
    setRequiredEnv({ MY_DAY_REFRESH_TIMES: "04:30,1215,2100" });

    const config = loadConfig();

    expect(config.intervals.myDayRefreshTimes).toEqual([
      { hour: 4, minute: 30 },
      { hour: 12, minute: 15 },
      { hour: 21, minute: 0 },
    ]);
  });

  it("parses configured Personal Intelligence refresh times", () => {
    setRequiredEnv({ PERSONAL_INTELLIGENCE_REFRESH_TIMES: "0000,12:30" });

    const config = loadConfig();

    expect(config.intervals.personalIntelligenceRefreshTimes).toEqual([
      { hour: 0, minute: 0 },
      { hour: 12, minute: 30 },
    ]);
  });

  it("allows a shared non-hot-path LLM timeout override", () => {
    setRequiredEnv({ BACKGROUND_LLM_TIMEOUT_MS: "120000" });

    const config = loadConfig();

    expect(config.backgroundLlmTimeoutMs).toBe(120_000);
    expect(config.personalIntelligenceTimeoutMs).toBe(30 * 60_000);
  });

  it("allows a longer Personal Intelligence timeout override", () => {
    setRequiredEnv({
      PERSONAL_INTELLIGENCE_TIMEOUT_MS: "3600000",
      PERSONAL_INTELLIGENCE_MAX_STEPS: "240",
    });

    const config = loadConfig();

    expect(config.personalIntelligenceTimeoutMs).toBe(3_600_000);
    expect(config.personalIntelligenceMaxSteps).toBe(240);
  });

  it("parses Graphile scheduler runtime overrides", () => {
    setRequiredEnv({
      GRAPHILE_WORKER_CONCURRENCY: "8",
      GRAPHILE_WORKER_MAX_POOL_SIZE: "12",
      GRAPHILE_WORKER_POLL_INTERVAL_MS: "2000",
      SCHEDULER_PATTERN_TICK_MS: "30000",
      SCHEDULER_MY_DAY_TICK_MS: "45000",
      SCHEDULER_PERSONAL_INTELLIGENCE_TICK_MS: "120000",
      SCHEDULER_MY_DAY_JITTER_MS: "600000",
      SCHEDULER_PERSONAL_INTELLIGENCE_JITTER_MS: "1800000",
    });

    const config = loadConfig();

    expect(config.scheduler.graphile).toEqual({
      concurrency: 8,
      maxPoolSize: 12,
      pollIntervalMs: 2_000,
      patternTickMs: 30_000,
      myDayTickMs: 45_000,
      personalIntelligenceTickMs: 120_000,
      myDayScheduledJitterMs: 600_000,
      personalIntelligenceScheduledJitterMs: 1_800_000,
    });
  });
});

describe("loadConfig LLM models", () => {
  it("loads OpenAI-compatible endpoints with an optional API key", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "openai-compatible",
      DEFAULT_MODEL: "openai-compatible:local-chat-model",
      DEFAULT_API_KEY: undefined,
      DEFAULT_BASE_URL: "http://localhost:1234/v1",
    });

    const config = loadConfig();

    expect(config.models.default).toEqual({
      provider: "openai-compatible",
      model: "openai-compatible:local-chat-model",
      baseUrl: "http://localhost:1234/v1",
      maxContextTokens: 128_000,
    });
    expect(config.models.hotPath.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.models.worker.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.models.compactor.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.apiKeys.default).toBeUndefined();
    expect(config.capabilities.llm.defaultProvider).toBe("openai-compatible");
    expect(config.llm.forceToolChoice).toBe(false);
  });

  it("allows process-specific OpenAI-compatible base URL overrides", () => {
    setRequiredEnv({
      WORKER_PROVIDER: "openai-compatible",
      WORKER_MODEL: "openai-compatible:worker-model",
      WORKER_BASE_URL: "https://models.example.com/v1",
    });

    const config = loadConfig();

    expect(config.models.hotPath.baseUrl).toBeUndefined();
    expect(config.models.worker).toEqual({
      provider: "openai-compatible",
      model: "openai-compatible:worker-model",
      baseUrl: "https://models.example.com/v1",
      maxContextTokens: 128_000,
    });
    expect(config.models.compactor.baseUrl).toBeUndefined();
    expect(config.llm.forceToolChoice).toBe(false);
  });

  it("loads DeepSeek as a model provider", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "deepseek",
      DEFAULT_MODEL: "deepseek:deepseek-v4-pro",
    });

    const config = loadConfig();

    expect(config.models.hotPath).toEqual({
      provider: "deepseek",
      model: "deepseek:deepseek-v4-pro",
      maxContextTokens: 128_000,
    });
    expect(config.capabilities.llm.defaultProvider).toBe("deepseek");
  });

  it("rejects OpenAI-compatible endpoints without a base URL", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "openai-compatible",
      DEFAULT_MODEL: "openai-compatible:local-chat-model",
      DEFAULT_API_KEY: undefined,
      DEFAULT_BASE_URL: undefined,
    });

    expect(() => loadConfig()).toThrow("DEFAULT_BASE_URL");
  });

  it("rejects invalid OpenAI-compatible base URLs", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "openai-compatible",
      DEFAULT_MODEL: "openai-compatible:local-chat-model",
      DEFAULT_API_KEY: undefined,
      DEFAULT_BASE_URL: "not-a-url",
    });

    expect(() => loadConfig()).toThrow();
  });

  it("still requires API keys for non-compatible providers", () => {
    setRequiredEnv({ DEFAULT_API_KEY: undefined });

    expect(() => loadConfig()).toThrow("DEFAULT_API_KEY");
  });

  it("loads default context and output limits for every LLM process", () => {
    setRequiredEnv({
      DEFAULT_MAX_CONTEXT_TOKENS: "1000000",
      DEFAULT_MAX_OUTPUT_TOKENS: "384000",
    });

    const config = loadConfig();

    expect(config.models.default.maxContextTokens).toBe(1_000_000);
    expect(config.models.default.maxOutputTokens).toBe(384_000);
    expect(config.models.hotPath.maxContextTokens).toBe(1_000_000);
    expect(config.models.hotPath.maxOutputTokens).toBe(384_000);
    expect(config.models.worker.maxContextTokens).toBe(1_000_000);
    expect(config.models.worker.maxOutputTokens).toBe(384_000);
    expect(config.models.compactor.maxContextTokens).toBe(1_000_000);
    expect(config.models.compactor.maxOutputTokens).toBe(384_000);
    expect(config.context.maxTokens).toBe(1_000_000);
  });

  it("allows forced tool choice to be disabled for incompatible providers", () => {
    setRequiredEnv({ LLM_FORCE_TOOL_CHOICE: "false" });

    const config = loadConfig();

    expect(config.llm.forceToolChoice).toBe(false);
  });

  it("keeps forced tool choice enabled by default for native providers", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.llm.forceToolChoice).toBe(true);
  });

  it("allows forced tool choice to be explicitly enabled for OpenAI-compatible providers", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "openai-compatible",
      DEFAULT_MODEL: "openai-compatible:local-chat-model",
      DEFAULT_API_KEY: undefined,
      DEFAULT_BASE_URL: "http://localhost:1234/v1",
      LLM_FORCE_TOOL_CHOICE: "true",
    });

    const config = loadConfig();

    expect(config.llm.forceToolChoice).toBe(true);
  });

  it("allows process-specific context and output limit overrides", () => {
    setRequiredEnv({
      DEFAULT_MAX_CONTEXT_TOKENS: "1000000",
      DEFAULT_MAX_OUTPUT_TOKENS: "384000",
      WORKER_MAX_CONTEXT_TOKENS: "512000",
      WORKER_MAX_OUTPUT_TOKENS: "64000",
    });

    const config = loadConfig();

    expect(config.models.hotPath.maxContextTokens).toBe(1_000_000);
    expect(config.models.hotPath.maxOutputTokens).toBe(384_000);
    expect(config.models.worker.maxContextTokens).toBe(512_000);
    expect(config.models.worker.maxOutputTokens).toBe(64_000);
    expect(config.models.compactor.maxContextTokens).toBe(1_000_000);
    expect(config.models.compactor.maxOutputTokens).toBe(384_000);
  });

  it("loads DeepSeek reasoning effort for every process from the default env", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "deepseek",
      DEFAULT_MODEL: "deepseek:deepseek-v4-pro",
      DEFAULT_REASONING_EFFORT: "high",
    });

    const config = loadConfig();

    expect(config.models.default.reasoningEffort).toBe("high");
    expect(config.models.hotPath.reasoningEffort).toBe("high");
    expect(config.models.worker.reasoningEffort).toBe("high");
    expect(config.models.compactor.reasoningEffort).toBe("high");
  });

  it("allows process-specific DeepSeek reasoning effort overrides", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "openai",
      DEFAULT_MODEL: "openai:gpt-4o-mini",
      DEFAULT_REASONING_EFFORT: "high",
      WORKER_PROVIDER: "deepseek",
      WORKER_MODEL: "deepseek:deepseek-v4-pro",
      WORKER_REASONING_EFFORT: "max",
    });

    const config = loadConfig();

    expect(config.models.hotPath.reasoningEffort).toBeUndefined();
    expect(config.models.worker).toEqual({
      provider: "deepseek",
      model: "deepseek:deepseek-v4-pro",
      reasoningEffort: "max",
      maxContextTokens: 128_000,
    });
    expect(config.models.compactor.reasoningEffort).toBeUndefined();
  });

  it("rejects invalid DeepSeek reasoning effort values", () => {
    setRequiredEnv({
      DEFAULT_PROVIDER: "deepseek",
      DEFAULT_MODEL: "deepseek:deepseek-v4-pro",
      DEFAULT_REASONING_EFFORT: "minimal",
    });

    expect(() => loadConfig()).toThrow();
  });
});

describe("loadConfig telemetry", () => {
  it("keeps telemetry disabled by default", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.telemetry).toEqual({
      provider: "none",
      posthog: { host: "https://us.i.posthog.com" },
    });
  });

  it("enables optional PostHog telemetry when configured", () => {
    setRequiredEnv({ POSTHOG_API_KEY: "phc_test" });

    const config = loadConfig();

    expect(config.telemetry).toEqual({
      provider: "posthog",
      posthog: { apiKey: "phc_test", host: "https://us.i.posthog.com" },
    });
  });

  it("rejects unsupported legacy telemetry providers", () => {
    setRequiredEnv({ TELEMETRY_PROVIDER: "otlp" });

    expect(() => loadConfig()).toThrow();
  });
});

describe("resolveMemoryProvider", () => {
  it("defaults to none when no memory provider is configured", () => {
    expect(resolveMemoryProvider({ integrations: {} })).toBe("none");
  });

  it("defaults to Supermemory for existing Supermemory-only deployments", () => {
    expect(resolveMemoryProvider({ integrations: { supermemory: { apiKey: "test" } } })).toBe("supermemory");
  });

  it("defaults to Honcho when only Honcho is configured", () => {
    expect(resolveMemoryProvider({ integrations: { honcho: { apiKey: "test" } } })).toBe("honcho");
    expect(resolveMemoryProvider({ integrations: { honcho: { baseUrl: "https://honcho.example.com" } } })).toBe("honcho");
    expect(resolveMemoryProvider({ integrations: { mem0: { apiKey: "test" } } })).toBe("mem0");
  });

  it("requires an explicit provider when multiple memory providers are configured", () => {
    expect(() => resolveMemoryProvider({
      integrations: {
        supermemory: { apiKey: "test" },
        hindsight: { baseUrl: "https://hindsight.example.com" },
      },
    })).toThrow("MEMORY_PROVIDER is required");
  });

  it("honors an explicit provider selection", () => {
    expect(resolveMemoryProvider({ requested: "none", integrations: { supermemory: { apiKey: "test" } } })).toBe("none");
    expect(resolveMemoryProvider({ requested: "supermemory", integrations: { supermemory: { apiKey: "test" } } })).toBe("supermemory");
    expect(resolveMemoryProvider({ requested: "hindsight", integrations: { hindsight: { baseUrl: "https://hindsight.example.com" } } })).toBe("hindsight");
    expect(resolveMemoryProvider({ requested: "honcho", integrations: { honcho: { apiKey: "test" } } })).toBe("honcho");
    expect(resolveMemoryProvider({ requested: "mem0", integrations: { mem0: { apiKey: "test" } } })).toBe("mem0");
  });

  it("does not infer Hindsight from API key without base URL", () => {
    expect(resolveMemoryProvider({ integrations: { hindsight: { apiKey: "test" } } })).toBe("none");
  });
});

describe("loadConfig memory provider validation", () => {
  it("rejects an invalid memory provider", () => {
    setRequiredEnv({ MEMORY_PROVIDER: "invalid" });

    expect(() => loadConfig()).toThrow();
  });

  it("rejects Supermemory provider selection without a Supermemory API key", () => {
    setRequiredEnv({ MEMORY_PROVIDER: "supermemory", SUPERMEMORY_API_KEY: undefined });

    expect(() => loadConfig()).toThrow("MEMORY_PROVIDER=supermemory requires SUPERMEMORY_API_KEY");
  });

  it("rejects Hindsight provider selection without a Hindsight base URL", () => {
    setRequiredEnv({ MEMORY_PROVIDER: "hindsight", HINDSIGHT_BASE_URL: undefined });

    expect(() => loadConfig()).toThrow("MEMORY_PROVIDER=hindsight requires HINDSIGHT_BASE_URL");
  });

  it("rejects Honcho provider selection without a Honcho API key or base URL", () => {
    setRequiredEnv({ MEMORY_PROVIDER: "honcho", HONCHO_API_KEY: undefined, HONCHO_BASE_URL: undefined });

    expect(() => loadConfig()).toThrow("MEMORY_PROVIDER=honcho requires HONCHO_API_KEY or HONCHO_BASE_URL");
  });

  it("rejects Mem0 provider selection without a Mem0 API key", () => {
    setRequiredEnv({ MEMORY_PROVIDER: "mem0", MEM0_API_KEY: undefined });

    expect(() => loadConfig()).toThrow("MEMORY_PROVIDER=mem0 requires MEM0_API_KEY");
  });

  it("rejects multiple configured memory providers without explicit selection", () => {
    setRequiredEnv({
      SUPERMEMORY_API_KEY: "test",
      HINDSIGHT_BASE_URL: "https://hindsight.example.com",
    });

    expect(() => loadConfig()).toThrow("MEMORY_PROVIDER is required");
  });

  it("loads configured memory mode", () => {
    setRequiredEnv({
      MEMORY_PROVIDER: "hindsight",
      MEMORY_MODE: "hybrid",
      HINDSIGHT_BASE_URL: "https://hindsight.example.com",
    });

    const config = loadConfig();

    expect(config.memory).toEqual({
      provider: "hindsight",
      mode: "hybrid",
      autoRecallTimeoutMs: 3_000,
      autoRecallMaxResults: 8,
      provisionMentalModels: true,
    });
    expect(config.capabilities.tools.hotPath.search_memory).toBe(true);
    expect(config.capabilities.tools.hotPath.reflect_memory).toBe(true);
  });

  it("loads configured Honcho memory settings", () => {
    setRequiredEnv({
      MEMORY_PROVIDER: "honcho",
      MEMORY_MODE: "hybrid",
      HONCHO_API_KEY: "honcho-key",
      HONCHO_BASE_URL: "https://honcho.example.com",
      HONCHO_WORKSPACE_PREFIX: "finn-dev",
      HONCHO_TIMEOUT_MS: "12000",
    });

    const config = loadConfig();

    expect(config.memory.provider).toBe("honcho");
    expect(config.memory.mode).toBe("hybrid");
    expect(config.integrations?.honcho).toEqual({
      apiKey: "honcho-key",
      baseUrl: "https://honcho.example.com",
      workspacePrefix: "finn-dev",
      timeoutMs: 12000,
    });
    expect(config.capabilities.integrations.honcho).toBe(true);
    expect(config.capabilities.tools.hotPath.search_memory).toBe(true);
    expect(config.capabilities.tools.hotPath.reflect_memory).toBe(true);
  });

  it("loads configured auto recall timeout", () => {
    setRequiredEnv({
      MEMORY_PROVIDER: "hindsight",
      MEMORY_MODE: "hybrid",
      MEMORY_AUTO_RECALL_TIMEOUT_MS: "5000",
      HINDSIGHT_BASE_URL: "https://hindsight.example.com",
    });

    const config = loadConfig();

    expect(config.memory.autoRecallTimeoutMs).toBe(5_000);
  });

  it("loads configured auto recall max results and mental model provisioning toggle", () => {
    setRequiredEnv({
      MEMORY_PROVIDER: "hindsight",
      MEMORY_MODE: "hybrid",
      MEMORY_AUTO_RECALL_MAX_RESULTS: "12",
      MEMORY_PROVISION_MENTAL_MODELS: "false",
      HINDSIGHT_BASE_URL: "https://hindsight.example.com",
    });

    const config = loadConfig();

    expect(config.memory.autoRecallMaxResults).toBe(12);
    expect(config.memory.provisionMentalModels).toBe(false);
  });
});
