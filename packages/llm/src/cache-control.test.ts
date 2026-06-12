import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import { withAnthropicSystemCacheControl, withAnthropicToolCacheControl } from "./cache-control.js";

describe("withAnthropicSystemCacheControl", () => {
  it("marks string system prompts with an Anthropic cache breakpoint", () => {
    expect(withAnthropicSystemCacheControl("stable prompt")).toEqual([
      {
        role: "system",
        content: "stable prompt",
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral" },
          },
        },
      },
    ]);
  });

  it("marks only the first system message so later dynamic context stays outside the breakpoint", () => {
    expect(withAnthropicSystemCacheControl([
      { role: "system", content: "stable prompt" },
      { role: "system", content: "dynamic context" },
    ])).toEqual([
      {
        role: "system",
        content: "stable prompt",
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral" },
          },
        },
      },
      { role: "system", content: "dynamic context" },
    ]);
  });

  it("marks only the last tool definition with an Anthropic cache breakpoint", () => {
    const tools = withAnthropicToolCacheControl({
      first: tool({
        description: "First tool",
        inputSchema: z.object({ value: z.string() }),
      }),
      second: tool({
        description: "Second tool",
        inputSchema: z.object({ value: z.string() }),
      }),
    });

    expect(tools.first.providerOptions).toBeUndefined();
    expect(tools.second.providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
    });
  });
});
