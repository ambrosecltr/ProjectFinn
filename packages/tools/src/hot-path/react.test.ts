import { describe, expect, it, mock } from "bun:test";

import { createReactTool } from "./react.js";

describe("createReactTool", () => {
  it("describes reaction handles as message handle attributes", () => {
    const sender = {
      sendReaction: mock(async () => {}),
    } as unknown as Parameters<typeof createReactTool>[0];
    const reactTool = createReactTool(sender);
    const inputSchemaDescription = (reactTool.inputSchema as unknown as {
      shape: { messageHandle: { description?: string } };
    }).shape.messageHandle.description;

    expect(inputSchemaDescription).toContain("handle attribute");
    expect(inputSchemaDescription).toContain("<message");
    expect(inputSchemaDescription).not.toContain("[handle:");
  });
});
