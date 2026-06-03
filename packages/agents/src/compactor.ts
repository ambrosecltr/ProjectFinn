import {
  createFinnTelemetry,
  createFinnTelemetryContext,
  createProcessLogger,
  estimateTokens,
  generateId,
  getTracer,
  loadIdentityFile,
  sanitizePostgresText,
  withSpan,
  type AppConfig,
  type EventBus,
  type UserContext,
} from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import type { LLMManager } from "@finn/llm";
import { generateText, stepCountIs } from "ai";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { HotPathConversationStore } from "./conversation-store.js";
import { sanitizeModelVisibleWorkspacePaths } from "./workspace-paths.js";
const compactorPromptTemplate = loadIdentityFile("compactor.xml", "./prompts");

export interface CompactorDeps {
  db: Database;
  llmManager: LLMManager;
  eventBus: EventBus;
  config: AppConfig;
  user: UserContext;
}

export class Compactor {
  private readonly logger = createProcessLogger("compactor");
  private readonly tracer = getTracer("compactor");
  private compacting = false;
  private readonly conversationStore: HotPathConversationStore;

  constructor(private readonly deps: CompactorDeps) {
    this.conversationStore = new HotPathConversationStore(
      deps.db,
      { userTimezone: deps.config.userTimezone, context: deps.config.context },
      deps.llmManager.getModel("compactor"),
      deps.user,
      (conversationId) => deps.llmManager.getRequestOptions("compactor", conversationId),
    );
  }

  async checkAndCompact(conversationId: string): Promise<void> {
    if (this.compacting) {
      this.logger.debug("Compaction already in progress, skipping");
      return;
    }

    const telemetryContext = createFinnTelemetryContext({
      functionId: "compactor.checkAndCompact",
      processType: "compactor",
      user: this.deps.user,
      conversationId,
    });

    return withSpan(this.tracer, "compactor.checkAndCompact", {}, async (span) => {
      const usage = await this.getContextUsage(conversationId);
      span.setAttribute("compactor.context_usage", usage);
      span.setAttribute("conversation.id", conversationId);
      const {
        thresholdWarn,
        thresholdBackground,
        thresholdAggressive,
        thresholdEmergency,
      } = this.deps.config.context;

      if (usage < thresholdWarn) {
        span.setAttribute("compactor.action", "none");
        return;
      }

      if (usage >= thresholdEmergency) {
        span.setAttribute("compactor.action", "emergency_truncate");
        this.logger.warn({ usage }, "Emergency context truncation");
        await this.runUntilBelowThreshold(
          conversationId,
          thresholdAggressive,
          () => this.emergencyTruncate(conversationId),
        );
        return;
      }

      if (usage >= thresholdAggressive) {
        span.setAttribute("compactor.action", "aggressive_compact");
        this.logger.info({ usage }, "Aggressive compaction triggered");
        await this.runUntilBelowThreshold(
          conversationId,
          thresholdBackground,
          () => this.compact(conversationId, { aggressive: true }),
        );
        return;
      }

      if (usage >= thresholdBackground) {
        span.setAttribute("compactor.action", "background_compact");
        this.logger.info({ usage }, "Background compaction triggered");
        await this.runUntilBelowThreshold(
          conversationId,
          thresholdBackground,
          () => this.compact(conversationId, { aggressive: false }),
        );
        return;
      }

      span.setAttribute("compactor.action", "warn_only");
      this.logger.info({ usage }, "Context usage approaching threshold");
    }, telemetryContext);
  }

  async ensureCurrentChapter(now = new Date(), opts: { waitForSummary?: boolean } = {}): Promise<void> {
    await this.conversationStore.ensureCurrentChapter(now, opts);
  }

  private async getContextUsage(conversationId: string): Promise<number> {
    const maxTokens = this.deps.config.context.maxTokens;
    const bufferTokens = this.deps.config.context.compactionBufferTokens;
    const budget = maxTokens - bufferTokens;

    const result = await this.deps.db
      .select({ total: sql<number>`coalesce(sum(${schema.messages.tokenEstimate}), 0)` })
      .from(schema.messages)
      .where(and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.compacted, false),
      ));

    const totalTokens = Number(result[0]?.total ?? 0);
    return totalTokens / budget;
  }

  private async compact(conversationId: string, opts: { aggressive: boolean }): Promise<void> {
    this.compacting = true;

    try {
      const batchSize = opts.aggressive
        ? this.deps.config.context.compactionBatchAggressive
        : this.deps.config.context.compactionBatchBackground;
      const oldTurns = await this.deps.db
        .select()
        .from(schema.messages)
        .where(and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.compacted, false),
        ))
        .orderBy(asc(schema.messages.createdAt))
        .limit(batchSize);

      if (oldTurns.length < 4) {
        this.logger.debug("Not enough turns to compact");
        return;
      }

      const compactionGroupId = generateId("cmp");
      const conversationText = oldTurns
        .map((turn) => `${turn.role}: ${sanitizeModelVisibleWorkspacePaths(turn.content)}`)
        .join("\n");
      const prompt = [
        compactorPromptTemplate,
        "",
        `Compaction mode: ${opts.aggressive ? "aggressive" : "normal"}`,
        "Create the replacement summary for this older conversation excerpt.",
        "",
        conversationText,
      ].join("\n");

      const result = await generateText({
        model: this.deps.llmManager.getModel("compactor"),
        prompt,
        ...this.deps.llmManager.getRequestOptions("compactor", conversationId),
        stopWhen: stepCountIs(this.deps.config.maxTurns.compactor),
        experimental_telemetry: createFinnTelemetry({
          functionId: "compactor.generate",
          processType: "compactor",
          user: this.deps.user,
          conversationId,
        }),
      });

      const summaryText = result.text;
      const summaryTokens = estimateTokens(summaryText);

      await this.replaceHistoryWithCompactionSummary({
        conversationId,
        summaryText,
        turnsCompacted: oldTurns.length,
        turnIds: oldTurns.map((turn) => turn.id),
        compactionGroupId,
      });

      this.logger.info(
        {
          turnsCompacted: oldTurns.length,
          summaryTokens,
          compactionGroupId,
          conversationId,
          aggressive: opts.aggressive,
        },
        "Compaction complete",
      );

      await this.deps.eventBus.emit({
        type: "compaction_complete",
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        turnsSummarized: oldTurns.length,
      });
    } catch (error) {
      this.logger.error({ error }, "Compaction failed");
    } finally {
      this.compacting = false;
    }
  }

  private async emergencyTruncate(conversationId: string): Promise<void> {
    this.compacting = true;

    try {
      const dropCount = this.deps.config.context.compactionEmergencyBatch;
      const oldTurns = await this.deps.db
        .select()
        .from(schema.messages)
        .where(and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.compacted, false),
        ))
        .orderBy(asc(schema.messages.createdAt))
        .limit(dropCount);

      if (oldTurns.length === 0) {
        return;
      }

      const compactionGroupId = generateId("emt");
      await this.replaceHistoryWithCompactionSummary({
        conversationId,
        summaryText: `Emergency context truncation removed ${oldTurns.length} oldest turns without an LLM summary because the active hot-path context exceeded the emergency threshold. Details from those turns are no longer available in active context.`,
        turnsCompacted: oldTurns.length,
        turnIds: oldTurns.map((turn) => turn.id),
        compactionGroupId,
      });

      this.logger.warn(
        {
          turnsDropped: oldTurns.length,
          compactionGroupId,
          conversationId,
        },
        "Emergency truncation complete — turns dropped without summary",
      );

      await this.deps.eventBus.emit({
        type: "compaction_complete",
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        turnsSummarized: oldTurns.length,
      });
    } catch (error) {
      this.logger.error({ error }, "Emergency truncation failed");
    } finally {
      this.compacting = false;
    }
  }

  private async runUntilBelowThreshold(
    conversationId: string,
    targetUsage: number,
    runPass: () => Promise<void>,
  ): Promise<void> {
    const maxPasses = this.deps.config.context.compactionMaxPasses;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      await runPass();

      const usage = await this.getContextUsage(conversationId);
      if (usage < targetUsage) {
        return;
      }
    }
  }

  private async replaceHistoryWithCompactionSummary(params: {
    conversationId: string;
    summaryText: string;
    turnsCompacted: number;
    turnIds: string[];
    compactionGroupId: string;
  }): Promise<void> {
    const createdAt = new Date();
    const content = sanitizePostgresText(`[Summary of ${params.turnsCompacted} messages]\n${params.summaryText}`);

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(schema.messages).values({
        id: generateId("msg"),
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        conversationId: params.conversationId,
        role: "system",
        content,
        source: "system",
        sourceMessageId: null,
        toolCalls: null,
        tokenEstimate: estimateTokens(content),
        createdAt,
        compacted: false,
        compactionGroup: null,
      });

      await tx
        .update(schema.messages)
        .set({
          compacted: true,
          compactionGroup: params.compactionGroupId,
        })
        .where(and(
          eq(schema.messages.conversationId, params.conversationId),
          inArray(schema.messages.id, params.turnIds),
        ));

      await tx
        .update(schema.conversations)
        .set({ lastMessageAt: createdAt })
        .where(and(
          eq(schema.conversations.id, params.conversationId),
          eq(schema.conversations.tenantId, this.deps.user.tenantId),
          eq(schema.conversations.userId, this.deps.user.userId),
        ));
    });
  }
}
