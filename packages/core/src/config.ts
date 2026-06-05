import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTimeZone } from "./timezone.js";

// ---------------------------------------------------------------------------
// Schema — every config value validated at load time
// ---------------------------------------------------------------------------

const contextConfigSchema = z.object({
  maxTokens: z.number().int().positive(),
  promptHistoryTokenBudget: z.number().int().positive(),
  promptHistoryMessageTokenBudget: z.number().int().positive(),
  currentTurnTokenBudget: z.number().int().positive(),
  chapterSummaryTokenBudget: z.number().int().positive(),
  handoffInputTokenBudget: z.number().int().positive(),
  compactionBufferTokens: z.number().int().positive(),
  compactionBatchBackground: z.number().int().positive(),
  compactionBatchAggressive: z.number().int().positive(),
  compactionEmergencyBatch: z.number().int().positive(),
  compactionMaxPasses: z.number().int().positive(),
  dailyRolloverHour: z.number().int().min(0).max(23),
  dailyRolloverMinute: z.number().int().min(0).max(59),
  thresholdWarn: z.number().min(0).max(1),
  thresholdBackground: z.number().min(0).max(1),
  thresholdAggressive: z.number().min(0).max(1),
  thresholdEmergency: z.number().min(0).max(1),
}).superRefine((context, ctx) => {
  if (context.maxTokens <= context.compactionBufferTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxTokens"],
      message: "HOT_PATH_MAX_CONTEXT_TOKENS must be greater than COMPACTION_BUFFER_TOKENS.",
    });
  }

  if (!(context.thresholdWarn <= context.thresholdBackground
    && context.thresholdBackground <= context.thresholdAggressive
    && context.thresholdAggressive <= context.thresholdEmergency)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thresholdWarn"],
      message: "Compaction thresholds must be ordered: warn <= background <= aggressive <= emergency.",
    });
  }
});

const llmProviderSchema = z.enum(["anthropic", "openai", "fireworks", "deepseek", "openai-compatible"]);
const llmReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const telemetryProviderSchema = z.enum(["none", "posthog"]);
const memoryProviderSchema = z.enum(["none", "supermemory", "hindsight", "honcho", "mem0"]);
const memoryModeSchema = z.enum(["hybrid", "context", "tools"]);
const memoryConfigSchema = z.object({
  provider: memoryProviderSchema,
  mode: memoryModeSchema,
  autoRecallTimeoutMs: z.number().int().positive(),
  autoRecallMaxResults: z.number().int().positive(),
  provisionMentalModels: z.boolean(),
});

const myDayRefreshTimeSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const modelConfigSchema = z.object({
  model: z.string().min(1),
  provider: llmProviderSchema,
  reasoningEffort: llmReasoningEffortSchema.optional(),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  baseUrl: z.string().url().optional(),
});

const processKeys = ["hotPath", "worker", "compactor"] as const;
const defaultWorkerTimeoutMs = 15 * 60_000;
type ProcessConfigKey = typeof processKeys[number];
type LLMProvider = z.infer<typeof llmProviderSchema>;
type LLMReasoningEffort = z.infer<typeof llmReasoningEffortSchema>;
type ModelConfig = z.infer<typeof modelConfigSchema>;
export type MemoryProvider = z.infer<typeof memoryProviderSchema>;
export type MemoryMode = z.infer<typeof memoryModeSchema>;

const processEnvPrefixes: Record<ProcessConfigKey, string> = {
  hotPath: "HOT_PATH",
  worker: "WORKER",
  compactor: "COMPACTOR",
};

export const requiredComposioToolkits = ["gmail", "outlook"] as const;

function parseComposioAllowedToolkits(value: string | undefined): string[] {
  const configuredToolkits = value
    ? value.split(",").map((toolkit) => toolkit.trim()).filter(Boolean)
    : [];

  return [...new Set([...requiredComposioToolkits, ...configuredToolkits])];
}

function validateModelProvider(modelConfig: { model: string; provider: string }, ctx: z.RefinementCtx, path: (string | number)[]): void {
  const separatorIndex = modelConfig.model.indexOf(":");
  if (separatorIndex === -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${modelConfig.model} must be prefixed with its provider, for example ${modelConfig.provider}:model-name.`,
    });
    return;
  }

  const providerFromModel = modelConfig.model.slice(0, separatorIndex);
  const modelName = modelConfig.model.slice(separatorIndex + 1);
  if (!modelName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${modelConfig.model} must include a model name after the provider prefix.`,
    });
  }

  if (providerFromModel !== modelConfig.provider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${modelConfig.model} does not match provider ${modelConfig.provider}.`,
    });
  }
}

function validateModelBaseUrl(
  modelConfig: Pick<ModelConfig, "provider" | "baseUrl">,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  envName: string,
): void {
  if (modelConfig.provider === "openai-compatible" && !modelConfig.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${envName} is required when provider is openai-compatible.`,
    });
  }
}

function validateModelApiKey(
  modelConfig: Pick<ModelConfig, "provider">,
  apiKey: string | undefined,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  envName: string,
): void {
  if (modelConfig.provider !== "openai-compatible" && !apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${envName} is required when provider is ${modelConfig.provider}.`,
    });
  }
}

const configSchema = z.object({
  // Spectrum (iMessage)
  spectrum: z.object({
    projectId: z.string().min(1),
    projectSecret: z.string().min(1),
    dedicatedLinePhone: z.string().min(1).optional(),
    allowedNumbers: z.array(z.string().min(1)).optional(),
  }),
  userPhoneNumber: z.string().min(1).optional(),
  userTimezone: z.string().min(1),

  // Public URL
  publicUrl: z.string().url(),

  // Database
  databaseUrl: z.string().min(1),

  // LLM models per process type. Process values are resolved from the default envs
  // plus any HOT_PATH_*, WORKER_*, or COMPACTOR_* overrides.
  models: z.object({
    default: modelConfigSchema,
    hotPath: modelConfigSchema,
    worker: modelConfigSchema,
    compactor: modelConfigSchema,
  }),
  llm: z.object({
    forceToolChoice: z.boolean(),
  }),

  // Max turns per agent
  maxTurns: z.object({
    hotPath: z.number().int().positive(),
    worker: z.number().int().positive(),
    compactor: z.number().int().positive(),
  }),

  // LLM API keys per process. Process keys resolve from DEFAULT_API_KEY unless
  // overridden with HOT_PATH_API_KEY, WORKER_API_KEY, or COMPACTOR_API_KEY.
  apiKeys: z.object({
    default: z.string().min(1).optional(),
    hotPath: z.string().min(1).optional(),
    worker: z.string().min(1).optional(),
    compactor: z.string().min(1).optional(),
  }),

  capabilities: z.object({
    boot: z.object({
      spectrum: z.literal(true),
      publicUrl: z.literal(true),
      database: z.literal(true),
      llm: z.literal(true),
      fileStorage: z.literal(true),
    }),
    llm: z.object({
      defaultProvider: llmProviderSchema,
      processes: z.record(modelConfigSchema),
    }),
    integrations: z.object({
      memory: z.boolean(),
      exa: z.boolean(),
      fal: z.boolean(),
      composio: z.boolean(),
      deepgram: z.boolean(),
      elevenlabs: z.boolean(),
      hindsight: z.boolean(),
      honcho: z.boolean(),
      mem0: z.boolean(),
      supermemory: z.boolean(),
    }),
    media: z.object({
      fileStorage: z.literal(true),
      speechToText: z.boolean(),
      textToSpeech: z.boolean(),
      voiceRoundTrip: z.boolean(),
    }),
    tools: z.object({
      hotPath: z.record(z.boolean()),
      worker: z.record(z.boolean()),
    }),
  }),

  // Context management
  context: contextConfigSchema,

  memory: memoryConfigSchema,

  hotPathIngress: z.object({
    userGroupingWindowMs: z.number().int().nonnegative(),
    maxCoalesceMessages: z.number().int().positive(),
  }),

  // Worker limits
  workerLimits: z.object({
    timeoutMs: z.number().int().positive(),
    maxConcurrent: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  }),
  backgroundLlmTimeoutMs: z.number().int().positive(),
  personalIntelligenceTimeoutMs: z.number().int().positive(),
  personalIntelligenceMaxSteps: z.number().int().positive(),
  workerTimeoutMs: z.number().int().positive(),
  workerSandbox: z.object({
    workspacesPath: z.string().min(1),
  }),

  scheduler: z.object({
    graphile: z.object({
      concurrency: z.number().int().positive(),
      maxPoolSize: z.number().int().min(2),
      pollIntervalMs: z.number().int().positive(),
      patternTickMs: z.number().int().positive(),
      myDayTickMs: z.number().int().positive(),
      personalIntelligenceTickMs: z.number().int().positive(),
      myDayScheduledJitterMs: z.number().int().nonnegative(),
      personalIntelligenceScheduledJitterMs: z.number().int().nonnegative(),
    }),
  }),

  // File storage
  fileStorage: z.object({
    maxFileSizeMb: z.number().int().positive(),
  }),

  // Intervals
  intervals: z.object({
    patternCircuitBreakerThreshold: z.number().int().positive(),
    myDayRefreshTimes: z.array(myDayRefreshTimeSchema).min(1),
    personalIntelligenceRefreshTimes: z.array(myDayRefreshTimeSchema).min(1),
    personalIntelligenceInitialBackfillMs: z.number().int().positive(),
    personalIntelligenceOverlapMs: z.number().int().nonnegative(),
  }),

  // Integrations (all optional — enabled only when API keys present)
  integrations: z
    .object({
      exa: z.object({ apiKey: z.string().optional() }).optional(),
      fal: z
        .object({
          apiKey: z.string().optional(),
          imageGenModel: z.string().optional(),
          imageEditModel: z.string().optional(),
          videoGenModel: z.string().optional(),
          imageToVideoModel: z.string().optional(),
          videoEditModel: z.string().optional(),
        })
        .optional(),
      composio: z
        .object({
          apiKey: z.string().optional(),
          callbackUrl: z.string().url().optional(),
          allowedToolkits: z.array(z.string().min(1)).optional(),
          webhookSecret: z.string().optional(),
        })
        .optional(),
      deepgram: z.object({ apiKey: z.string().optional() }).optional(),
      elevenlabs: z
        .object({
          apiKey: z.string().optional(),
          voiceId: z.string().optional(),
          modelId: z.string().optional(),
        })
        .optional(),
      supermemory: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      hindsight: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      honcho: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
          workspacePrefix: z.string().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      mem0: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),

  // Admin API
  admin: z.object({ bearerToken: z.string().optional() }).optional(),

  // Observability
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  telemetry: z.object({
    provider: telemetryProviderSchema,
    posthog: z.object({
      apiKey: z.string().optional(),
      host: z.string().url(),
    }),
  }),

  // Server
  server: z.object({
    port: z.number().int().positive(),
    host: z.string().min(1),
  }),
}).superRefine((config, ctx) => {
  validateModelProvider(config.models.default, ctx, ["models", "default", "model"]);
  validateModelBaseUrl(config.models.default, ctx, ["models", "default", "baseUrl"], "DEFAULT_BASE_URL");
  validateModelApiKey(config.models.default, config.apiKeys.default, ctx, ["apiKeys", "default"], "DEFAULT_API_KEY");
  for (const key of processKeys) {
    validateModelProvider(config.models[key], ctx, ["models", key, "model"]);
    validateModelBaseUrl(config.models[key], ctx, ["models", key, "baseUrl"], `${processEnvPrefixes[key]}_BASE_URL or DEFAULT_BASE_URL`);
    validateModelApiKey(config.models[key], config.apiKeys[key], ctx, ["apiKeys", key], `${processEnvPrefixes[key]}_API_KEY or DEFAULT_API_KEY`);
  }

  if (config.memory.provider === "supermemory" && !config.integrations?.supermemory?.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory", "provider"],
      message: "MEMORY_PROVIDER=supermemory requires SUPERMEMORY_API_KEY.",
    });
  }

  if (config.memory.provider === "hindsight" && !config.integrations?.hindsight?.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory", "provider"],
      message: "MEMORY_PROVIDER=hindsight requires HINDSIGHT_BASE_URL.",
    });
  }

  if (config.memory.provider === "honcho" && !isHonchoConfigured(config.integrations ?? {})) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory", "provider"],
      message: "MEMORY_PROVIDER=honcho requires HONCHO_API_KEY or HONCHO_BASE_URL.",
    });
  }

  if (config.memory.provider === "mem0" && !config.integrations?.mem0?.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory", "provider"],
      message: "MEMORY_PROVIDER=mem0 requires MEM0_API_KEY.",
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function envInt(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw !== undefined) return parseInt(raw, 10);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envFloat(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw !== undefined) return parseFloat(raw);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === undefined) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`${key} must be a boolean value.`);
}

function optionalEnv(key: string): string | undefined {
  return process.env[key] || undefined;
}

function parseRefreshTimes(envName: string, value: string): Array<z.infer<typeof myDayRefreshTimeSchema>> {
  return value.split(",").map((item) => {
    const normalized = item.trim().replace(":", "");
    if (!/^\d{4}$/.test(normalized)) {
      throw new Error(`${envName} must use comma-separated HHMM values, got ${item}.`);
    }
    const hour = Number(normalized.slice(0, 2));
    const minute = Number(normalized.slice(2, 4));
    return myDayRefreshTimeSchema.parse({ hour, minute });
  });
}

function resolveProvider(provider: string): LLMProvider {
  return llmProviderSchema.parse(provider);
}

function resolveTelemetryProvider(): z.infer<typeof telemetryProviderSchema> {
  const provider = process.env["TELEMETRY_PROVIDER"];
  if (provider) return telemetryProviderSchema.parse(provider);
  return optionalEnv("POSTHOG_API_KEY") ? "posthog" : "none";
}

function resolveProcessModelConfig(
  processName: string,
  defaultProvider: LLMProvider,
  defaultModel: string,
  defaultMaxContextTokens: number,
  defaultMaxOutputTokens?: number,
  defaultBaseUrl?: string,
): ModelConfig {
  const provider = resolveProvider(env(`${processName}_PROVIDER`, defaultProvider));

  return {
    model: env(`${processName}_MODEL`, defaultModel),
    provider,
    reasoningEffort: resolveReasoningEffort(processName, provider),
    maxContextTokens: envInt(`${processName}_MAX_CONTEXT_TOKENS`, defaultMaxContextTokens),
    maxOutputTokens: optionalEnv(`${processName}_MAX_OUTPUT_TOKENS`)
      ? envInt(`${processName}_MAX_OUTPUT_TOKENS`)
      : defaultMaxOutputTokens,
    baseUrl: provider === "openai-compatible"
      ? optionalEnv(`${processName}_BASE_URL`) ?? defaultBaseUrl
      : undefined,
  };
}

function resolveReasoningEffort(processName: string, provider: LLMProvider): LLMReasoningEffort | undefined {
  if (provider !== "deepseek") {
    return undefined;
  }

  const value = optionalEnv(`${processName}_REASONING_EFFORT`) ?? optionalEnv("DEFAULT_REASONING_EFFORT");
  return value ? llmReasoningEffortSchema.parse(value) : undefined;
}

function isHindsightConfigured(integrations: NonNullable<z.infer<typeof configSchema>["integrations"]>): boolean {
  return Boolean(integrations.hindsight?.baseUrl);
}

function isHonchoConfigured(integrations: NonNullable<z.infer<typeof configSchema>["integrations"]>): boolean {
  return Boolean(integrations.honcho?.apiKey || integrations.honcho?.baseUrl);
}

function shouldForceToolChoiceByDefault(models: Record<"default" | ProcessConfigKey, ModelConfig>): boolean {
  return !processKeys.some((key) => models[key].provider === "openai-compatible");
}

export function resolveMemoryProvider(input: {
  requested?: string;
  integrations: NonNullable<z.infer<typeof configSchema>["integrations"]>;
}): MemoryProvider {
  if (input.requested) {
    return memoryProviderSchema.parse(input.requested);
  }

  const configuredProviders: MemoryProvider[] = [
    ...(input.integrations.supermemory?.apiKey ? ["supermemory" as const] : []),
    ...(isHindsightConfigured(input.integrations) ? ["hindsight" as const] : []),
    ...(isHonchoConfigured(input.integrations) ? ["honcho" as const] : []),
    ...(input.integrations.mem0?.apiKey ? ["mem0" as const] : []),
  ];

  if (configuredProviders.length > 1) {
    throw new Error("MEMORY_PROVIDER is required when multiple memory providers are configured.");
  }

  return configuredProviders[0] ?? "none";
}

export function buildCapabilities(raw: {
  models: Record<"default" | ProcessConfigKey, ModelConfig>;
  integrations: NonNullable<z.infer<typeof configSchema>["integrations"]>;
  memoryProvider?: MemoryProvider;
  memoryMode?: MemoryMode;
}): z.infer<typeof configSchema>["capabilities"] {
  const hasExa = Boolean(raw.integrations.exa?.apiKey);
  const hasFal = Boolean(raw.integrations.fal?.apiKey);
  const hasComposio = Boolean(raw.integrations.composio?.apiKey);
  const hasDeepgram = Boolean(raw.integrations.deepgram?.apiKey);
  const hasElevenlabs = Boolean(raw.integrations.elevenlabs?.apiKey);
  const hasSupermemory = Boolean(raw.integrations.supermemory?.apiKey);
  const hasHindsight = isHindsightConfigured(raw.integrations);
  const hasHoncho = isHonchoConfigured(raw.integrations);
  const hasMem0 = Boolean(raw.integrations.mem0?.apiKey);
  const memoryProvider = raw.memoryProvider ?? resolveMemoryProvider({ integrations: raw.integrations });
  const memoryMode = raw.memoryMode ?? "tools";
  const hasMemory = (memoryProvider === "supermemory" && hasSupermemory)
    || (memoryProvider === "hindsight" && hasHindsight)
    || (memoryProvider === "honcho" && hasHoncho)
    || (memoryProvider === "mem0" && hasMem0);
  const hasHotPathMemoryTools = hasMemory && memoryMode !== "context";
  const hasMemoryReflect = (memoryProvider === "hindsight" && hasHindsight)
    || (memoryProvider === "honcho" && hasHoncho);

  return {
    boot: {
      spectrum: true,
      publicUrl: true,
      database: true,
      llm: true,
      fileStorage: true,
    },
    llm: {
      defaultProvider: raw.models.default.provider,
      processes: {
        hotPath: raw.models.hotPath,
        worker: raw.models.worker,
        compactor: raw.models.compactor,
      },
    },
    integrations: {
      memory: hasMemory,
      exa: hasExa,
      fal: hasFal,
      composio: hasComposio,
      deepgram: hasDeepgram,
      elevenlabs: hasElevenlabs,
      hindsight: hasHindsight,
      honcho: hasHoncho,
      mem0: hasMem0,
      supermemory: hasSupermemory,
    },
    media: {
      fileStorage: true,
      speechToText: hasDeepgram,
      textToSpeech: hasElevenlabs,
      voiceRoundTrip: hasDeepgram && hasElevenlabs,
    },
    tools: {
      hotPath: {
        send_message: true,
        send_media: true,
        react: true,
        wait: true,
        display_draft: true,
        patterns: true,
        my_day: true,
        files: true,
        search_memory: hasHotPathMemoryTools,
        reflect_memory: hasHotPathMemoryTools && hasMemoryReflect,
      },
      worker: {
        web_search: hasExa,
        get_page_contents: hasExa,
        create_or_edit_image: hasFal,
        create_or_edit_video: hasFal,
        mcp: true,
        patterns: true,
        composio: hasComposio,
        memory: hasMemory,
        memory_reflect: hasMemoryReflect,
        skills: true,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Loader — called once on startup, validated, cached
// ---------------------------------------------------------------------------

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const defaultProvider = resolveProvider(env("DEFAULT_PROVIDER"));
  const defaultModel = env("DEFAULT_MODEL");
  const defaultBaseUrl = optionalEnv("DEFAULT_BASE_URL");
  const defaultMaxContextTokens = envInt("DEFAULT_MAX_CONTEXT_TOKENS", envInt("HOT_PATH_MAX_CONTEXT_TOKENS", 128_000));
  const defaultMaxOutputTokens = optionalEnv("DEFAULT_MAX_OUTPUT_TOKENS")
    ? envInt("DEFAULT_MAX_OUTPUT_TOKENS")
    : undefined;
  const models = {
    default: {
      model: defaultModel,
      provider: defaultProvider,
      reasoningEffort: resolveReasoningEffort("DEFAULT", defaultProvider),
      maxContextTokens: defaultMaxContextTokens,
      maxOutputTokens: defaultMaxOutputTokens,
      baseUrl: defaultProvider === "openai-compatible" ? defaultBaseUrl : undefined,
    },
    hotPath: resolveProcessModelConfig("HOT_PATH", defaultProvider, defaultModel, defaultMaxContextTokens, defaultMaxOutputTokens, defaultBaseUrl),
    worker: resolveProcessModelConfig("WORKER", defaultProvider, defaultModel, defaultMaxContextTokens, defaultMaxOutputTokens, defaultBaseUrl),
    compactor: resolveProcessModelConfig("COMPACTOR", defaultProvider, defaultModel, defaultMaxContextTokens, defaultMaxOutputTokens, defaultBaseUrl),
  };

  const defaultApiKey = optionalEnv("DEFAULT_API_KEY");
  const apiKeys = {
    default: defaultApiKey,
    hotPath: optionalEnv("HOT_PATH_API_KEY") ?? defaultApiKey,
    worker: optionalEnv("WORKER_API_KEY") ?? defaultApiKey,
    compactor: optionalEnv("COMPACTOR_API_KEY") ?? defaultApiKey,
  };

  const integrations = {
    exa: { apiKey: optionalEnv("EXA_API_KEY") },
    fal: {
      apiKey: optionalEnv("FAL_API_KEY"),
      imageGenModel: optionalEnv("FAL_IMAGE_GEN_MODEL"),
      imageEditModel: optionalEnv("FAL_IMAGE_EDIT_MODEL"),
      videoGenModel: optionalEnv("FAL_VIDEO_GEN_MODEL"),
      imageToVideoModel: optionalEnv("FAL_IMAGE_TO_VIDEO_MODEL"),
      videoEditModel: optionalEnv("FAL_VIDEO_EDIT_MODEL"),
    },
    composio: {
      apiKey: optionalEnv("COMPOSIO_API_KEY"),
      callbackUrl: optionalEnv("COMPOSIO_CALLBACK_URL"),
      allowedToolkits: parseComposioAllowedToolkits(process.env.COMPOSIO_ALLOWED_TOOLKITS),
      webhookSecret: optionalEnv("COMPOSIO_WEBHOOK_SECRET"),
    },
    deepgram: { apiKey: optionalEnv("DEEPGRAM_API_KEY") },
    elevenlabs: {
      apiKey: optionalEnv("ELEVENLABS_API_KEY"),
      voiceId: optionalEnv("ELEVENLABS_VOICE_ID"),
      modelId: optionalEnv("ELEVENLABS_MODEL_ID"),
    },
    supermemory: {
      apiKey: optionalEnv("SUPERMEMORY_API_KEY"),
      baseUrl: optionalEnv("SUPERMEMORY_BASE_URL"),
    },
    hindsight: {
      apiKey: optionalEnv("HINDSIGHT_API_KEY"),
      baseUrl: optionalEnv("HINDSIGHT_BASE_URL"),
    },
    honcho: {
      apiKey: optionalEnv("HONCHO_API_KEY"),
      baseUrl: optionalEnv("HONCHO_BASE_URL"),
      workspacePrefix: optionalEnv("HONCHO_WORKSPACE_PREFIX"),
      timeoutMs: optionalEnv("HONCHO_TIMEOUT_MS") ? envInt("HONCHO_TIMEOUT_MS") : undefined,
    },
    mem0: {
      apiKey: optionalEnv("MEM0_API_KEY"),
      baseUrl: optionalEnv("MEM0_BASE_URL"),
    },
  };
  const memoryProvider = resolveMemoryProvider({
    requested: optionalEnv("MEMORY_PROVIDER"),
    integrations,
  });
  const memoryMode = memoryModeSchema.parse(env("MEMORY_MODE", "tools"));
  const autoRecallTimeoutMs = envInt("MEMORY_AUTO_RECALL_TIMEOUT_MS", 3_000);
  const autoRecallMaxResults = envInt("MEMORY_AUTO_RECALL_MAX_RESULTS", 8);
  const provisionMentalModels = envBool("MEMORY_PROVISION_MENTAL_MODELS", true);

  const raw = {
    spectrum: {
      projectId: env("SPECTRUM_PROJECT_ID"),
      projectSecret: env("SPECTRUM_PROJECT_SECRET"),
      dedicatedLinePhone: optionalEnv("SPECTRUM_DEDICATED_LINE_PHONE"),
      allowedNumbers: process.env["SPECTRUM_ALLOWED_NUMBERS"]
        ? process.env["SPECTRUM_ALLOWED_NUMBERS"].split(",").map((n) => n.trim()).filter(Boolean)
        : undefined,
    },
    userPhoneNumber: process.env["USER_PHONE_NUMBER"] || undefined,
    userTimezone: resolveTimeZone(process.env["USER_TIMEZONE"] || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),

    publicUrl: env("PUBLIC_URL"),
    databaseUrl: env("DATABASE_URL"),

    models,

    llm: {
      forceToolChoice: envBool("LLM_FORCE_TOOL_CHOICE", shouldForceToolChoiceByDefault(models)),
    },

    maxTurns: {
      hotPath: envInt("HOT_PATH_MAX_TURNS", 20),
      worker: envInt("WORKER_MAX_TURNS", 20),
      compactor: envInt("COMPACTOR_MAX_TURNS", 5),
    },

    apiKeys,

    capabilities: buildCapabilities({ models, integrations, memoryProvider, memoryMode }),

    context: {
      maxTokens: models.hotPath.maxContextTokens,
      promptHistoryTokenBudget: envInt("HOT_PATH_HISTORY_TOKEN_BUDGET", 12_000),
      promptHistoryMessageTokenBudget: envInt("HOT_PATH_HISTORY_MESSAGE_TOKEN_BUDGET", 4_000),
      currentTurnTokenBudget: envInt("HOT_PATH_CURRENT_TURN_TOKEN_BUDGET", 12_000),
      chapterSummaryTokenBudget: envInt("HOT_PATH_CHAPTER_SUMMARY_TOKEN_BUDGET", 8_000),
      handoffInputTokenBudget: envInt("HOT_PATH_HANDOFF_INPUT_TOKEN_BUDGET", 12_000),
      compactionBufferTokens: envInt("COMPACTION_BUFFER_TOKENS", 4_000),
      compactionBatchBackground: envInt("COMPACTION_BATCH_BACKGROUND", 20),
      compactionBatchAggressive: envInt("COMPACTION_BATCH_AGGRESSIVE", 40),
      compactionEmergencyBatch: envInt("COMPACTION_BATCH_EMERGENCY", 30),
      compactionMaxPasses: envInt("COMPACTION_MAX_PASSES", 3),
      dailyRolloverHour: envInt("HOT_PATH_DAILY_ROLLOVER_HOUR", 4),
      dailyRolloverMinute: envInt("HOT_PATH_DAILY_ROLLOVER_MINUTE", 0),
      thresholdWarn: envFloat("COMPACTION_THRESHOLD_WARN", 0.7),
      thresholdBackground: envFloat("COMPACTION_THRESHOLD_BACKGROUND", 0.8),
      thresholdAggressive: envFloat("COMPACTION_THRESHOLD_AGGRESSIVE", 0.9),
      thresholdEmergency: envFloat("COMPACTION_THRESHOLD_EMERGENCY", 0.95),
    },

    hotPathIngress: {
      userGroupingWindowMs: envInt("HOT_PATH_INGRESS_USER_GROUPING_WINDOW_MS", 500),
      maxCoalesceMessages: envInt("HOT_PATH_INGRESS_MAX_COALESCE_MESSAGES", 5),
    },

    memory: {
      provider: memoryProvider,
      mode: memoryMode,
      autoRecallTimeoutMs,
      autoRecallMaxResults,
      provisionMentalModels,
    },

    workerLimits: {
      timeoutMs: envInt("WORKER_TIMEOUT_MS", defaultWorkerTimeoutMs),
      maxConcurrent: envInt("WORKER_MAX_CONCURRENT", 5),
      maxToolCalls: envInt("WORKER_MAX_TOOL_CALLS", 50),
    },
    backgroundLlmTimeoutMs: envInt("BACKGROUND_LLM_TIMEOUT_MS", envInt("WORKER_TIMEOUT_MS", defaultWorkerTimeoutMs)),
    personalIntelligenceTimeoutMs: envInt("PERSONAL_INTELLIGENCE_TIMEOUT_MS", 30 * 60_000),
    personalIntelligenceMaxSteps: envInt("PERSONAL_INTELLIGENCE_MAX_STEPS", 120),
    workerTimeoutMs: envInt("WORKER_TIMEOUT_MS", defaultWorkerTimeoutMs),
    workerSandbox: {
      workspacesPath: env("WORKER_WORKSPACES_PATH", "./workspaces"),
    },
    scheduler: {
      graphile: {
        concurrency: envInt("GRAPHILE_WORKER_CONCURRENCY", 4),
        maxPoolSize: envInt("GRAPHILE_WORKER_MAX_POOL_SIZE", 10),
        pollIntervalMs: envInt("GRAPHILE_WORKER_POLL_INTERVAL_MS", 1_000),
        patternTickMs: envInt("SCHEDULER_PATTERN_TICK_MS", 60_000),
        myDayTickMs: envInt("SCHEDULER_MY_DAY_TICK_MS", 60_000),
        personalIntelligenceTickMs: envInt("SCHEDULER_PERSONAL_INTELLIGENCE_TICK_MS", 5 * 60_000),
        myDayScheduledJitterMs: envInt("SCHEDULER_MY_DAY_JITTER_MS", 20 * 60_000),
        personalIntelligenceScheduledJitterMs: envInt("SCHEDULER_PERSONAL_INTELLIGENCE_JITTER_MS", 60 * 60_000),
      },
    },

    fileStorage: {
      maxFileSizeMb: envInt("MAX_FILE_SIZE_MB", 100),
    },

    intervals: {
      patternCircuitBreakerThreshold: envInt("PATTERN_CIRCUIT_BREAKER_THRESHOLD", 3),
      myDayRefreshTimes: parseRefreshTimes("MY_DAY_REFRESH_TIMES", env("MY_DAY_REFRESH_TIMES", "0500,1100,1700")),
      personalIntelligenceRefreshTimes: parseRefreshTimes("PERSONAL_INTELLIGENCE_REFRESH_TIMES", env("PERSONAL_INTELLIGENCE_REFRESH_TIMES", "0000")),
      personalIntelligenceInitialBackfillMs: envInt("PERSONAL_INTELLIGENCE_INITIAL_BACKFILL_MS", 30 * 24 * 60 * 60_000),
      personalIntelligenceOverlapMs: envInt("PERSONAL_INTELLIGENCE_INCREMENTAL_OVERLAP_MS", 6 * 60 * 60_000),
    },

    integrations,

    admin: { bearerToken: process.env["ADMIN_BEARER_TOKEN"] || undefined },

    logLevel: env("LOG_LEVEL", "info") as AppConfig["logLevel"],
    telemetry: {
      provider: resolveTelemetryProvider(),
      posthog: {
        apiKey: optionalEnv("POSTHOG_API_KEY"),
        host: env("POSTHOG_HOST", "https://us.i.posthog.com"),
      },
    },

    server: {
      port: envInt("PORT", 3000),
      host: env("HOST", "0.0.0.0"),
    },
  };

  _config = configSchema.parse(raw);
  return _config;
}

// ---------------------------------------------------------------------------
// Identity file loading
// ---------------------------------------------------------------------------

export function loadIdentityFile(name: string, basePath = "./identity"): string {
  try {
    return readFileSync(join(basePath, name), "utf-8");
  } catch {
    throw new Error(`Failed to load identity file: ${join(basePath, name)}`);
  }
}

/** Reset config cache (for testing) */
export function resetConfig(): void {
  _config = null;
}
