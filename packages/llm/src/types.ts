import type { ProcessType } from "@finn/core";

export type LLMProviderName = "anthropic" | "openai" | "fireworks" | "deepseek";
export type LLMReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConfig {
  model: string;
  provider: LLMProviderName;
  reasoningEffort?: LLMReasoningEffort;
  maxContextTokens: number;
  maxOutputTokens?: number;
}

export type ProcessModelMap = Record<ProcessType, ModelConfig>;
