import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { formatUnknownError } from "./error-format.js";

describe("formatUnknownError", () => {
  it("formats Zod validation errors with paths", () => {
    const schema = z.object({ content: z.string() }).strict();
    const result = schema.safeParse({ path: "/workspace/note.txt" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatUnknownError(result.error, { zodPrefix: "Tool input validation failed" }))
        .toBe("Tool input validation failed: content: Required; (root): Unrecognized key(s) in object: 'path'");
    }
  });

  it("serializes plain and circular object errors without [object Object]", () => {
    const error: Record<string, unknown> = { code: "REMOTE_FAIL", message: "remote failed" };
    error.self = error;

    expect(formatUnknownError(error))
      .toBe("{\"code\":\"REMOTE_FAIL\",\"message\":\"remote failed\",\"self\":\"[Circular]\"}");
  });
});
