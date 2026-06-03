import { describe, expect, it } from "bun:test";
import { maxPatchFileInputCharacters, patchFileInputSchema } from "./schemas.js";

describe("files schemas", () => {
  it("accepts structured patch input at max size", () => {
    expect(() => patchFileInputSchema.parse({
      input: "x".repeat(maxPatchFileInputCharacters),
    })).not.toThrow();
  });

  it("bounds structured patch input size", () => {
    expect(() => patchFileInputSchema.parse({
      input: "x".repeat(maxPatchFileInputCharacters + 1),
    })).toThrow();
  });
});
