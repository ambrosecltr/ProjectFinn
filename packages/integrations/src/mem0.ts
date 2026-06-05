import { createLogger, type UserContext } from "@finn/core";
import OfficialMem0 from "mem0ai";
import type {
  MemoryAddDocumentInput,
  MemoryAddDocumentResponse,
  MemoryClient,
  MemoryContextResponse,
  MemoryMetadata,
  MemorySearchInput,
  MemorySearchResponse,
  MemorySearchResult,
} from "./memory.js";
import { getDefaultMemoryOperation, getMemoryLogContext, getSafeMemoryFailureReason } from "./memory.js";

const logger = createLogger("mem0");
const defaultSearchThreshold = 0.1;
const maxMem0Results = 20;

const operationalContextKinds = new Set(["activity_feed_event", "pattern_run_outcome"]);

export type Mem0Metadata = MemoryMetadata;
export type Mem0SearchResult = MemorySearchResult;
export type Mem0SearchResponse = MemorySearchResponse;
export type Mem0AddDocumentInput = MemoryAddDocumentInput;
export type Mem0SearchInput = MemorySearchInput;

export interface Mem0ClientOptions {
  apiKey: string;
  baseUrl?: string;
}

type Mem0Message = {
  role: "user" | "assistant";
  content: string;
};

type Mem0Filter = Record<string, unknown>;

interface Mem0AddOptions {
  userId: string;
  metadata?: Record<string, unknown>;
  infer?: boolean;
  timestamp?: number;
}

interface Mem0SearchOptions {
  filters: Mem0Filter;
  topK?: number;
  threshold?: number;
  rerank?: boolean;
  latestOnly?: boolean;
  referenceDate?: string;
}

interface Mem0GetAllOptions {
  filters: Mem0Filter;
  pageSize?: number;
  latestOnly?: boolean;
}

interface Mem0UpdateOptions {
  text?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

interface Mem0SdkClient {
  add(messages: Mem0Message[], options?: Mem0AddOptions): Promise<unknown>;
  search(query: string, options?: Mem0SearchOptions): Promise<unknown>;
  getAll?(options?: Mem0GetAllOptions): Promise<unknown>;
  update?(memoryId: string, options: Mem0UpdateOptions): Promise<unknown>;
}

interface Mem0ClientInternalOptions extends Mem0ClientOptions {
  sdkClient?: Mem0SdkClient;
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl?.replace(/\/+$/, "");
}

function sanitizeScopePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96);
}

function sanitizeCustomIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96);
}

export function buildMem0UserId(user: Pick<UserContext, "tenantId" | "userId">): string {
  return `finn:${sanitizeScopePart(user.tenantId)}:${sanitizeScopePart(user.userId)}`.slice(0, 220);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = toStringOrNull(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function getNumberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumberOrNull(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function getResultsArray(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (isRecord(response) && Array.isArray(response["results"])) {
    return response["results"];
  }
  return [];
}

function parseTimestampSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const text = toStringOrNull(value);
  if (!text) {
    return undefined;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function getDocumentTimestamp(input: MemoryAddDocumentInput): number | undefined {
  return parseTimestampSeconds(input.source?.timestamp)
    ?? parseTimestampSeconds(input.metadata["timestamp"])
    ?? parseTimestampSeconds(input.metadata["completedAt"])
    ?? parseTimestampSeconds(input.metadata["occurredAt"]);
}

function buildMem0Metadata(input: MemoryAddDocumentInput): Record<string, unknown> {
  return {
    ...input.metadata,
    finnCustomId: input.customId,
    ...(input.source
      ? {
          sourceProvider: input.source.provider,
          sourceType: input.source.type,
          sourceId: input.source.id,
          ...(input.source.title ? { sourceTitle: input.source.title } : {}),
          ...(input.source.url ? { sourceUrl: input.source.url } : {}),
          ...(input.source.timestamp ? { sourceTimestamp: input.source.timestamp } : {}),
        }
      : {}),
  };
}

function buildMetadataFilter(key: string, value: MemoryMetadata[string] | string): Mem0Filter[] {
  if (Array.isArray(value)) {
    const values = value
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (values.length === 0) {
      return [];
    }
    return [{
      OR: values.map((item) => ({ metadata: { [key]: { contains: item } } })),
    }];
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return [];
  }

  return [{ metadata: { [key]: value } }];
}

export function buildMem0Filters(user: Pick<UserContext, "tenantId" | "userId">, metadata: MemoryMetadata = {}): Mem0Filter {
  const conditions: Mem0Filter[] = [{ user_id: buildMem0UserId(user) }];
  for (const [key, value] of Object.entries(metadata)) {
    conditions.push(...buildMetadataFilter(key, value));
  }

  return conditions.length === 1 ? conditions[0] : { AND: conditions };
}

function formatConversationMessage(message: NonNullable<MemoryAddDocumentInput["conversationMessages"]>[number]): Mem0Message | null {
  const lines = [
    message.content.trim(),
    ...(message.attachments ?? []).flatMap((attachment) => [
      `[attachment: ${attachment.filename}]`,
      `mime type: ${attachment.mimeType}`,
      attachment.context?.trim() ? `context: ${attachment.context.trim()}` : null,
    ]),
  ].filter((line): line is string => Boolean(line && line.trim().length > 0));
  const content = lines.join("\n").trim();
  if (!content) {
    return null;
  }

  return {
    role: message.role,
    content,
  };
}

function buildMem0Messages(input: MemoryAddDocumentInput): Mem0Message[] {
  const conversationMessages = input.conversationMessages
    ?.map(formatConversationMessage)
    .filter((message): message is Mem0Message => Boolean(message));
  if (conversationMessages?.length) {
    return conversationMessages;
  }

  const content = input.content.trim();
  return content ? [{ role: "user", content }] : [];
}

function shouldInferMemories(input: MemoryAddDocumentInput): boolean {
  const kind = input.metadata["kind"];
  return kind !== "activity_feed_event" && kind !== "pattern_run_outcome" && kind !== "user_profile_seed";
}

function shouldCheckExisting(input: MemoryAddDocumentInput): boolean {
  return input.observability?.operation === "backfill_retain" || input.metadata["kind"] === "user_profile_seed";
}

function normalizeSearchResult(result: unknown): Mem0SearchResult | null {
  if (!isRecord(result)) {
    return null;
  }

  const documentId = getStringField(result, "id", "memoryId", "memory_id");
  if (!documentId) {
    return null;
  }

  const memoryData = isRecord(result["data"]) ? result["data"] : {};
  const content = getStringField(result, "memory", "content", "text")
    ?? getStringField(memoryData, "memory", "content", "text");
  const metadata = normalizeMetadata(result["metadata"]);
  const categories = normalizeStringList(result["categories"]);
  const score = getNumberField(result, "score", "similarity");

  return {
    documentId,
    title: getStringField(result, "title"),
    summary: content,
    content,
    score,
    createdAt: getStringField(result, "createdAt", "created_at"),
    updatedAt: getStringField(result, "updatedAt", "updated_at"),
    metadata: categories.length > 0 ? { ...metadata, categories } : metadata,
    chunks: content ? [{ content, score, isRelevant: true }] : [],
  };
}

function normalizeAddResponse(response: unknown, customId: string): MemoryAddDocumentResponse {
  const firstResult = getResultsArray(response)[0];
  const record = isRecord(response)
    ? response
    : isRecord(firstResult)
      ? firstResult
      : {};
  const id = getStringField(record, "id", "memoryId", "memory_id", "eventId", "event_id") ?? customId;
  const status = getStringField(record, "status", "event", "message") ?? "queued";
  return { id, status };
}

function getBestResultText(result: Mem0SearchResult): string | null {
  const text = result.summary ?? result.content ?? result.chunks[0]?.content;
  return text?.trim() ? text.trim() : null;
}

function getContextOccurredAt(result: Mem0SearchResult): string | null {
  return toStringOrNull(result.metadata["timestamp"])
    ?? toStringOrNull(result.metadata["sourceTimestamp"])
    ?? result.createdAt;
}

export function getMem0FailureReason(error: unknown): string {
  if (isRecord(error)) {
    const code = toStringOrNull(error["errorCode"]);
    if (code) {
      return code;
    }
  }

  return getSafeMemoryFailureReason(error);
}

export class Mem0Client implements MemoryClient {
  readonly provider = "mem0";

  private readonly client: Mem0SdkClient;

  constructor(options: Mem0ClientOptions);
  constructor(options: Mem0ClientInternalOptions) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    this.client = options.sdkClient ?? (new OfficialMem0({
      apiKey: options.apiKey,
      ...(baseUrl ? { host: baseUrl } : {}),
    }) as unknown as Mem0SdkClient);
  }

  getUserId(user: Pick<UserContext, "tenantId" | "userId">): string {
    return buildMem0UserId(user);
  }

  buildHotPathTurnCustomId(messageId: string): string {
    return `hot-path-turn_${sanitizeCustomIdPart(messageId)}`.slice(0, 120);
  }

  buildPatternRunCustomId(patternRunId: string): string {
    return `pattern-run_${sanitizeCustomIdPart(patternRunId)}`.slice(0, 120);
  }

  async addDocument(input: Mem0AddDocumentInput): Promise<MemoryAddDocumentResponse | null> {
    try {
      const messages = buildMem0Messages(input);
      if (messages.length === 0) {
        return { id: input.customId, status: "skipped_empty" };
      }

      const metadata = buildMem0Metadata(input);
      const existingId = shouldCheckExisting(input)
        ? await this.findExistingCustomId(input.user, input.customId)
        : null;
      if (existingId) {
        if (input.metadata["kind"] === "user_profile_seed" && this.client.update) {
          const updateResponse = await this.client.update(existingId, {
            text: input.content,
            metadata,
            timestamp: getDocumentTimestamp(input),
          });
          return normalizeAddResponse(updateResponse, existingId);
        }
        return { id: existingId, status: "skipped_duplicate" };
      }

      const response = await this.client.add(messages, {
        userId: this.getUserId(input.user),
        metadata,
        infer: shouldInferMemories(input),
        timestamp: getDocumentTimestamp(input),
      });
      return normalizeAddResponse(response, input.customId);
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
        failureReason: getMem0FailureReason(error),
      }, "Memory retain failed");
      return null;
    }
  }

  async searchDocuments(input: Mem0SearchInput): Promise<Mem0SearchResponse> {
    return this.searchMemoryEntries(input, { rerank: true });
  }

  async buildContext(input: Mem0SearchInput): Promise<MemoryContextResponse> {
    const response = await this.searchMemoryEntries({
      ...input,
      metadata: {},
    }, { rerank: false });
    if (!response.ok) {
      return response;
    }

    return {
      ok: true,
      results: response.results.flatMap((result) => {
        const kind = result.metadata["kind"];
        if (typeof kind === "string" && operationalContextKinds.has(kind)) {
          return [];
        }

        const text = getBestResultText(result);
        if (!text) {
          return [];
        }

        return [{
          text,
          type: typeof result.metadata["sourceType"] === "string"
            ? result.metadata["sourceType"]
            : typeof kind === "string"
              ? kind
              : null,
          occurredAt: getContextOccurredAt(result),
        }];
      }),
    };
  }

  private async searchMemoryEntries(input: Mem0SearchInput, options: { rerank: boolean }): Promise<Mem0SearchResponse> {
    try {
      const limit = Math.max(1, Math.min(input.limit ?? 5, maxMem0Results));
      const response = await this.client.search(input.query, {
        filters: buildMem0Filters(input.user, input.metadata),
        topK: limit,
        threshold: defaultSearchThreshold,
        latestOnly: true,
        rerank: options.rerank,
        ...(input.queryTimestamp ? { referenceDate: input.queryTimestamp } : {}),
      });

      return {
        ok: true,
        results: getResultsArray(response)
          .map(normalizeSearchResult)
          .filter((result): result is Mem0SearchResult => Boolean(result))
          .slice(0, limit),
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
        failureReason: getMem0FailureReason(error),
      }, "Memory search failed");
      return { ok: false, results: [], error: "memory search is unavailable right now" };
    }
  }

  private async findExistingCustomId(user: Pick<UserContext, "tenantId" | "userId">, customId: string): Promise<string | null> {
    if (!this.client.getAll) {
      return null;
    }

    const response = await this.client.getAll({
      filters: buildMem0Filters(user, { finnCustomId: customId }),
      pageSize: 1,
      latestOnly: true,
    });
    const result = getResultsArray(response)
      .map(normalizeSearchResult)
      .find((memory) => memory?.metadata["finnCustomId"] === customId);
    return result?.documentId ?? null;
  }
}
