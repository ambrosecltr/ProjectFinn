import { describe, expect, it } from "bun:test";
import type { AppConfig } from "@finn/core";

import { buildMemoryProviderStatus, buildRuntimeGatingStatus, createAdminRoutes } from "./admin.js";

function createConfig(capabilities: AppConfig["capabilities"], overrides: Partial<Pick<AppConfig, "integrations" | "memory">> = {}): AppConfig {
  return {
    spectrum: {
      projectId: "spectrum-project",
      projectSecret: "spectrum-secret",
      dedicatedLinePhone: "+15555550100",
    },
    userTimezone: "UTC",
    publicUrl: "https://finn.example.com",
    databaseUrl: "postgres://user:pass@localhost:5432/finn",
    models: {
      default: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
      hotPath: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
      worker: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
      compactor: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
    },
    llm: { forceToolChoice: true },
    maxTurns: { hotPath: 10, worker: 20, compactor: 5 },
    apiKeys: {
      default: "test-key",
      hotPath: "test-key",
      worker: "test-key",
      compactor: "test-key",
    },
    capabilities,
    memory: overrides.memory ?? {
      provider: capabilities.integrations.mem0
        ? "mem0"
        : capabilities.integrations.honcho
          ? "honcho"
          : capabilities.integrations.hindsight
            ? "hindsight"
            : capabilities.integrations.supermemory
              ? "supermemory"
              : "none",
      mode: "tools",
      autoRecallTimeoutMs: 3_000,
      autoRecallMaxResults: 8,
      provisionMentalModels: true,
    },
    context: {
      maxTokens: 128_000,
      promptHistoryTokenBudget: 12_000,
      promptHistoryMessageTokenBudget: 4_000,
      currentTurnTokenBudget: 12_000,
      chapterSummaryTokenBudget: 8_000,
      handoffInputTokenBudget: 12_000,
      compactionBufferTokens: 4_000,
      compactionBatchBackground: 20,
      compactionBatchAggressive: 40,
      compactionEmergencyBatch: 30,
      compactionMaxPasses: 3,
      dailyRolloverHour: 4,
      dailyRolloverMinute: 0,
      thresholdWarn: 0.7,
      thresholdBackground: 0.8,
      thresholdAggressive: 0.9,
      thresholdEmergency: 0.95,
    },
    webSearchProvider: "auto",
    hotPathIngress: {
      userGroupingWindowMs: 500,
      maxCoalesceMessages: 5,
    },
    workerLimits: {
      timeoutMs: 300_000,
      maxConcurrent: 5,
      maxToolCalls: 50,
    },
    backgroundLlmTimeoutMs: 300_000,
    personalIntelligenceTimeoutMs: 30 * 60_000,
    personalIntelligenceMaxSteps: 120,
    workerTimeoutMs: 300_000,
    workerSandbox: {
      workspacesPath: "./workspaces",
    },
    scheduler: {
      graphile: {
        concurrency: 4,
        maxPoolSize: 10,
        pollIntervalMs: 1_000,
        patternTickMs: 60_000,
        myDayTickMs: 60_000,
        personalIntelligenceTickMs: 5 * 60_000,
        myDayScheduledJitterMs: 20 * 60_000,
        personalIntelligenceScheduledJitterMs: 60 * 60_000,
      },
    },
    fileStorage: {
      maxFileSizeMb: 100,
    },
    intervals: {
      patternCircuitBreakerThreshold: 3,
      myDayRefreshTimes: [
        { hour: 5, minute: 0 },
        { hour: 11, minute: 0 },
        { hour: 17, minute: 0 },
      ],
      personalIntelligenceRefreshTimes: [{ hour: 0, minute: 0 }],
      personalIntelligenceInitialBackfillMs: 30 * 86_400_000,
      personalIntelligenceOverlapMs: 6 * 60 * 60_000,
    },
    integrations: overrides.integrations ?? {},
    admin: {},
    logLevel: "info",
    telemetry: {
      provider: "none",
      posthog: { host: "https://us.i.posthog.com" },
    },
    server: {
      port: 3000,
      host: "0.0.0.0",
    },
  };
}

function createCapabilities(overrides: {
  web?: boolean;
  exa?: boolean;
  parallel?: boolean;
  fal?: boolean;
  composio?: boolean;
  deepgram?: boolean;
  elevenlabs?: boolean;
  hindsight?: boolean;
  honcho?: boolean;
  mem0?: boolean;
  supermemory?: boolean;
} = {}): AppConfig["capabilities"] {
  const web = overrides.web ?? overrides.exa ?? overrides.parallel ?? false;
  const exa = overrides.exa ?? false;
  const parallel = overrides.parallel ?? false;
  const fal = overrides.fal ?? false;
  const composio = overrides.composio ?? false;
  const deepgram = overrides.deepgram ?? false;
  const elevenlabs = overrides.elevenlabs ?? false;
  const hindsight = overrides.hindsight ?? false;
  const honcho = overrides.honcho ?? false;
  const mem0 = overrides.mem0 ?? false;
  const supermemory = overrides.supermemory ?? false;
  const memory = supermemory || hindsight || honcho || mem0;
  const memoryReflect = hindsight || honcho;

  return {
    boot: {
      spectrum: true,
      publicUrl: true,
      database: true,
      llm: true,
      fileStorage: true,
    },
    llm: {
      defaultProvider: "openai",
      processes: {
        hotPath: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
        worker: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
        compactor: { model: "openai:gpt-4o-mini", provider: "openai", maxContextTokens: 128_000 },
      },
    },
    integrations: {
      web,
      memory,
      exa,
      parallel,
      fal,
      composio,
      deepgram,
      elevenlabs,
      hindsight,
      honcho,
      mem0,
      supermemory,
    },
    media: {
      fileStorage: true,
      speechToText: deepgram,
      textToSpeech: elevenlabs,
      voiceRoundTrip: deepgram && elevenlabs,
    },
    tools: {
      hotPath: {
        send_message: true,
        send_media: true,
        react: true,
        wait: true,
        display_draft: true,
        patterns: true,
        files: true,
        search_memory: memory,
        reflect_memory: memoryReflect,
        my_day: true,
      },
      worker: {
        web_search: web,
        get_page_contents: web,
        create_or_edit_image: fal,
        create_or_edit_video: fal,
        mcp: true,
        patterns: true,
        composio,
        memory,
        memory_reflect: memoryReflect,
        skills: true,
      },
    },
  };
}

describe("buildRuntimeGatingStatus", () => {
  it("surfaces disabled optional integrations and worker tool families", () => {
    const status = buildRuntimeGatingStatus(createConfig(createCapabilities()));

    expect(status.integrations.disabled).toEqual(["composio", "deepgram", "elevenlabs", "exa", "fal", "hindsight", "honcho", "mem0", "memory", "parallel", "supermemory", "web"]);
    expect(status.media.enabled).toEqual(["fileStorage"]);
    expect(status.media.disabled).toEqual(["speechToText", "textToSpeech", "voiceRoundTrip"]);
    expect(status.configuredToolFamilies.worker.disabled).toEqual([
      "composio",
      "create_or_edit_image",
      "create_or_edit_video",
      "get_page_contents",
      "memory",
      "memory_reflect",
      "web_search",
    ]);
  });

  it("surfaces enabled runtime-gated tool families", () => {
    const status = buildRuntimeGatingStatus(createConfig(createCapabilities({
      exa: true,
      fal: true,
      composio: true,
      deepgram: true,
      elevenlabs: true,
      supermemory: true,
    })));

    expect(status.integrations.enabled).toEqual(["composio", "deepgram", "elevenlabs", "exa", "fal", "memory", "supermemory", "web"]);
    expect(status.media.enabled).toEqual(["fileStorage", "speechToText", "textToSpeech", "voiceRoundTrip"]);
    expect(status.configuredToolFamilies.worker.disabled).toEqual(["memory_reflect"]);
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("search_memory");
    expect(status.configuredToolFamilies.hotPath.disabled).toContain("reflect_memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("web_search");
    expect(status.configuredToolFamilies.worker.enabled).toContain("create_or_edit_image");
    expect(status.configuredToolFamilies.worker.enabled).toContain("composio");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory");
  });

  it("surfaces Hindsight-backed memory as enabled", () => {
    const status = buildRuntimeGatingStatus(createConfig(createCapabilities({ hindsight: true })));

    expect(status.integrations.enabled).toEqual(["hindsight", "memory"]);
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("search_memory");
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("reflect_memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory_reflect");
  });

  it("surfaces Honcho-backed memory as enabled", () => {
    const status = buildRuntimeGatingStatus(createConfig(createCapabilities({ honcho: true })));

    expect(status.integrations.enabled).toEqual(["honcho", "memory"]);
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("search_memory");
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("reflect_memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory_reflect");
  });

  it("surfaces Mem0-backed memory as search-only", () => {
    const status = buildRuntimeGatingStatus(createConfig(createCapabilities({ mem0: true })));

    expect(status.integrations.enabled).toEqual(["mem0", "memory"]);
    expect(status.configuredToolFamilies.hotPath.enabled).toContain("search_memory");
    expect(status.configuredToolFamilies.hotPath.disabled).toContain("reflect_memory");
    expect(status.configuredToolFamilies.worker.enabled).toContain("memory");
    expect(status.configuredToolFamilies.worker.disabled).toContain("memory_reflect");
  });
});

describe("buildMemoryProviderStatus", () => {
  it("shows disabled memory with per-provider configuration state", () => {
    const status = buildMemoryProviderStatus(createConfig(createCapabilities()));

    expect(status).toEqual({
      selectedProvider: "none",
      mode: "tools",
      configured: false,
      providers: {
        supermemory: { configured: false, selected: false },
        hindsight: { configured: false, selected: false },
        honcho: { configured: false, selected: false },
        mem0: { configured: false, selected: false },
      },
    });
  });

  it("shows selected Supermemory separately from configured Hindsight", () => {
    const status = buildMemoryProviderStatus(createConfig(createCapabilities({ supermemory: true, hindsight: true }), {
      integrations: {
        supermemory: { apiKey: "test" },
        hindsight: { baseUrl: "https://hindsight.example.com" },
      },
      memory: { provider: "supermemory", mode: "hybrid", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
    }));

    expect(status).toEqual({
      selectedProvider: "supermemory",
      mode: "hybrid",
      configured: true,
      providers: {
        supermemory: { configured: true, selected: true },
        hindsight: { configured: true, selected: false },
        honcho: { configured: false, selected: false },
        mem0: { configured: false, selected: false },
      },
    });
  });

  it("requires a Hindsight base URL to mark Hindsight configured", () => {
    const status = buildMemoryProviderStatus(createConfig(createCapabilities({ hindsight: true }), {
      integrations: { hindsight: { apiKey: "test" } },
      memory: { provider: "hindsight", mode: "tools", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
    }));

    expect(status).toEqual({
      selectedProvider: "hindsight",
      mode: "tools",
      configured: false,
      providers: {
        supermemory: { configured: false, selected: false },
        hindsight: { configured: false, selected: true },
        honcho: { configured: false, selected: false },
        mem0: { configured: false, selected: false },
      },
    });
  });

  it("shows selected Honcho when an API key is configured", () => {
    const status = buildMemoryProviderStatus(createConfig(createCapabilities({ honcho: true }), {
      integrations: { honcho: { apiKey: "test" } },
      memory: { provider: "honcho", mode: "tools", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
    }));

    expect(status).toEqual({
      selectedProvider: "honcho",
      mode: "tools",
      configured: true,
      providers: {
        supermemory: { configured: false, selected: false },
        hindsight: { configured: false, selected: false },
        honcho: { configured: true, selected: true },
        mem0: { configured: false, selected: false },
      },
    });
  });

  it("shows selected Mem0 when an API key is configured", () => {
    const status = buildMemoryProviderStatus(createConfig(createCapabilities({ mem0: true }), {
      integrations: { mem0: { apiKey: "test" } },
      memory: { provider: "mem0", mode: "tools", autoRecallTimeoutMs: 3_000, autoRecallMaxResults: 8, provisionMentalModels: true },
    }));

    expect(status).toEqual({
      selectedProvider: "mem0",
      mode: "tools",
      configured: true,
      providers: {
        supermemory: { configured: false, selected: false },
        hindsight: { configured: false, selected: false },
        honcho: { configured: false, selected: false },
        mem0: { configured: true, selected: true },
      },
    });
  });
});

describe("GET /admin/status", () => {
  it("returns runtime stats without user-owned worker or pattern records", async () => {
    const app = createAdminRoutes({
      config: createConfig(createCapabilities()),
      db: {} as never,
      patternStore: {
        getActiveCount: async () => 2,
        listActive: async () => {
          throw new Error("status must not load pattern records");
        },
      } as never,
      workerManager: {
        getActive: async () => [
          {
            id: "wrk_sensitive",
            task: "private user task",
            userId: "usr_sensitive",
          },
        ],
      } as never,
    });

    const response = await app.request("http://localhost/status");
    const body = await response.json() as {
      patterns?: unknown;
      workers?: unknown;
      stats: { workers: { activeCount: number }; patterns: { activeCount: number }; mcp?: unknown };
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.patterns).toBeUndefined();
    expect(body.workers).toBeUndefined();
    expect(body.stats.workers.activeCount).toBe(1);
    expect(body.stats.patterns.activeCount).toBe(2);
    expect(body.stats.mcp).toBeUndefined();
    expect(serialized).not.toContain("private user task");
    expect(serialized).not.toContain("usr_sensitive");
  });
});
