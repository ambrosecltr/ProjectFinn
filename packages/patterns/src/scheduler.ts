import { createLogger, getTracer, withSpan, type AppConfig, type EventBus, type PatternNotifyOutcome, type PatternRecord, type PatternRunRecord, type PatternRunToolScope, type SpawnWorkerFn, type WorkerResult } from "@finn/core";
import { isOneShotScheduleConfig, PatternStore } from "./store.js";

const recentRunContextLimit = 5;

export interface PatternOutcomeRecorder {
  recordPatternRunOutcome(input: {
    pattern: PatternRecord;
    run: PatternRunRecord;
    result: WorkerResult;
    notifyOutcome: PatternNotifyOutcome;
  }): Promise<void>;
}

function applyNotifyCondition(pattern: PatternRecord, outcome: PatternNotifyOutcome): PatternNotifyOutcome {
  if (pattern.notifyCondition.type === "worker_decision") {
    return outcome;
  }

  return {
    ...outcome,
    notify: pattern.notifyCondition.type === "always",
  };
}

function formatRuntimeTimestamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

function formatRunHistory(runs: PatternRunRecord[], timeZone: string): string {
  return runs.map((run) => {
    const summary = run.notifyOutcome?.summary ?? run.result?.summary ?? run.error ?? "no summary";
    return `- runId=${run.id} time=${formatRuntimeTimestamp(run.createdAt, timeZone)} summary=${summary}`;
  }).join("\n");
}

function buildPatternRunToolScope(pattern: PatternRecord): PatternRunToolScope {
  return {
    connectorScope: pattern.connectorScope,
  };
}

function getReminderContext(pattern: PatternRecord) {
  return pattern.reminderContext ?? {
    reminderText: pattern.userDescription ?? pattern.taskPrompt,
    reason: pattern.taskPrompt,
    supportingContext: pattern.description,
  };
}

export interface PatternSchedulerDeps {
  store: PatternStore;
  spawnWorker: SpawnWorkerFn;
  eventBus: EventBus;
  config: AppConfig;
  outcomeRecorder?: PatternOutcomeRecorder;
  beforeRunPattern?: (pattern: PatternRecord, triggeredBy: "schedule" | "manual" | "composio") => Promise<boolean>;
}

export class PatternScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger = createLogger("pattern-scheduler");
  private readonly tracer = getTracer("patterns");
  private readonly checkIntervalMs = 60_000;
  private readonly oneShotFailureRetryLimit = 3;
  private readonly oneShotRetryBaseMs = 60_000;
  private isTicking = false;

  constructor(private readonly deps: PatternSchedulerDeps) {
    deps.eventBus.on("worker_completed", async (event) => {
      if (event.source !== "pattern") return;
      const workerNotifyOutcome = event.patternNotifyOutcome;
      if (!workerNotifyOutcome) {
        await this.handlePatternRunFailure(event.workerId, `Pattern worker ${event.workerId} completed without a notify outcome.`);
        return;
      }

      const pattern = await deps.store.getByWorkerId(event.workerId);
      const notifyOutcome = pattern ? applyNotifyCondition(pattern, workerNotifyOutcome) : workerNotifyOutcome;
      const result = { ...event.result, data: event.result.data ?? notifyOutcome.data };
      const run = await deps.store.markRunCompleted(event.workerId, result, notifyOutcome);
      if (!run) return;
      const completedPattern = pattern ?? await deps.store.getById(run.patternId);
      if (completedPattern && isOneShotScheduleConfig(completedPattern.triggerConfig)) {
        await deps.store.remove(run.patternId);
      }
      await deps.eventBus.emit({
        type: "pattern_run_completed",
        tenantId: run.tenantId,
        userId: run.userId,
        patternId: run.patternId,
        patternName: completedPattern?.name ?? run.patternId,
        runId: run.id,
        workerId: event.workerId,
        task: event.task,
        triggeredBy: run.triggeredBy,
        triggerPayload: run.triggerPayload,
        result,
        notifyOutcome,
      });
      if (completedPattern) {
        const retainedRun = await deps.store.getRun(completedPattern.id, run.id) ?? run;
        void deps.outcomeRecorder?.recordPatternRunOutcome({
          pattern: completedPattern,
          run: retainedRun,
          result,
          notifyOutcome,
        }).catch((error: unknown) => {
          this.logger.error({
            error,
            operation: "retain_pattern_run_outcome",
            tenantId: retainedRun.tenantId,
            userId: retainedRun.userId,
            patternId: completedPattern.id,
            patternRunId: retainedRun.id,
          }, "Pattern memory recording failed");
        });
      }
    });

    deps.eventBus.on("worker_failed", async (event) => {
      if (event.source !== "pattern") return;
      await this.handlePatternRunFailure(event.workerId, event.error);
    });

    deps.eventBus.on("worker_cancelled", async (event) => {
      if (event.source !== "pattern") return;
      await this.handlePatternRunCancellation(event.workerId, event.reason ?? `Pattern worker ${event.workerId} was cancelled.`);
    });
  }

  async start(): Promise<void> {
    if (this.timer) {
      this.logger.warn("Pattern scheduler already started");
      return;
    }

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const duePatterns = await this.deps.store.getDue();
      if (duePatterns.length === 0) return;

      await withSpan(this.tracer, "patterns.tick", {}, async (span) => {
        span.setAttribute("patterns.due_count", duePatterns.length);
        for (const pattern of duePatterns) {
          await this.runPattern(pattern, "schedule");
        }
      });
    } finally {
      this.isTicking = false;
    }
  }

  async runPattern(pattern: PatternRecord, triggeredBy: "schedule" | "manual" | "composio", payload?: Record<string, unknown>): Promise<string> {
    if (this.deps.beforeRunPattern && !await this.deps.beforeRunPattern(pattern, triggeredBy)) {
      this.logger.info({ patternId: pattern.id, triggeredBy }, "Skipping Pattern run because preflight blocked it");
      return "";
    }

    const scheduledClaim = triggeredBy === "schedule"
      ? await this.deps.store.claimScheduledRun(pattern)
      : null;
    if (triggeredBy === "schedule" && !scheduledClaim) {
      this.logger.info({ patternId: pattern.id }, "Skipping Pattern run because another scheduler claimed it");
      return "";
    }

    const run = scheduledClaim?.run ?? await this.deps.store.createRun({ pattern, triggeredBy, triggerPayload: payload ?? null });
    if (pattern.workerType === "reminder") {
      return this.completeReminderPattern(pattern, run, triggeredBy, payload);
    }

    const [recentRuns, previousRunCount] = await Promise.all([
      this.deps.store.listRuns({ patternId: pattern.id, limit: recentRunContextLimit, beforeRunId: run.id }),
      this.deps.store.countRuns({ patternId: pattern.id, beforeRunId: run.id }),
    ]);
    const toolScope = buildPatternRunToolScope(pattern);
    await this.deps.store.recordRunToolScope(run.id, toolScope);
    let workerId: string;
    try {
      workerId = await this.deps.spawnWorker({
        tenantId: pattern.tenantId,
        userId: pattern.userId,
        task: pattern.taskPrompt,
        type: "pattern_worker",
        context: this.formatWorkerContext(pattern, run, recentRuns, previousRunCount, payload),
        source: "pattern",
        pattern: {
          patternId: pattern.id,
          runId: run.id,
          connectorScope: pattern.connectorScope,
        },
      });
    } catch (error) {
      await this.handlePatternRunFailureById(run.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    try {
      await this.deps.store.markRunStarted(run.id, workerId);
    } catch (error) {
      await this.handlePatternRunFailureById(run.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    await this.deps.eventBus.emit({
      type: "pattern_run_started",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      patternId: pattern.id,
      runId: run.id,
      workerId,
    });

    if (triggeredBy !== "schedule") {
      await this.deps.store.update(pattern.id, { lastRunAt: new Date(), failureCount: 0 });
    }

    return workerId;
  }

  private async completeReminderPattern(pattern: PatternRecord, run: PatternRunRecord, triggeredBy: "schedule" | "manual" | "composio", payload?: Record<string, unknown>): Promise<string> {
    const reminder = getReminderContext(pattern);
    const summary = reminder.reminderText;
    const notifyOutcome: PatternNotifyOutcome = {
      notify: true,
      summary,
      reason: reminder.reason,
      data: {
        type: "reminder",
        patternId: pattern.id,
        reminder,
      },
    };
    const result: WorkerResult = {
      summary,
      data: notifyOutcome.data,
    };
    const completedRun = await this.deps.store.markReminderRunCompleted(run.id, result, notifyOutcome);
    if (!completedRun) {
      return run.id;
    }

    if (isOneShotScheduleConfig(pattern.triggerConfig)) {
      await this.deps.store.remove(pattern.id);
    }

    await this.deps.eventBus.emit({
      type: "reminder_triggered",
      tenantId: pattern.tenantId,
      userId: pattern.userId,
      patternId: pattern.id,
      patternName: pattern.name,
      runId: completedRun.id,
      triggeredBy,
      triggerPayload: payload ?? null,
      reminder,
      summary,
    });

    return completedRun.id;
  }

  async skipPattern(pattern: PatternRecord, triggeredBy: "schedule" | "manual" | "composio", payload: Record<string, unknown> | undefined, summary: string): Promise<void> {
    await this.deps.store.createSkippedRun({
      pattern,
      triggeredBy,
      triggerPayload: payload ?? null,
      skipReason: "trigger_filter_no_match",
      result: { summary },
    });

    if (triggeredBy === "schedule") {
      const nextRunAt = pattern.triggerConfig.type === "schedule" && !isOneShotScheduleConfig(pattern.triggerConfig)
        ? this.deps.store.computeNextRun(pattern.triggerConfig, pattern.timezone)
        : null;
      await this.deps.store.updateAfterScheduledRun(pattern, nextRunAt);
    } else {
      await this.deps.store.update(pattern.id, { lastRunAt: new Date() });
    }
  }

  private formatWorkerContext(pattern: PatternRecord, run: PatternRunRecord, recentRuns: PatternRunRecord[], previousRunCount: number, payload?: Record<string, unknown>): string {
    return [
      `Pattern: ${pattern.name}`,
      `Pattern ID: ${pattern.id}`,
      `Current time: ${formatRuntimeTimestamp(new Date(), pattern.timezone)} (${pattern.timezone})`,
      `Trigger event time: ${formatRuntimeTimestamp(run.createdAt, pattern.timezone)} (${pattern.timezone})`,
      `Triggered by: ${run.triggeredBy}`,
      `Notify condition: ${JSON.stringify(pattern.notifyCondition)}`,
      pattern.triggerFilters.length > 0 ? `Trigger filters: ${JSON.stringify(pattern.triggerFilters)}` : null,
      pattern.connectorScope.composio.length > 0 || pattern.connectorScope.mcpServerIds.length > 0 ? `Connector scope: ${JSON.stringify(pattern.connectorScope)}` : null,
      this.formatRecentRunContext(recentRuns, previousRunCount, pattern.timezone),
      payload ? `Trigger payload: ${JSON.stringify(payload)}` : null,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  private formatRecentRunContext(recentRuns: PatternRunRecord[], previousRunCount: number, timeZone: string): string {
    if (recentRuns.length === 0) {
      return "Recent runs for this Pattern only: none";
    }

    const note = previousRunCount > recentRuns.length
      ? `Showing the ${recentRuns.length} most recent of ${previousRunCount} previous runs. Use finn.pattern.runs and finn.pattern.run for older or full details.`
      : `Showing all ${previousRunCount} previous run${previousRunCount === 1 ? "" : "s"}. Use finn.pattern.run for full details.`;

    return `Recent runs for this Pattern only (${note}):\n${formatRunHistory(recentRuns, timeZone)}`;
  }

  private computeOneShotRetryAt(failureCount: number): Date {
    const retryIndex = Math.max(0, failureCount - 1);
    return new Date(Date.now() + this.oneShotRetryBaseMs * 2 ** retryIndex);
  }

  private async handlePatternRunFailure(workerId: string, error: string): Promise<void> {
    const run = await this.deps.store.markRunFailed(workerId, error);
    if (!run) return;
    await this.handleFailedRun(run, error, workerId);
  }

  private async handlePatternRunCancellation(workerId: string, error: string): Promise<void> {
    const run = await this.deps.store.markRunCancelled(workerId, error);
    if (!run) return;
    await this.handleFailedRun(run, error, workerId);
  }

  private async handlePatternRunFailureById(runId: string, error: string): Promise<void> {
    const run = await this.deps.store.markRunFailedById(runId, error);
    if (!run) return;
    await this.handleFailedRun(run, error, run.workerId ?? undefined);
  }

  private async handleFailedRun(run: PatternRunRecord, error: string, workerId?: string): Promise<void> {
    const failCount = await this.deps.store.incrementFailure(run.patternId);
    const pattern = await this.deps.store.getById(run.patternId);

    if (pattern && isOneShotScheduleConfig(pattern.triggerConfig)) {
      if (failCount >= this.oneShotFailureRetryLimit) {
        await this.deps.store.remove(run.patternId);
      } else {
        await this.deps.store.update(run.patternId, {
          active: true,
          nextRunAt: this.computeOneShotRetryAt(failCount),
        });
      }
    } else if (failCount >= this.deps.config.intervals.patternCircuitBreakerThreshold) {
      await this.deps.store.deactivate(run.patternId);
    }

    await this.deps.eventBus.emit({
      type: "pattern_run_failed",
      tenantId: run.tenantId,
      userId: run.userId,
      patternId: run.patternId,
      runId: run.id,
      ...(workerId ? { workerId } : {}),
      error,
    });
  }
}
