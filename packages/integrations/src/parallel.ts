import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";
import { Parallel } from "parallel-web";
import type {
  AdvancedExtractSettings,
  AdvancedSearchSettings,
  ExtractParams,
  FetchPolicy,
  FullContentSettings,
  SearchParams,
} from "parallel-web/resources/top-level";
import type { SourcePolicy } from "parallel-web/resources/shared";

const logger = createLogger("parallel");
const tracer = getTracer("parallel");
const DEFAULT_PARALLEL_TIMEOUT_MS = 60_000;
const DEFAULT_FULL_CONTENT_CHARS = 20_000;
const MAX_EXTRACT_URLS = 20;

export type ParallelFetchPolicy = {
  maxAgeSeconds?: number;
  timeoutSeconds?: number;
  disableCacheFallback?: boolean;
};

export type ParallelSourcePolicy = {
  includeDomains?: string[];
  excludeDomains?: string[];
  afterDate?: string;
};

export type ParallelContentLimit = {
  maxCharsPerResult?: number;
};

export type ParallelSearchOptions = {
  query?: string;
  objective?: string;
  searchQueries?: string[];
  numResults?: number;
  maxAgeHours?: number;
  mode?: "basic" | "advanced";
  maxCharsTotal?: number;
  sessionId?: string;
  clientModel?: string;
  sourcePolicy?: ParallelSourcePolicy;
  fetchPolicy?: ParallelFetchPolicy;
  maxCharsPerResult?: number;
  location?: string;
};

export type ParallelSearchResult = {
  url: string;
  title: string | null;
  publishedDate?: string;
  highlights?: string[];
  excerpts?: string[];
};

export type ParallelUsageItem = {
  name: string;
  count: number;
};

export type ParallelWarning = {
  type: string;
  message: string;
  detail?: Record<string, unknown> | null;
};

export type ParallelSearchResponse = {
  provider: "parallel";
  results: ParallelSearchResult[];
  searchId: string;
  sessionId: string;
  warnings?: ParallelWarning[];
  usage?: ParallelUsageItem[];
};

export type ParallelExtractError = {
  url: string;
  errorType: string;
  httpStatusCode?: number | null;
  content?: string | null;
};

export type ParallelContent = {
  url: string;
  title: string | null;
  publishedDate?: string;
  text?: string;
  fullContent?: string;
  highlights?: string[];
  excerpts?: string[];
};

export type ParallelContentOptions = {
  includeText?: boolean;
  objective?: string;
  searchQueries?: string[];
  maxCharsTotal?: number;
  sessionId?: string;
  clientModel?: string;
  fetchPolicy?: ParallelFetchPolicy;
  maxCharsPerResult?: number;
  fullContent?: boolean | ParallelContentLimit;
};

export type ParallelContentResponse = {
  provider: "parallel";
  contents: ParallelContent[];
  extractId: string;
  sessionId: string;
  errors: ParallelExtractError[];
  warnings?: ParallelWarning[];
  usage?: ParallelUsageItem[];
};

export type ParallelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ParallelClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  clientModel?: string;
  fetch?: ParallelFetch;
}

function cleanStrings(values: string[] | undefined): string[] | undefined {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function buildSearchQueries(opts: Pick<ParallelSearchOptions, "query" | "objective" | "searchQueries">): string[] {
  const explicitQueries = cleanStrings(opts.searchQueries);
  if (explicitQueries) {
    return explicitQueries;
  }

  const fallbackQuery = opts.query?.trim() || opts.objective?.trim();
  if (!fallbackQuery) {
    throw new IntegrationError("Parallel search requires query, objective, or searchQueries.", "parallel", 400);
  }
  return [fallbackQuery];
}

function afterDateFromMaxAgeHours(maxAgeHours: number | undefined): string | undefined {
  if (maxAgeHours === undefined || maxAgeHours < 0) {
    return undefined;
  }

  const millis = maxAgeHours * 60 * 60 * 1000;
  return new Date(Date.now() - millis).toISOString().slice(0, 10);
}

function toFetchPolicy(policy: ParallelFetchPolicy | undefined): FetchPolicy | undefined {
  if (!policy) {
    return undefined;
  }

  return {
    ...(policy.maxAgeSeconds === undefined ? {} : { max_age_seconds: policy.maxAgeSeconds }),
    ...(policy.timeoutSeconds === undefined ? {} : { timeout_seconds: policy.timeoutSeconds }),
    ...(policy.disableCacheFallback === undefined ? {} : { disable_cache_fallback: policy.disableCacheFallback }),
  };
}

function toSourcePolicy(opts: ParallelSearchOptions): SourcePolicy | undefined {
  const afterDate = opts.sourcePolicy?.afterDate ?? afterDateFromMaxAgeHours(opts.maxAgeHours);
  const policy: SourcePolicy = {
    ...(opts.sourcePolicy?.includeDomains ? { include_domains: opts.sourcePolicy.includeDomains } : {}),
    ...(opts.sourcePolicy?.excludeDomains ? { exclude_domains: opts.sourcePolicy.excludeDomains } : {}),
    ...(afterDate ? { after_date: afterDate } : {}),
  };

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function toFullContentSettings(
  fullContent: ParallelContentOptions["fullContent"],
  includeText: boolean | undefined,
): FullContentSettings | boolean | undefined {
  if (typeof fullContent === "boolean") {
    return fullContent;
  }

  if (fullContent) {
    return {
      ...(fullContent.maxCharsPerResult === undefined ? {} : { max_chars_per_result: fullContent.maxCharsPerResult }),
    };
  }

  if (includeText) {
    return { max_chars_per_result: DEFAULT_FULL_CONTENT_CHARS };
  }

  return undefined;
}

function compactObject<T extends object>(value: T): T | undefined {
  return Object.values(value).some((entry) => entry !== undefined && entry !== null) ? value : undefined;
}

function toIntegrationError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Parallel request failed";
  const statusCode = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  return new IntegrationError(message, "parallel", statusCode);
}

function toWarnings(warnings: ParallelSearchResponse["warnings"] | null | undefined): ParallelWarning[] | undefined {
  return warnings && warnings.length > 0 ? warnings : undefined;
}

function toUsage(usage: ParallelSearchResponse["usage"] | null | undefined): ParallelUsageItem[] | undefined {
  return usage && usage.length > 0 ? usage : undefined;
}

export class ParallelClient {
  readonly provider = "parallel" as const;

  private readonly client: Parallel;
  private readonly clientModel?: string;

  constructor(opts: ParallelClientOptions) {
    this.client = new Parallel({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      timeout: opts.timeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS,
      ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
      ...(opts.fetch ? { fetch: opts.fetch as typeof fetch } : {}),
    });
    this.clientModel = opts.clientModel;
  }

  async search(opts: ParallelSearchOptions): Promise<ParallelSearchResponse> {
    const searchQueries = buildSearchQueries(opts);
    const advancedSettings: AdvancedSearchSettings | undefined = compactObject({
      ...(opts.numResults === undefined ? {} : { max_results: opts.numResults }),
      ...(opts.location === undefined ? {} : { location: opts.location }),
      source_policy: toSourcePolicy(opts),
      fetch_policy: toFetchPolicy(opts.fetchPolicy),
      excerpt_settings: opts.maxCharsPerResult === undefined
        ? undefined
        : { max_chars_per_result: opts.maxCharsPerResult },
    });
    const request: SearchParams = {
      search_queries: searchQueries,
      objective: opts.objective ?? opts.query ?? searchQueries.join("; "),
      mode: opts.mode ?? "advanced",
      ...(opts.maxCharsTotal === undefined ? {} : { max_chars_total: opts.maxCharsTotal }),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      ...(opts.clientModel ?? this.clientModel ? { client_model: opts.clientModel ?? this.clientModel } : {}),
      ...(advancedSettings ? { advanced_settings: advancedSettings } : {}),
    };

    return withSpan(tracer, "parallel.search", {
      "parallel.queryCount": searchQueries.length,
      "parallel.mode": request.mode ?? "advanced",
      "parallel.numResults": opts.numResults ?? 10,
    }, async (span) => {
      try {
        logger.debug({
          objective: request.objective?.slice(0, 256),
          queryCount: searchQueries.length,
          mode: request.mode,
          numResults: opts.numResults,
        }, "Parallel search request");
        const response = await this.client.search(request);
        span.setAttribute("parallel.resultCount", response.results.length);
        span.setAttribute("parallel.searchId", response.search_id);
        return {
          provider: "parallel",
          searchId: response.search_id,
          sessionId: response.session_id,
          warnings: toWarnings(response.warnings),
          usage: toUsage(response.usage),
          results: response.results.map((result) => ({
            url: result.url,
            title: result.title ?? null,
            publishedDate: result.publish_date ?? undefined,
            highlights: result.excerpts,
            excerpts: result.excerpts,
          })),
        };
      } catch (error) {
        throw toIntegrationError(error);
      }
    });
  }

  async getContents(url: string | string[], opts: ParallelContentOptions = {}): Promise<ParallelContentResponse> {
    const urls = Array.isArray(url) ? url : [url];
    if (urls.length > MAX_EXTRACT_URLS) {
      throw new IntegrationError(`Parallel extract accepts at most ${MAX_EXTRACT_URLS} URLs.`, "parallel", 400);
    }
    const fullContent = toFullContentSettings(opts.fullContent, opts.includeText);
    const advancedSettings: AdvancedExtractSettings | undefined = compactObject({
      fetch_policy: toFetchPolicy(opts.fetchPolicy),
      excerpt_settings: opts.maxCharsPerResult === undefined
        ? undefined
        : { max_chars_per_result: opts.maxCharsPerResult },
      ...(fullContent === undefined ? {} : { full_content: fullContent }),
    });
    const request: ExtractParams = {
      urls,
      ...(opts.objective ? { objective: opts.objective } : {}),
      ...(opts.searchQueries ? { search_queries: opts.searchQueries } : {}),
      ...(opts.maxCharsTotal === undefined ? {} : { max_chars_total: opts.maxCharsTotal }),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      ...(opts.clientModel ?? this.clientModel ? { client_model: opts.clientModel ?? this.clientModel } : {}),
      ...(advancedSettings ? { advanced_settings: advancedSettings } : {}),
    };

    return withSpan(tracer, "parallel.extract", {
      "parallel.urlCount": urls.length,
      "parallel.includeFullContent": Boolean(fullContent),
    }, async (span) => {
      try {
        logger.debug({ urlCount: urls.length, includeFullContent: Boolean(fullContent) }, "Parallel extract request");
        const response = await this.client.extract(request);
        span.setAttribute("parallel.resultCount", response.results.length);
        span.setAttribute("parallel.errorCount", response.errors.length);
        span.setAttribute("parallel.extractId", response.extract_id);
        return {
          provider: "parallel",
          extractId: response.extract_id,
          sessionId: response.session_id,
          errors: response.errors.map((error) => ({
            url: error.url,
            errorType: error.error_type,
            httpStatusCode: error.http_status_code,
            content: error.content,
          })),
          warnings: toWarnings(response.warnings),
          usage: toUsage(response.usage),
          contents: response.results.map((result) => ({
            url: result.url,
            title: result.title ?? null,
            publishedDate: result.publish_date ?? undefined,
            highlights: result.excerpts,
            excerpts: result.excerpts,
            text: result.full_content ?? undefined,
            fullContent: result.full_content ?? undefined,
          })),
        };
      } catch (error) {
        throw toIntegrationError(error);
      }
    });
  }
}
