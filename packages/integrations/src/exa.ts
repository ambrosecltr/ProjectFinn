import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";
import { Exa } from "exa-js";
import type { ContentsOptions } from "exa-js";

const logger = createLogger("exa");
const tracer = getTracer("exa");
const EXA_REQUEST_TIMEOUT_MS = 30_000;

export type ExaSearchOptions = {
  query: string;
  numResults: number;
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
};

export type ExaContent = {
  url: string;
  title: string | null;
  text?: string;
  highlights?: string[];
};

export class ExaClient {
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

  async search(opts: ExaSearchOptions): Promise<ExaSearchResult[]> {
    return withSpan(tracer, "exa.search", {
      "exa.query": opts.query.slice(0, 256),
      "exa.numResults": opts.numResults,
      "exa.type": "auto",
      "exa.vertical": opts.vertical ?? "web",
    }, async (span) => {
      logger.debug({ query: opts.query.slice(0, 256), numResults: opts.numResults, vertical: opts.vertical }, "Exa search request");
      const response = await this.withTimeout(this.client.search(opts.query, {
        type: "auto",
        numResults: opts.numResults,
        ...(opts.vertical === undefined ? {} : { category: opts.vertical }),
        contents: {
          highlights: true,
          ...(opts.maxAgeHours === undefined ? {} : { maxAgeHours: opts.maxAgeHours }),
        },
      }));
      span.setAttribute("exa.resultCount", response.results.length);
      return response.results;
    });
  }

  async getContents(url: string, opts: { includeText?: boolean } = {}): Promise<ExaContent[]> {
    const contents: ContentsOptions = {
      highlights: true,
      ...(opts.includeText ? { text: { maxCharacters: 20_000 } } : {}),
    };

    return withSpan(tracer, "exa.getContents", {
      "exa.url": url,
      "exa.includeText": Boolean(opts.includeText),
    }, async (span) => {
      logger.debug({ url, includeText: Boolean(opts.includeText) }, "Exa contents request");
      const response = await this.withTimeout(this.client.getContents([url], contents));
      span.setAttribute("exa.resultCount", response.results.length);
      return response.results;
    });
  }
}
