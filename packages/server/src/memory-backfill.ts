import type { PatternRecord, PatternRunRecord, UserMessage, UserTimezoneSource, WorkerResult } from "@finn/core";
import type { Database, Message, StoredUser } from "@finn/db";
import * as schema from "@finn/db";
import {
  buildHotPathAssistantMemoryDocument,
  buildHotPathTurnMemoryDocument,
  buildPatternRunOutcomeMemoryDocument,
  buildUserProfileSeedMemoryDocument,
  USER_PROFILE_SEED_CUSTOM_ID,
  type MemoryClient,
  type MemoryConversationMessage,
  type MemoryMetadata,
  type MemoryObservabilityContext,
  type MemoryRecorderUser,
  type MemoryStructuredSource,
  type UserProfileSeedUser,
} from "@finn/integrations";
import { and, asc, eq, gt, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";

export type MemoryBackfillKind = "hot_path_turn" | "pattern_run_outcome" | "user_profile_seed";

export interface MemoryBackfillOptions {
  dryRun: boolean;
  kinds: MemoryBackfillKind[];
  tenantId?: string;
  userId?: string;
  since?: Date;
  limit?: number;
  concurrency: number;
  defaultTimezone: string;
}

export interface MemoryBackfillDocument {
  kind: MemoryBackfillKind;
  user: Pick<MemoryRecorderUser, "tenantId" | "userId">;
  customId: string;
  content: string;
  conversationMessages?: MemoryConversationMessage[];
  source?: MemoryStructuredSource;
  metadata: MemoryMetadata;
  observability?: MemoryObservabilityContext;
}

export interface MemoryBackfillPlan {
  documents: MemoryBackfillDocument[];
  scanned: number;
  skipped: Record<string, number>;
}

export interface MemoryBackfillResult extends MemoryBackfillPlan {
  dryRun: boolean;
  written: number;
  failed: number;
}

type BackfillMessage = Pick<Message, "id" | "tenantId" | "userId" | "conversationId" | "role" | "source" | "sourceMessageId" | "content" | "createdAt">;
type BackfillUser = Pick<StoredUser, "id" | "tenantId" | "phoneNumber" | "timezone" | "displayName" | "location" | "metadata">;
type OwnerColumns = {
  tenantId: typeof schema.messages.tenantId | typeof schema.patternRuns.tenantId;
  userId: typeof schema.messages.userId | typeof schema.patternRuns.userId;
};

function incrementSkipped(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

function ownerConditions(input: { tenantId?: string; userId?: string }, owner: OwnerColumns): SQL[] {
  return [
    ...(input.tenantId ? [eq(owner.tenantId, input.tenantId)] : []),
    ...(input.userId ? [eq(owner.userId, input.userId)] : []),
  ];
}

function toRecorderUser(user: BackfillUser, defaultTimezone: string): MemoryRecorderUser {
  return {
    tenantId: user.tenantId,
    userId: user.id,
    timezone: user.timezone || defaultTimezone,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTimezoneSource(user: Pick<BackfillUser, "metadata">): UserTimezoneSource {
  const profile = isRecord(user.metadata?.profile) ? user.metadata.profile : null;
  const source = profile?.timezoneSource;
  return source === "manual" || source === "browser" ? source : "server";
}

function toUserProfileSeedUser(user: BackfillUser, defaultTimezone: string): UserProfileSeedUser {
  const timezoneSource = getTimezoneSource(user);
  return {
    tenantId: user.tenantId,
    userId: user.id,
    displayName: user.displayName,
    timezone: timezoneSource === "server" ? defaultTimezone : user.timezone,
    timezoneSource,
    location: user.location,
  };
}

function getBackfillMessageId(message: BackfillMessage): string {
  return message.sourceMessageId ?? message.id;
}

function formatAssistantMessages(messages: BackfillMessage[]): string {
  return messages
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
}

export function buildHotPathTurnBackfillDocument(input: {
  client: MemoryClient;
  user: BackfillUser;
  userMessage: BackfillMessage;
  assistantMessage?: BackfillMessage;
  assistantMessages?: BackfillMessage[];
  defaultTimezone: string;
}): MemoryBackfillDocument | null {
  const recorderUser = toRecorderUser(input.user, input.defaultTimezone);
  const messageId = getBackfillMessageId(input.userMessage);
  const assistantMessages = input.assistantMessages ?? (input.assistantMessage ? [input.assistantMessage] : []);
  const message: UserMessage = {
    source: "user",
    tenantId: input.userMessage.tenantId,
    userId: input.userMessage.userId,
    phoneNumber: input.user.phoneNumber,
    content: input.userMessage.content,
    messageId,
    timestamp: input.userMessage.createdAt,
  };
  const document = buildHotPathTurnMemoryDocument({
    user: recorderUser,
    message,
    conversationId: input.userMessage.conversationId,
    deliveredAssistantText: formatAssistantMessages(assistantMessages),
  });

  return document
    ? {
        kind: document.kind,
        user: recorderUser,
        customId: input.client.buildHotPathTurnCustomId(messageId),
        content: document.content,
        conversationMessages: document.conversationMessages,
        source: document.source,
        metadata: document.metadata,
        observability: {
          operation: "backfill_retain",
          messageId,
          conversationId: input.userMessage.conversationId,
        },
      }
    : null;
}

export function buildHotPathAssistantBackfillDocument(input: {
  client: MemoryClient;
  user: BackfillUser;
  source: "worker" | "trigger";
  sourceMessageId: string;
  conversationId: string;
  assistantMessages: BackfillMessage[];
  defaultTimezone: string;
}): MemoryBackfillDocument | null {
  const recorderUser = toRecorderUser(input.user, input.defaultTimezone);
  const timestamp = input.assistantMessages[0]?.createdAt;
  if (!timestamp) {
    return null;
  }

  const document = buildHotPathAssistantMemoryDocument({
    user: recorderUser,
    source: input.source,
    sourceMessageId: input.sourceMessageId,
    conversationId: input.conversationId,
    deliveredAssistantText: formatAssistantMessages(input.assistantMessages),
    timestamp,
  });

  return document
    ? {
        kind: document.kind,
        user: recorderUser,
        customId: input.client.buildHotPathTurnCustomId(input.sourceMessageId),
        content: document.content,
        conversationMessages: document.conversationMessages,
        source: document.source,
        metadata: document.metadata,
        observability: {
          operation: "backfill_retain",
          messageId: input.sourceMessageId,
          conversationId: input.conversationId,
        },
      }
    : null;
}

export function buildPatternRunOutcomeBackfillDocument(input: {
  client: MemoryClient;
  user: BackfillUser;
  pattern: PatternRecord;
  run: PatternRunRecord;
  result: WorkerResult;
  defaultTimezone: string;
}): MemoryBackfillDocument | null {
  const recorderUser = toRecorderUser(input.user, input.defaultTimezone);
  const notifyOutcome = input.run.notifyOutcome;
  if (!notifyOutcome) {
    return null;
  }

  const document = buildPatternRunOutcomeMemoryDocument({
    user: recorderUser,
    pattern: input.pattern,
    run: input.run,
    result: input.result,
    notifyOutcome,
  });

  return document
    ? {
        kind: document.kind,
        user: recorderUser,
        customId: input.client.buildPatternRunCustomId(input.run.id),
        content: document.content,
        source: document.source,
        metadata: document.metadata,
        observability: {
          operation: "backfill_retain",
          patternId: input.pattern.id,
          patternRunId: input.run.id,
        },
      }
    : null;
}

export function buildUserProfileSeedBackfillDocument(input: {
  user: BackfillUser;
  defaultTimezone: string;
  now?: Date;
}): MemoryBackfillDocument | null {
  const recorderUser = toRecorderUser(input.user, input.defaultTimezone);
  const document = buildUserProfileSeedMemoryDocument({
    user: toUserProfileSeedUser(input.user, input.defaultTimezone),
    timestamp: input.now,
  });

  return document
    ? {
        kind: document.kind,
        user: recorderUser,
        customId: USER_PROFILE_SEED_CUSTOM_ID,
        content: document.content,
        source: document.source,
        metadata: document.metadata,
        observability: {
          operation: "backfill_retain",
        },
      }
    : null;
}

export async function planMemoryBackfill(input: {
  db: Database;
  client: MemoryClient;
  options: MemoryBackfillOptions;
}): Promise<MemoryBackfillPlan> {
  const plans = await Promise.all(input.options.kinds.map((kind) => {
    switch (kind) {
      case "hot_path_turn":
        return planHotPathTurnBackfill(input);
      case "pattern_run_outcome":
        return planPatternRunBackfill(input);
      case "user_profile_seed":
        return planUserProfileSeedBackfill(input);
    }
  }));

  return mergePlans(plans);
}

export async function runMemoryBackfill(input: {
  db: Database;
  client: MemoryClient;
  options: MemoryBackfillOptions;
}): Promise<MemoryBackfillResult> {
  const plan = await planMemoryBackfill(input);
  if (input.options.dryRun) {
    return {
      ...plan,
      dryRun: true,
      written: 0,
      failed: 0,
    };
  }

  const writeResult = await writeDocuments(input.client, plan.documents, input.options.concurrency);
  return {
    ...plan,
    dryRun: false,
    written: writeResult.written,
    failed: writeResult.failed,
  };
}

async function planHotPathTurnBackfill(input: {
  db: Database;
  client: MemoryClient;
  options: MemoryBackfillOptions;
}): Promise<MemoryBackfillPlan> {
  const conditions: SQL[] = [
    eq(schema.messages.role, "user"),
    eq(schema.messages.source, "user"),
    ...ownerConditions(input.options, { tenantId: schema.messages.tenantId, userId: schema.messages.userId }),
    ...(input.options.since ? [gt(schema.messages.createdAt, input.options.since)] : []),
  ];
  const query = input.db
    .select({ message: schema.messages, user: schema.users })
    .from(schema.messages)
    .innerJoin(schema.users, and(
      eq(schema.messages.tenantId, schema.users.tenantId),
      eq(schema.messages.userId, schema.users.id),
    ))
    .where(and(...conditions))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
  const rows = input.options.limit ? await query.limit(input.options.limit) : await query;
  const skipped: Record<string, number> = {};
  const documents: MemoryBackfillDocument[] = [];

  for (const row of rows) {
    const assistantMessages = await findAssistantMessagesBeforeNextInbound(input.db, row.message);
    const document = buildHotPathTurnBackfillDocument({
      client: input.client,
      user: row.user,
      userMessage: row.message,
      assistantMessages,
      defaultTimezone: input.options.defaultTimezone,
    });
    if (!document) {
      incrementSkipped(skipped, "hot_path_unbuildable");
      continue;
    }
    documents.push(document);
  }

  const assistantOnlyRows = await findInternalDeliveryIngressMessages(input);
  for (const row of assistantOnlyRows) {
    const assistantMessages = await findAssistantMessagesBeforeNextInbound(input.db, row.message);
    const document = buildHotPathAssistantBackfillDocument({
      client: input.client,
      user: row.user,
      source: row.message.source as "worker" | "trigger",
      sourceMessageId: getBackfillMessageId(row.message),
      conversationId: row.message.conversationId,
      assistantMessages,
      defaultTimezone: input.options.defaultTimezone,
    });
    if (!document) {
      incrementSkipped(skipped, "assistant_delivery_unbuildable");
      continue;
    }
    documents.push(document);
  }

  return {
    documents,
    scanned: rows.length + assistantOnlyRows.length,
    skipped,
  };
}

async function findInternalDeliveryIngressMessages(input: {
  db: Database;
  options: MemoryBackfillOptions;
}): Promise<Array<{ message: BackfillMessage; user: BackfillUser }>> {
  const conditions: SQL[] = [
    eq(schema.messages.role, "user"),
    inArray(schema.messages.source, ["worker", "trigger"]),
    ...ownerConditions(input.options, { tenantId: schema.messages.tenantId, userId: schema.messages.userId }),
    ...(input.options.since ? [gt(schema.messages.createdAt, input.options.since)] : []),
  ];
  const query = input.db
    .select({ message: schema.messages, user: schema.users })
    .from(schema.messages)
    .innerJoin(schema.users, and(
      eq(schema.messages.tenantId, schema.users.tenantId),
      eq(schema.messages.userId, schema.users.id),
    ))
    .where(and(...conditions))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));

  return input.options.limit ? await query.limit(input.options.limit) : await query;
}

async function planPatternRunBackfill(input: {
  db: Database;
  client: MemoryClient;
  options: MemoryBackfillOptions;
}): Promise<MemoryBackfillPlan> {
  const conditions: SQL[] = [
    eq(schema.patternRuns.state, "done"),
    sql`${schema.patterns.workerType} <> 'reminder'`,
    isNotNull(schema.patternRuns.result),
    isNotNull(schema.patternRuns.notifyOutcome),
    isNotNull(schema.patternRuns.completedAt),
    ...ownerConditions(input.options, { tenantId: schema.patternRuns.tenantId, userId: schema.patternRuns.userId }),
    ...(input.options.since ? [gt(schema.patternRuns.completedAt, input.options.since)] : []),
  ];
  const query = input.db
    .select({ pattern: schema.patterns, run: schema.patternRuns, user: schema.users })
    .from(schema.patternRuns)
    .innerJoin(schema.patterns, eq(schema.patternRuns.patternId, schema.patterns.id))
    .innerJoin(schema.users, and(
      eq(schema.patternRuns.tenantId, schema.users.tenantId),
      eq(schema.patternRuns.userId, schema.users.id),
    ))
    .where(and(...conditions))
    .orderBy(asc(schema.patternRuns.completedAt), asc(schema.patternRuns.id));
  const rows = input.options.limit ? await query.limit(input.options.limit) : await query;
  const skipped: Record<string, number> = {};
  const documents: MemoryBackfillDocument[] = [];

  for (const row of rows) {
    if (!row.run.result || !row.run.notifyOutcome) {
      incrementSkipped(skipped, "pattern_missing_outcome");
      continue;
    }

    const document = buildPatternRunOutcomeBackfillDocument({
      client: input.client,
      user: row.user,
      pattern: row.pattern,
      run: row.run,
      result: row.run.result,
      defaultTimezone: input.options.defaultTimezone,
    });
    if (!document) {
      incrementSkipped(skipped, "pattern_one_shot");
      continue;
    }
    documents.push(document);
  }

  return {
    documents,
    scanned: rows.length,
    skipped,
  };
}

async function planUserProfileSeedBackfill(input: {
  db: Database;
  client: MemoryClient;
  options: MemoryBackfillOptions;
}): Promise<MemoryBackfillPlan> {
  if (input.client.provider !== "supermemory" && input.client.provider !== "mem0") {
    return {
      documents: [],
      scanned: 0,
      skipped: { user_profile_seed_unsupported_provider: 1 },
    };
  }

  const conditions: SQL[] = [
    ...(input.options.tenantId ? [eq(schema.users.tenantId, input.options.tenantId)] : []),
    ...(input.options.userId ? [eq(schema.users.id, input.options.userId)] : []),
    ...(input.options.since ? [gt(schema.users.updatedAt, input.options.since)] : []),
  ];
  const query = input.db
    .select({ user: schema.users })
    .from(schema.users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.users.createdAt), asc(schema.users.id));
  const rows = input.options.limit ? await query.limit(input.options.limit) : await query;
  const skipped: Record<string, number> = {};
  const documents: MemoryBackfillDocument[] = [];

  for (const row of rows) {
    const document = buildUserProfileSeedBackfillDocument({
      user: row.user,
      defaultTimezone: input.options.defaultTimezone,
    });
    if (!document) {
      incrementSkipped(skipped, "user_profile_seed_empty");
      continue;
    }
    documents.push(document);
  }

  return {
    documents,
    scanned: rows.length,
    skipped,
  };
}

async function findAssistantMessagesBeforeNextInbound(db: Database, inboundMessage: BackfillMessage): Promise<BackfillMessage[]> {
  const [nextInboundMessage] = await db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.tenantId, inboundMessage.tenantId),
      eq(schema.messages.userId, inboundMessage.userId),
      eq(schema.messages.conversationId, inboundMessage.conversationId),
      eq(schema.messages.role, "user"),
      gt(schema.messages.createdAt, inboundMessage.createdAt),
    ))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
    .limit(1);
  const conditions: SQL[] = [
    eq(schema.messages.tenantId, inboundMessage.tenantId),
    eq(schema.messages.userId, inboundMessage.userId),
    eq(schema.messages.conversationId, inboundMessage.conversationId),
    eq(schema.messages.role, "assistant"),
    gt(schema.messages.createdAt, inboundMessage.createdAt),
    ...(nextInboundMessage ? [lt(schema.messages.createdAt, nextInboundMessage.createdAt)] : []),
  ];

  return db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
}

async function writeDocuments(client: MemoryClient, documents: MemoryBackfillDocument[], concurrency: number): Promise<{ written: number; failed: number }> {
  let cursor = 0;
  let written = 0;
  let failed = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), Math.max(documents.length, 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const document = documents[index];
      if (!document) {
        return;
      }

      const result = await client.addDocument(document);
      if (result) {
        written += 1;
      } else {
        failed += 1;
      }
    }
  });

  await Promise.all(workers);
  return { written, failed };
}

function mergePlans(plans: MemoryBackfillPlan[]): MemoryBackfillPlan {
  const skipped: Record<string, number> = {};
  for (const plan of plans) {
    for (const [reason, count] of Object.entries(plan.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + count;
    }
  }

  return {
    documents: plans.flatMap((plan) => plan.documents),
    scanned: plans.reduce((total, plan) => total + plan.scanned, 0),
    skipped,
  };
}
