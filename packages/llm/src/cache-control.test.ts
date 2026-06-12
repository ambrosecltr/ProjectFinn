import { describe, expect, it } from "bun:test";

import { withAnthropicSystemCacheControl } from "./cache-control.js";

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
});
