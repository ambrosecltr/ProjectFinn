import { describe, expect, it } from "bun:test";

import { startsWithPromptEnvelope } from "./prompt-envelopes.js";

describe("startsWithPromptEnvelope", () => {
  it("matches only exact tag names", () => {
    expect(startsWithPromptEnvelope("<human_message>\nhi\n</human_message>", "human_message")).toBe(true);
    expect(startsWithPromptEnvelope("  <human_message role=\"user\">hi</human_message>", "human_message")).toBe(true);
    expect(startsWithPromptEnvelope("<human_message/>", "human_message")).toBe(true);
    expect(startsWithPromptEnvelope("<human_message_fake>hi</human_message_fake>", "human_message")).toBe(false);
    expect(startsWithPromptEnvelope("<human_messageevil>hi</human_messageevil>", "human_message")).toBe(false);
  });
});
