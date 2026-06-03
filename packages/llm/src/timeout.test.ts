import { describe, expect, it } from "bun:test";
import { getAbortErrorMessage, withLLMTimeout } from "./timeout.js";

describe("withLLMTimeout", () => {
  it("aborts long-running LLM work", async () => {
    await expect(withLLMTimeout({ timeoutMs: 5, timeoutMessage: "timed out" }, (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error(String(signal.reason))), { once: true });
      setTimeout(() => resolve("done"), 50);
    }))).rejects.toThrow("timed out");
  });

  it("extracts abort and timeout error messages", () => {
    expect(getAbortErrorMessage(new DOMException("aborted", "AbortError"))).toBe("aborted");
    expect(getAbortErrorMessage(new Error("request timed out"))).toBe("request timed out");
    expect(getAbortErrorMessage(new Error("other"))).toBeNull();
  });
});
