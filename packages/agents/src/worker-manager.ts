import {
  createProcessLogger,
  generateId,
  getTracer,
  sanitizePostgresJson,
  sanitizePostgresText,
  withSpan,
  type AppConfig,
  type EventBus,
  type PatternNotifyOutcome,
  type SpawnWorkerFn,
  type SpawnWorkerOpts,
  type UpdateWorkerStatusFn,
  type UserContext,
  type WorkerRecord,
  type WorkerRunMessage,
  type WorkerOriginSource,
  type WorkerResult,
  type WorkerState,
  type WorkerType,
  type WorkerToolOutputArtifactStore,
} from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import { getAbortErrorMessage, type LLMManager } from "@finn/llm";
import { and, desc, eq, gt } from "drizzle-orm";
import type { ToolSet } from "ai";
import { WorkerAgent } from "./worker.js";

export interface WorkerRuntimeConfig {
  tools: ToolSet;
  promptAppendix?: string;
  toolOutputArtifacts?: WorkerToolOutputArtifactStore;
  cleanup?: (options?: WorkerRuntimeCleanupOptions) => void | Promise<void>;
}

export interface WorkerRuntimeCleanupOptions {
  preserveTemporaryWorkspace?: boolean;
}

export type GetWorkerToolsFn = (
  type: WorkerType,
  options?: { source?: "user" | "pattern"; pattern?: SpawnWorkerOpts["pattern"]; workerId?: string },
) => Promise<WorkerRuntimeConfig>;

function resolveWorkerOriginSource(opts: SpawnWorkerOpts): WorkerOriginSource | undefined {
  return opts.originSource ?? opts.source;
}

export interface WorkerManagerOptions {
  db: Database;
  llmManager: LLMManager;
  eventBus: EventBus;
  config: AppConfig;
  user: UserContext;
  getWorkerTools?: GetWorkerToolsFn;
}

type ActiveExecution = {
  timeout: ReturnType<typeof setTimeout>;
  abortController: AbortController;
};

type PendingRuntimeCleanup = {
  timeout: ReturnType<typeof setTimeout>;
  cleanup: () => Promise<void>;
  runAt: number;
};

const terminalStates: WorkerState[] = ["done", "failed", "cancelled"];
const workerFollowUpWindowMs = 5 * 60 * 1000;
export const hotPathWorkerCancellationReasons = [
  "user_cancelled",
  "user_corrected_task",
  "superseded_by_new_request",
  "bad_delegate_directive",
] as const;

export type HotPathWorkerCancellationReason = (typeof hotPathWorkerCancellationReasons)[number];

export type CancelWorkerResult =
  | { cancelled: true; workerId: string; task: string; reason: HotPathWorkerCancellationReason }
  | { cancelled: false; workerId: string; error: string; instruction: string };

export class WorkerFollowUpUnavailableError extends Error {
  constructor(workerId: string) {
    super(`Worker ${workerId} is no longer available for follow-up. Delegate to a fresh worker instead.`);
    this.name = "WorkerFollowUpUnavailableError";
  }
}

export class WorkerManager {
  private readonly logger = createProcessLogger("worker");
  private readonly tracer = getTracer("worker-manager");
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly pendingRuntimeCleanups = new Map<string, PendingRuntimeCleanup>();
  private readonly getWorkerTools: GetWorkerToolsFn;

  constructor(private readonly deps: WorkerManagerOptions) {
    this.getWorkerTools = deps.getWorkerTools ?? (async () => ({ tools: {} }));
  }

  readonly spawn: SpawnWorkerFn = async (opts) => {
    if (opts.workerId) {
      return this.resume(opts.workerId, opts);
    }

    const maxConcurrent = this.deps.config.workerLimits.maxConcurrent;
    if (this.activeExecutions.size >= maxConcurrent) {
      throw new Error(
        `Worker limit reached (${this.activeExecutions.size}/${maxConcurrent}). Try again later.`,
      );
    }

    const workerId = generateId("wrk");
    const now = new Date();

    await this.deps.db.insert(schema.workers).values({
      id: workerId,
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      type: opts.type ?? "general",
      task: sanitizePostgresText(opts.task),
      state: "created",
      runSequence: 1,
      originMessageId: opts.originMessageId ?? null,
      completionDeliveredAt: null,
      toolCallsUsed: 0,
      statusDetail: null,
      result: null,
      modelMessages: null,
      followUpExpiresAt: null,
      parentConversationId: opts.parentConversationId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    void this.runWorker(workerId, opts);

    return workerId;
  };

  async getActive(): Promise<WorkerRecord[]> {
    return this.deps.db
      .select()
      .from(schema.workers)
      .where(and(
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, "running"),
      ));
  }

  async getFollowUpEnabled(now = new Date()): Promise<WorkerRecord[]> {
    const workers = await this.deps.db
      .select()
      .from(schema.workers)
      .where(and(
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, "done"),
        gt(schema.workers.followUpExpiresAt, now),
      ))
      .orderBy(desc(schema.workers.followUpExpiresAt))
      .limit(5);

    return workers;
  }

  async reconcileInterrupted(): Promise<void> {
    const interrupted = await this.deps.db
      .select()
      .from(schema.workers)
      .where(and(
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, "running"),
      ));

    const now = new Date();
    for (const worker of interrupted) {
      const result: WorkerResult = {
        summary: "Worker interrupted during server restart.",
        error: "Server restarted before the worker completed.",
      };
      await this.deps.db
        .update(schema.workers)
        .set({
          state: "failed",
          statusDetail: "Worker interrupted during server restart.",
          result: sanitizePostgresJson(result),
          updatedAt: now,
          completedAt: now,
        })
        .where(eq(schema.workers.id, worker.id));
    }
  }

  async getRecentlyCompleted(limit = 5): Promise<WorkerRecord[]> {
    return this.deps.db
      .select()
      .from(schema.workers)
      .where(and(
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, "done"),
      ))
      .orderBy(desc(schema.workers.completedAt))
      .limit(limit);
  }

  private async resume(workerId: string, opts: SpawnWorkerOpts): Promise<string> {
    const maxConcurrent = this.deps.config.workerLimits.maxConcurrent;
    if (this.activeExecutions.size >= maxConcurrent) {
      throw new Error(
        `Worker limit reached (${this.activeExecutions.size}/${maxConcurrent}). Try again later.`,
      );
    }

    const worker = await this.getWorker(workerId);
    const now = new Date();
    if (
      !worker
      || worker.state !== "done"
      || worker.type === "pattern_worker"
      || !worker.modelMessages
      || !worker.followUpExpiresAt
      || worker.followUpExpiresAt <= now
    ) {
      throw new WorkerFollowUpUnavailableError(workerId);
    }
    const previousMessages = worker.modelMessages;

    const [claimed] = await this.deps.db
      .update(schema.workers)
      .set({
        task: sanitizePostgresText(opts.task),
        state: "created",
        runSequence: worker.runSequence + 1,
        originMessageId: opts.originMessageId ?? worker.originMessageId,
        completionDeliveredAt: null,
        toolCallsUsed: 0,
        statusDetail: null,
        result: null,
        followUpExpiresAt: null,
        parentConversationId: opts.parentConversationId ?? worker.parentConversationId,
        updatedAt: now,
        completedAt: null,
      })
      .where(and(
        eq(schema.workers.id, workerId),
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, "done"),
        eq(schema.workers.runSequence, worker.runSequence),
        gt(schema.workers.followUpExpiresAt, now),
      ))
      .returning({ id: schema.workers.id });

    if (!claimed) {
      throw new WorkerFollowUpUnavailableError(workerId);
    }

    void this.runWorker(workerId, {
      ...opts,
      type: worker.type,
      source: "user",
    }, previousMessages);

    return workerId;
  }

  async markCompletionDelivered(workerId: string, deliveredAt = new Date()): Promise<void> {
    await this.deps.db
      .update(schema.workers)
      .set({
        completionDeliveredAt: deliveredAt,
        updatedAt: deliveredAt,
      })
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.tenantId, this.deps.user.tenantId),
          eq(schema.workers.userId, this.deps.user.userId),
        ),
      );
  }

  async cancel(workerId: string, options: { detail?: string } = {}): Promise<boolean> {
    const worker = await this.getWorker(workerId);
    if (!worker || terminalStates.includes(worker.state)) {
      this.clearExecution(workerId);
      return false;
    }

    const now = new Date();
    const statusDetail = sanitizePostgresText(options.detail ?? worker.statusDetail ?? "Cancelled.");

    const [cancelled] = await this.deps.db
      .update(schema.workers)
      .set({
        state: "cancelled",
        updatedAt: now,
        completedAt: now,
        followUpExpiresAt: null,
        statusDetail,
      })
      .where(and(
        eq(schema.workers.id, workerId),
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
        eq(schema.workers.state, worker.state),
      ))
      .returning({ id: schema.workers.id });

    if (!cancelled) {
      return false;
    }

    this.abortExecution(workerId, statusDetail);
    this.clearExecution(workerId);
    await this.deps.eventBus.emit({
      type: "worker_cancelled",
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      workerId,
      task: worker.task,
      source: worker.type === "pattern_worker" ? "pattern" : "user",
      originMessageId: worker.originMessageId ?? null,
      reason: statusDetail,
    });
    return true;
  }

  async cancelHotPathWorker(workerId: string, reason: HotPathWorkerCancellationReason): Promise<CancelWorkerResult> {
    const worker = await this.getWorker(workerId);
    if (!worker) {
      return {
        cancelled: false,
        workerId,
        error: "Worker was not found.",
        instruction: "Do not retry this cancellation. If the user still needs the work, delegate a fresh worker.",
      };
    }

    if (worker.type !== "general") {
      return {
        cancelled: false,
        workerId,
        error: "Only active general workers can be cancelled from the hot path.",
        instruction: "Do not cancel Pattern management or automation workers. Continue with the user's request normally.",
      };
    }

    if (worker.state !== "created" && worker.state !== "running") {
      return {
        cancelled: false,
        workerId,
        error: `Worker is already ${worker.state}.`,
        instruction: "Do not retry this cancellation. Use the current worker result/status or delegate a fresh worker if needed.",
      };
    }

    const cancelled = await this.cancel(workerId, {
      detail: `Cancelled by hot path: ${reason}.`,
    });

    if (!cancelled) {
      return {
        cancelled: false,
        workerId,
        error: "Worker could not be cancelled because it changed state.",
        instruction: "Do not retry this cancellation. Use the current worker result/status or delegate a fresh worker if needed.",
      };
    }

    return {
      cancelled: true,
      workerId,
      task: worker.task,
      reason,
    };
  }

  async shutdownAll(): Promise<void> {
    const workerIds = [...this.activeExecutions.keys()];
    await Promise.all(workerIds.map(async (workerId) => this.cancel(workerId)));
    await this.flushPendingRuntimeCleanups();
  }

  readonly updateWorkerStatus: UpdateWorkerStatusFn = async (workerId, kind, detail) => {
    const worker = await this.getWorker(workerId);
    if (!worker || terminalStates.includes(worker.state)) {
      return;
    }

    const statusDetail = sanitizePostgresText(typeof detail === "string" ? detail : detail.summary);

    await this.deps.db
      .update(schema.workers)
      .set({
        statusDetail,
        updatedAt: new Date(),
      })
      .where(eq(schema.workers.id, workerId));

    await this.deps.eventBus.emit({
      type: "worker_status",
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      workerId,
      status: kind,
      detail: statusDetail,
    });
  };

  private async runWorker(workerId: string, opts: SpawnWorkerOpts, initialMessages: WorkerRunMessage[] = []): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      void this.handleTimeout(workerId);
    }, this.deps.config.workerTimeoutMs);

    this.activeExecutions.set(workerId, { timeout, abortController });

    await withSpan(this.tracer, "worker-manager.runWorker", {
      "worker.id": workerId,
      "worker.type": opts.type ?? "general",
      "worker.task": opts.task.slice(0, 256),
      "worker.hasContext": Boolean(opts.context),
      "worker.isFollowUp": initialMessages.length > 0,
    }, async (span) => {
      let runtimeConfig: WorkerRuntimeConfig | null = null;
      let pausedRuntimeCleanup: PendingRuntimeCleanup | null = null;
      try {
        const current = await this.getWorker(workerId);
        if (!current || current.state === "cancelled") {
          span.setAttribute("worker.skipped", true);
          this.clearExecution(workerId);
          return;
        }

        const [claimed] = await this.deps.db
          .update(schema.workers)
          .set({
            state: "running",
            updatedAt: new Date(),
          })
          .where(and(eq(schema.workers.id, workerId), eq(schema.workers.state, "created")))
          .returning({ id: schema.workers.id });

        if (!claimed) {
          span.setAttribute("worker.skipped", true);
          return;
        }

        await this.deps.eventBus.emit({
          type: "worker_started",
          tenantId: this.deps.user.tenantId,
          userId: this.deps.user.userId,
          workerId,
          task: opts.task,
        });

        pausedRuntimeCleanup = this.cancelPendingRuntimeCleanup(workerId);
        runtimeConfig = await this.getWorkerTools(opts.type ?? "general", { source: opts.source, pattern: opts.pattern, workerId });
        pausedRuntimeCleanup = null;
        const agent = new WorkerAgent({
          task: opts.task,
          context: opts.context ?? "",
          currentTime: new Date(),
          timeZone: this.deps.user.timezone || this.deps.config.userTimezone,
          user: this.deps.user,
          tools: runtimeConfig.tools,
          promptAppendix: runtimeConfig.promptAppendix,
          model: this.deps.llmManager.getModel("worker"),
          requestOptions: this.deps.llmManager.getRequestOptions("worker", workerId),
          compactionModel: this.deps.llmManager.getModel("compactor"),
          compactionRequestOptions: this.deps.llmManager.getRequestOptions("compactor", workerId),
          workerId,
          onStatus: async (kind, detail) => {
            await this.updateWorkerStatus(workerId, kind, detail);
          },
          maxTurns: this.deps.config.maxTurns.worker,
          maxToolCalls: this.deps.config.workerLimits.maxToolCalls,
          maxPromptTokens: Math.floor(this.deps.llmManager.getMaxContextTokens("worker") * 0.9),
          forceToolChoice: this.deps.config.llm.forceToolChoice,
          workerType: opts.type ?? "general",
          source: opts.source,
          abortSignal: abortController.signal,
          initialMessages,
          toolOutputArtifacts: runtimeConfig.toolOutputArtifacts,
          onToolCallCountChange: async (toolCallsUsed) => {
            await this.deps.db
              .update(schema.workers)
              .set({
                toolCallsUsed,
                updatedAt: new Date(),
              })
              .where(eq(schema.workers.id, workerId));
          },
          onMessagesChange: async (modelMessages) => {
            await this.deps.db
              .update(schema.workers)
              .set({
                modelMessages: sanitizePostgresJson(modelMessages),
                updatedAt: new Date(),
              })
              .where(eq(schema.workers.id, workerId));
          },
        });

        const result = await agent.run();
        span.setAttribute("worker.result.hasError", Boolean(result.error));
        span.setAttribute("worker.result.summary", result.summary.slice(0, 256));
        await this.finalizeWorker(workerId, opts, result, agent.getPatternNotifyOutcome());
      } catch (error) {
        if (!runtimeConfig && pausedRuntimeCleanup) {
          this.restorePendingRuntimeCleanup(workerId, pausedRuntimeCleanup);
          pausedRuntimeCleanup = null;
        }
        const abortMessage = getAbortErrorMessage(error);
        if (abortMessage) {
          const worker = await this.getWorker(workerId);
          if (!worker || worker.state === "cancelled") {
            span.setAttribute("worker.result.aborted", true);
            return;
          }
        }

        span.setAttribute("worker.result.hasError", true);
        this.logger.error({ error, workerId, task: opts.task }, "worker manager run failed");
        const message = error instanceof Error ? error.message : String(error);
        await this.failWorker(workerId, message, opts);
      } finally {
        await this.cleanupRuntime(workerId, runtimeConfig);
        this.clearExecution(workerId);
      }
    });
  }

  private async finalizeWorker(
    workerId: string,
    opts: SpawnWorkerOpts,
    result: WorkerResult,
    patternNotifyOutcome: PatternNotifyOutcome | null,
  ): Promise<void> {
    const worker = await this.getWorker(workerId);
    if (!worker || worker.state === "cancelled") {
      return;
    }

    const now = new Date();
    const state: WorkerState = result.error ? "failed" : "done";
    const sanitizedResult = sanitizePostgresJson(result);
    const sanitizedPatternNotifyOutcome = patternNotifyOutcome
      ? sanitizePostgresJson(patternNotifyOutcome)
      : null;
    const followUpExpiresAt = state === "done" && opts.source !== "pattern" && worker.type !== "pattern_worker"
      ? new Date(now.getTime() + workerFollowUpWindowMs)
      : null;

    await this.deps.db
      .update(schema.workers)
      .set({
        state,
        result: sanitizedResult,
        statusDetail: sanitizePostgresText(result.summary),
        followUpExpiresAt,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(schema.workers.id, workerId));

    if (state === "done") {
      await this.deps.eventBus.emit({
        type: "worker_completed",
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        workerId,
        task: opts.task,
        result: sanitizedResult,
        ...(opts.source === "pattern" && sanitizedPatternNotifyOutcome ? { patternNotifyOutcome: sanitizedPatternNotifyOutcome } : {}),
        source: opts.source,
        originSource: resolveWorkerOriginSource(opts),
        originMessageId: worker.originMessageId ?? null,
      });
      return;
    }

    await this.deps.eventBus.emit({
      type: "worker_failed",
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      workerId,
      task: worker.task,
      error: sanitizePostgresText(result.error ?? result.summary),
      source: opts.source,
      originSource: resolveWorkerOriginSource(opts),
      originMessageId: worker.originMessageId ?? null,
    });
  }

  private async failWorker(workerId: string, error: string, opts: SpawnWorkerOpts): Promise<void> {
    const worker = await this.getWorker(workerId);
    if (!worker || worker.state === "cancelled") {
      return;
    }

    const result: WorkerResult = {
      summary: "Worker execution failed.",
      error: sanitizePostgresText(error),
    };

    const now = new Date();

    await this.deps.db
      .update(schema.workers)
      .set({
        state: "failed",
        result: sanitizePostgresJson(result),
        statusDetail: sanitizePostgresText(error),
        followUpExpiresAt: null,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(schema.workers.id, workerId));

    await this.deps.eventBus.emit({
      type: "worker_failed",
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      workerId,
      task: worker.task,
      error: sanitizePostgresText(error),
      source: opts.source,
      originSource: resolveWorkerOriginSource(opts),
      originMessageId: worker.originMessageId ?? null,
    });
  }

  private async handleTimeout(workerId: string): Promise<void> {
    const worker = await this.getWorker(workerId);
    if (!worker || terminalStates.includes(worker.state)) {
      this.clearExecution(workerId);
      return;
    }

    await this.deps.db
      .update(schema.workers)
      .set({
        statusDetail: sanitizePostgresText(`Timed out after ${this.deps.config.workerTimeoutMs}ms.`),
        updatedAt: new Date(),
      })
      .where(eq(schema.workers.id, workerId));

    await this.cancel(workerId);
  }

  private async cleanupRuntime(workerId: string, runtimeConfig: WorkerRuntimeConfig | null): Promise<void> {
    if (!runtimeConfig?.cleanup) {
      return;
    }

    try {
      const worker = await this.getWorker(workerId);
      const now = Date.now();
      const cleanupAt = worker?.state === "done" && worker.followUpExpiresAt
        ? worker.followUpExpiresAt.getTime()
        : 0;
      const delayMs = Math.max(0, cleanupAt - now);
      if (delayMs > 0) {
        await runtimeConfig.cleanup({ preserveTemporaryWorkspace: true });
        this.scheduleRuntimeCleanup(workerId, runtimeConfig, delayMs);
        return;
      }

      await runtimeConfig.cleanup();
    } catch (error) {
      this.logger.warn({ error, workerId }, "worker runtime cleanup failed");
    }
  }

  private scheduleRuntimeCleanup(workerId: string, runtimeConfig: WorkerRuntimeConfig, delayMs: number): void {
    this.cancelPendingRuntimeCleanup(workerId);
    const cleanup = async () => {
      try {
        await runtimeConfig.cleanup?.();
      } catch (error) {
        this.logger.warn({ error, workerId }, "deferred worker runtime cleanup failed");
      }
    };
    const runAt = Date.now() + delayMs;
    const timeout = setTimeout(() => {
      this.pendingRuntimeCleanups.delete(workerId);
      void cleanup();
    }, delayMs);
    timeout.unref?.();
    this.pendingRuntimeCleanups.set(workerId, { timeout, cleanup, runAt });
  }

  private cancelPendingRuntimeCleanup(workerId: string): PendingRuntimeCleanup | null {
    const pending = this.pendingRuntimeCleanups.get(workerId);
    if (!pending) {
      return null;
    }
    clearTimeout(pending.timeout);
    this.pendingRuntimeCleanups.delete(workerId);
    return pending;
  }

  private restorePendingRuntimeCleanup(workerId: string, pending: PendingRuntimeCleanup): void {
    this.cancelPendingRuntimeCleanup(workerId);
    const delayMs = Math.max(0, pending.runAt - Date.now());
    const timeout = setTimeout(() => {
      this.pendingRuntimeCleanups.delete(workerId);
      void pending.cleanup();
    }, delayMs);
    timeout.unref?.();
    this.pendingRuntimeCleanups.set(workerId, {
      cleanup: pending.cleanup,
      runAt: pending.runAt,
      timeout,
    });
  }

  private async flushPendingRuntimeCleanups(): Promise<void> {
    const pendingCleanups = [...this.pendingRuntimeCleanups.values()];
    this.pendingRuntimeCleanups.clear();
    for (const pending of pendingCleanups) {
      clearTimeout(pending.timeout);
    }
    await Promise.allSettled(pendingCleanups.map((pending) => pending.cleanup()));
  }

  private clearExecution(workerId: string): void {
    const execution = this.activeExecutions.get(workerId);
    if (!execution) {
      return;
    }

    clearTimeout(execution.timeout);
    this.activeExecutions.delete(workerId);
  }

  private abortExecution(workerId: string, reason: string): void {
    const execution = this.activeExecutions.get(workerId);
    if (!execution || execution.abortController.signal.aborted) {
      return;
    }

    const error = new Error(reason);
    error.name = "AbortError";
    execution.abortController.abort(error);
  }

  private async getWorker(workerId: string): Promise<WorkerRecord | undefined> {
    const [worker] = await this.deps.db
      .select()
      .from(schema.workers)
      .where(and(
        eq(schema.workers.id, workerId),
        eq(schema.workers.tenantId, this.deps.user.tenantId),
        eq(schema.workers.userId, this.deps.user.userId),
      ))
      .limit(1);

    return worker;
  }
}
