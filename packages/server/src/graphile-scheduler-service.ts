import { createLogger, type AppConfig } from "@finn/core";
import type { PatternScheduler } from "@finn/patterns";
import { createHash } from "crypto";
import {
  Logger as GraphileLogger,
  run as runGraphileWorker,
  runMigrations as runGraphileMigrations,
  type AddJobFunction,
  type LogFunctionFactory,
  type Runner,
  type RunnerOptions,
  type TaskList,
} from "graphile-worker";
import type { MyDayRefreshService } from "./my-day-refresh-service.js";
import type { PersonalIntelligenceService } from "./personal-intelligence-service.js";
import type { UserRegistry } from "./user-registry.js";

const logger = createLogger("graphile-scheduler");
const graphileWorkerLogger = createGraphileWorkerLogger();
const minimumRecurringDuplicateWindowMs = 5_000;

export const graphileSchedulerTasks = {
  patternTick: "finn/scheduler/pattern_tick",
  myDayTick: "finn/scheduler/my_day_tick",
  myDayRefreshUser: "finn/scheduler/my_day_refresh_user",
  personalIntelligenceTick: "finn/scheduler/personal_intelligence_tick",
  personalIntelligenceConnector: "finn/scheduler/personal_intelligence_connector",
} as const;

type GraphileSchedulerTask = (typeof graphileSchedulerTasks)[keyof typeof graphileSchedulerTasks];

const recurringGraphileSchedulerTasks = [
  graphileSchedulerTasks.patternTick,
  graphileSchedulerTasks.myDayTick,
  graphileSchedulerTasks.personalIntelligenceTick,
] as const satisfies readonly GraphileSchedulerTask[];

interface ScheduledTaskStatus {
  task: GraphileSchedulerTask;
  intervalMs: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
}

export interface GraphileSchedulerStatus {
  enabled: boolean;
  running: boolean;
  migrated: boolean;
  concurrency: number;
  maxPoolSize: number;
  pollIntervalMs: number;
  lastError: string | null;
  tasks: Record<GraphileSchedulerTask, ScheduledTaskStatus>;
}

interface GraphileSchedulerTaskDeps {
  patternScheduler: Pick<PatternScheduler, "tick">;
  myDayRefreshService: Pick<MyDayRefreshService, "listDueRefreshJobs" | "refreshDueUser">;
  personalIntelligenceService: Pick<PersonalIntelligenceService, "listDueConnectorJobs" | "ingestDueConnector">;
  users: Pick<UserRegistry, "requireUser">;
}

interface GraphileSchedulerDeps extends GraphileSchedulerTaskDeps {
  config: AppConfig;
  graphile?: {
    migrate(options: RunnerOptions): Promise<void>;
    run(options: RunnerOptions): Promise<Runner>;
  };
}

const defaultGraphile = {
  migrate: runGraphileMigrations,
  run: runGraphileWorker,
};

export class GraphileSchedulerService {
  private runner: Runner | null = null;
  private migrated = false;
  private running = false;
  private lastError: string | null = null;
  private readonly graphile: NonNullable<GraphileSchedulerDeps["graphile"]>;
  private readonly taskStatus: Record<GraphileSchedulerTask, ScheduledTaskStatus>;

  constructor(private readonly deps: GraphileSchedulerDeps) {
    this.graphile = deps.graphile ?? defaultGraphile;
    this.taskStatus = {
      [graphileSchedulerTasks.patternTick]: this.createTaskStatus(
        graphileSchedulerTasks.patternTick,
        deps.config.scheduler.graphile.patternTickMs,
      ),
      [graphileSchedulerTasks.myDayTick]: this.createTaskStatus(
        graphileSchedulerTasks.myDayTick,
        deps.config.scheduler.graphile.myDayTickMs,
      ),
      [graphileSchedulerTasks.personalIntelligenceTick]: this.createTaskStatus(
        graphileSchedulerTasks.personalIntelligenceTick,
        deps.config.scheduler.graphile.personalIntelligenceTickMs,
      ),
      [graphileSchedulerTasks.myDayRefreshUser]: this.createTaskStatus(
        graphileSchedulerTasks.myDayRefreshUser,
        0,
      ),
      [graphileSchedulerTasks.personalIntelligenceConnector]: this.createTaskStatus(
        graphileSchedulerTasks.personalIntelligenceConnector,
        0,
      ),
    };
  }

  async start(): Promise<void> {
    if (this.runner) {
      return;
    }

    const options = this.buildRunnerOptions();
    await this.graphile.migrate(options);
    this.migrated = true;

    this.runner = await this.graphile.run(options);
    this.running = true;
    this.runner.promise.catch((error: unknown) => {
      this.running = false;
      this.lastError = getErrorMessage(error);
      logger.error({ error }, "Graphile scheduler runner failed");
    });

    await this.seedRecurringTasks(this.runner.addJob, new Date());
  }

  async stop(): Promise<void> {
    const runner = this.runner;
    if (!runner) {
      return;
    }

    this.runner = null;
    this.running = false;
    await runner.stop();
  }

  getStatus(): GraphileSchedulerStatus {
    const graphileConfig = this.deps.config.scheduler.graphile;
    return {
      enabled: true,
      running: this.running,
      migrated: this.migrated,
      concurrency: graphileConfig.concurrency,
      maxPoolSize: graphileConfig.maxPoolSize,
      pollIntervalMs: graphileConfig.pollIntervalMs,
      lastError: this.lastError,
      tasks: this.taskStatus,
    };
  }

  private buildRunnerOptions(): RunnerOptions {
    const graphileConfig = this.deps.config.scheduler.graphile;
    return {
      connectionString: this.deps.config.databaseUrl,
      concurrency: graphileConfig.concurrency,
      maxPoolSize: graphileConfig.maxPoolSize,
      pollInterval: graphileConfig.pollIntervalMs,
      noHandleSignals: true,
      logger: graphileWorkerLogger,
      taskList: this.createTaskList(),
    };
  }

  private createTaskList(): TaskList {
    return {
      [graphileSchedulerTasks.patternTick]: async (_payload, helpers) => {
        await this.runRecurringTask(graphileSchedulerTasks.patternTick, helpers.addJob, () => this.deps.patternScheduler.tick());
      },
      [graphileSchedulerTasks.myDayTick]: async (_payload, helpers) => {
        await this.runRecurringTask(graphileSchedulerTasks.myDayTick, helpers.addJob, async () => {
          const dueJobs = await this.deps.myDayRefreshService.listDueRefreshJobs();
          await Promise.all(dueJobs.map((job) => helpers.addJob(graphileSchedulerTasks.myDayRefreshUser, job, {
            jobKey: job.jobKey,
            jobKeyMode: "replace",
            queueName: "finn_automation",
            maxAttempts: 1,
            runAt: buildJitteredRunAt(job.scheduledAt, job.jobKey, this.deps.config.scheduler.graphile.myDayScheduledJitterMs),
          })));
        });
      },
      [graphileSchedulerTasks.personalIntelligenceTick]: async (_payload, helpers) => {
        await this.runRecurringTask(
          graphileSchedulerTasks.personalIntelligenceTick,
          helpers.addJob,
          async () => {
            const dueJobs = await this.deps.personalIntelligenceService.listDueConnectorJobs();
            await Promise.all(dueJobs.map((job) => helpers.addJob(graphileSchedulerTasks.personalIntelligenceConnector, job, {
              jobKey: job.jobKey,
              jobKeyMode: "replace",
              queueName: "finn_automation",
              maxAttempts: 1,
              runAt: buildJitteredRunAt(job.scheduledAt, job.jobKey, this.deps.config.scheduler.graphile.personalIntelligenceScheduledJitterMs),
            })));
          },
        );
      },
      [graphileSchedulerTasks.myDayRefreshUser]: async (payload) => {
        await this.runMyDayRefreshUserTask(payload);
      },
      [graphileSchedulerTasks.personalIntelligenceConnector]: async (payload) => {
        await this.runPersonalIntelligenceConnectorTask(payload);
      },
    };
  }

  private async runRecurringTask(task: GraphileSchedulerTask, addJob: AddJobFunction, execute: () => Promise<void>): Promise<void> {
    const status = this.taskStatus[task];
    const startedAt = new Date();
    if (this.isDuplicateRecurringTask(task, startedAt)) {
      return;
    }

    status.lastStartedAt = startedAt.toISOString();
    status.lastError = null;
    try {
      await execute();
    } catch (error) {
      const message = getErrorMessage(error);
      status.lastError = message;
      this.lastError = message;
      logger.error({ error, task }, "Graphile scheduled task failed");
    } finally {
      status.lastCompletedAt = new Date().toISOString();
      await this.enqueueRecurringTask(addJob, task, new Date(Date.now() + status.intervalMs));
    }
  }

  private isDuplicateRecurringTask(task: GraphileSchedulerTask, startedAt: Date): boolean {
    const status = this.taskStatus[task];
    if (status.intervalMs <= 0 || !status.lastStartedAt) {
      return false;
    }

    const previousStartedAt = Date.parse(status.lastStartedAt);
    if (Number.isNaN(previousStartedAt)) {
      return false;
    }

    const duplicateWindowMs = Math.min(minimumRecurringDuplicateWindowMs, Math.floor(status.intervalMs / 2));
    return startedAt.getTime() - previousStartedAt < duplicateWindowMs;
  }

  private async seedRecurringTasks(addJob: AddJobFunction, runAt: Date): Promise<void> {
    await Promise.all(
      recurringGraphileSchedulerTasks
        .map((task) => this.enqueueRecurringTask(addJob, task, runAt)),
    );
  }

  private async enqueueRecurringTask(addJob: AddJobFunction, task: GraphileSchedulerTask, runAt: Date): Promise<void> {
    this.taskStatus[task].nextRunAt = runAt.toISOString();
    await addJob(task, {}, {
      runAt,
      jobKey: buildRecurringTaskJobKey(task, runAt),
      jobKeyMode: "replace",
      queueName: "finn_scheduler",
      maxAttempts: 1,
    });
  }

  private createTaskStatus(task: GraphileSchedulerTask, intervalMs: number): ScheduledTaskStatus {
    return {
      task,
      intervalMs,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastError: null,
    };
  }

  private async runMyDayRefreshUserTask(payload: unknown): Promise<void> {
    const input = parseMyDayRefreshUserPayload(payload);
    this.taskStatus[graphileSchedulerTasks.myDayRefreshUser].lastStartedAt = new Date().toISOString();
    try {
      const user = await this.deps.users.requireUser(input.userId);
      await this.deps.myDayRefreshService.refreshDueUser(user, new Date(input.scheduledAt));
      this.taskStatus[graphileSchedulerTasks.myDayRefreshUser].lastError = null;
    } catch (error) {
      const message = getErrorMessage(error);
      this.taskStatus[graphileSchedulerTasks.myDayRefreshUser].lastError = message;
      this.lastError = message;
      logger.error({ error, tenantId: input.tenantId, userId: input.userId }, "Graphile My Day refresh user task failed");
    } finally {
      this.taskStatus[graphileSchedulerTasks.myDayRefreshUser].lastCompletedAt = new Date().toISOString();
    }
  }

  private async runPersonalIntelligenceConnectorTask(payload: unknown): Promise<void> {
    const input = parsePersonalIntelligenceConnectorPayload(payload);
    this.taskStatus[graphileSchedulerTasks.personalIntelligenceConnector].lastStartedAt = new Date().toISOString();
    try {
      const user = await this.deps.users.requireUser(input.userId);
      await this.deps.personalIntelligenceService.ingestDueConnector(user, input, new Date(input.scheduledAt));
      this.taskStatus[graphileSchedulerTasks.personalIntelligenceConnector].lastError = null;
    } catch (error) {
      const message = getErrorMessage(error);
      this.taskStatus[graphileSchedulerTasks.personalIntelligenceConnector].lastError = message;
      this.lastError = message;
      logger.error({
        error,
        tenantId: input.tenantId,
        userId: input.userId,
        toolkitSlug: input.toolkitSlug,
        accountScopeId: input.accountScopeId,
        connectedAccountId: input.connectedAccountId,
      }, "Graphile Personal Intelligence connector task failed");
    } finally {
      this.taskStatus[graphileSchedulerTasks.personalIntelligenceConnector].lastCompletedAt = new Date().toISOString();
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Unknown scheduler error";
}

function buildRecurringTaskJobKey(task: GraphileSchedulerTask, runAt: Date): string {
  return `finn:${task}:${runAt.toISOString()}`;
}

function buildJitteredRunAt(scheduledAt: string, stableKey: string, maxJitterMs: number): Date {
  const baseTime = Date.parse(scheduledAt);
  if (Number.isNaN(baseTime)) {
    throw new Error(`Invalid scheduledAt for jittered Graphile job: ${scheduledAt}`);
  }

  return new Date(baseTime + deterministicJitterMs(stableKey, maxJitterMs));
}

function deterministicJitterMs(stableKey: string, maxJitterMs: number): number {
  if (maxJitterMs <= 0) {
    return 0;
  }

  const digest = createHash("sha256").update(stableKey).digest();
  return digest.readUInt32BE(0) % (maxJitterMs + 1);
}

function parseMyDayRefreshUserPayload(payload: unknown): {
  tenantId: string;
  userId: string;
  scheduledAt: string;
} {
  const input = parsePayloadRecord(payload, graphileSchedulerTasks.myDayRefreshUser);
  return {
    tenantId: parsePayloadString(input, "tenantId", graphileSchedulerTasks.myDayRefreshUser),
    userId: parsePayloadString(input, "userId", graphileSchedulerTasks.myDayRefreshUser),
    scheduledAt: parsePayloadString(input, "scheduledAt", graphileSchedulerTasks.myDayRefreshUser),
  };
}

function parsePersonalIntelligenceConnectorPayload(payload: unknown): {
  tenantId: string;
  userId: string;
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  scheduledAt: string;
} {
  const input = parsePayloadRecord(payload, graphileSchedulerTasks.personalIntelligenceConnector);
  return {
    tenantId: parsePayloadString(input, "tenantId", graphileSchedulerTasks.personalIntelligenceConnector),
    userId: parsePayloadString(input, "userId", graphileSchedulerTasks.personalIntelligenceConnector),
    toolkitSlug: parsePayloadString(input, "toolkitSlug", graphileSchedulerTasks.personalIntelligenceConnector),
    accountScopeId: parsePayloadString(input, "accountScopeId", graphileSchedulerTasks.personalIntelligenceConnector),
    connectedAccountId: parsePayloadString(input, "connectedAccountId", graphileSchedulerTasks.personalIntelligenceConnector),
    scheduledAt: parsePayloadString(input, "scheduledAt", graphileSchedulerTasks.personalIntelligenceConnector),
  };
}

function parsePayloadRecord(payload: unknown, task: GraphileSchedulerTask): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid ${task} payload.`);
  }

  return payload as Record<string, unknown>;
}

function parsePayloadString(payload: Record<string, unknown>, key: string, task: GraphileSchedulerTask): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${task} payload: ${key} is required.`);
  }

  return value;
}

function createGraphileWorkerLogger(): GraphileLogger {
  const graphileLogFactory: LogFunctionFactory = (scope) => (level, message, meta) => {
    if (shouldDropGraphileWorkerLog(level, meta)) {
      return;
    }

    const fields = buildGraphileLogFields(scope, meta);
    switch (level) {
      case "error":
        logger.error(fields, message);
        return;
      case "warning":
        logger.warn(fields, message);
        return;
      case "debug":
      case "info":
      default:
        logger.debug(fields, message);
    }
  };

  return new GraphileLogger(graphileLogFactory);
}

function shouldDropGraphileWorkerLog(level: string, meta?: Record<string, unknown>): boolean {
  if (level !== "info" || meta?.["success"] !== true) {
    return false;
  }

  const job = parseGraphileLogJob(meta["job"]);
  return isRecurringSchedulerTask(job?.taskIdentifier);
}

function isRecurringSchedulerTask(taskIdentifier: string | undefined): boolean {
  return taskIdentifier === graphileSchedulerTasks.patternTick
    || taskIdentifier === graphileSchedulerTasks.myDayTick
    || taskIdentifier === graphileSchedulerTasks.personalIntelligenceTick;
}

function buildGraphileLogFields(
  scope: {
    label?: string;
    workerId?: string;
    taskIdentifier?: string;
    jobId?: string;
  },
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  const job = parseGraphileLogJob(meta?.["job"]);
  return {
    graphile: {
      label: scope.label,
      workerId: scope.workerId,
      task: job?.taskIdentifier ?? scope.taskIdentifier,
      jobId: job?.id ?? scope.jobId,
      durationMs: typeof meta?.["duration"] === "number" ? meta["duration"] : undefined,
      success: typeof meta?.["success"] === "boolean" ? meta["success"] : undefined,
      failure: typeof meta?.["failure"] === "boolean" ? meta["failure"] : undefined,
    },
    error: meta?.["error"],
  };
}

function parseGraphileLogJob(input: unknown): { id?: string | number; taskIdentifier?: string } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = typeof record["id"] === "string" || typeof record["id"] === "number"
    ? record["id"]
    : undefined;
  const taskIdentifier = typeof record["task_identifier"] === "string"
    ? record["task_identifier"]
    : undefined;

  return id === undefined && taskIdentifier === undefined ? null : { id, taskIdentifier };
}
