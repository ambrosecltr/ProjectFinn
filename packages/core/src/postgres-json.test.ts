import { describe, expect, it } from "bun:test";

import { sanitizePostgresJsonValue, sanitizePostgresText } from "./postgres-json.js";

describe("Postgres JSON sanitization", () => {
  it("preserves valid emoji surrogate pairs", () => {
    expect(sanitizePostgresText("brief: \uD83C\uDF05")).toBe("brief: \uD83C\uDF05");
  });

  it("replaces malformed surrogate halves before JSONB persistence", () => {
    expect(sanitizePostgresText("brief: \uD83C")).toBe("brief: \uFFFD");
    expect(sanitizePostgresText("brief: \uDF05")).toBe("brief: \uFFFD");
  });

  it("sanitizes nested JSON values and reports changes", () => {
    const shared = { title: "brief: \uD83C" };
    const input = {
      normal: "ok",
      nested: [shared, shared],
      ["bad\uD83Ckey"]: "value",
    };

    const result = sanitizePostgresJsonValue(input);

    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("\\ud83c");
    expect(result.value as Record<string, unknown>).toEqual({
      normal: "ok",
      nested: [{ title: "brief: \uFFFD" }, { title: "brief: \uFFFD" }],
      ["bad\uFFFDkey"]: "value",
    });
  });
});
