import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createFireworks } from "@ai-sdk/fireworks";

import type { LLMProviderName } from "./types.js";

export interface LLMApiKeys {
  default: string;
  hotPath: string;
  worker: string;
  compactor: string;
}

type AnthropicProvider = ReturnType<typeof createAnthropic>;
type OpenAIProvider = ReturnType<typeof createOpenAI>;
type FireworksProvider = ReturnType<typeof createFireworks>;
type DeepSeekProvider = ReturnType<typeof createDeepSeek>;

type AnyProvider = AnthropicProvider | OpenAIProvider | FireworksProvider | DeepSeekProvider;

let anthropicProviderCache:
  | { apiKey: string; provider: AnthropicProvider }
  | null = null;
let openAIProviderCache: { apiKey: string; provider: OpenAIProvider } | null = null;
let fireworksProviderCache: { apiKey: string; provider: FireworksProvider } | null = null;
let deepSeekProviderCache: { apiKey: string; provider: DeepSeekProvider } | null = null;

function requireKey(name: LLMProviderName, key: string | undefined): string {
  if (!key) {
    throw new Error(
      `Missing API key for provider "${name}". Set DEFAULT_API_KEY or the process-specific *_API_KEY override.`,
    );
  }
  return key;
}

function getAnthropicProvider(apiKey: string): AnthropicProvider {
  if (anthropicProviderCache?.apiKey !== apiKey) {
    anthropicProviderCache = {
      apiKey,
      provider: createAnthropic({ apiKey }),
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

export function getProvider(
  name: LLMProviderName,
  apiKey: string,
): AnyProvider {
  switch (name) {
    case "anthropic":
      return getAnthropicProvider(requireKey("anthropic", apiKey));
    case "openai":
      return getOpenAIProvider(requireKey("openai", apiKey));
    case "fireworks":
      return getFireworksProvider(requireKey("fireworks", apiKey));
    case "deepseek":
      return getDeepSeekProvider(requireKey("deepseek", apiKey));
  }
}
