import { createHash } from "node:crypto";
import { createLogger, type UserContext } from "@finn/core";
import { Honcho, type MessageInput, type PeerAddition, type SessionConfig, type WorkspaceConfig } from "@honcho-ai/sdk";
import type {
  MemoryAddDocumentInput,
  MemoryAddDocumentResponse,
  MemoryClient,
  MemoryContextResponse,
  MemoryContextResult,
  MemoryConversationMessage,
  MemoryMetadata,
  MemoryProfileContextInput,
  MemoryProfileContextResponse,
  MemoryReflectBudget,
  MemoryReflectInput,
  MemoryReflectResponse,
  MemorySearchInput,
  MemorySearchResponse,
  MemorySearchResult,
} from "./memory.js";
import { getDefaultMemoryOperation, getMemoryLogContext, getSafeMemoryFailureReason } from "./memory.js";

const logger = createLogger("honcho");

const defaultWorkspacePrefix = "finn";
const finnPeerId = "finn";
const userPeerId = "user";
const operationalPeerId = "finn_operational";
const maxHonchoResults = 10;
const defaultHonchoTimeoutMs = 30_000;

const userReasoningInstructions = [
  "Finn is a single-user personal intelligence companion. Extract source-grounded conclusions that help Finn know the observed user as a real person over time.",
  "Prioritize durable identity, relationships, household context, commitments, projects, constraints, preferences, routines, communication style, and the smaller everyday details that recur or are explicitly important.",
  "Treat Finn assistant messages as context unless the user confirms them or connected-app evidence supports them. Ignore tool chatter, process details, jokes, tests, and transient logistics unless they reveal a durable preference or current open loop.",
  "Preserve uncertainty and keep sensitive health, legal, financial, security, identity, and family material narrow and factual.",
].join(" ");

const patternReasoningInstructions = [
  "Extract only durable continuity for this Finn Pattern: terminal outcomes, current operational state, cross-run trends, and dedupe-relevant facts.",
  "Do not infer broad user personality, preferences, or life facts from Pattern runs. Distinguish found, notified, and surfaced states.",
].join(" ");

const operationalReasoningInstructions = [
  "Extract operational Finn state only: Pattern lifecycle changes, automation state, and narrow current system facts.",
  "Do not convert operational records into personal traits, hobbies, goals, or preferences.",
].join(" ");

type HonchoReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

interface HonchoMessageLike {
  id: string;
  content: string;
  peerId: string;
  sessionId: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  tokenCount: number;
}

interface HonchoPeerContextLike {
  representation: string | null;
  peerCard: string[] | null;
}

interface HonchoPeerLike {
  id: string;
  message(content: string, options?: {
    metadata?: Record<string, unknown>;
    configuration?: { reasoning?: { enabled?: boolean | null; customInstructions?: string | null } | null } | null;
    createdAt?: string | Date;
  }): MessageInput;
  context(options?: {
    target?: string;
    searchQuery?: string;
    searchTopK?: number;
    searchMaxDistance?: number;
    includeMostFrequent?: boolean;
    maxConclusions?: number;
  }): Promise<HonchoPeerContextLike>;
  chat(query: string, options?: {
    target?: string;
    reasoningLevel?: HonchoReasoningLevel;
  }): Promise<string | null>;
}

interface HonchoSessionLike {
  id: string;
  addMessages(messages: MessageInput | MessageInput[]): Promise<HonchoMessageLike[]>;
}

interface HonchoSdkClient {
  peer(id: string, options?: {
    metadata?: Record<string, unknown>;
    configuration?: { observeMe?: boolean | null };
  }): Promise<HonchoPeerLike>;
  session(id: string, options?: {
    metadata?: Record<string, unknown>;
    configuration?: SessionConfig;
    peers?: PeerAddition;
  }): Promise<HonchoSessionLike>;
  search(query: string, options?: {
    filters?: Record<string, unknown>;
    limit?: number;
  }): Promise<HonchoMessageLike[]>;
  setMetadata?(metadata: Record<string, unknown>): Promise<void>;
  setConfiguration?(configuration: WorkspaceConfig): Promise<void>;
}

export type HonchoMetadata = MemoryMetadata;
export type HonchoSearchResult = MemorySearchResult;
export type HonchoSearchResponse = MemorySearchResponse;
export type HonchoAddDocumentInput = MemoryAddDocumentInput;
export type HonchoSearchInput = MemorySearchInput;

export interface HonchoClientOptions {
  apiKey?: string;
  baseUrl?: string;
  workspacePrefix?: string;
  timeoutMs?: number;
}

interface HonchoClientInternalOptions extends HonchoClientOptions {
  sdkClientFactory?: (workspaceId: string) => HonchoSdkClient;
}

interface HonchoScope {
  kind: "user" | "pattern" | "operational";
  targetPeerId: string;
  sessionId: string;
  instructions: string;
  sessionMetadata: Record<string, unknown>;
}

interface HonchoScopePeers {
  targetPeer: HonchoPeerLike;
  finnPeer: HonchoPeerLike;
  sessionPeers: PeerAddition;
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl?.replace(/\/+$/, "");
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeIdPart(value: string, maxLength: number): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^_+|_+$/g, "");
  return (sanitized || "unknown").slice(0, maxLength);
}

function buildStablePart(value: string, maxLength: number): string {
  const hash = stableHash(value);
  const sanitized = sanitizeIdPart(value, Math.max(1, maxLength - hash.length - 1));
  return `${sanitized}_${hash}`.slice(0, maxLength);
}

function buildStableId(prefix: string, parts: string[], maxLength = 100): string {
  const hash = stableHash(parts.join("\0"));
  const readable = [prefix, ...parts].map((part) => sanitizeIdPart(part, 28)).join("_");
  const available = Math.max(1, maxLength - hash.length - 1);
  return `${readable.slice(0, available).replace(/_+$/g, "")}_${hash}`.slice(0, maxLength);
}

function normalizeWorkspacePrefix(prefix?: string): string {
  return sanitizeIdPart(prefix ?? defaultWorkspacePrefix, 32).toLowerCase();
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFilterableMetadataValue(value: MemoryMetadata[string]): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item.trim().length > 0);
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function buildArrayMetadataFilter(key: string, values: string[]): Record<string, unknown> | null {
  const uniqueValues = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  if (uniqueValues.length === 0) {
    return null;
  }

  if (uniqueValues.length === 1) {
    return { metadata: { [key]: { contains: uniqueValues[0] } } };
  }

  return {
    OR: uniqueValues.map((value) => ({ metadata: { [key]: { contains: value } } })),
  };
}

function buildHonchoMetadata(input: HonchoAddDocumentInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...input.metadata,
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    customId: input.customId,
    ...(input.source ? {
      sourceProvider: input.source.provider,
      sourceType: input.source.type,
      sourceId: input.source.id,
      ...(input.source.title ? { sourceTitle: input.source.title } : {}),
      ...(input.source.url ? { sourceUrl: input.source.url } : {}),
      ...(input.source.timestamp ? { sourceTimestamp: input.source.timestamp } : {}),
    } : {}),
    ...extra,
  };
}

export function buildHonchoFilters(metadata: HonchoMetadata, peerIds?: string[]): Record<string, unknown> | undefined {
  const scalarMetadataFilters: Record<string, string | number | boolean> = {};
  const filterExpressions: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (!isFilterableMetadataValue(value)) {
      continue;
    }

    if (Array.isArray(value)) {
      const expression = buildArrayMetadataFilter(key, value);
      if (expression) {
        filterExpressions.push(expression);
      }
      continue;
    }

    scalarMetadataFilters[key] = value;
  }

  if (Object.keys(scalarMetadataFilters).length > 0) {
    filterExpressions.unshift({ metadata: scalarMetadataFilters });
  }

  if (peerIds && peerIds.length > 0) {
    filterExpressions.push({ peer_id: peerIds.length === 1 ? peerIds[0] : { in: peerIds } });
  }

  if (filterExpressions.length === 0) {
    return undefined;
  }

  return filterExpressions.length === 1 ? filterExpressions[0] : { AND: filterExpressions };
}

function getMessageTimestamp(input: HonchoAddDocumentInput): string | undefined {
  return toStringOrNull(input.metadata["timestamp"])
    ?? toStringOrNull(input.metadata["completedAt"])
    ?? input.source?.timestamp;
}

function getScopeTimestampSuffix(input: HonchoAddDocumentInput): string | undefined {
  return toStringOrNull(input.metadata["day"]) ?? getMessageTimestamp(input)?.slice(0, 10);
}

function formatConversationMessage(message: MemoryConversationMessage): string {
  const parts = [message.content.trim()].filter(Boolean);
  const attachments = message.attachments?.flatMap((attachment) => {
    const context = attachment.context?.trim();
    const label = `${attachment.filename} (${attachment.mimeType})`;
    return context ? [`${label}: ${context}`] : [label];
  }) ?? [];

  if (attachments.length > 0) {
    parts.push(`Attachments:\n${attachments.map((attachment) => `- ${attachment}`).join("\n")}`);
  }

  return parts.join("\n\n").trim();
}

function normalizeProfileLines(value: string | null, maxEntries: number): string[] {
  if (!value) {
    return [];
  }

  const lines = value
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);

  return (lines.length > 0 ? lines : [value.trim()]).slice(0, maxEntries);
}

function normalizeStringList(value: string[] | null, maxEntries: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxEntries);
}

function parseHonchoRepresentationContext(representation: string, limit: number): MemoryContextResult[] {
  const sections = splitRepresentationSections(representation);
  const explicitObservations = parseExplicitObservationSection(sections.get("explicit observations") ?? []);
  const inductiveObservations = parseInductiveObservationSection(sections.get("inductive observations") ?? []);

  return [
    ...explicitObservations,
    ...inductiveObservations.slice(0, Math.max(0, limit - explicitObservations.length)),
  ].slice(0, limit);
}

function splitRepresentationSections(representation: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;

  for (const rawLine of representation.split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentSection = heading[1].trim().toLowerCase();
      sections.set(currentSection, []);
      continue;
    }

    if (currentSection) {
      sections.get(currentSection)?.push(rawLine);
    }
  }

  return sections;
}

function parseExplicitObservationSection(lines: string[]): MemoryContextResult[] {
  const observations: MemoryContextResult[] = [];
  let current: MemoryContextResult | null = null;

  const flushCurrent = () => {
    if (current?.text.trim()) {
      observations.push({ ...current, text: current.text.trim() });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const observation = line.match(/^\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?\]\s+(.+)$/);
    if (observation) {
      flushCurrent();
      current = {
        text: observation[3].trim(),
        type: "explicit_observation",
        occurredAt: observation[2] ? `${observation[1]} ${observation[2]}` : observation[1],
      };
      continue;
    }

    if (current) {
      current = {
        ...current,
        text: `${current.text} ${line.replace(/^\s*[-*]\s*/, "").trim()}`.trim(),
      };
    }
  }

  flushCurrent();
  return observations;
}

function parseInductiveObservationSection(lines: string[]): MemoryContextResult[] {
  return lines.flatMap((rawLine): MemoryContextResult[] => {
    const line = rawLine.trim();
    const pattern = line.match(/^\*\*Pattern\*\*(?:\s+\[[^\]]+\])?:\s+(.+)$/i);
    const text = pattern?.[1]?.trim();
    return text ? [{ text, type: "inductive_observation", occurredAt: null }] : [];
  });
}

function normalizeSearchResult(message: HonchoMessageLike): HonchoSearchResult | null {
  const id = toStringOrNull(message.id);
  if (!id) {
    return null;
  }

  const content = toStringOrNull(message.content);
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};

  return {
    documentId: id,
    title: null,
    summary: content,
    content,
    score: null,
    createdAt: toStringOrNull(message.createdAt),
    updatedAt: null,
    metadata: {
      ...metadata,
      peerId: message.peerId,
      sessionId: message.sessionId,
      workspaceId: message.workspaceId,
      tokenCount: toNumberOrNull(message.tokenCount),
    },
    chunks: content ? [{ content, score: null, isRelevant: true }] : [],
  };
}

function normalizeContextResult(message: HonchoMessageLike): MemoryContextResult | null {
  const result = normalizeSearchResult(message);
  const text = result?.content?.trim() ?? result?.summary?.trim();
  if (!result || !text) {
    return null;
  }

  return {
    text,
    type: typeof result.metadata["sourceType"] === "string"
      ? result.metadata["sourceType"]
      : typeof result.metadata["kind"] === "string"
        ? result.metadata["kind"]
        : null,
    occurredAt: result.createdAt,
  };
}

function getReflectReasoningLevel(budget: MemoryReflectBudget | undefined): HonchoReasoningLevel {
  switch (budget) {
    case "low":
      return "low";
    case "high":
      return "high";
    case "mid":
    default:
      return "medium";
  }
}

export class HonchoClient implements MemoryClient {
  readonly provider = "honcho";

  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly workspacePrefix: string;
  private readonly timeoutMs: number;
  private readonly sdkClientFactory?: (workspaceId: string) => HonchoSdkClient;
  private readonly clients = new Map<string, HonchoSdkClient>();
  private readonly configuredWorkspaces = new Set<string>();
  private readonly configuringWorkspaces = new Map<string, Promise<void>>();

  constructor(options: HonchoClientOptions);
  constructor(options: HonchoClientInternalOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.workspacePrefix = normalizeWorkspacePrefix(options.workspacePrefix);
    this.timeoutMs = options.timeoutMs ?? defaultHonchoTimeoutMs;
    this.sdkClientFactory = options.sdkClientFactory;
  }

  getUserWorkspaceId(user: Pick<UserContext, "tenantId" | "userId">): string {
    return buildStableId(this.workspacePrefix, ["user", user.tenantId, user.userId]);
  }

  getPatternPeerId(patternId: string): string {
    return `pattern_${buildStablePart(patternId, 72)}`.slice(0, 100);
  }

  buildHotPathTurnCustomId(messageId: string): string {
    return `hot-path-turn_${buildStablePart(messageId, 72)}`.slice(0, 100);
  }

  buildPatternRunCustomId(patternRunId: string): string {
    return `pattern-run_${buildStablePart(patternRunId, 72)}`.slice(0, 100);
  }

  async addDocument(input: HonchoAddDocumentInput): Promise<MemoryAddDocumentResponse | null> {
    try {
      const scope = this.resolveDocumentScope(input);
      const client = this.getClient(input.user);
      await this.ensureWorkspaceConfigured(input.user, client);
      const peers = await this.ensureScopePeers(input.user, client, scope);
      const session = await client.session(scope.sessionId, {
        metadata: scope.sessionMetadata,
        configuration: this.buildSessionConfiguration(scope.instructions),
        peers: peers.sessionPeers,
      });

      const messages = input.conversationMessages?.length
        ? input.conversationMessages.flatMap((message, index) => {
            const content = formatConversationMessage(message);
            if (!content) {
              return [];
            }
            const peer = message.role === "assistant" ? peers.finnPeer : peers.targetPeer;
            return [peer.message(content, {
              metadata: buildHonchoMetadata(input, {
                role: message.role,
                sequence: index,
                ...(message.messageId ? { messageId: message.messageId } : {}),
                ...(typeof message.delivered === "boolean" ? { delivered: message.delivered } : {}),
              }),
              configuration: { reasoning: { enabled: message.role === "assistant" ? false : true } },
              createdAt: message.timestamp,
            })];
          })
        : [peers.targetPeer.message(input.content, {
            metadata: buildHonchoMetadata(input),
            configuration: { reasoning: { enabled: true } },
            createdAt: getMessageTimestamp(input),
          })];

      if (messages.length === 0) {
        return { id: input.customId, status: "skipped_empty" };
      }

      const createdMessages = await session.addMessages(messages);
      return {
        id: createdMessages[0]?.id ?? input.customId,
        status: "queued",
      };
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
        failureReason: getSafeMemoryFailureReason(error),
      }, "Memory retain failed");
      return null;
    }
  }

  async searchDocuments(input: HonchoSearchInput): Promise<HonchoSearchResponse> {
    try {
      const client = this.getClient(input.user);
      await this.ensureWorkspaceConfigured(input.user, client);
      const limit = Math.max(1, Math.min(input.limit ?? 5, maxHonchoResults));
      const response = await client.search(input.query, {
        filters: buildHonchoFilters(input.metadata),
        limit,
      });

      return {
        ok: true,
        results: response
          .map(normalizeSearchResult)
          .filter((result): result is HonchoSearchResult => Boolean(result))
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
        failureReason: getSafeMemoryFailureReason(error),
      }, "Memory search failed");
      return { ok: false, results: [], error: "memory search is unavailable right now" };
    }
  }

  async buildContext(input: HonchoSearchInput): Promise<MemoryContextResponse> {
    try {
      const client = this.getClient(input.user);
      await this.ensureWorkspaceConfigured(input.user, client);
      const scope = this.resolveSearchScope(input);
      const peers = await this.ensureScopePeers(input.user, client, scope);
      const limit = Math.max(1, Math.min(input.limit ?? 5, maxHonchoResults));
      const context = await peers.finnPeer.context({
        target: scope.targetPeerId,
        searchQuery: input.query,
        searchTopK: limit,
        includeMostFrequent: false,
        maxConclusions: Math.max(8, limit * 2),
      });

      const representation = context.representation?.trim();
      if (representation) {
        const observations = parseHonchoRepresentationContext(representation, limit);
        if (observations.length > 0) {
          return { ok: true, results: observations };
        }

        return {
          ok: true,
          results: [{
            text: representation,
            type: scope.kind === "pattern" ? "pattern_representation" : "user_representation",
            occurredAt: null,
          }],
        };
      }

      const fallback = await client.search(input.query, {
        filters: buildHonchoFilters({}, scope.kind === "user" ? [userPeerId, finnPeerId] : [scope.targetPeerId, finnPeerId]),
        limit,
      });
      return {
        ok: true,
        results: fallback
          .map(normalizeContextResult)
          .filter((result): result is MemoryContextResult => Boolean(result))
          .slice(0, limit),
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "search_memory",
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
      }, "Memory context recall failed");
      return { ok: false, results: [], error: "memory context is unavailable right now" };
    }
  }

  async buildProfileContext(input: MemoryProfileContextInput): Promise<MemoryProfileContextResponse> {
    try {
      const client = this.getClient(input.user);
      await this.ensureWorkspaceConfigured(input.user, client);
      const peers = await this.ensureScopePeers(input.user, client, this.buildUserScope(input.user, "profile_seed"));
      const context = await peers.finnPeer.context({
        target: userPeerId,
        includeMostFrequent: true,
        maxConclusions: 30,
      });

      return {
        ok: true,
        profile: {
          static: normalizeStringList(context.peerCard, 12),
          dynamic: normalizeProfileLines(context.representation, 12),
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
        failureReason: getSafeMemoryFailureReason(error),
      }, "Memory profile context failed");
      return { ok: false, profile: null, error: "memory profile is unavailable right now" };
    }
  }

  async reflectMemory(input: MemoryReflectInput): Promise<MemoryReflectResponse> {
    try {
      const client = this.getClient(input.user);
      await this.ensureWorkspaceConfigured(input.user, client);
      const scope = this.resolveSearchScope(input);
      const peers = await this.ensureScopePeers(input.user, client, scope);
      const answer = await peers.finnPeer.chat(input.query, {
        target: scope.targetPeerId,
        reasoningLevel: getReflectReasoningLevel(input.budget),
      });

      return {
        ok: true,
        answer: answer?.trim() ?? "",
        evidence: null,
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "reflect_memory",
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
      }, "Memory reflect failed");
      return { ok: false, answer: null, evidence: null, error: "memory reflection is unavailable right now" };
    }
  }

  async provisionUserBank(user: Pick<UserContext, "tenantId" | "userId">): Promise<void> {
    try {
      const client = this.getClient(user);
      await this.ensureWorkspaceConfigured(user, client);
      await this.ensureScopePeers(user, client, this.buildUserScope(user, "profile_seed"));
    } catch (error) {
      logger.warn({
        workspaceId: this.getUserWorkspaceId(user),
        failureReason: getSafeMemoryFailureReason(error),
      }, "Honcho user workspace provisioning failed");
    }
  }

  private getClient(user: Pick<UserContext, "tenantId" | "userId">): HonchoSdkClient {
    const workspaceId = this.getUserWorkspaceId(user);
    const existing = this.clients.get(workspaceId);
    if (existing) {
      return existing;
    }

    const client = this.sdkClientFactory?.(workspaceId) ?? this.createSdkClient(workspaceId);
    this.clients.set(workspaceId, client);
    return client;
  }

  private createSdkClient(workspaceId: string): HonchoSdkClient {
    const options: {
      apiKey?: string;
      baseURL?: string;
      workspaceId: string;
      timeout: number;
      maxRetries: number;
    } = {
      workspaceId,
      timeout: this.timeoutMs,
      maxRetries: 0,
    };
    if (this.apiKey) {
      options.apiKey = this.apiKey;
    }
    if (this.baseUrl) {
      options.baseURL = this.baseUrl;
    }
    return new Honcho(options);
  }

  private async ensureWorkspaceConfigured(user: Pick<UserContext, "tenantId" | "userId">, client: HonchoSdkClient): Promise<void> {
    const workspaceId = this.getUserWorkspaceId(user);
    if (this.configuredWorkspaces.has(workspaceId)) {
      return;
    }

    const existing = this.configuringWorkspaces.get(workspaceId);
    if (existing) {
      await existing;
      return;
    }

    const configurePromise = this.configureWorkspace(user, client)
      .then(() => {
        this.configuredWorkspaces.add(workspaceId);
      })
      .finally(() => {
        this.configuringWorkspaces.delete(workspaceId);
      });
    this.configuringWorkspaces.set(workspaceId, configurePromise);
    await configurePromise;
  }

  private async configureWorkspace(user: Pick<UserContext, "tenantId" | "userId">, client: HonchoSdkClient): Promise<void> {
    await client.setMetadata?.({
      tenantId: user.tenantId,
      userId: user.userId,
      provider: "finn",
      scope: "user_runtime",
    });
    await client.setConfiguration?.({
      reasoning: { enabled: true },
      peerCard: { use: true, create: true },
      summary: { enabled: true, messagesPerShortSummary: 30, messagesPerLongSummary: 120 },
      dream: { enabled: true },
    });
  }

  private async ensureScopePeers(
    user: Pick<UserContext, "tenantId" | "userId">,
    client: HonchoSdkClient,
    scope: HonchoScope,
  ): Promise<HonchoScopePeers> {
    const [targetPeer, finnPeer] = await Promise.all([
      client.peer(scope.targetPeerId, {
        metadata: {
          tenantId: user.tenantId,
          userId: user.userId,
          role: scope.kind,
        },
        configuration: { observeMe: true },
      }),
      client.peer(finnPeerId, {
        metadata: {
          tenantId: user.tenantId,
          userId: user.userId,
          role: "assistant",
        },
        configuration: { observeMe: false },
      }),
    ]);

    return {
      targetPeer,
      finnPeer,
      sessionPeers: [
        [scope.targetPeerId, { observeMe: true, observeOthers: false }],
        [finnPeerId, { observeMe: false, observeOthers: true }],
      ],
    };
  }

  private buildSessionConfiguration(instructions: string): SessionConfig {
    return {
      reasoning: { enabled: true, customInstructions: instructions },
      peerCard: { use: true, create: true },
      summary: { enabled: true, messagesPerShortSummary: 30, messagesPerLongSummary: 120 },
      dream: { enabled: true },
    };
  }

  private resolveDocumentScope(input: HonchoAddDocumentInput): HonchoScope {
    const kind = toStringOrNull(input.metadata["kind"]);
    if (kind === "pattern_run_outcome") {
      const patternId = toStringOrNull(input.metadata["patternId"]);
      if (!patternId) {
        throw new Error("Honcho Pattern memory requires patternId metadata.");
      }
      return {
        kind: "pattern",
        targetPeerId: this.getPatternPeerId(patternId),
        sessionId: buildStableId("pattern", [patternId]),
        instructions: patternReasoningInstructions,
        sessionMetadata: {
          tenantId: input.user.tenantId,
          userId: input.user.userId,
          kind: "pattern_run_outcome",
          patternId,
        },
      };
    }

    if (kind === "activity_feed_event") {
      return {
        kind: "operational",
        targetPeerId: operationalPeerId,
        sessionId: buildStableId("activity", [
          toStringOrNull(input.metadata["entityType"]) ?? "general",
          toStringOrNull(input.metadata["entityId"]) ?? "general",
        ]),
        instructions: operationalReasoningInstructions,
        sessionMetadata: {
          tenantId: input.user.tenantId,
          userId: input.user.userId,
          kind: "activity_feed_event",
          ...(toStringOrNull(input.metadata["entityType"]) ? { entityType: input.metadata["entityType"] } : {}),
          ...(toStringOrNull(input.metadata["entityId"]) ? { entityId: input.metadata["entityId"] } : {}),
        },
      };
    }

    return this.buildUserScope(input.user, this.resolveUserSessionId(input));
  }

  private resolveSearchScope(input: Pick<MemorySearchInput, "user" | "metadata">): HonchoScope {
    const kind = toStringOrNull(input.metadata["kind"]);
    if (kind === "pattern_run_outcome") {
      const patternId = toStringOrNull(input.metadata["patternId"]);
      if (!patternId) {
        throw new Error("Honcho Pattern memory search requires patternId metadata.");
      }
      return {
        kind: "pattern",
        targetPeerId: this.getPatternPeerId(patternId),
        sessionId: buildStableId("pattern", [patternId]),
        instructions: patternReasoningInstructions,
        sessionMetadata: {
          tenantId: input.user.tenantId,
          userId: input.user.userId,
          kind: "pattern_run_outcome",
          patternId,
        },
      };
    }

    return this.buildUserScope(input.user, "profile_seed");
  }

  private buildUserScope(user: Pick<UserContext, "tenantId" | "userId">, sessionId: string): HonchoScope {
    return {
      kind: "user",
      targetPeerId: userPeerId,
      sessionId,
      instructions: userReasoningInstructions,
      sessionMetadata: {
        tenantId: user.tenantId,
        userId: user.userId,
        kind: "user_memory",
      },
    };
  }

  private resolveUserSessionId(input: HonchoAddDocumentInput): string {
    const kind = toStringOrNull(input.metadata["kind"]) ?? "memory";
    if (kind === "hot_path_turn") {
      return buildStableId("hot_path", [
        toStringOrNull(input.metadata["conversationId"]) ?? "conversation",
        getScopeTimestampSuffix(input) ?? "ongoing",
      ]);
    }

    if (kind === "personal_intelligence_source") {
      return buildStableId("pi", [
        input.source?.provider ?? toStringOrNull(input.metadata["sourceProvider"]) ?? "source",
        input.source?.type ?? toStringOrNull(input.metadata["sourceType"]) ?? "item",
        toStringOrNull(input.metadata["accountScopeId"]) ?? toStringOrNull(input.metadata["connectedAccountId"]) ?? "account",
      ]);
    }

    if (kind === "user_profile_seed") {
      return "profile_seed";
    }

    return buildStableId("memory", [
      kind,
      toStringOrNull(input.metadata["source"]) ?? input.source?.provider ?? "source",
      input.customId,
    ]);
  }
}
