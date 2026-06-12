import type { SystemModelMessage, ToolSet } from "ai";

const anthropicCacheControlProviderOptions = {
  anthropic: {
    cacheControl: { type: "ephemeral" },
  },
} as const;

export function withAnthropicSystemCacheControl(
  system: string | SystemModelMessage | SystemModelMessage[],
): SystemModelMessage[] {
  const messages = typeof system === "string"
    ? [{ role: "system" as const, content: system }]
    : Array.isArray(system) ? system : [system];

  return messages.map((message, index) => {
    if (index !== 0) {
      return message;
    }

    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        anthropic: {
          ...message.providerOptions?.anthropic,
          ...anthropicCacheControlProviderOptions.anthropic,
        },
      },
    };
  });
}

export function withAnthropicToolCacheControl<TTools extends ToolSet>(tools: TTools): TTools {
  const entries = Object.entries(tools);
  const lastToolName = entries.at(-1)?.[0];
  if (!lastToolName) {
    return tools;
  }

  return {
    ...tools,
    [lastToolName]: {
      ...tools[lastToolName],
      providerOptions: {
        ...tools[lastToolName]?.providerOptions,
        anthropic: {
          ...tools[lastToolName]?.providerOptions?.anthropic,
          ...anthropicCacheControlProviderOptions.anthropic,
        },
      },
    },
  };
}
