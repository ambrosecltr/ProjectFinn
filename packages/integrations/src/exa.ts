import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";
import { Exa } from "exa-js";
import type { ContentsOptions } from "exa-js";

const logger = createLogger("exa");
const tracer = getTracer("exa");
const EXA_REQUEST_TIMEOUT_MS = 30_000;

export type ExaSearchOptions = {
  query?: string;
  objective?: string;
  searchQueries?: string[];
  numResults?: number;
  maxAgeHours?: number;
  vertical?: "company" | "people";
};

export type ExaSearchResult = {
  url: string;
  title: string | null;
  score?: number;
  publishedDate?: string;
  author?: string;
  id: string;
  highlights?: string[];
  excerpts?: string[];
};

export type ExaSearchResponse = {
  provider: "exa";
  results: ExaSearchResult[];
};

export type ExaContent = {
  url: string;
  title: string | null;
  text?: string;
  fullContent?: string;
  highlights?: string[];
  excerpts?: string[];
};

export type ExaContentResponse = {
  provider: "exa";
  contents: ExaContent[];
};

export class ExaClient {
  readonly provider = "exa" as const;

  private readonly client: Exa;

  constructor(opts: { apiKey: string }) {
    this.client = new Exa(opts.apiKey);
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new IntegrationError(`Exa request timed out after ${EXA_REQUEST_TIMEOUT_MS / 1000} seconds`, "exa", 504));
      }, EXA_REQUEST_TIMEOUT_MS);
    });

    try {
      return await Promise.race([operation, timedOut]);
    } catch (error) {
      if (error instanceof IntegrationError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Exa request failed";
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
      throw new IntegrationError(message, "exa", statusCode);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async search(opts: ExaSearchOptions): Promise<ExaSearchResponse> {
    const query = opts.query ?? opts.objective ?? opts.searchQueries?.join(" ");
    if (!query) {
      throw new IntegrationError("Exa search requires a query.", "exa", 400);
    }
    const numResults = opts.numResults ?? 5;

    return withSpan(tracer, "exa.search", {
      "exa.query": query.slice(0, 256),
      "exa.numResults": numResults,
      "exa.type": "auto",
      "exa.vertical": opts.vertical ?? "web",
    }, async (span) => {
      logger.debug({ query: query.slice(0, 256), numResults, vertical: opts.vertical }, "Exa search request");
      const response = await this.withTimeout(this.client.search(query, {
        type: "auto",
        numResults,
        ...(opts.vertical === undefined ? {} : { category: opts.vertical }),
        contents: {
          highlights: true,
          ...(opts.maxAgeHours === undefined ? {} : { maxAgeHours: opts.maxAgeHours }),
        },
      }));
      span.setAttribute("exa.resultCount", response.results.length);
      return {
        provider: "exa",
        results: response.results.map((result) => ({
          ...result,
          excerpts: result.highlights,
        })),
      };
    });
  }

  async getContents(url: string | string[], opts: { includeText?: boolean } = {}): Promise<ExaContentResponse> {
    const urls = Array.isArray(url) ? url : [url];
    const spanUrl = urls.join(", ").slice(0, 512);
    const contents: ContentsOptions = {
      highlights: true,
      ...(opts.includeText ? { text: { maxCharacters: 20_000 } } : {}),
    };

    return withSpan(tracer, "exa.getContents", {
      "exa.url": spanUrl,
      "exa.includeText": Boolean(opts.includeText),
    }, async (span) => {
      logger.debug({ url, includeText: Boolean(opts.includeText) }, "Exa contents request");
      const response = await this.withTimeout(this.client.getContents(urls, contents));
      const results = response.results as ExaContent[];
      span.setAttribute("exa.resultCount", response.results.length);
      return {
        provider: "exa",
        contents: results.map((result) => ({
          ...result,
          excerpts: result.highlights,
          fullContent: result.text,
        })),
      };
    });
  }
}
