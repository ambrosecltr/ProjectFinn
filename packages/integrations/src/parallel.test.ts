import { describe, expect, it, mock } from "bun:test";
import { ParallelClient, type ParallelFetch } from "./parallel.js";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body.");
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("ParallelClient", () => {
  it("maps rich search options to Parallel Search and normalizes metadata", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: ParallelFetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: readRequestBody(init) });
      return createJsonResponse({
        search_id: "search_123",
        session_id: "session_123",
        results: [{
          url: "https://example.com",
          title: "Example",
          publish_date: "2026-06-01",
          excerpts: ["Relevant excerpt"],
        }],
        warnings: [{ type: "warning", message: "careful" }],
        usage: [{ name: "sku_search", count: 1 }],
      });
    });
    const client = new ParallelClient({ apiKey: "test", clientModel: "worker-model", fetch: fetchImpl });

    const response = await client.search({
      objective: "Find official launch details",
      searchQueries: ["official launch details", "release notes"],
      numResults: 4,
      mode: "basic",
      maxCharsTotal: 5000,
      sessionId: "session_existing",
      sourcePolicy: { includeDomains: ["example.com"], afterDate: "2026-01-01" },
      fetchPolicy: { maxAgeSeconds: 3600, timeoutSeconds: 15, disableCacheFallback: true },
      maxCharsPerResult: 1200,
      location: "us",
    });

    expect(requests[0]?.url).toContain("/v1/search");
    expect(requests[0]?.body).toMatchObject({
      objective: "Find official launch details",
      search_queries: ["official launch details", "release notes"],
      mode: "basic",
      max_chars_total: 5000,
      session_id: "session_existing",
      client_model: "worker-model",
      advanced_settings: {
        max_results: 4,
        location: "us",
        source_policy: { include_domains: ["example.com"], after_date: "2026-01-01" },
        fetch_policy: { max_age_seconds: 3600, timeout_seconds: 15, disable_cache_fallback: true },
        excerpt_settings: { max_chars_per_result: 1200 },
      },
    });
    expect(response).toMatchObject({
      provider: "parallel",
      searchId: "search_123",
      sessionId: "session_123",
      warnings: [{ type: "warning", message: "careful" }],
      usage: [{ name: "sku_search", count: 1 }],
      results: [{
        url: "https://example.com",
        title: "Example",
        publishedDate: "2026-06-01",
        excerpts: ["Relevant excerpt"],
        highlights: ["Relevant excerpt"],
      }],
    });
  });

  it("maps fetch options to Parallel Extract and preserves partial errors", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: ParallelFetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: readRequestBody(init) });
      return createJsonResponse({
        extract_id: "extract_123",
        session_id: "session_123",
        results: [{
          url: "https://example.com/a",
          title: "A",
          publish_date: null,
          excerpts: ["A excerpt"],
          full_content: "A full content",
        }],
        errors: [{
          url: "https://example.com/b",
          error_type: "fetch_failed",
          http_status_code: 404,
          content: "not found",
        }],
      });
    });
    const client = new ParallelClient({ apiKey: "test", fetch: fetchImpl });

    const response = await client.getContents(["https://example.com/a", "https://example.com/b"], {
      objective: "Compare launch dates",
      searchQueries: ["launch date"],
      sessionId: "session_123",
      fullContent: { maxCharsPerResult: 8000 },
      maxCharsPerResult: 1000,
    });

    expect(requests[0]?.url).toContain("/v1/extract");
    expect(requests[0]?.body).toMatchObject({
      urls: ["https://example.com/a", "https://example.com/b"],
      objective: "Compare launch dates",
      search_queries: ["launch date"],
      session_id: "session_123",
      advanced_settings: {
        excerpt_settings: { max_chars_per_result: 1000 },
        full_content: { max_chars_per_result: 8000 },
      },
    });
    expect(response).toMatchObject({
      provider: "parallel",
      extractId: "extract_123",
      sessionId: "session_123",
      errors: [{
        url: "https://example.com/b",
        errorType: "fetch_failed",
        httpStatusCode: 404,
        content: "not found",
      }],
      contents: [{
        url: "https://example.com/a",
        text: "A full content",
        fullContent: "A full content",
        excerpts: ["A excerpt"],
      }],
    });
  });
});
