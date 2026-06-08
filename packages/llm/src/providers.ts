import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createFireworks } from "@ai-sdk/fireworks";

import type { LLMProviderName } from "./types.js";

export interface LLMApiKeys {
  default?: string;
  hotPath?: string;
  worker?: string;
  compactor?: string;
}

type AnthropicProvider = ReturnType<typeof createAnthropic>;
type OpenAIProvider = ReturnType<typeof createOpenAI>;
type FireworksProvider = ReturnType<typeof createFireworks>;
type DeepSeekProvider = ReturnType<typeof createDeepSeek>;
type OpenAICompatibleProvider = ReturnType<typeof createOpenAICompatible>;

type AnyProvider = AnthropicProvider | OpenAIProvider | FireworksProvider | DeepSeekProvider | OpenAICompatibleProvider;

let anthropicProviderCache:
  | { apiKey: string; baseUrl?: string; provider: AnthropicProvider }
  | null = null;
let openAIProviderCache: { apiKey: string; provider: OpenAIProvider } | null = null;
let fireworksProviderCache: { apiKey: string; provider: FireworksProvider } | null = null;
let deepSeekProviderCache: { apiKey: string; provider: DeepSeekProvider } | null = null;
let openAICompatibleProviderCache:
  | { apiKey?: string; baseUrl: string; provider: OpenAICompatibleProvider }
  | null = null;

function requireKey(name: LLMProviderName, key: string | undefined): string {
  if (!key) {
    throw new Error(
      `Missing API key for provider "${name}". Set DEFAULT_API_KEY or the process-specific *_API_KEY override.`,
    );
  }
  return key;
}

function requireBaseUrl(name: LLMProviderName, baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new Error(
      `Missing base URL for provider "${name}". Set DEFAULT_BASE_URL or the process-specific *_BASE_URL override.`,
    );
  }
  return baseUrl;
}

function getAnthropicProvider(apiKey: string, baseUrl?: string): AnthropicProvider {
  if (anthropicProviderCache?.apiKey !== apiKey || anthropicProviderCache.baseUrl !== baseUrl) {
    anthropicProviderCache = {
      apiKey,
      baseUrl,
      provider: createAnthropic({ apiKey, baseURL: baseUrl }),
    };
  }

  return anthropicProviderCache.provider;
}

function getOpenAIProvider(apiKey: string): OpenAIProvider {
  if (openAIProviderCache?.apiKey !== apiKey) {
    openAIProviderCache = {
      apiKey,
      provider: createOpenAI({ apiKey }),
    };
  }

  return openAIProviderCache.provider;
}

function getFireworksProvider(apiKey: string): FireworksProvider {
  if (fireworksProviderCache?.apiKey !== apiKey) {
    fireworksProviderCache = {
      apiKey,
      provider: createFireworks({ apiKey }),
    };
  }

  return fireworksProviderCache.provider;
}

function getDeepSeekProvider(apiKey: string): DeepSeekProvider {
  if (deepSeekProviderCache?.apiKey !== apiKey) {
    deepSeekProviderCache = {
      apiKey,
      provider: createDeepSeek({ apiKey }),
    };
  }

  return deepSeekProviderCache.provider;
}

function getOpenAICompatibleProvider(apiKey: string | undefined, baseUrl: string): OpenAICompatibleProvider {
  if (!openAICompatibleProviderCache || openAICompatibleProviderCache.apiKey !== apiKey || openAICompatibleProviderCache.baseUrl !== baseUrl) {
    openAICompatibleProviderCache = {
      apiKey,
      baseUrl,
      provider: createOpenAICompatible({
        name: "openaiCompatible",
        apiKey,
        baseURL: baseUrl,
        includeUsage: true,
      }),
    };
  }

  return openAICompatibleProviderCache.provider;
}

export function getProvider(
  name: LLMProviderName,
  apiKey: string | undefined,
  baseUrl?: string,
): AnyProvider {
  switch (name) {
    case "anthropic":
      return getAnthropicProvider(requireKey("anthropic", apiKey), baseUrl);
    case "openai":
      return getOpenAIProvider(requireKey("openai", apiKey));
    case "fireworks":
      return getFireworksProvider(requireKey("fireworks", apiKey));
    case "deepseek":
      return getDeepSeekProvider(requireKey("deepseek", apiKey));
    case "openai-compatible":
      return getOpenAICompatibleProvider(apiKey, requireBaseUrl("openai-compatible", baseUrl));
  }
}
