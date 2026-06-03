import { createLogger, type UserContext } from "@finn/core";
import OfficialSupermemory, { APIError, type Supermemory as OfficialSupermemoryTypes } from "supermemory";
import type {
  MemoryAddDocumentInput,
  MemoryAddDocumentResponse,
  MemoryClient,
  MemoryContextResponse,
  MemoryMetadata,
  MemoryProfileContextInput,
  MemoryProfileContextResponse,
  MemorySearchInput,
  MemorySearchResponse,
  MemorySearchResult,
} from "./memory.js";
import { getDefaultMemoryOperation, getMemoryLogContext, getSafeMemoryFailureReason } from "./memory.js";

const logger = createLogger("supermemory");
const defaultBaseUrl = "https://api.supermemory.ai";

export type SupermemoryMetadata = MemoryMetadata;

export type SupermemoryFilter = {
  key: string;
  value: string;
  filterType?: "metadata" | "numeric" | "array_contains" | "string_contains";
  negate?: boolean;
  ignoreCase?: boolean;
  numericOperator?: ">" | "<" | ">=" | "<=" | "=";
};

export type SupermemoryFilterExpression = SupermemoryFilter | SupermemoryFilterGroup;

export type SupermemoryFilterGroup =
  | { AND: SupermemoryFilterExpression[]; OR?: never }
  | { OR: SupermemoryFilterExpression[]; AND?: never };

export type SupermemorySearchResult = MemorySearchResult;

export type SupermemorySearchResponse = MemorySearchResponse;

export type SupermemoryAddDocumentInput = MemoryAddDocumentInput;

export type SupermemorySearchInput = MemorySearchInput;

export interface SupermemoryClientOptions {
  apiKey: string;
  baseUrl?: string;
}

type SupermemoryAddResponse = MemoryAddDocumentResponse;
type SupermemoryAddParams = OfficialSupermemoryTypes.AddParams & {
  filterByMetadata?: SupermemoryMetadata;
};
type SupermemoryProfileParams = OfficialSupermemoryTypes.ProfileParams;
type SupermemorySearchParams = OfficialSupermemoryTypes.SearchMemoriesParams;
type SupermemoryProfileResponse = OfficialSupermemoryTypes.ProfileResponse;

interface SupermemorySdkClient {
  add(params: SupermemoryAddParams): PromiseLike<SupermemoryAddResponse>;
  profile(params: SupermemoryProfileParams): PromiseLike<SupermemoryProfileResponse>;
  search: {
    memories(params: SupermemorySearchParams): PromiseLike<RawSupermemorySearchResponse>;
  };
}

interface SupermemoryClientInternalOptions extends SupermemoryClientOptions {
  sdkClient?: SupermemorySdkClient;
}

interface RawSupermemorySearchResult {
  id?: unknown;
  memory?: unknown;
  chunk?: unknown;
  similarity?: unknown;
  documentId?: unknown;
  title?: unknown;
  summary?: unknown;
  content?: unknown;
  score?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  metadata?: unknown;
  chunks?: unknown;
}

interface RawSupermemorySearchResponse {
  results?: unknown;
}

interface RawSupermemoryProfileResponse {
  profile?: unknown;
}

type SupermemorySearchMode = "hybrid" | "memories";

const supermemorySearchThreshold = 0.6;

const finnEntityContext = [
  "Finn is a personal intelligence companion for one user, not a generic enterprise agent.",
  "Extract source-backed personal context that helps Finn understand and assist the user over time: durable preferences, relationships, family and household context, responsibilities, commitments, projects, routines, communication style, decisions, and active open loops.",
  "Treat Finn assistant text as lower-confidence unless confirmed by the user or backed by connected-app evidence. Do not turn guesses, jokes, tool/process details, test data, transient notifications, or cancelled/archived operational state into durable user facts.",
  "Preserve provenance cues and prefer concise, entity-centric memories about the user and their world.",
].join(" ");

function sanitizeContainerTagPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

function sanitizeCustomIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 72);
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeChunks(value: unknown): SupermemorySearchResult["chunks"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((chunk) => {
    if (!chunk || typeof chunk !== "object") {
      return [];
    }
    const record = chunk as Record<string, unknown>;
    const content = typeof record["content"] === "string" ? record["content"] : "";
    if (content.trim().length === 0) {
      return [];
    }
    return [{
      content,
      score: toNumberOrNull(record["score"]),
      isRelevant: typeof record["isRelevant"] === "boolean" ? record["isRelevant"] : null,
    }];
  });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildSupermemoryMetadata(input: SupermemoryAddDocumentInput): SupermemoryMetadata {
  return input.source
    ? {
        ...input.metadata,
        sourceProvider: input.source.provider,
        sourceType: input.source.type,
        sourceId: input.source.id,
        sourceContext: JSON.stringify(input.source),
      }
    : input.metadata;
}

export function getSupermemoryFailureReason(error: unknown): string {
  if (error instanceof APIError) {
    return typeof error.status === "number" ? `provider_http_${error.status}` : "provider_connection_error";
  }

  return getSafeMemoryFailureReason(error);
}

function normalizeSearchResult(result: RawSupermemorySearchResult): SupermemorySearchResult | null {
  const documentId = toStringOrNull(result.documentId) ?? toStringOrNull(result.id);
  if (!documentId) {
    return null;
  }

  const memory = toStringOrNull(result.memory);
  const chunk = toStringOrNull(result.chunk);
  const content = memory ?? chunk ?? toStringOrNull(result.content);
  const score = toNumberOrNull(result.similarity) ?? toNumberOrNull(result.score);
  const chunks = normalizeChunks(result.chunks);

  return {
    documentId,
    title: toStringOrNull(result.title),
    summary: memory ?? toStringOrNull(result.summary),
    content,
    score,
    createdAt: toStringOrNull(result.createdAt),
    updatedAt: toStringOrNull(result.updatedAt),
    metadata: normalizeMetadata(result.metadata),
    chunks: chunks.length > 0
      ? chunks
      : content?.trim()
        ? [{ content: content.trim(), score, isRelevant: true }]
        : [],
  };
}

function getBestResultText(result: SupermemorySearchResult): string | null {
  const bestChunk = result.chunks.find((chunk) => chunk.isRelevant !== false) ?? result.chunks[0];
  const text = bestChunk?.content ?? result.summary ?? result.content;
  return text?.trim() ? text.trim() : null;
}

function getContextResultText(result: SupermemorySearchResult): string | null {
  const text = result.summary ?? getBestResultText(result) ?? result.content;
  return text?.trim() ? text.trim() : null;
}

export class SupermemoryClient implements MemoryClient {
  readonly provider = "supermemory";

  private readonly client: SupermemorySdkClient;

  constructor(options: SupermemoryClientOptions);
  constructor(options: SupermemoryClientInternalOptions) {
    this.client = options.sdkClient ?? new OfficialSupermemory({
      apiKey: options.apiKey,
      baseURL: normalizeBaseUrl(options.baseUrl),
      maxRetries: 0,
    });
  }

  getUserContainerTag(user: Pick<UserContext, "tenantId" | "userId">): string {
    const tenantId = sanitizeContainerTagPart(user.tenantId);
    const userId = sanitizeContainerTagPart(user.userId);
    return `finn_user_${tenantId}_${userId}`.slice(0, 100);
  }

  buildHotPathTurnCustomId(messageId: string): string {
    return `hot-path-turn_${sanitizeCustomIdPart(messageId)}`.slice(0, 100);
  }

  buildPatternRunCustomId(patternRunId: string): string {
    return `pattern-run_${sanitizeCustomIdPart(patternRunId)}`.slice(0, 100);
  }

  async addDocument(input: SupermemoryAddDocumentInput): Promise<SupermemoryAddResponse | null> {
    try {
      const response = await this.client.add({
        content: input.content,
        containerTag: this.getUserContainerTag(input.user),
        customId: input.customId,
        metadata: buildSupermemoryMetadata(input),
        filterByMetadata: buildSupermemoryFilterByMetadata(input),
        entityContext: finnEntityContext,
      });
      return response;
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? getDefaultMemoryOperation(input.metadata, "retain"),
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
          customId: input.customId,
        }),
        failureReason: getSupermemoryFailureReason(error),
      }, "Memory retain failed");
      return null;
    }
  }

  async searchDocuments(input: SupermemorySearchInput): Promise<SupermemorySearchResponse> {
    return this.searchMemoryEntries(input, "hybrid");
  }

  private async searchMemoryEntries(input: SupermemorySearchInput, searchMode: SupermemorySearchMode): Promise<SupermemorySearchResponse> {
    try {
      const response = await this.client.search.memories({
        q: input.query,
        containerTag: this.getUserContainerTag(input.user),
        searchMode,
        threshold: supermemorySearchThreshold,
        filters: buildSupermemoryFilters(input.metadata),
        limit: Math.max(1, Math.min(input.limit ?? 5, 10)),
      });

      if (!Array.isArray(response.results)) {
        return { ok: true, results: [] };
      }

      return {
        ok: true,
        results: response.results
          .map((result) => normalizeSearchResult(result as RawSupermemorySearchResult))
          .filter((result): result is SupermemorySearchResult => Boolean(result)),
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? getDefaultMemoryOperation(input.metadata, "search"),
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSupermemoryFailureReason(error),
      }, "Memory search failed");
      return { ok: false, results: [], error: "memory search is unavailable right now" };
    }
  }

  async buildContext(input: SupermemorySearchInput): Promise<MemoryContextResponse> {
    const response = await this.searchMemoryEntries({
      ...input,
      metadata: {},
    }, "memories");
    if (!response.ok) {
      return response;
    }

    return {
      ok: true,
      results: response.results.flatMap((result) => {
        if (result.metadata["kind"] === "pattern_run_outcome" || result.metadata["kind"] === "activity_feed_event") {
          return [];
        }

        const text = getContextResultText(result);
        if (!text) {
          return [];
        }

        return [{
          text,
          type: typeof result.metadata["sourceType"] === "string"
            ? result.metadata["sourceType"]
            : typeof result.metadata["kind"] === "string"
              ? result.metadata["kind"]
              : null,
          occurredAt: result.createdAt,
        }];
      }),
    };
  }

  async buildProfileContext(input: MemoryProfileContextInput): Promise<MemoryProfileContextResponse> {
    try {
      const response = await this.client.profile({
        containerTag: this.getUserContainerTag(input.user),
      });
      const profile = normalizeMetadata(response.profile);

      return {
        ok: true,
        profile: {
          static: normalizeStringList(profile["static"]),
          dynamic: normalizeStringList(profile["dynamic"]),
        },
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "build_profile_context",
          user: input.user,
          metadata: {},
          observability: input.observability,
        }),
        failureReason: getSupermemoryFailureReason(error),
      }, "Memory profile context failed");
      return { ok: false, profile: null, error: "memory profile is unavailable right now" };
    }
  }
}

export function buildSupermemoryFilters(metadata: SupermemoryMetadata): SupermemoryFilterGroup {
  return {
    AND: Object.entries(metadata).flatMap(([key, value]) => buildSupermemoryFilter(key, value)),
  };
}

function buildSupermemoryFilter(key: string, value: MemoryMetadata[string]): Array<SupermemoryFilter | SupermemoryFilterGroup> {
  if (Array.isArray(value)) {
    const values = value
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (values.length === 0) {
      return [];
    }
    return [{
      OR: values.map((item) => ({ key, value: item, filterType: "array_contains" })),
    }];
  }

  if (typeof value === "number") {
    return [{ key, value: String(value), filterType: "numeric", numericOperator: "=" }];
  }

  return [{ key, value: String(value) }];
}

function buildSupermemoryFilterByMetadata(input: SupermemoryAddDocumentInput): MemoryMetadata {
  const filterKeys = [
    "kind",
    "source",
    "sourceType",
    "sourceId",
    "accountScopeId",
    "connectedAccountId",
    "patternId",
  ];
  const filters: MemoryMetadata = {};

  for (const key of filterKeys) {
    const value = input.metadata[key];
    if (value !== undefined) {
      filters[key] = value;
    }
  }

  return filters;
}
