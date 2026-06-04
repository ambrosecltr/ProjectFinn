import type { AppConfig, ProcessType } from "@finn/core";
import type { LanguageModel } from "ai";
import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";

import { getProvider } from "./providers.js";
import type { LLMProviderName, ModelConfig } from "./types.js";

type LanguageModelV1 = LanguageModel;
type ProviderOptionValue = null | string | number | boolean | ProviderOptionValue[] | ProviderOptionObject;
type ProviderOptionObject = { [key: string]: ProviderOptionValue | undefined };

export type LLMRequestOptions = {
  headers?: Record<string, string>;
  providerOptions?: Record<string, ProviderOptionObject>;
  maxOutputTokens?: number;
};

type ProcessConfigKey = "hotPath" | "worker" | "compactor";

function toProcessConfigKey(processType: ProcessType): ProcessConfigKey {
  switch (processType) {
    case "hot-path":
      return "hotPath";
    case "worker":
      return "worker";
    case "compactor":
      return "compactor";
  }
}

function toProviderName(provider: string): LLMProviderName {
  if (
    provider === "anthropic"
    || provider === "openai"
    || provider === "fireworks"
    || provider === "deepseek"
    || provider === "openai-compatible"
  ) {
    return provider;
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

function parseModelConfig(config: {
  model: string;
  provider: string;
  reasoningEffort?: ModelConfig["reasoningEffort"];
  maxContextTokens: number;
  maxOutputTokens?: number;
  baseUrl?: string;
}): ModelConfig {
  const separatorIndex = config.model.indexOf(":");

  if (separatorIndex === -1) {
    throw new Error(`Invalid model config: ${config.model}`);
  }

  const providerFromModel = config.model.slice(0, separatorIndex);
  const modelName = config.model.slice(separatorIndex + 1);
  const provider = toProviderName(config.provider);

  if (providerFromModel !== provider) {
    throw new Error(
      `Model/provider mismatch: ${config.model} does not match provider ${config.provider}`,
    );
  }

  if (!modelName) {
    throw new Error(`Invalid model name: ${config.model}`);
  }

  return {
    provider,
    model: modelName,
    reasoningEffort: config.reasoningEffort,
    maxContextTokens: config.maxContextTokens,
    maxOutputTokens: config.maxOutputTokens,
    baseUrl: config.baseUrl,
  };
}

export class LLMManager {
  constructor(private readonly config: AppConfig) {}

  getModel(processType: ProcessType): LanguageModelV1 {
    const processConfigKey = toProcessConfigKey(processType);
    const modelConfig = parseModelConfig(this.config.models[processConfigKey]);

    return getProvider(modelConfig.provider, this.config.apiKeys[processConfigKey], modelConfig.baseUrl)(modelConfig.model);
  }

  getModelForKey(key: ProcessConfigKey): LanguageModelV1 {
    const modelConfig = parseModelConfig(this.config.models[key]);

    return getProvider(modelConfig.provider, this.config.apiKeys[key], modelConfig.baseUrl)(modelConfig.model);
  }

  getMaxSteps(processType: ProcessType): number {
    return this.config.maxTurns[toProcessConfigKey(processType)];
  }

  getMaxContextTokens(processType: ProcessType): number {
    return this.config.models[toProcessConfigKey(processType)].maxContextTokens;
  }

  getRequestOptions(processType: ProcessType, cacheKey: string): LLMRequestOptions {
    const processConfigKey = toProcessConfigKey(processType);
    const modelConfig = parseModelConfig(this.config.models[processConfigKey]);
    const normalizedCacheKey = cacheKey.trim();

    const requestOptions: LLMRequestOptions = {};

    if (modelConfig.maxOutputTokens) {
      requestOptions.maxOutputTokens = modelConfig.maxOutputTokens;
    }

    if (modelConfig.provider === "fireworks" && normalizedCacheKey.length > 0) {
      requestOptions.headers = {
        "x-session-affinity": normalizedCacheKey,
      };
      requestOptions.providerOptions = {
        fireworks: {
          user: normalizedCacheKey,
        },
      };
    }

    if (modelConfig.provider === "deepseek" && modelConfig.reasoningEffort) {
      requestOptions.providerOptions = {
        ...requestOptions.providerOptions,
        deepseek: {
          thinking: { type: "enabled" },
          reasoningEffort: modelConfig.reasoningEffort,
        } satisfies DeepSeekLanguageModelOptions,
      };
    }

    return requestOptions;
  }
}
