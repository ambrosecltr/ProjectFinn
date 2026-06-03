import type { ActivityFeedEvent, PatternNotifyOutcome, PatternRecord, PatternRunRecord, UserContext, UserMessage, WorkerResult } from "@finn/core";

export type MemoryMetadataValue = string | number | boolean | string[];

export type MemoryMetadata = Record<string, MemoryMetadataValue>;

export type MemoryFactType = "world" | "experience" | "observation";

export type MemoryOperationKind =
  | "retain_hot_path_turn"
  | "retain_activity_feed_event"
  | "retain_pattern_run_outcome"
  | "retain_personal_intelligence_item"
  | "retain_user_profile_seed"
  | "build_profile_context"
  | "reflect_memory"
  | "search_memory"
  | "backfill_retain";

export interface MemoryObservabilityContext {
  operation: MemoryOperationKind;
  activityEventId?: string;
  messageId?: string;
  conversationId?: string;
  patternId?: string;
  patternRunId?: string;
}

export interface MemorySearchResult {
  documentId: string;
  title: string | null;
  summary: string | null;
  content: string | null;
  score: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
  chunks: Array<{
    content: string;
    score: number | null;
    isRelevant: boolean | null;
  }>;
}

export interface MemoryContextResult {
  text: string;
  type?: string | null;
  occurredAt?: string | null;
}

export interface MemoryConversationAttachment {
  filename: string;
  mimeType: string;
  context?: string;
}

export interface MemoryConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  messageId?: string;
  delivered?: boolean;
  attachments?: MemoryConversationAttachment[];
}

export interface MemoryStructuredSource {
  provider: string;
  type: string;
  id: string;
  title?: string;
  url?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export type MemorySearchResponse =
  | { ok: true; results: MemorySearchResult[] }
  | { ok: false; results: []; error: string };

export type MemoryContextResponse =
  | { ok: true; results: MemoryContextResult[] }
  | { ok: false; results: []; error: string };

export interface MemoryProfileContext {
  static: string[];
  dynamic: string[];
}

export type MemoryProfileContextResponse =
  | { ok: true; profile: MemoryProfileContext }
  | { ok: false; profile: null; error: string };

export type MemoryReflectBudget = "low" | "mid" | "high";

export interface MemoryReflectEvidence {
  memories: Array<{
    id: string | null;
    text: string;
    type: string | null;
    context: string | null;
    occurredStart: string | null;
    occurredEnd: string | null;
  }>;
  mentalModels: Array<{
    id: string;
    text: string;
    context: string | null;
  }>;
  directives: Array<{
    id: string;
    name: string;
    content: string;
  }>;
}

export type MemoryReflectResponse =
  | { ok: true; answer: string; evidence: MemoryReflectEvidence | null }
  | { ok: false; answer: null; evidence: null; error: string };

export interface MemoryAddDocumentInput {
  user: Pick<UserContext, "tenantId" | "userId">;
  customId: string;
  content: string;
  conversationMessages?: MemoryConversationMessage[];
  source?: MemoryStructuredSource;
  metadata: MemoryMetadata;
  observability?: MemoryObservabilityContext;
}

export interface MemorySearchInput {
  user: Pick<UserContext, "tenantId" | "userId">;
  query: string;
  limit?: number;
  types?: MemoryFactType[];
  queryTimestamp?: string;
  metadata: MemoryMetadata;
  observability?: MemoryObservabilityContext;
}

export interface MemoryProfileContextInput {
  user: Pick<UserContext, "tenantId" | "userId">;
  observability?: MemoryObservabilityContext;
}

export interface MemoryReflectInput {
  user: Pick<UserContext, "tenantId" | "userId">;
  query: string;
  budget?: MemoryReflectBudget;
  maxTokens?: number;
  metadata: MemoryMetadata;
  observability?: MemoryObservabilityContext;
}

export interface MemoryAddDocumentResponse {
  id: string;
  status: string;
}

export interface MemoryClient {
  readonly provider: string;
  addDocument(input: MemoryAddDocumentInput): Promise<MemoryAddDocumentResponse | null>;
  searchDocuments(input: MemorySearchInput): Promise<MemorySearchResponse>;
  buildContext?(input: MemorySearchInput): Promise<MemoryContextResponse>;
  buildProfileContext?(input: MemoryProfileContextInput): Promise<MemoryProfileContextResponse>;
  provisionUserBank?(user: Pick<UserContext, "tenantId" | "userId">): Promise<void>;
  reflectMemory?(input: MemoryReflectInput): Promise<MemoryReflectResponse>;
  buildHotPathTurnCustomId(messageId: string): string;
  buildPatternRunCustomId(patternRunId: string): string;
}

export type MemoryRecorderUser = Pick<UserContext, "tenantId" | "userId" | "timezone">;

export interface HotPathTurnMemoryDocument {
  kind: "hot_path_turn";
  messageId: string;
  content: string;
  conversationMessages: MemoryConversationMessage[];
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

export interface HotPathAssistantMemoryDocument {
  kind: "hot_path_turn";
  messageId: string;
  content: string;
  conversationMessages: MemoryConversationMessage[];
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

export interface PatternRunOutcomeMemoryDocument {
  kind: "pattern_run_outcome";
  patternRunId: string;
  content: string;
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

export interface PersonalIntelligenceMemoryDocument {
  kind: "personal_intelligence_source";
  sourceId: string;
  accountScopeId: string;
  content: string;
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

export interface ActivityFeedMemoryDocument {
  kind: "activity_feed_event";
  eventId: string;
  content: string;
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

export const USER_PROFILE_SEED_CUSTOM_ID = "user-profile-seed";

export type UserProfileSeedUser = Pick<UserContext, "tenantId" | "userId" | "displayName" | "timezone" | "timezoneSource" | "location">;

export interface UserProfileSeedMemoryDocument {
  kind: "user_profile_seed";
  content: string;
  source: MemoryStructuredSource;
  metadata: MemoryMetadata;
}

function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getUserMessageParts(message: UserMessage) {
  return message.parts ?? [{
    content: message.content,
    attachments: message.attachments,
    messageId: message.messageId,
    timestamp: message.timestamp,
  }];
}

function buildUserConversationMessage(part: ReturnType<typeof getUserMessageParts>[number]): MemoryConversationMessage {
  const attachments = (part.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    ...(attachment.contextText ? { context: attachment.contextText } : {}),
  }));

  return {
    role: "user",
    content: part.content.trim(),
    timestamp: part.timestamp.toISOString(),
    messageId: part.messageId,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function sanitizeAssistantMemoryContent(content: string): string {
  return content
    .split(/\n\s*\n/)
    .map((block) => block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !/^\[handle:[^\]]+\]$/.test(line))
      .filter((line) => !/^\[reply to handle:[^\]]+\]$/.test(line))
      .map((line) => line.replace(/\s+\|\s+target_handle: [^\]]+(?=\])/, ""))
      .join("\n")
      .trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function buildAssistantConversationMessage(content: string, delivered: boolean): MemoryConversationMessage {
  const sanitizedContent = sanitizeAssistantMemoryContent(content);

  return {
    role: "assistant",
    content: delivered ? sanitizedContent : "",
    delivered: delivered && sanitizedContent.length > 0,
  };
}

function formatAssistantContent(content: string): string {
  const sanitized = sanitizeAssistantMemoryContent(content);
  return sanitized.length > 0 ? sanitized : "[no visible assistant response]";
}

function formatUserPart(part: ReturnType<typeof getUserMessageParts>[number]): string {
  const lines = [
    `[user | ${part.timestamp.toISOString()} | message:${part.messageId}]`,
    part.content.trim(),
  ].filter((line) => line.length > 0);

  for (const attachment of part.attachments ?? []) {
    lines.push([
      `[attachment | message:${part.messageId}]`,
      `filename: ${attachment.filename}`,
      `mime type: ${attachment.mimeType}`,
      attachment.contextText ? `context: ${attachment.contextText}` : null,
    ].filter((line): line is string => Boolean(line)).join("\n"));
  }

  return lines.join("\n");
}

function serializeData(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim().length > 0 ? value.trim() : null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getMetadataValue(metadata: MemoryMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function getSafeMemoryFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (error instanceof AggregateError) {
    const reasons = error.errors
      .map(getSafeMemoryFailureReason)
      .filter((reason) => reason !== "unknown");
    if (reasons.length > 0) {
      return reasons.join("; ");
    }
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "unknown";
}

export function getDefaultMemoryOperation(metadata: MemoryMetadata, mode: "retain" | "search"): MemoryOperationKind {
  const kind = getMetadataValue(metadata, "kind");
  if (mode === "retain") {
    if (kind === "activity_feed_event") {
      return "retain_activity_feed_event";
    }
    return kind === "pattern_run_outcome" ? "retain_pattern_run_outcome" : "retain_hot_path_turn";
  }

  return "search_memory";
}

export function getMemoryLogContext(input: {
  provider: string;
  operation: MemoryOperationKind;
  user: Pick<UserContext, "tenantId" | "userId">;
  metadata?: MemoryMetadata;
  observability?: MemoryObservabilityContext;
  customId?: string;
}): Record<string, unknown> {
  return {
    provider: input.provider,
    operation: input.operation,
    kind: getMetadataValue(input.metadata, "kind"),
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    customId: input.customId,
    activityEventId: input.observability?.activityEventId ?? getMetadataValue(input.metadata, "activityEventId"),
    messageId: input.observability?.messageId ?? getMetadataValue(input.metadata, "messageId"),
    conversationId: input.observability?.conversationId ?? getMetadataValue(input.metadata, "conversationId"),
    patternId: input.observability?.patternId ?? getMetadataValue(input.metadata, "patternId"),
    patternRunId: input.observability?.patternRunId ?? getMetadataValue(input.metadata, "patternRunId"),
  };
}

function formatActivityFeedContent(event: ActivityFeedEvent): string {
  const currentStatus = event.action === "deleted"
    ? "deleted"
    : event.action === "paused"
      ? "paused"
      : event.action === "resumed"
        ? "active"
        : event.details.active ? "active" : "paused";

  return [
    "[Pattern lifecycle event]",
    `summary: ${event.summary}`,
    `event_id: ${event.eventId}`,
    `occurred_at: ${event.occurredAt}`,
    `origin: ${event.origin}`,
    `entity_type: ${event.entityType}`,
    `pattern_id: ${event.details.patternId}`,
    `pattern_name: ${event.details.patternName}`,
    `lifecycle_action: ${event.action}`,
    `resulting_pattern_status: ${currentStatus}`,
    `worker_type: ${event.details.workerType}`,
    `trigger_type: ${event.details.triggerType}`,
    `next_run_at: ${event.details.nextRunAt ?? "none"}`,
    event.details.userDescription ? `user_description: ${event.details.userDescription}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function isSameSerializedValue(left: unknown, right: unknown): boolean {
  return serializeData(left) === serializeData(right);
}

function formatPatternOutcomeContent(input: {
  pattern: PatternRecord;
  run: PatternRunRecord;
  result: WorkerResult;
  notifyOutcome: PatternNotifyOutcome;
}): string {
  const resultData = serializeData(input.result.data);
  const notifyData = isSameSerializedValue(input.result.data, input.notifyOutcome.data)
    ? null
    : serializeData(input.notifyOutcome.data);

  return [
    `Pattern: ${input.pattern.name}`,
    `Pattern ID: ${input.pattern.id}`,
    `Pattern run ID: ${input.run.id}`,
    `Triggered by: ${input.run.triggeredBy}`,
    `Completed at: ${(input.run.completedAt ?? new Date()).toISOString()}`,
    `Worker summary: ${input.result.summary}`,
    resultData ? `Worker data: ${resultData}` : null,
    `Notify: ${input.notifyOutcome.notify}`,
    `Notify summary: ${input.notifyOutcome.summary}`,
    input.notifyOutcome.reason ? `Notify reason: ${input.notifyOutcome.reason}` : null,
    notifyData ? `Notify data: ${notifyData}` : null,
    input.run.surfacedAt ? `Surfaced at: ${input.run.surfacedAt.toISOString()}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function sanitizePersonalIntelligenceMetadata(metadata?: Record<string, unknown>): MemoryMetadata {
  const sanitized: MemoryMetadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function formatPersonalIntelligenceProvenance(input: {
  accountScopeId: string;
  connectedAccountId: string;
  messageId?: string | null;
  threadId?: string | null;
  eventId?: string | null;
  senderEmail?: string | null;
  recipientEmails?: string[];
  attendeeEmails?: string[];
  sourceUrl?: string | null;
}): string[] {
  return [
    `PI account scope ID: ${input.accountScopeId}`,
    `Connected account ID: ${input.connectedAccountId}`,
    input.messageId ? `Message ID: ${input.messageId}` : null,
    input.threadId ? `Thread ID: ${input.threadId}` : null,
    input.eventId ? `Event ID: ${input.eventId}` : null,
    input.senderEmail ? `Sender: ${input.senderEmail}` : null,
    input.recipientEmails?.length ? `Recipients: ${input.recipientEmails.join(", ")}` : null,
    input.attendeeEmails?.length ? `Attendees: ${input.attendeeEmails.join(", ")}` : null,
    input.sourceUrl ? `Source URL: ${input.sourceUrl}` : null,
  ].filter((line): line is string => line !== null);
}

export function buildHotPathTurnMemoryDocument(input: {
  user: MemoryRecorderUser;
  message: UserMessage;
  conversationId: string;
  deliveredAssistantText: string;
}): HotPathTurnMemoryDocument | null {
  const parts = getUserMessageParts(input.message);
  const assistantContent = formatAssistantContent(input.deliveredAssistantText);
  const delivered = assistantContent !== "[no visible assistant response]";
  const content = [
    ...parts.map(formatUserPart),
    `[assistant | delivered]\n${assistantContent}`,
  ].join("\n\n");
  const conversationMessages = [
    ...parts.map(buildUserConversationMessage),
    buildAssistantConversationMessage(input.deliveredAssistantText, delivered),
  ];
  const metadata: MemoryMetadata = {
    kind: "hot_path_turn",
    source: "hot_path",
    process: "hot-path",
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    messageId: input.message.messageId,
    conversationId: input.conversationId,
    day: formatDay(input.message.timestamp, input.user.timezone),
    timestamp: input.message.timestamp.toISOString(),
    delivered,
  };

  return {
    kind: "hot_path_turn",
    messageId: input.message.messageId,
    content,
    conversationMessages,
    source: {
      provider: "finn",
      type: "imessage_turn",
      id: input.message.messageId,
      timestamp: input.message.timestamp.toISOString(),
      metadata: {
        conversationId: input.conversationId,
        partCount: parts.length,
        delivered,
      },
    },
    metadata,
  };
}

export function buildUserProfileSeedMemoryDocument(input: {
  user: UserProfileSeedUser;
  timestamp?: Date;
}): UserProfileSeedMemoryDocument | null {
  const displayName = input.user.displayName?.trim();
  const location = input.user.location?.trim();
  const timezone = input.user.timezone.trim();
  const hasTimezone = (input.user.timezoneSource === "manual" || input.user.timezoneSource === "browser") && timezone.length > 0;
  if (!displayName && !location && !hasTimezone) {
    return null;
  }

  const timestamp = (input.timestamp ?? new Date()).toISOString();
  const hasDisplayName = Boolean(displayName);
  const hasLocation = Boolean(location);
  const metadata: MemoryMetadata = {
    kind: "user_profile_seed",
    source: "finn_core_profile",
    process: "profile_sync",
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    seedVersion: 1,
    hasDisplayName,
    hasLocation,
    hasTimezone,
    timezoneSource: input.user.timezoneSource,
    timestamp,
  };

  return {
    kind: "user_profile_seed",
    content: [
      "Finn core profile snapshot",
      "",
      "This is Finn's authoritative current operational profile for the user.",
      "Extract only explicit fields as current facts. Do not infer missing values.",
      "",
      displayName ? `Name: ${displayName}` : null,
      location ? `Home/base location: ${location}` : null,
      hasTimezone ? `Timezone: ${timezone}` : null,
      hasTimezone ? `Timezone source: ${input.user.timezoneSource}` : null,
    ].filter((line): line is string => line !== null).join("\n"),
    source: {
      provider: "finn",
      type: "user_profile_seed",
      id: "core_profile",
      title: "Finn core profile snapshot",
      timestamp,
      metadata: {
        hasDisplayName,
        hasLocation,
        hasTimezone,
        timezoneSource: input.user.timezoneSource,
      },
    },
    metadata,
  };
}

export function buildHotPathAssistantMemoryDocument(input: {
  user: MemoryRecorderUser;
  source: "worker" | "trigger";
  sourceMessageId: string;
  conversationId: string;
  deliveredAssistantText: string;
  timestamp: Date;
}): HotPathAssistantMemoryDocument | null {
  const assistantContent = sanitizeAssistantMemoryContent(input.deliveredAssistantText);
  if (assistantContent.length === 0) {
    return null;
  }

  const metadata: MemoryMetadata = {
    kind: "hot_path_turn",
    source: "hot_path",
    process: "hot-path",
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    messageId: input.sourceMessageId,
    conversationId: input.conversationId,
    day: formatDay(input.timestamp, input.user.timezone),
    timestamp: input.timestamp.toISOString(),
    delivered: true,
    inboundSource: input.source,
  };

  return {
    kind: "hot_path_turn",
    messageId: input.sourceMessageId,
    content: `[assistant | delivered | source:${input.source}]\n${assistantContent}`,
    conversationMessages: [buildAssistantConversationMessage(input.deliveredAssistantText, true)],
    source: {
      provider: "finn",
      type: `${input.source}_assistant_delivery`,
      id: input.sourceMessageId,
      timestamp: input.timestamp.toISOString(),
      metadata: {
        conversationId: input.conversationId,
        inboundSource: input.source,
      },
    },
    metadata,
  };
}

export function buildPatternRunOutcomeMemoryDocument(input: {
  user: MemoryRecorderUser;
  pattern: PatternRecord;
  run: PatternRunRecord;
  result: WorkerResult;
  notifyOutcome: PatternNotifyOutcome;
}): PatternRunOutcomeMemoryDocument | null {
  if (input.pattern.workerType === "reminder") {
    return null;
  }

  if (input.pattern.triggerConfig.type === "schedule"
    && (input.pattern.triggerConfig.schedule.kind === "once" || (input.pattern.triggerConfig.schedule.kind === "internal_cron" && input.pattern.triggerConfig.schedule.oneShot))) {
    return null;
  }

  const completedAt = input.run.completedAt ?? new Date();
  const metadata: MemoryMetadata = {
    kind: "pattern_run_outcome",
    source: "pattern_worker",
    process: "worker",
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    patternId: input.pattern.id,
    patternRunId: input.run.id,
    triggeredBy: input.run.triggeredBy,
    oneShot: false,
    notified: input.notifyOutcome.notify,
    surfaced: Boolean(input.run.surfacedAt),
    day: formatDay(completedAt, input.pattern.timezone),
    completedAt: completedAt.toISOString(),
    ...(input.run.workerId ? { workerId: input.run.workerId } : {}),
  };

  return {
    kind: "pattern_run_outcome",
    patternRunId: input.run.id,
    content: formatPatternOutcomeContent(input),
    source: {
      provider: "finn",
      type: "pattern_run_outcome",
      id: input.run.id,
      title: input.pattern.name,
      timestamp: completedAt.toISOString(),
      metadata: {
        patternId: input.pattern.id,
        triggeredBy: input.run.triggeredBy,
        notified: input.notifyOutcome.notify,
        surfaced: Boolean(input.run.surfacedAt),
      },
    },
    metadata,
  };
}

export function buildActivityFeedMemoryDocument(input: {
  user: MemoryRecorderUser;
  event: ActivityFeedEvent;
}): ActivityFeedMemoryDocument | null {
  const event = input.event;
  if (event.tenantId !== input.user.tenantId || event.userId !== input.user.userId) {
    return null;
  }

  const metadata: MemoryMetadata = {
    kind: "activity_feed_event",
    source: "finn_activity_feed",
    sourceType: "pattern_activity_timeline",
    process: "activity_feed",
    tenantId: event.tenantId,
    userId: event.userId,
    entityType: event.entityType,
    entityId: event.details.patternId,
    patternId: event.details.patternId,
  };

  return {
    kind: "activity_feed_event",
    eventId: event.eventId,
    content: formatActivityFeedContent(event),
    source: {
      provider: "finn_activity_feed",
      type: "activity_feed_event",
      id: event.eventId,
      title: event.summary,
      timestamp: event.occurredAt,
      metadata: {
        origin: event.origin,
        entityType: event.entityType,
        action: event.action,
        patternId: event.details.patternId,
      },
    },
    metadata,
  };
}

export function buildPersonalIntelligenceMemoryDocument(input: {
  user: MemoryRecorderUser;
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  sourceType: string;
  sourceId: string;
  messageId?: string | null;
  threadId?: string | null;
  eventId?: string | null;
  senderEmail?: string | null;
  recipientEmails?: string[];
  attendeeEmails?: string[];
  sourceUrl?: string | null;
  title?: string | null;
  timestamp?: string | null;
  content: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): PersonalIntelligenceMemoryDocument | null {
  const content = input.content.trim();
  const reason = input.reason.trim();
  const sourceId = input.sourceId.trim();
  const toolkitSlug = input.toolkitSlug.trim();
  const sourceType = input.sourceType.trim();
  const accountScopeId = input.accountScopeId?.trim();
  if (!content || !reason || !sourceId || !toolkitSlug || !sourceType || !accountScopeId) {
    return null;
  }

  const timestamp = input.timestamp?.trim() || new Date().toISOString();
  const inputMetadata = sanitizePersonalIntelligenceMetadata(input.metadata);
  const metadata: MemoryMetadata = {
    ...inputMetadata,
    kind: "personal_intelligence_source",
    source: toolkitSlug,
    process: "personal_intelligence",
    tenantId: input.user.tenantId,
    userId: input.user.userId,
    sourceType,
    sourceId,
    accountScopeId,
    connectedAccountId: input.connectedAccountId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}),
    ...(input.recipientEmails?.length ? { recipientEmails: input.recipientEmails } : {}),
    ...(input.attendeeEmails?.length ? { attendeeEmails: input.attendeeEmails } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    reason,
    timestamp,
    day: formatDay(new Date(timestamp), input.user.timezone),
  };

  return {
    kind: "personal_intelligence_source",
    sourceId,
    accountScopeId,
    content: [
      `Source: ${toolkitSlug}/${sourceType}`,
      `Source ID: ${sourceId}`,
      ...formatPersonalIntelligenceProvenance(input),
      input.title?.trim() ? `Title: ${input.title.trim()}` : null,
      `Timestamp: ${timestamp}`,
      `Why this matters: ${reason}`,
      "",
      content,
    ].filter((line): line is string => line !== null).join("\n"),
    source: {
      provider: toolkitSlug,
      type: sourceType,
      id: sourceId,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
      timestamp,
      metadata: {
        ...inputMetadata,
        accountScopeId,
        connectedAccountId: input.connectedAccountId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}),
        ...(input.recipientEmails?.length ? { recipientEmails: input.recipientEmails } : {}),
        ...(input.attendeeEmails?.length ? { attendeeEmails: input.attendeeEmails } : {}),
      },
    },
    metadata,
  };
}

export class MemoryRecorder {
  constructor(
    private readonly deps: {
      client?: MemoryClient;
      user: MemoryRecorderUser;
    },
  ) {}

  get configured(): boolean {
    return Boolean(this.deps.client);
  }

  async recordHotPathTurn(input: {
    message: UserMessage;
    conversationId: string;
    deliveredAssistantText: string;
  }): Promise<void> {
    const client = this.deps.client;
    if (!client) {
      return;
    }

    const document = buildHotPathTurnMemoryDocument({
      user: this.deps.user,
      message: input.message,
      conversationId: input.conversationId,
      deliveredAssistantText: input.deliveredAssistantText,
    });
    if (!document) {
      return;
    }

    await client.addDocument({
      user: this.deps.user,
      customId: client.buildHotPathTurnCustomId(document.messageId),
      content: document.content,
      conversationMessages: document.conversationMessages,
      source: document.source,
      metadata: document.metadata,
      observability: {
        operation: "retain_hot_path_turn",
        messageId: document.messageId,
        conversationId: input.conversationId,
      },
    });
  }

  async recordVisibleAssistantMessage(input: {
    source: "worker" | "trigger";
    sourceMessageId: string;
    conversationId: string;
    deliveredAssistantText: string;
    timestamp: Date;
  }): Promise<void> {
    const client = this.deps.client;
    if (!client) {
      return;
    }

    const document = buildHotPathAssistantMemoryDocument({
      user: this.deps.user,
      source: input.source,
      sourceMessageId: input.sourceMessageId,
      conversationId: input.conversationId,
      deliveredAssistantText: input.deliveredAssistantText,
      timestamp: input.timestamp,
    });
    if (!document) {
      return;
    }

    await client.addDocument({
      user: this.deps.user,
      customId: client.buildHotPathTurnCustomId(document.messageId),
      content: document.content,
      conversationMessages: document.conversationMessages,
      source: document.source,
      metadata: document.metadata,
      observability: {
        operation: "retain_hot_path_turn",
        messageId: document.messageId,
        conversationId: input.conversationId,
      },
    });
  }

  async recordActivityFeedEvent(event: ActivityFeedEvent): Promise<void> {
    const client = this.deps.client;
    if (!client) {
      return;
    }

    const document = buildActivityFeedMemoryDocument({
      user: this.deps.user,
      event,
    });
    if (!document) {
      return;
    }

    await client.addDocument({
      user: this.deps.user,
      customId: `activity-feed_${document.eventId}`,
      content: document.content,
      source: document.source,
      metadata: document.metadata,
      observability: {
        operation: "retain_activity_feed_event",
        activityEventId: document.eventId,
        patternId: event.details.patternId,
      },
    });
  }

  async recordPatternRunOutcome(input: {
    pattern: PatternRecord;
    run: PatternRunRecord;
    result: WorkerResult;
    notifyOutcome: PatternNotifyOutcome;
  }): Promise<void> {
    const client = this.deps.client;
    if (!client) {
      return;
    }

    const document = buildPatternRunOutcomeMemoryDocument({
      user: this.deps.user,
      pattern: input.pattern,
      run: input.run,
      result: input.result,
      notifyOutcome: input.notifyOutcome,
    });
    if (!document) {
      return;
    }

    await client.addDocument({
      user: this.deps.user,
      customId: client.buildPatternRunCustomId(document.patternRunId),
      content: document.content,
      source: document.source,
      metadata: document.metadata,
      observability: {
        operation: "retain_pattern_run_outcome",
        patternId: input.pattern.id,
        patternRunId: input.run.id,
      },
    });
  }

  async recordPersonalIntelligenceItem(input: {
    toolkitSlug: string;
    accountScopeId: string;
    connectedAccountId: string;
    sourceType: string;
    sourceId: string;
    messageId?: string | null;
    threadId?: string | null;
    eventId?: string | null;
    senderEmail?: string | null;
    recipientEmails?: string[];
    attendeeEmails?: string[];
    sourceUrl?: string | null;
    title?: string | null;
    timestamp?: string | null;
    content: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryAddDocumentResponse | null> {
    const client = this.deps.client;
    if (!client) {
      return null;
    }

    const document = buildPersonalIntelligenceMemoryDocument({
      user: this.deps.user,
      ...input,
    });
    if (!document) {
      return null;
    }

    return client.addDocument({
      user: this.deps.user,
      customId: `personal-intelligence_${document.source.provider}_${safeMemoryCustomIdPart(document.metadata.accountScopeId)}_${document.source.type}_${document.source.id}`,
      content: document.content,
      source: document.source,
      metadata: document.metadata,
      observability: {
        operation: "retain_personal_intelligence_item",
      },
    });
  }
}

function safeMemoryCustomIdPart(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : "unknown-account";
  return encodeURIComponent(text).replace(/%/g, "_");
}
