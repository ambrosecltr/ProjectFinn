import {
  createFinnTelemetry,
  estimateTokens,
  formatInternalMessage,
  generateId,
  sanitizePostgresJson,
  sanitizePostgresText,
  truncate,
  type AppConfig,
  type ConversationMessageSource,
  type ConversationRecord,
  type ConversationTurn,
  type InboundMessage,
  type UserContext,
} from "@finn/core";
import type { Database, StoredConversation, StoredConversationTurn } from "@finn/db";
import * as schema from "@finn/db";
import type { LLMRequestOptions } from "@finn/llm";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { formatPromptEnvelope, startsWithPromptEnvelope } from "./prompt-envelopes.js";
import { sanitizeModelVisibleWorkspacePaths } from "./workspace-paths.js";

type PersistedHistory = {
  conversation: ConversationRecord;
  chapterSummary: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

type ConversationStoreConfig = Pick<AppConfig, "userTimezone" | "context">;

type InsertConversationMessage = {
  role: ConversationTurn["role"];
  content: string;
  source: ConversationMessageSource;
  sourceMessageId?: string;
  toolCalls?: ConversationTurn["toolCalls"];
  createdAt?: Date;
};

function formatPromptTimestamp(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });

  const parts = formatter.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup("hour")}:${lookup("minute")}:${lookup("second")} ${lookup("timeZoneName")}`.trim();
}

function formatPromptHeader(turn: StoredConversationTurn, timeZone: string): string {
  const label = turn.role === "assistant"
    ? "assistant"
    : turn.source === "user"
      ? "user"
      : `internal:${turn.source}`;

  return `[${label} | ${formatPromptTimestamp(turn.createdAt, timeZone)}]`;
}

function formatUserLocalDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toConversationRecord(conversation: StoredConversation): ConversationRecord {
  return {
    id: conversation.id,
    tenantId: conversation.tenantId,
    userId: conversation.userId,
    rootConversationId: conversation.rootConversationId,
    previousConversationId: conversation.previousConversationId,
    chapterIndex: conversation.chapterIndex,
    userLocalDate: conversation.userLocalDate,
    handoffSummary: conversation.handoffSummary,
    startedAt: conversation.startedAt,
    lastMessageAt: conversation.lastMessageAt,
    active: conversation.active,
    archivedAt: conversation.archivedAt,
  };
}

function toPromptMessage(
  turn: StoredConversationTurn,
  timeZone: string,
): { role: "user" | "assistant"; content: string } | null {
  const content = sanitizeModelVisibleWorkspacePaths(turn.content);

  if (turn.role === "assistant") {
    return {
      role: "assistant",
      content: startsWithPromptEnvelope(content, "assistant_message")
        ? content
        : formatPromptEnvelope("assistant_message", { timestamp: formatPromptTimestamp(turn.createdAt, timeZone) }, content, { escapeContent: true }),
    };
  }

  if (turn.role === "user") {
    if (turn.source === "user" && !startsWithPromptEnvelope(content, "human_message")) {
      return {
        role: "user",
        content: formatPromptEnvelope(
          "human_message",
          { source: "user" },
          formatPromptEnvelope(
            "message",
            {
              handle: turn.sourceMessageId,
              timestamp: formatPromptTimestamp(turn.createdAt, timeZone),
              modality: content.trim().length > 0 ? "text" : "empty",
            },
            content.trim().length > 0
              ? formatPromptEnvelope("text", {}, content, { escapeContent: true })
              : "",
          ),
        ),
      };
    }

    return {
      role: "user",
      content: startsWithPromptEnvelope(content, "human_message")
          || startsWithPromptEnvelope(content, "internal_message")
          || startsWithPromptEnvelope(content, "worker_result")
          || startsWithPromptEnvelope(content, "trigger_event")
        ? content
        : formatPromptEnvelope(
            turn.source === "user" ? "human_message" : "internal_message",
            {
              source: turn.source,
              source_message_id: turn.sourceMessageId,
              timestamp: formatPromptTimestamp(turn.createdAt, timeZone),
            },
            `${formatPromptHeader(turn, timeZone)}\n${content}`,
            { escapeContent: true },
          ),
    };
  }

  return null;
}

function formatDailyHandoffHeader(turn: StoredConversationTurn, timeZone: string): string {
  const label = turn.role === "assistant"
    ? "finn"
    : turn.source === "user"
      ? "user"
      : "same-day summary";

  return `[${label} | ${formatPromptTimestamp(turn.createdAt, timeZone)}]`;
}

function shouldIncludeDailyHandoffTurn(turn: StoredConversationTurn): boolean {
  return turn.source !== "worker" && turn.source !== "trigger";
}

function formatDailyHandoffTurnContent(turn: StoredConversationTurn): string {
  const content = sanitizeModelVisibleWorkspacePaths(turn.role === "system"
    ? turn.content.replace(/^\[Summary of \d+ messages\]\n?/, "")
    : turn.content);

  return content
    .split("\n")
    .map((line) => line.replace(/\s+\|\s+target_handle: [^\]]+(?=\])/, ""))
    .map((line) => line.replace(/\s+\|\s+reply_to:[^\]]+(?=\])/, ""))
    .filter((line) => !/^\[user \| .+\]$/.test(line.trim()))
    .filter((line) => !/^\[handle:[^\]]+\]$/.test(line.trim()))
    .join("\n")
    .trim();
}

export function formatDailyHandoffSourceTurns(turns: StoredConversationTurn[], timeZone: string): string {
  return turns
    .filter(shouldIncludeDailyHandoffTurn)
    .map((turn) => {
      const content = formatDailyHandoffTurnContent(turn);
      if (content.length === 0) {
        return null;
      }

      return `${formatDailyHandoffHeader(turn, timeZone)}\n${content}`;
    })
    .filter((turn): turn is string => turn !== null)
    .join("\n\n");
}

export function buildDailyHandoffPrompt(turns: StoredConversationTurn[], timeZone: string): string | null {
  const source = formatDailyHandoffSourceTurns(turns, timeZone);
  if (source.length === 0) {
    return null;
  }

  return [
    "Create a daily handoff for Finn's next-day conversation context.",
    "This is not same-day compaction and not a durable profile store. User profile context, Patterns, and worker status are handled separately.",
    "",
    "Preserve only personal continuity Finn may need tomorrow:",
    "- unresolved user-facing asks or pending confirmations",
    "- commitments Finn directly made that still need follow-up",
    "- conversations or plans the user and Finn were actively in the middle of",
    "- emotional tone, relationship context, or notable user experience that would make tomorrow feel continuous",
    "- concrete details only when they anchor one of those live threads",
    "",
    "Do not preserve:",
    "- Pattern definitions, recurring automations, reminders, schedules, connector state, trigger details, tool names, worker IDs, or internal mechanics",
    "- raw worker payloads or Pattern run results unless Finn still owes the user a direct follow-up not covered by Pattern/status delivery",
    "- standalone profile facts/preferences that belong in long-term memory, such as where the user lives or favorite colors, unless they are part of an active thread",
    "- completed setup/testing churn or one-off notifications that do not need tomorrow's attention",
    "",
    "Write one concise natural paragraph for Finn to read, not for the user. Use third person. No headings, no bullet lists, no labels, no meta-commentary.",
    "",
    "Conversation excerpt:",
    source,
  ].join("\n");
}

function normalizeStoredTurn(turn: typeof schema.messages.$inferSelect): StoredConversationTurn {
  return {
    ...turn,
    toolCalls: turn.toolCalls ?? undefined,
    sourceMessageId: turn.sourceMessageId ?? undefined,
  } as StoredConversationTurn;
}


export class HotPathConversationStore {
  private rolloverPromise: Promise<ConversationRecord> | null = null;
  private handoffBackfillByPreviousConversation = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly config: ConversationStoreConfig,
    private readonly handoffModel: LanguageModel,
    private readonly user: UserContext,
    private readonly getHandoffRequestOptions: (conversationId: string) => LLMRequestOptions = () => ({}),
  ) {}

  async hydrateActiveConversation(now = new Date()): Promise<PersistedHistory> {
    let conversation = await this.getActiveConversation();

    if (!conversation) {
      conversation = await this.createInitialConversation(now);
    }

    const currentLocalDate = formatUserLocalDate(now, this.getUserTimeZone());
    if (conversation.userLocalDate !== currentLocalDate) {
      conversation = await this.rolloverConversation(conversation, now, currentLocalDate, { waitForSummary: false });
    }

    const [chapterSummary, messages] = await Promise.all([
      this.getChapterSummary(conversation),
      this.getPromptHistory(conversation.id),
    ]);

    return {
      conversation,
      chapterSummary,
      messages,
    };
  }

  async appendInbound(message: InboundMessage, content: string, now = new Date()): Promise<void> {
    const { conversation } = await this.hydrateActiveConversation(now);
    await this.insertMessage(conversation.id, {
      role: "user",
      content,
      source: this.toInboundSource(message),
      sourceMessageId: this.getSourceMessageId(message),
      createdAt: now,
    });
  }

  async appendAssistant(content: string, now = new Date()): Promise<void> {
    const { conversation } = await this.hydrateActiveConversation(now);
    await this.insertMessage(conversation.id, {
      role: "assistant",
      content,
      source: "system",
      createdAt: now,
    });
  }

  async appendAssistantReaction(reaction: string, targetMessageId?: string, now = new Date()): Promise<void> {
    const target = targetMessageId ? ` | target_handle: ${targetMessageId}` : "";
    await this.appendAssistant(`[tapback: ${reaction}${target}]`, now);
  }

  async getActiveConversationId(now = new Date()): Promise<string> {
    const { conversation } = await this.hydrateActiveConversation(now);
    return conversation.id;
  }

  async listPromptMessages(now = new Date()): Promise<PersistedHistory> {
    return this.hydrateActiveConversation(now);
  }

  async ensureCurrentChapter(now = new Date(), opts: { waitForSummary?: boolean } = {}): Promise<ConversationRecord> {
    let conversation = await this.getActiveConversation();

    if (!conversation) {
      return this.createInitialConversation(now);
    }

    const currentLocalDate = formatUserLocalDate(now, this.getUserTimeZone());
    if (conversation.userLocalDate === currentLocalDate) {
      return conversation;
    }

    return this.rolloverConversation(conversation, now, currentLocalDate, {
      waitForSummary: opts.waitForSummary ?? true,
    });
  }

  async createCompactionSummary(conversationId: string, summary: string, turns: number, createdAt = new Date()): Promise<void> {
    await this.insertMessage(conversationId, {
      role: "system",
      content: `[Summary of ${turns} messages]\n${summary}`,
      source: "system",
      createdAt,
    });
  }

  private async createInitialConversation(now: Date): Promise<ConversationRecord> {
    const id = generateId("cnv");
    const localDate = formatUserLocalDate(now, this.getUserTimeZone());

    await this.db.insert(schema.conversations).values({
      id,
      tenantId: this.user.tenantId,
      userId: this.user.userId,
      rootConversationId: id,
      previousConversationId: null,
      chapterIndex: 1,
      userLocalDate: localDate,
      handoffSummary: null,
      startedAt: now,
      lastMessageAt: now,
      active: true,
      archivedAt: null,
      metadata: { channel: "imessage" },
    });

    const conversation = await this.getConversationById(id);
    if (!conversation) {
      throw new Error("Failed to create initial conversation.");
    }

    return conversation;
  }

  private async rolloverConversation(
    current: ConversationRecord,
    now: Date,
    nextLocalDate: string,
    opts: { waitForSummary: boolean },
  ): Promise<ConversationRecord> {
    if (this.rolloverPromise) {
      return this.rolloverPromise;
    }

    this.rolloverPromise = this.createNextConversationChapter(current, now, nextLocalDate, opts);
    try {
      return await this.rolloverPromise;
    } finally {
      this.rolloverPromise = null;
    }
  }

  private async createNextConversationChapter(
    current: ConversationRecord,
    now: Date,
    nextLocalDate: string,
    opts: { waitForSummary: boolean },
  ): Promise<ConversationRecord> {
    const summary = opts.waitForSummary ? await this.safeGenerateHandoffSummary(current.id) : null;
    const nextId = generateId("cnv");

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.conversations)
        .set({ active: false, archivedAt: now, lastMessageAt: now })
        .where(and(
          eq(schema.conversations.id, current.id),
          eq(schema.conversations.tenantId, this.user.tenantId),
          eq(schema.conversations.userId, this.user.userId),
        ));

      await tx.insert(schema.conversations).values({
        id: nextId,
        tenantId: this.user.tenantId,
        userId: this.user.userId,
        rootConversationId: current.rootConversationId,
        previousConversationId: current.id,
        chapterIndex: current.chapterIndex + 1,
        userLocalDate: nextLocalDate,
        handoffSummary: summary,
        startedAt: now,
        lastMessageAt: now,
        active: true,
        archivedAt: null,
        metadata: { channel: "imessage" },
      });
    });

    const nextConversation = await this.getConversationById(nextId);
    if (!nextConversation) {
      throw new Error("Failed to create next conversation chapter.");
    }

    if (!opts.waitForSummary) {
      this.backfillHandoffSummary(current.id, nextConversation.id).catch(() => undefined);
    }

    return nextConversation;
  }

  private async backfillHandoffSummary(previousConversationId: string, nextConversationId: string): Promise<void> {
    if (this.handoffBackfillByPreviousConversation.has(previousConversationId)) {
      return;
    }

    this.handoffBackfillByPreviousConversation.add(previousConversationId);
    try {
      const summary = await this.safeGenerateHandoffSummary(previousConversationId);
      if (!summary) {
        return;
      }

      await this.db
        .update(schema.conversations)
        .set({ handoffSummary: summary })
        .where(and(
          eq(schema.conversations.id, nextConversationId),
          eq(schema.conversations.tenantId, this.user.tenantId),
          eq(schema.conversations.userId, this.user.userId),
          isNull(schema.conversations.handoffSummary),
        ));
    } finally {
      this.handoffBackfillByPreviousConversation.delete(previousConversationId);
    }
  }

  private async generateHandoffSummary(conversationId: string): Promise<string | null> {
    const turns = await this.getRecentTurnsForBudget(conversationId, this.config.context.handoffInputTokenBudget);
    const prompt = buildDailyHandoffPrompt(turns, this.getUserTimeZone());
    if (!prompt) {
      return null;
    }

    const result = await generateText({
      model: this.handoffModel,
      prompt,
      ...this.getHandoffRequestOptions(conversationId),
      experimental_telemetry: createFinnTelemetry({
        functionId: "hot-path.handoff",
        processType: "hot-path",
        user: this.user,
        conversationId,
      }),
    });

    const summary = result.text.trim();
    return summary.length > 0 ? summary : null;
  }

  private async safeGenerateHandoffSummary(conversationId: string): Promise<string | null> {
    try {
      return await this.generateHandoffSummary(conversationId);
    } catch {
      return null;
    }
  }

  private async getActiveConversation(): Promise<ConversationRecord | null> {
    const [conversation] = await this.db
      .select()
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.tenantId, this.user.tenantId),
        eq(schema.conversations.userId, this.user.userId),
        eq(schema.conversations.active, true),
        isNull(schema.conversations.archivedAt),
      ))
      .orderBy(desc(schema.conversations.chapterIndex), desc(schema.conversations.startedAt))
      .limit(1);

    return conversation ? toConversationRecord(conversation) : null;
  }

  private async getConversationById(conversationId: string): Promise<ConversationRecord | null> {
    const [conversation] = await this.db
      .select()
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.tenantId, this.user.tenantId),
        eq(schema.conversations.userId, this.user.userId),
      ))
      .limit(1);

    return conversation ? toConversationRecord(conversation) : null;
  }

  private async getPromptHistory(
    conversationId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const turns = (await this.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.compacted, false)))
      .orderBy(desc(schema.messages.createdAt)))
      .map(normalizeStoredTurn);

    const timeZone = this.getUserTimeZone();
    const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
    let usedTokens = 0;
    const tokenBudget = this.config.context.promptHistoryTokenBudget;
    const perMessageBudget = this.config.context.promptHistoryMessageTokenBudget;

    for (const turn of turns) {
      if (turn.role === "system") {
        continue;
      }

      const promptMessage = this.toBudgetedPromptMessage(turn, timeZone, perMessageBudget);
      if (!promptMessage) {
        continue;
      }

      const nextTokens = usedTokens + estimateTokens(promptMessage.content);
      if (nextTokens > tokenBudget) {
        break;
      }

      selected.push(promptMessage);
      usedTokens = nextTokens;
    }

    return selected.reverse();
  }

  private async getRecentTurnsForBudget(conversationId: string, tokenBudget: number): Promise<StoredConversationTurn[]> {
    const turns = (await this.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.compacted, false)))
      .orderBy(desc(schema.messages.createdAt)))
      .map(normalizeStoredTurn);

    const selected: StoredConversationTurn[] = [];
    let usedTokens = 0;

    for (const turn of turns) {
      const content = this.truncateToTokenBudget(turn.content, this.config.context.promptHistoryMessageTokenBudget);
      const nextTokens = usedTokens + estimateTokens(content);
      if (nextTokens > tokenBudget) {
        break;
      }

      selected.push({ ...turn, content });
      usedTokens = nextTokens;
    }

    return selected.reverse();
  }

  private async getChapterSummary(conversation: ConversationRecord): Promise<string | null> {
    const summaryTurns = await this.db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(
        eq(schema.messages.conversationId, conversation.id),
        eq(schema.messages.compacted, false),
        eq(schema.messages.role, "system"),
      ))
      .orderBy(asc(schema.messages.createdAt));

    const parts: string[] = [];
    if (conversation.handoffSummary) {
      parts.push(`Previous chapter handoff:\n${conversation.handoffSummary}`);
    }

    if (summaryTurns.length > 0) {
      parts.push(summaryTurns.map((turn) => sanitizeModelVisibleWorkspacePaths(turn.content)).join("\n\n"));
    }

    const summary = parts.join("\n\n").trim();
    if (summary.length === 0) {
      return null;
    }

    return this.truncateToTokenBudget(summary, this.config.context.chapterSummaryTokenBudget);
  }

  private toBudgetedPromptMessage(
    turn: StoredConversationTurn,
    timeZone: string,
    tokenBudget: number,
  ): { role: "user" | "assistant"; content: string } | null {
    const promptMessage = toPromptMessage(turn, timeZone);
    if (!promptMessage) {
      return null;
    }

    return {
      role: promptMessage.role,
      content: this.truncateToTokenBudget(promptMessage.content, tokenBudget),
    };
  }

  private truncateToTokenBudget(text: string, tokenBudget: number): string {
    const maxChars = Math.max(1, tokenBudget) * 4;
    if (text.length <= maxChars) {
      return text;
    }

    return truncate(
      `${text}\n[content truncated to fit hot-path context budget]`,
      maxChars,
    );
  }

  private async insertMessage(conversationId: string, message: InsertConversationMessage): Promise<void> {
    const createdAt = message.createdAt ?? new Date();

    await this.db.transaction(async (tx) => {
      if (message.sourceMessageId) {
        const [existing] = await tx
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(and(
            eq(schema.messages.conversationId, conversationId),
            eq(schema.messages.sourceMessageId, message.sourceMessageId),
          ))
          .limit(1);

        if (existing) {
          return;
        }
      }

      const content = sanitizePostgresText(message.content);
      await tx.insert(schema.messages).values({
        id: generateId("msg"),
        tenantId: this.user.tenantId,
        userId: this.user.userId,
        conversationId,
        role: message.role,
        content,
        source: message.source,
        sourceMessageId: message.sourceMessageId,
        toolCalls: sanitizePostgresJson(message.toolCalls),
        tokenEstimate: estimateTokens(content),
        createdAt,
        compacted: false,
        compactionGroup: null,
      });

      await tx
        .update(schema.conversations)
        .set({ lastMessageAt: createdAt })
        .where(and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.tenantId, this.user.tenantId),
          eq(schema.conversations.userId, this.user.userId),
        ));
    });
  }

  private toInboundSource(message: InboundMessage): ConversationMessageSource {
    return message.source;
  }

  private getSourceMessageId(message: InboundMessage): string | undefined {
    switch (message.source) {
      case "user":
        return message.messageId;
      case "worker":
        return message.workerId;
      case "trigger":
        return message.triggerId;
    }
  }

  private getUserTimeZone(): string {
    return this.user.timezone || this.config.userTimezone;
  }
}

export function buildStatusTaskLabel(task: string): string {
  return truncate(task.replace(/\s+/g, " ").trim(), 80);
}

function formatWorkerMetadata(message: Extract<InboundMessage, { source: "worker" }>): string[] {
  const metadata: string[] = [];

  if (message.pattern) {
    metadata.push(`Pattern: ${message.pattern.name}`);
    metadata.push(`Pattern ID: ${message.pattern.id}`);
    metadata.push(`Triggered by: ${message.pattern.triggeredBy}`);
    if (message.pattern.notifyOutcome) {
      metadata.push(`Notify: ${message.pattern.notifyOutcome.notify ? "yes" : "no"}`);
      if (message.pattern.notifyOutcome.reason) {
        metadata.push(`Notify reason: ${message.pattern.notifyOutcome.reason}`);
      }
    }
    if (message.pattern.triggerPayload) {
      metadata.push(`Trigger payload: ${formatWorkerResultData(message.pattern.triggerPayload)}`);
    }

    return metadata;
  }

  if (message.originSource) {
    metadata.push(`Origin: ${message.originSource}`);
  }

  if (message.originMessageId) {
    metadata.push(`Origin message: ${message.originMessageId}`);
  }

  return metadata;
}

function formatWorkerResultData(data: unknown): string | null {
  if (data === undefined) {
    return null;
  }

  const maxStructuredDataChars = 16_000;
  try {
    const text = JSON.stringify(data, null, 2) ?? String(data);
    return truncateWorkerResultData(text, maxStructuredDataChars);
  } catch {
    return truncateWorkerResultData(String(data), maxStructuredDataChars);
  }
}

function truncateWorkerResultData(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const header = `Structured result data truncated from ${text.length} chars to keep hot-path context healthy. Preserve important IDs/URLs in the worker summary when needed.`;
  const omitted = "\n[...middle omitted...]\n";
  const remainingChars = Math.max(1, maxChars - header.length - omitted.length - 2);
  const headChars = Math.ceil(remainingChars * 0.75);
  const tailChars = remainingChars - headChars;

  return `${header}\n${text.slice(0, headChars)}${omitted}${text.slice(-tailChars)}`;
}


export function formatWorkerDeliveryContent(message: Extract<InboundMessage, { source: "worker" }>): string {
  const metadata = formatWorkerMetadata(message);
  const resultData = formatWorkerResultData(message.pattern?.notifyOutcome?.data ?? message.result.data);
  const answer = message.pattern?.notifyOutcome?.summary ?? message.result.summary;
  const guidance = message.originSource === "user"
    ? "This result belongs to an earlier user request. Use the current conversation state and timing to decide whether to surface it now, weave it into the live thread, or wait. Treat the result as facts, not ready-made message text."
    : message.originSource === "pattern"
      ? "This result came from a saved pattern, not a live user request. The Pattern notify condition was met, so surface the answer naturally without implying the user just asked for it. Treat the answer as facts, not ready-made message text."
      : "Note: this is raw internal output. If you message the user, write it naturally in finn's voice instead of copying it verbatim. Treat the result as facts, not ready-made message text.";

  return [
    formatInternalMessage("worker", {
      task: truncate(message.task, 2_000),
      status: message.result.error ? "Failed" : "Completed",
      result: truncate(message.result.error ?? answer, 8_000),
    }),
    ...(metadata.length > 0 ? [metadata.join("\n")] : []),
    ...(resultData ? [`Supporting data / dataSummary:\n${resultData}`] : []),
    guidance,
  ].join("\n");
}
