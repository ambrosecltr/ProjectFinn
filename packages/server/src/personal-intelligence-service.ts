import { compactWorkerLoopMessages, compactWorkerMessagesWithCheckpoint, wrapToolsWithOutputArtifacts } from "@finn/agents";
import { createFinnTelemetry, createFinnTelemetryContext, createLogger, estimateTokens, getTracer, normalizePhoneNumber, truncate, withSpan, type AppConfig, type UserContext, type WorkerToolOutputArtifactStore } from "@finn/core";
import type { Database, StoredPersonalIntelligenceCheckpoint, UserConnectorConfig } from "@finn/db";
import type { MemoryMetadata, MemoryRecorder } from "@finn/integrations";
import { getAbortErrorMessage, withAnthropicSystemCacheControl, withAnthropicToolCacheControl, withLLMTimeout, type LLMManager } from "@finn/llm";
import { createToolsetRuntime, type CodeModeToolsetSummary } from "@finn/toolsets";
import { createProcessRuntimeServices, type MemoryRuntimeService, type ProcessRuntimeServices, type UserRuntimeServices } from "@finn/runtime";
import { generateText, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { createSearchMemoryTool } from "./automation-memory-tools.js";
import { AutomationRunStore } from "./automation-run-store.js";
import { getConnectorConfig } from "./connector-config.js";
import { buildCheckpointKey, PersonalIntelligenceCheckpointStore, type PersonalIntelligenceCheckpointScope, type PersonalIntelligenceCheckpointUpdate } from "./personal-intelligence-checkpoint-store.js";
import { PersonalIntelligenceSourceStore, type RecordPersonalIntelligenceSourceParams } from "./personal-intelligence-source-store.js";
import {
  filterAvailablePuterToolsets,
  getPuterSourceAvailability,
  puterDeviceIdFromConnectedAccount,
  puterPersonalIntelligenceAccountScopeId,
  puterPersonalIntelligenceMarkersForToolsets,
  puterPersonalIntelligenceToolSlugs,
  puterSourceForToolset,
  puterToolkitName as puterConnectorName,
  puterToolkitSlug,
  puterToolsetForPersonalIntelligenceMarker,
  type PuterLocalAccessStatus,
} from "./puter-connector.js";
import type { PuterBridge } from "./puter-bridge.js";
import { getPersonalIntelligenceAccountScopeId, getPersonalIntelligenceConnectorScope, type PersonalIntelligenceConnectorScope } from "./personal-intelligence-account-scope.js";
import { createCodeModeToolsForToolsetRuntime, createUserFilesCodeModeTools, createUserFilesToolsetDefinition, createUserToolOutputArtifactStore } from "./tool-output-artifacts.js";
import type { UserRegistry } from "./user-registry.js";
import type { UserRuntimeRegistry } from "./user-runtime.js";

const logger = createLogger("personal-intelligence");
const tracer = getTracer("personal-intelligence");
const schedulerTickMs = 5 * 60_000;
const schedulerRunWindowMinutes = Math.ceil((schedulerTickMs * 2) / 60_000);
const checkpointSourceTypes = ["records"] as const;
const maxHandoffSummaryLength = 2400;
const maxRunSummaryLength = 1200;
const maxCheckpointContextItems = 20;
const personalIntelligenceRecentMessageTokens = 24_000;
const personalIntelligenceMaxMessageTokens = 8_000;
const finishPersonalIntelligenceRunToolName = "finish_personal_intelligence_run";

const personalIntelligenceCandidateSchema = z.object({
  toolkitSlug: z.string().trim().min(1).max(80),
  accountScopeId: z.string().trim().min(1).max(300).optional(),
  connectedAccountId: z.string().trim().min(1).max(300),
  sourceType: z.string().trim().min(1).max(80),
  sourceId: z.string().trim().min(1).max(300),
  supportingSourceIds: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  messageId: z.string().trim().min(1).max(300).optional(),
  supportingMessageIds: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  threadId: z.string().trim().min(1).max(300).optional(),
  supportingThreadIds: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  eventId: z.string().trim().min(1).max(300).optional(),
  senderEmail: z.string().trim().min(1).max(320).optional(),
  recipientEmails: z.array(z.string().trim().min(1).max(320)).max(50).optional().default([]),
  attendeeEmails: z.array(z.string().trim().min(1).max(320)).max(100).optional().default([]),
  sourceUrl: z.string().trim().min(1).max(1000).optional(),
  title: z.string().trim().max(300).optional().default(""),
  timestamp: z.string().trim().max(80).optional().default(""),
  content: z.string().trim().min(1).max(5000),
  reason: z.string().trim().min(1).max(700),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional().default({}),
});

const checkpointEntitySchema = z.object({
  label: z.string().trim().min(1).max(160),
  kind: z.string().trim().min(1).max(80).optional().default("entity"),
  reason: z.string().trim().min(1).max(300).optional().default(""),
  sourceIds: z.array(z.string().trim().min(1).max(300)).max(12).optional().default([]),
});

const checkpointGapSchema = z.object({
  toolkitSlug: z.string().trim().min(1).max(80).optional(),
  connectedAccountId: z.string().trim().min(1).max(300).optional(),
  sourceType: z.string().trim().min(1).max(80).optional(),
  reason: z.string().trim().min(1).max(400),
});

const checkpointInputSchema = z.object({
  summary: z.string().trim().min(1).max(maxHandoffSummaryLength),
  coverageEnd: z.string().trim().max(80).optional().default(""),
  lastProcessedSourceTimestamp: z.string().trim().max(80).optional().default(""),
  sourceCursor: z.string().trim().max(500).optional().default(""),
  exploredEntities: z.array(checkpointEntitySchema).max(20).optional().default([]),
  knownGaps: z.array(checkpointGapSchema).max(20).optional().default([]),
});

const personalIntelligenceFinalOutcomeSchema = z.object({
  status: z.enum(["completed", "partial"]),
  auditSummary: z.string().trim().min(1).max(maxRunSummaryLength),
  retainedItems: z.number().int().min(0).max(500).optional().default(0),
  skippedNoise: z.array(z.string().trim().min(1).max(200)).max(12).optional().default([]),
  checkpoint: checkpointInputSchema,
});

export type PersonalIntelligenceCandidate = z.infer<typeof personalIntelligenceCandidateSchema>;

export interface PersonalIntelligenceRunSelection {
  status: "completed" | "partial";
  retainedDocumentIds: string[];
  retainFailures: string[];
  skippedReasons: Record<string, unknown>;
  summary: string;
  checkpoint: PersonalIntelligenceRunCheckpoint;
}

export interface PersonalIntelligenceRunCheckpoint {
  summary: string;
  coverageEnd: Date | null;
  lastProcessedSourceTimestamp: Date | null;
  sourceCursor: string | null;
  exploredEntities: Record<string, unknown>[];
  knownGaps: Record<string, unknown>[];
}

interface PersonalIntelligenceFinalOutcome {
  status: "completed" | "partial";
  summary: string;
  retainedItems: number;
  skippedNoise: string[];
  checkpoint: PersonalIntelligenceRunCheckpoint;
}

type PersonalIntelligenceProcessRuntime = ProcessRuntimeServices & {
  files: NonNullable<ProcessRuntimeServices["files"]>;
  memory: MemoryRuntimeService;
};

interface RunnablePuterToolsets {
  enabled: Set<string>;
  available: Set<string>;
  completed: Set<string>;
  runnable: Set<string>;
  blocked: Array<{ toolset: string; message: string }>;
}

export interface PersonalIntelligenceRunPlan {
  windowStart: Date;
  windowEnd: Date;
  mode: "initial_backfill" | "incremental";
  checkpoints: StoredPersonalIntelligenceCheckpoint[];
  checkpointScopes: PersonalIntelligenceCheckpointScope[];
  previousCoverageEnd: Date | null;
}

interface AllowedPersonalIntelligenceScope extends PersonalIntelligenceConnectorScope {
  sourceType: string;
  enforceSourceType?: boolean;
}

export function buildPersonalIntelligenceCheckpointScopesForTest(connectors: UserConnectorConfig[]): PersonalIntelligenceCheckpointScope[] {
  return buildCheckpointScopes(connectors);
}

export function buildPersonalIntelligenceCheckpointUpdatesForTest(input: {
  connectors: UserConnectorConfig[];
  runPlan: PersonalIntelligenceRunPlan;
  runId: string;
  selection: PersonalIntelligenceRunSelection;
}): PersonalIntelligenceCheckpointUpdate[] {
  return buildCheckpointUpdates(input);
}

export function buildPersonalIntelligenceFallbackCheckpointForTest(input: {
  summary: string;
  runPlan: PersonalIntelligenceRunPlan;
  retainedDocumentIds: string[];
  skippedReasons: Record<string, unknown>;
}): PersonalIntelligenceRunCheckpoint {
  return buildFallbackRunCheckpoint(input);
}

export function getPersonalIntelligenceScheduleDayStartForTest(now: Date, timezone: string): Date {
  return getLocalDayStart(now, timezone);
}

export function getDeferredPersonalIntelligenceRefreshSlotForTest(input: {
  now: Date;
  timezone: string;
  refreshTimes: AppConfig["intervals"]["personalIntelligenceRefreshTimes"];
}): Date | null {
  return getLatestPersonalIntelligenceRefreshSlot(input);
}

export interface PersonalIntelligenceServiceStatus {
  enabled: boolean;
  running: boolean;
  initialBackfillMs: number;
  overlapMs: number;
  refreshTimes: string[];
  timeoutMs: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
}

export interface PersonalIntelligenceDueConnectorJob {
  tenantId: string;
  userId: string;
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  scheduledAt: string;
  jobKey: string;
}

export class PersonalIntelligenceService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly deferredPuterRuns = new Set<string>();
  private lastStartedAt: Date | null = null;
  private lastCompletedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly deps: {
      config: AppConfig;
      db: Database;
      llmManager: LLMManager;
      users: UserRegistry;
      runtimes: UserRuntimeRegistry;
      puterBridge?: PuterBridge;
    },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.ingestDueUsers().catch((error: unknown) => {
        this.lastError = getErrorMessage(error);
        logger.error({ error }, "Personal intelligence scheduler tick failed");
      });
    }, schedulerTickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): PersonalIntelligenceServiceStatus {
    return {
      enabled: this.deps.config.capabilities.integrations.memory,
      running: this.running,
      initialBackfillMs: this.deps.config.intervals.personalIntelligenceInitialBackfillMs,
      overlapMs: this.deps.config.intervals.personalIntelligenceOverlapMs,
      refreshTimes: this.deps.config.intervals.personalIntelligenceRefreshTimes.map(formatRefreshTime),
      timeoutMs: this.deps.config.personalIntelligenceTimeoutMs,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: this.lastCompletedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  async ingestDueUsers(now = new Date()): Promise<void> {
    if (!this.getStatus().enabled || this.running) {
      return;
    }

    this.running = true;
    this.lastStartedAt = now;
    try {
      await this.failStaleRuns(now);
      const runStore = new AutomationRunStore({ db: this.deps.db });
      const users = await this.deps.users.listExistingUsers();
      for (const user of users) {
        if (!shouldRunPersonalIntelligenceNow({
          now,
          timezone: user.timezone,
          refreshTimes: this.deps.config.intervals.personalIntelligenceRefreshTimes,
        })) {
          continue;
        }

        const connectors = await this.getEnabledPersonalIntelligenceConnectors(user);
        if (connectors.length === 0) {
          continue;
        }

        const cutoff = getLocalDayStart(now, user.timezone);
        for (const connector of connectors) {
          const latestCompletedRun = await runStore.getLatestCompletedRunSince(user, "personal_intelligence", cutoff, connectorRunScope(connector));
          if (connector.toolkitSlug === puterToolkitSlug) {
            const deviceId = puterDeviceIdFromConnectedAccount(connector.connectedAccountId);
            const status = deviceId ? this.deps.puterBridge?.getStatus(user, deviceId) : null;
            const enabledToolsets = getPuterPersonalIntelligenceToolsets(connector.enabledTools);
            if (!status?.active || getPendingAvailablePuterToolsets(latestCompletedRun, enabledToolsets, status.access).size === 0) {
              continue;
            }
          } else if (latestCompletedRun) {
            continue;
          }

          try {
            await this.ingestConnector(user, connector, { now });
          } catch (error) {
            this.lastError = getErrorMessage(error);
            logger.error({
              error,
              failureReason: getErrorMessage(error),
              tenantId: user.tenantId,
              userId: user.userId,
              toolkitSlug: connector.toolkitSlug,
              connectedAccountId: connector.connectedAccountId,
            }, "Personal intelligence ingestion failed for connector");
          }
        }
      }
      this.lastCompletedAt = new Date();
    } finally {
      this.running = false;
    }
  }

  async listDueConnectorJobs(now = new Date()): Promise<PersonalIntelligenceDueConnectorJob[]> {
    if (!this.getStatus().enabled) {
      return [];
    }

    await this.failStaleRuns(now);
    const runStore = new AutomationRunStore({ db: this.deps.db });
    const users = await this.deps.users.listExistingUsers();
    const dueJobs: PersonalIntelligenceDueConnectorJob[] = [];
    for (const user of users) {
      const scheduledAt = getCurrentPersonalIntelligenceRefreshSlot({
        now,
        timezone: user.timezone,
        refreshTimes: this.deps.config.intervals.personalIntelligenceRefreshTimes,
      });
      if (!scheduledAt) {
        continue;
      }

      const connectors = await this.getEnabledPersonalIntelligenceConnectors(user);
      if (connectors.length === 0) {
        continue;
      }

      const cutoff = getLocalDayStart(scheduledAt, user.timezone);
      const userLocalDate = getLocalDate(scheduledAt, user.timezone);
      for (const connector of connectors) {
        const scope = connectorRunScope(connector);
        if (!scope.connectedAccountId || !scope.accountScopeId) {
          continue;
        }
        const latestCompletedRun = await runStore.getLatestCompletedRunSince(user, "personal_intelligence", cutoff, scope);
        if (connector.toolkitSlug === puterToolkitSlug) {
          const deviceId = puterDeviceIdFromConnectedAccount(connector.connectedAccountId);
          const status = deviceId ? this.deps.puterBridge?.getStatus(user, deviceId) : null;
          const enabledToolsets = getPuterPersonalIntelligenceToolsets(connector.enabledTools);
          if (!status?.active || getPendingAvailablePuterToolsets(latestCompletedRun, enabledToolsets, status.access).size === 0) {
            continue;
          }
        } else if (latestCompletedRun) {
          continue;
        }

        dueJobs.push({
          tenantId: user.tenantId,
          userId: user.userId,
          toolkitSlug: connector.toolkitSlug,
          accountScopeId: scope.accountScopeId,
          connectedAccountId: scope.connectedAccountId,
          scheduledAt: scheduledAt.toISOString(),
          jobKey: `finn:personal-intelligence:${user.tenantId}:${user.userId}:${connector.toolkitSlug}:${scope.accountScopeId}:${userLocalDate}`,
        });
      }
    }

    return dueJobs;
  }

  private async failStaleRuns(now: Date): Promise<void> {
    const failedCount = await new AutomationRunStore({ db: this.deps.db }).failRunningOlderThan(
      ["personal_intelligence"],
      new Date(now.getTime() - this.deps.config.personalIntelligenceTimeoutMs),
      `Personal intelligence exceeded ${this.deps.config.personalIntelligenceTimeoutMs}ms timeout.`,
    );
    if (failedCount > 0) {
      logger.warn({ failedCount }, "Marked stale personal intelligence runs failed");
    }
  }

  async ingestUser(user: UserContext, options: { now?: Date; toolkitSlug?: string } = {}): Promise<{ runId: string; retainedDocumentIds: string[] }> {
    if (!this.deps.config.capabilities.integrations.memory) {
      return { runId: "", retainedDocumentIds: [] };
    }

    const connectors = (await this.getEnabledPersonalIntelligenceConnectors(user))
      .filter((connector) => !options.toolkitSlug || connector.toolkitSlug === options.toolkitSlug);
    if (connectors.length === 0) {
      return { runId: "", retainedDocumentIds: [] };
    }

    const retainedDocumentIds: string[] = [];
    const runIds: string[] = [];
    for (const connector of connectors) {
      const result = await this.ingestConnector(user, connector, options);
      if (result.runId) {
        runIds.push(result.runId);
      }
      retainedDocumentIds.push(...result.retainedDocumentIds);
    }

    return { runId: runIds.join(","), retainedDocumentIds };
  }

  async ingestConnector(user: UserContext, connector: UserConnectorConfig, options: { now?: Date } = {}): Promise<{ runId: string; retainedDocumentIds: string[] }> {
    if (!this.deps.config.capabilities.integrations.memory || !connector.connectedAccountId) {
      return { runId: "", retainedDocumentIds: [] };
    }
    if (connector.toolkitSlug === puterToolkitSlug) {
      const deviceId = puterDeviceIdFromConnectedAccount(connector.connectedAccountId);
      if (!deviceId || !this.deps.puterBridge?.getStatus(user, deviceId).active) {
        return { runId: "", retainedDocumentIds: [] };
      }
      const result = await this.ingestPuterLive(user, { deviceId, now: options.now });
      return { runId: result.runId, retainedDocumentIds: result.retainedDocumentIds };
    }
    if (!isResolvedComposioPersonalIntelligenceConnector(connector)) {
      return { runId: "", retainedDocumentIds: [] };
    }
    const now = options.now ?? new Date();
    const userRuntime = await this.deps.runtimes.getAutomationRuntimeServices(user);
    const connectors = [connector];
    const checkpointStore = new PersonalIntelligenceCheckpointStore({ db: this.deps.db, user });
    const runPlan = await this.buildRunPlan(user, connectors, now, checkpointStore);

    const runStore = new AutomationRunStore({ db: this.deps.db, user });
    const run = await runStore.start({
      runType: "personal_intelligence",
      ...connectorRunScope(connector),
      windowStart: runPlan.windowStart,
      windowEnd: now,
      contributorStatus: {
        enabledToolkits: connectors.map((connector) => connector.toolkitSlug),
        mode: runPlan.mode,
        previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
      },
    });

    try {
      const tools = await this.loadScopedComposioTools(user, connectors);
      const processRuntime = this.createPersonalIntelligenceProcessRuntime(userRuntime, run.id);
      const recorder = this.requireMemoryRuntime(processRuntime).recorder;
      const selection = await this.runIngestion({
        user,
        runtime: processRuntime,
        runId: run.id,
        now,
        runPlan,
        tools,
        enabledToolkits: connectors.map((connector) => connector.toolkitSlug),
        allowedScopes: buildAllowedPersonalIntelligenceScopes(connectors),
        recorder,
      });
      if (selection.status !== "completed") {
        await runStore.complete(run.id, {
          state: "failed",
          contributorStatus: {
            enabledToolkits: connectors.map((connector) => connector.toolkitSlug),
            retainedItems: selection.retainedDocumentIds.length,
            mode: runPlan.mode,
            status: selection.status,
            retainFailures: selection.retainFailures,
            previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
          },
          resultSummary: selection.summary,
          retainedDocumentIds: selection.retainedDocumentIds,
          skippedReasons: selection.skippedReasons,
          error: "Personal intelligence run finished partial; coverage checkpoint was not advanced.",
        });
        logger.warn({
          runId: run.id,
          tenantId: user.tenantId,
          userId: user.userId,
          toolkitSlug: connector.toolkitSlug,
          connectedAccountId: connector.connectedAccountId,
          retainedCount: selection.retainedDocumentIds.length,
          retainFailures: selection.retainFailures.length,
        }, "Personal intelligence connector ingestion finished partial");
        return { runId: run.id, retainedDocumentIds: selection.retainedDocumentIds };
      }

      const checkpoints = await checkpointStore.upsertMany(buildCheckpointUpdates({
        connectors,
        runPlan,
        runId: run.id,
        selection,
      }));

      await runStore.complete(run.id, {
        state: "done",
        contributorStatus: {
          enabledToolkits: connectors.map((connector) => connector.toolkitSlug),
          retainedItems: selection.retainedDocumentIds.length,
          mode: runPlan.mode,
          status: selection.status,
          checkpointScopes: checkpoints.length,
          previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
          coverageEnd: selection.checkpoint.coverageEnd?.toISOString() ?? runPlan.windowEnd.toISOString(),
        },
        resultSummary: selection.summary,
        retainedDocumentIds: selection.retainedDocumentIds,
        skippedReasons: selection.skippedReasons,
      });
      logger.info({
        runId: run.id,
        tenantId: user.tenantId,
        userId: user.userId,
        toolkitSlug: connector.toolkitSlug,
        connectedAccountId: connector.connectedAccountId,
        retainedCount: selection.retainedDocumentIds.length,
      }, "Personal intelligence connector ingestion completed");
      return { runId: run.id, retainedDocumentIds: selection.retainedDocumentIds };
    } catch (error) {
      await runStore.complete(run.id, {
        state: "failed",
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  async ingestPuterLive(user: UserContext, input: {
    deviceId: string;
    now?: Date;
    toolsets?: Iterable<string>;
  }): Promise<{ runId: string; retainedDocumentIds: string[]; active: boolean }> {
    if (!this.deps.config.capabilities.integrations.memory || !this.deps.puterBridge) {
      return { runId: "", retainedDocumentIds: [], active: false };
    }

    const config = await getConnectorConfig(this.deps.db, user, puterToolkitSlug);
    if (!config?.connected || !config.connectedAccountId || !config.personalIntelligenceEnabled) {
      return { runId: "", retainedDocumentIds: [], active: false };
    }
    if (puterDeviceIdFromConnectedAccount(config.connectedAccountId) !== input.deviceId) {
      return { runId: "", retainedDocumentIds: [], active: false };
    }

    const enabledToolsets = getPuterPersonalIntelligenceToolsets(config.enabledTools);
    if (enabledToolsets.size === 0) {
      return { runId: "", retainedDocumentIds: [], active: false };
    }

    const status = this.deps.puterBridge.getStatus(user, input.deviceId);
    if (!status.active) {
      return { runId: "", retainedDocumentIds: [], active: false };
    }

    const now = input.now ?? new Date();
    const userRuntime = await this.deps.runtimes.getAutomationRuntimeServices(user);
    const runStore = new AutomationRunStore({ db: this.deps.db, user });
    const runnableToolsets = await this.resolveRunnablePuterToolsets(user, {
      enabledToolsets,
      requestedToolsets: input.toolsets,
      access: status.access,
      now,
      runStore,
      config,
    });
    if (runnableToolsets.runnable.size === 0) {
      logger.info({
        tenantId: user.tenantId,
        userId: user.userId,
        deviceId: input.deviceId,
        enabledLocalSources: [...runnableToolsets.enabled],
        availableLocalSources: [...runnableToolsets.available],
        completedLocalSources: [...runnableToolsets.completed],
        blockedLocalSources: runnableToolsets.blocked,
      }, "Skipping Puter personal intelligence; no enabled local source is runnable");
      return { runId: "", retainedDocumentIds: [], active: true };
    }

    const connector = {
      ...config,
      toolkitSlug: puterToolkitSlug,
      toolkitName: puterConnectorName,
      connectedAccountId: config.connectedAccountId,
      enabledTools: puterPersonalIntelligenceMarkersForToolsets(runnableToolsets.runnable),
    };
    const checkpointStore = new PersonalIntelligenceCheckpointStore({ db: this.deps.db, user });
    const runPlan = await this.buildRunPlan(user, [connector], now, checkpointStore);
    const run = await runStore.start({
      runType: "personal_intelligence",
      ...connectorRunScope(connector),
      windowStart: runPlan.windowStart,
      windowEnd: now,
      contributorStatus: {
        enabledToolkits: [puterToolkitSlug],
        enabledLocalSources: [...runnableToolsets.runnable],
        blockedLocalSources: runnableToolsets.blocked,
        mode: runPlan.mode,
        previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
        puterBridge: "live",
      },
    });
    const leaseId = this.deps.puterBridge.createLease(user, {
      deviceId: input.deviceId,
      runId: run.id,
      enabledTools: runnableToolsets.runnable,
    });

    try {
      const processRuntime = this.createPersonalIntelligenceProcessRuntime(userRuntime, run.id);
      const recorder = this.requireMemoryRuntime(processRuntime).recorder;
      const excludedHandles = await this.getPuterExcludedImessageHandles(user);
      const toolOutputArtifacts = createUserToolOutputArtifactStore(processRuntime, run.id);
      const toolsetAccess = await this.createScopedPuterLiveToolsetTools(processRuntime, user, connector, input.deviceId, leaseId, runPlan, toolOutputArtifacts, excludedHandles);
      const selection = await (async () => {
        try {
          return await this.runIngestion({
            user,
            runtime: processRuntime,
            runId: run.id,
            now,
            runPlan,
            tools: toolsetAccess.tools,
            enabledToolkits: [puterToolkitSlug],
            allowedScopes: buildAllowedPersonalIntelligenceScopes([connector]),
            toolsetSummaries: toolsetAccess.summaries,
            recorder,
            toolOutputArtifacts,
          });
        } finally {
          try {
            await toolsetAccess.cleanup?.();
          } catch (error) {
            logger.warn({ error, runId: run.id }, "Puter Personal Intelligence Finn JS workspace cleanup failed");
          }
        }
      })();
      if (selection.status !== "completed") {
        await runStore.complete(run.id, {
          state: "failed",
          contributorStatus: {
            enabledToolkits: [puterToolkitSlug],
            enabledLocalSources: [...runnableToolsets.runnable],
            blockedLocalSources: runnableToolsets.blocked,
            retainedItems: selection.retainedDocumentIds.length,
            mode: runPlan.mode,
            status: selection.status,
            retainFailures: selection.retainFailures,
            previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
            puterBridge: "live",
          },
          resultSummary: selection.summary,
          retainedDocumentIds: selection.retainedDocumentIds,
          skippedReasons: mergePuterBlockedSkippedReasons(selection.skippedReasons, runnableToolsets.blocked),
          error: "Personal intelligence run finished partial; coverage checkpoint was not advanced.",
        });
        logger.warn({
          runId: run.id,
          tenantId: user.tenantId,
          userId: user.userId,
          deviceId: input.deviceId,
          retainedCount: selection.retainedDocumentIds.length,
          retainFailures: selection.retainFailures.length,
        }, "Puter personal intelligence ingestion finished partial");
        return { runId: run.id, retainedDocumentIds: selection.retainedDocumentIds, active: true };
      }

      const checkpoints = await checkpointStore.upsertMany(buildCheckpointUpdates({
        connectors: [connector],
        runPlan,
        runId: run.id,
        selection,
      }));

      await runStore.complete(run.id, {
        state: "done",
        contributorStatus: {
          enabledToolkits: [puterToolkitSlug],
          enabledLocalSources: [...runnableToolsets.runnable],
          blockedLocalSources: runnableToolsets.blocked,
          retainedItems: selection.retainedDocumentIds.length,
          mode: runPlan.mode,
          status: selection.status,
          checkpointScopes: checkpoints.length,
          previousCoverageEnd: runPlan.previousCoverageEnd?.toISOString() ?? null,
          coverageEnd: selection.checkpoint.coverageEnd?.toISOString() ?? runPlan.windowEnd.toISOString(),
          puterBridge: "live",
        },
        resultSummary: selection.summary,
        retainedDocumentIds: selection.retainedDocumentIds,
        skippedReasons: mergePuterBlockedSkippedReasons(selection.skippedReasons, runnableToolsets.blocked),
      });

      return { runId: run.id, retainedDocumentIds: selection.retainedDocumentIds, active: true };
    } catch (error) {
      await runStore.complete(run.id, {
        state: "failed",
        error: getErrorMessage(error),
      });
      throw error;
    } finally {
      this.deps.puterBridge.releaseLease(user, input.deviceId, leaseId);
    }
  }

  async ingestDeferredPuterIfDue(user: UserContext, input: {
    deviceId: string;
    now?: Date;
  }): Promise<{ runId: string; retainedDocumentIds: string[]; scheduledAt: string } | null> {
    if (!this.getStatus().enabled || !this.deps.puterBridge) {
      return null;
    }

    const now = input.now ?? new Date();
    const scheduledAt = getLatestPersonalIntelligenceRefreshSlot({
      now,
      timezone: user.timezone,
      refreshTimes: this.deps.config.intervals.personalIntelligenceRefreshTimes,
    });
    if (!scheduledAt) {
      return null;
    }

    const connectors = await this.getEnabledPersonalIntelligenceConnectors(user);
    const connector = connectors.find((candidate) => {
      if (candidate.toolkitSlug !== puterToolkitSlug || !candidate.connectedAccountId) {
        return false;
      }
      return puterDeviceIdFromConnectedAccount(candidate.connectedAccountId) === input.deviceId;
    });
    const enabledTools = getPuterPersonalIntelligenceToolsets(connector?.enabledTools);
    if (!connector || enabledTools.size === 0) {
      return null;
    }

    const status = this.deps.puterBridge.getStatus(user, input.deviceId);
    if (!status.active) {
      return null;
    }

    const runStore = new AutomationRunStore({ db: this.deps.db });
    const scope = connectorRunScope(connector);
    const latestCompletedRun = await runStore.getLatestCompletedRunSince(user, "personal_intelligence", scheduledAt, scope);
    const pendingAvailableTools = getPendingAvailablePuterToolsets(latestCompletedRun, enabledTools, status.access);
    if (pendingAvailableTools.size === 0) {
      return null;
    }

    const lockKey = `${user.tenantId}:${user.userId}:${scope.accountScopeId}:${scheduledAt.toISOString()}`;
    if (this.deferredPuterRuns.has(lockKey)) {
      return null;
    }
    this.deferredPuterRuns.add(lockKey);
    try {
      const latestRunAfterLock = await runStore.getLatestCompletedRunSince(user, "personal_intelligence", scheduledAt, scope);
      const pendingAvailableToolsAfterLock = getPendingAvailablePuterToolsets(latestRunAfterLock, enabledTools, status.access);
      if (pendingAvailableToolsAfterLock.size === 0) {
        return null;
      }

      const result = await this.ingestPuterLive(user, {
        deviceId: input.deviceId,
        now,
        toolsets: pendingAvailableToolsAfterLock,
      });
      if (!result.runId) {
        return null;
      }

      logger.info({
        runId: result.runId,
        tenantId: user.tenantId,
        userId: user.userId,
        deviceId: input.deviceId,
        scheduledAt: scheduledAt.toISOString(),
        retainedCount: result.retainedDocumentIds.length,
      }, "Deferred Puter personal intelligence ingestion completed");
      return {
        runId: result.runId,
        retainedDocumentIds: result.retainedDocumentIds,
        scheduledAt: scheduledAt.toISOString(),
      };
    } finally {
      this.deferredPuterRuns.delete(lockKey);
    }
  }

  async ingestDueConnector(
    user: UserContext,
    input: Pick<PersonalIntelligenceDueConnectorJob, "toolkitSlug" | "accountScopeId" | "connectedAccountId">,
    scheduledAt = new Date(),
  ): Promise<{ runId: string; retainedDocumentIds: string[] } | null> {
    if (!this.getStatus().enabled || !shouldRunPersonalIntelligenceNow({
      now: scheduledAt,
      timezone: user.timezone,
      refreshTimes: this.deps.config.intervals.personalIntelligenceRefreshTimes,
    })) {
      return null;
    }

    const connector = (await this.getEnabledPersonalIntelligenceConnectors(user))
      .find((candidate) => {
        if (candidate.toolkitSlug !== input.toolkitSlug) {
          return false;
        }
        const scope = connectorRunScope(candidate);
        return input.accountScopeId
          ? scope.accountScopeId === input.accountScopeId
          : candidate.connectedAccountId === input.connectedAccountId;
      });
    if (!connector) {
      return null;
    }

    const runStore = new AutomationRunStore({ db: this.deps.db });
    const cutoff = getLocalDayStart(scheduledAt, user.timezone);
    const latestCompletedRun = await runStore.getLatestCompletedRunSince(user, "personal_intelligence", cutoff, connectorRunScope(connector));
    if (connector.toolkitSlug === puterToolkitSlug) {
      const deviceId = puterDeviceIdFromConnectedAccount(connector.connectedAccountId);
      const status = deviceId ? this.deps.puterBridge?.getStatus(user, deviceId) : null;
      const enabledToolsets = getPuterPersonalIntelligenceToolsets(connector.enabledTools);
      if (!status?.active || getPendingAvailablePuterToolsets(latestCompletedRun, enabledToolsets, status.access).size === 0) {
        return null;
      }
    } else if (latestCompletedRun) {
      return null;
    }

    return this.ingestConnector(user, connector, { now: new Date() });
  }

  private async getEnabledPersonalIntelligenceConnectors(user: UserContext): Promise<UserConnectorConfig[]> {
    const composio = await this.deps.runtimes.getComposioService(user);
    const composioConnectors = composio
      ? await composio.listConfiguredConnectorConfigs({ feature: "personal_intelligence" })
      : [];
    const puterConnector = await this.getEnabledPuterPersonalIntelligenceConnector(user);
    return puterConnector ? [...composioConnectors, puterConnector] : composioConnectors;
  }

  private async getEnabledPuterPersonalIntelligenceConnector(user: UserContext): Promise<UserConnectorConfig | null> {
    if (!this.deps.puterBridge) {
      return null;
    }

    const config = await getConnectorConfig(this.deps.db, user, puterToolkitSlug);
    if (!config?.connected || !config.connectedAccountId || !config.personalIntelligenceEnabled) {
      return null;
    }
    if (getPuterPersonalIntelligenceToolsets(config.enabledTools).size === 0) {
      return null;
    }

    return config;
  }

  private async loadScopedComposioTools(user: UserContext, connectors: Array<{ toolkitSlug: string; connectedAccountId: string | null; permissionMode: string }>): Promise<ToolSet> {
    const composio = await this.deps.runtimes.getComposioService(user);
    const configuredToolkits = connectors
      .filter((connector) => connector.toolkitSlug !== puterToolkitSlug)
      .filter((connector) => connector.connectedAccountId)
      .map((connector) => ({
        slug: connector.toolkitSlug,
        connectedAccountId: connector.connectedAccountId!,
        permissionMode: "read_only" as const,
      }));

    if (configuredToolkits.length === 0 || !composio) {
      return {};
    }

    return composio.getToolsForConfiguredToolkits(configuredToolkits);
  }

  private async getPuterExcludedImessageHandles(user: UserContext): Promise<string[]> {
    const handles = new Set<string>();
    const addHandle = (value: string | null | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return;
      }
      handles.add(trimmed);
      try {
        handles.add(normalizePhoneNumber(trimmed));
      } catch {
        // Non-phone handles are still useful as exact exclusions.
      }
    };

    addHandle(this.deps.config.spectrum.dedicatedLinePhone);
    addHandle(await this.deps.users.getSpectrumAssignedPhoneNumber(user.userId));
    return [...handles];
  }

  private createPersonalIntelligenceProcessRuntime(runtime: UserRuntimeServices, runId: string): PersonalIntelligenceProcessRuntime {
    const processRuntime = createProcessRuntimeServices(runtime, {
      processType: "personal_intelligence",
      runId,
      filesAccess: "read",
      grants: ["memory"],
    });
    if (!processRuntime.files) {
      throw new Error("Personal Intelligence files runtime is not available.");
    }
    if (!processRuntime.memory) {
      throw new Error("Personal Intelligence memory runtime is not available.");
    }
    return processRuntime as PersonalIntelligenceProcessRuntime;
  }

  private requireMemoryRuntime(runtime: Pick<ProcessRuntimeServices, "memory">): MemoryRuntimeService {
    if (!runtime.memory) {
      throw new Error("Personal Intelligence memory runtime is not available.");
    }

    return runtime.memory;
  }

  private async resolveRunnablePuterToolsets(user: UserContext, input: {
    enabledToolsets: ReadonlySet<string>;
    requestedToolsets?: Iterable<string>;
    access: PuterLocalAccessStatus | null;
    now: Date;
    runStore: AutomationRunStore;
    config: UserConnectorConfig;
  }): Promise<RunnablePuterToolsets> {
    const requested = input.requestedToolsets
      ? new Set([...input.requestedToolsets].filter((toolset) => input.enabledToolsets.has(toolset)))
      : new Set(input.enabledToolsets);
    const available = filterAvailablePuterToolsets(requested, input.access ?? undefined);
    const latestCompletedRun = await input.runStore.getLatestCompletedRunSince(
      user,
      "personal_intelligence",
      getLocalDayStart(input.now, user.timezone),
      connectorRunScope(input.config),
    );
    const completed = getCompletedPuterSources(latestCompletedRun);
    const runnable = new Set([...available].filter((toolset) => !completed.has(toolset)));
    const blocked = getBlockedPuterToolsets(requested, available, input.access);

    return {
      enabled: new Set(input.enabledToolsets),
      available,
      completed,
      runnable,
      blocked,
    };
  }

  private async createScopedPuterLiveToolsetTools(processRuntime: PersonalIntelligenceProcessRuntime, user: UserContext, connector: UserConnectorConfig, deviceId: string, leaseId: string, runPlan: PersonalIntelligenceRunPlan, toolOutputArtifacts: WorkerToolOutputArtifactStore, excludedHandles: string[] = []): Promise<{ tools: ToolSet; summaries: CodeModeToolsetSummary[]; cleanup?: () => Promise<void> }> {
    if (!connector.connectedAccountId || connector.toolkitSlug !== puterToolkitSlug || !this.deps.puterBridge) {
      return { tools: {}, summaries: [] };
    }

    const enabledTools = getPuterPersonalIntelligenceToolsets(connector.enabledTools);
    if (enabledTools.size === 0) {
      return { tools: {}, summaries: [] };
    }

    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: new Set([...enabledTools, "files"]),
      definitions: [createUserFilesToolsetDefinition(processRuntime, {
        access: "read",
        processTypes: ["personal_intelligence"],
      })],
      context: {
        connectedAccountId: connector.connectedAccountId,
        windowStart: runPlan.windowStart,
        windowEnd: runPlan.windowEnd,
        excludedHandles,
        runtime: { ...processRuntime, artifacts: toolOutputArtifacts },
        executeCommand: async (input, options) => decoratePuterCommandResult(await this.deps.puterBridge!.executeCommand(user, {
          deviceId,
          leaseId,
          windowStart: runPlan.windowStart,
          windowEnd: runPlan.windowEnd,
          excludedHandles,
          ...input,
        }, options), {
          accountScopeId: puterPersonalIntelligenceAccountScopeId,
          currentConnectedAccountId: connector.connectedAccountId ?? `puter:${deviceId}`,
          deviceId,
        }),
      },
    });

    return createCodeModeToolsForToolsetRuntime(processRuntime, runtime, {
      artifacts: toolOutputArtifacts,
    });
  }

  private async buildRunPlan(
    user: UserContext,
    connectors: UserConnectorConfig[],
    now: Date,
    checkpointStore: PersonalIntelligenceCheckpointStore,
  ): Promise<PersonalIntelligenceRunPlan> {
    const checkpointScopes = buildCheckpointScopes(connectors);
    const checkpoints = await checkpointStore.listByAccountScopes(checkpointScopes);
    const checkpointScopeKeys = new Set(checkpointScopes.map((scope) => buildCheckpointKey(scope)));
    const relevantCheckpoints = checkpoints.filter((checkpoint) => checkpointScopeKeys.has(buildCheckpointKey(checkpoint)));
    const existingScopeKeys = new Set(relevantCheckpoints.map((checkpoint) => buildCheckpointKey(checkpoint)));
    const hasEveryScope = checkpointScopes.every((scope) => existingScopeKeys.has(buildCheckpointKey(scope)));
    const previousCoverageEnd = getEarliestCoverageEnd(relevantCheckpoints);
    const isIncremental = hasEveryScope && previousCoverageEnd !== null;
    const mode = isIncremental ? "incremental" : "initial_backfill";
    const fallbackStart = new Date(now.getTime() - this.deps.config.intervals.personalIntelligenceInitialBackfillMs);
    const windowStart = isIncremental
      ? new Date(Math.max(0, previousCoverageEnd.getTime() - this.deps.config.intervals.personalIntelligenceOverlapMs))
      : fallbackStart;

    logger.debug({ tenantId: user.tenantId, userId: user.userId, mode, checkpointCount: relevantCheckpoints.length, windowStart, windowEnd: now }, "Built Personal Intelligence run plan");
    return {
      windowStart,
      windowEnd: now,
      mode,
      checkpoints: relevantCheckpoints,
      checkpointScopes,
      previousCoverageEnd,
    };
  }

  private async runIngestion(input: {
    user: UserContext;
    runtime: PersonalIntelligenceProcessRuntime;
    runId: string;
    now: Date;
    runPlan: PersonalIntelligenceRunPlan;
    tools: ToolSet;
    enabledToolkits: string[];
    allowedScopes: AllowedPersonalIntelligenceScope[];
    toolsetSummaries?: CodeModeToolsetSummary[];
    recorder: MemoryRecorder;
    toolOutputArtifacts?: WorkerToolOutputArtifactStore;
  }): Promise<PersonalIntelligenceRunSelection> {
    const retainedDocumentIds: string[] = [];
    const retainFailures: string[] = [];
    const skippedReasons: Record<string, unknown> = {};
    const seenSources = new Set<string>();
    const runState: {
      finalOutcome: PersonalIntelligenceFinalOutcome | null;
      exhaustedStepBudget: boolean;
    } = { finalOutcome: null, exhaustedStepBudget: false };
    const retainTool = createRetainPersonalIntelligenceTool({
      recorder: input.recorder,
      user: input.user,
      memory: this.requireMemoryRuntime(input.runtime),
      sourceStore: new PersonalIntelligenceSourceStore({ db: this.deps.db, user: input.user }),
      runId: input.runId,
      allowedScopes: input.allowedScopes,
      retainedDocumentIds,
      retainFailures,
      skippedReasons,
      seenSources,
    });
    const finishRunTool = tool({
      description: "Finalize this Personal Intelligence run with a compact audit outcome and coverage checkpoint. This is the only valid way to finish. Call it after all high-signal discoveries have already been retained with retain_personal_intelligence_item.",
      inputSchema: personalIntelligenceFinalOutcomeSchema,
      execute: async (outcome) => {
        if (runState.finalOutcome) {
          throw new Error("Personal Intelligence run already finalized.");
        }

        runState.finalOutcome = normalizeFinalOutcome(outcome, input.runPlan.windowEnd);
        return {
          ok: true,
          retainedItems: retainedDocumentIds.length,
        };
      },
    });
    const toolOutputArtifacts = input.toolOutputArtifacts ?? createUserToolOutputArtifactStore(input.runtime, input.runId);
    const hasCodeModeToolsetAccess = Boolean(input.tools.workspace_execute) || Boolean(input.toolsetSummaries?.length);
    const fileToolsetAccess = hasCodeModeToolsetAccess
      ? { tools: {}, summaries: [] as CodeModeToolsetSummary[], cleanup: undefined as (() => Promise<void>) | undefined }
      : createUserFilesCodeModeTools(input.runtime, {
          access: "read",
          processType: "personal_intelligence",
          artifacts: toolOutputArtifacts,
        });
    const toolsetSummaries = [...fileToolsetAccess.summaries, ...(input.toolsetSummaries ?? [])];
    const systemPrompt = buildPersonalIntelligenceRunSystemPrompt(toolsetSummaries);
    const telemetryContext = createFinnTelemetryContext({
      functionId: "personal-intelligence.run",
      processType: "personal_intelligence",
      user: input.user,
      runId: input.runId,
      metadata: {
        runMode: input.runPlan.mode,
        enabledToolkits: input.enabledToolkits.join(","),
      },
    });

    return await withSpan(tracer, "personal-intelligence.run", {
      "personal_intelligence.run_id": input.runId,
      "personal_intelligence.mode": input.runPlan.mode,
      "personal_intelligence.enabled_toolkits": input.enabledToolkits.join(","),
      "personal_intelligence.window_start": input.runPlan.windowStart.toISOString(),
      "personal_intelligence.window_end": input.runPlan.windowEnd.toISOString(),
    }, async (span) => {
      const result = await withLLMTimeout({
      timeoutMs: this.deps.config.personalIntelligenceTimeoutMs,
      timeoutMessage: `Personal intelligence ingestion timed out after ${this.deps.config.personalIntelligenceTimeoutMs}ms.`,
    }, async (abortSignal) => {
      const baseTools: ToolSet = {
        ...fileToolsetAccess.tools,
        ...input.tools,
        search_memory: createSearchMemoryTool({ memory: this.requireMemoryRuntime(input.runtime) }),
        retain_personal_intelligence_item: retainTool,
        [finishPersonalIntelligenceRunToolName]: finishRunTool,
      };
      const tools: ToolSet = {
        ...wrapToolsWithOutputArtifacts(baseTools, toolOutputArtifacts),
      };
      let messages: ModelMessage[] = [{
        role: "user",
        content: [
          `Enabled toolkits: ${input.enabledToolkits.join(", ")}`,
          `Allowed retain scopes (server authoritative): ${formatAllowedPersonalIntelligenceScopes(input.allowedScopes)}`,
          `Run mode: ${input.runPlan.mode}`,
          `Current local time: ${formatLocalDateTime(input.now, input.user.timezone)}`,
          `Current UTC time: ${input.now.toISOString()}`,
          `Primary inspection window start local: ${formatLocalDateTime(input.runPlan.windowStart, input.user.timezone)}`,
          `Primary inspection window start UTC: ${input.runPlan.windowStart.toISOString()}`,
          `Primary inspection window end UTC: ${input.runPlan.windowEnd.toISOString()}`,
          input.runPlan.previousCoverageEnd ? `Previous durable coverage end UTC: ${input.runPlan.previousCoverageEnd.toISOString()}` : "Previous durable coverage end UTC: never",
          `User timezone: ${input.user.timezone}`,
          `Timezone source: ${input.user.timezoneSource}`,
          input.user.location ? `User location: ${input.user.location}` : null,
          "Previous Personal Intelligence coverage handoff:",
          formatCheckpointContext(input.runPlan.checkpoints),
          Object.keys(input.tools).length > 0 ? "Connector/toolset access is available through the tools in this run. For Puter sources, only enabled Finn JS workspace APIs exist. Do not assume disabled Puter sources exist." : "No connector inspection tools are available for this run.",
          `Use search_memory before retaining any candidate. The retain tool also performs a final source-aware memory search check, so do not skip your own semantic duplicate review. Avoid saving anything Finn already knows or has already retained from the same source. Call ${finishPersonalIntelligenceRunToolName} once at the end with what you inspected, known gaps, explored entities/projects, and coverage timestamps. Do not save candidates for a final JSON blob. Do not finish with normal text.`,
        ].filter((line): line is string => line !== null).join("\n\n"),
      }];
      const summaryCache = new Map<string, string>();
      const compactMessages = (nextMessages: ModelMessage[]): Promise<ModelMessage[]> => compactWorkerMessagesWithCheckpoint(
        nextMessages,
        {
          model: this.deps.llmManager.getModel("compactor"),
          requestOptions: this.deps.llmManager.getRequestOptions("compactor", input.runId),
          maxPromptTokens: Math.floor(this.deps.llmManager.getMaxContextTokens("worker") * 0.9),
          maxMessageTokens: personalIntelligenceMaxMessageTokens,
          recentMessageTokens: personalIntelligenceRecentMessageTokens,
          summaryCache,
          user: input.user,
          runId: input.runId,
          processType: "personal_intelligence",
          compactionFunctionId: "personal-intelligence.context_compact",
        },
        (error) => {
          logger.warn({ error, runId: input.runId }, "Personal intelligence context compaction failed; using deterministic checkpoint");
        },
      );
      messages = await compactWorkerLoopMessages({ messages, fixedMessageCount: 1, compactMessages });
      const stopAfterOneStep = ({ steps }: { steps: readonly unknown[] }): boolean => steps.length >= 1;
      const maxSteps = this.deps.config.personalIntelligenceMaxSteps;
      let generatedText = "";
      let completedSteps = 0;
      let lastStepHadToolCalls = false;
      for (let stepIndex = 0; stepIndex < maxSteps && !runState.finalOutcome; stepIndex += 1) {
        messages = await compactWorkerLoopMessages({ messages, fixedMessageCount: 1, compactMessages });
        const stepStartedAt = Date.now();
        span.addEvent("personal_intelligence.generate_start", {
          step_index: stepIndex,
          max_steps: maxSteps,
        });
        const generated = await generateText({
          model: this.deps.llmManager.getModel("worker"),
          system: withAnthropicSystemCacheControl(systemPrompt),
          messages,
          tools: withAnthropicToolCacheControl(tools),
          ...this.deps.llmManager.getRequestOptions("worker", input.runId),
          stopWhen: stopAfterOneStep,
          experimental_telemetry: createFinnTelemetry({
            functionId: "personal-intelligence.ingest",
            processType: "personal_intelligence",
            user: input.user,
            runId: input.runId,
            metadata: {
              runMode: input.runPlan.mode,
              stepIndex,
            },
          }),
          abortSignal,
        });
        completedSteps = stepIndex + 1;
        generatedText = generated.text.trim() || generatedText;
        lastStepHadToolCalls = (generated.toolCalls ?? []).length > 0;
        span.addEvent("personal_intelligence.generate_finish", {
          step_index: stepIndex,
          elapsed_ms: Date.now() - stepStartedAt,
          tool_call_count: (generated.toolCalls ?? []).length,
          response_message_count: generated.response.messages.length,
        });
        messages = await compactWorkerLoopMessages({
          messages: [...messages, ...generated.response.messages],
          fixedMessageCount: 1,
          compactMessages,
        });

        if (runState.finalOutcome || !lastStepHadToolCalls) {
          break;
        }
      }
      if (runState.finalOutcome) {
        span.addEvent("personal_intelligence.finished_by_tool", {
          completed_steps: completedSteps,
          retained_count: retainedDocumentIds.length,
        });
        return { text: generatedText };
      }
      const exhaustedStepBudget = completedSteps >= maxSteps && lastStepHadToolCalls;
      runState.exhaustedStepBudget = exhaustedStepBudget;
      span.setAttribute("personal_intelligence.completed_steps", completedSteps);
      span.setAttribute("personal_intelligence.exhausted_step_budget", exhaustedStepBudget);

      const finalizationMessages = await compactWorkerLoopMessages({
        messages: exhaustedStepBudget
          ? [
              ...messages,
              {
                role: "user",
                content: "[runtime context - not from finn or the user]\n\nThe Personal Intelligence step budget was exhausted before the run finalized. Mark the run partial and record remaining coverage as known gaps; do not claim full coverage.",
              },
            ]
          : messages,
        fixedMessageCount: 1,
        compactMessages,
      });
      const finalizationStartedAt = Date.now();
      span.addEvent("personal_intelligence.finalize_start", {
        exhausted_step_budget: exhaustedStepBudget,
        completed_steps: completedSteps,
      });
      const finalizationResult = await generateText({
        model: this.deps.llmManager.getModel("worker"),
        system: withAnthropicSystemCacheControl([systemPrompt, personalIntelligenceFinalizationPrompt].join("\n\n")),
        messages: finalizationMessages,
        tools: withAnthropicToolCacheControl({
          [finishPersonalIntelligenceRunToolName]: finishRunTool,
        }),
        activeTools: [finishPersonalIntelligenceRunToolName],
        ...(this.deps.config.llm.forceToolChoice ? { toolChoice: "required" as const } : {}),
        ...this.deps.llmManager.getRequestOptions("worker", input.runId),
        stopWhen: finishPersonalIntelligenceRunStopCondition,
        experimental_telemetry: createFinnTelemetry({
          functionId: "personal-intelligence.finalize",
          processType: "personal_intelligence",
          user: input.user,
          runId: input.runId,
          metadata: {
            runMode: input.runPlan.mode,
          },
        }),
        abortSignal,
      });
      span.addEvent("personal_intelligence.finalize_finish", {
        elapsed_ms: Date.now() - finalizationStartedAt,
        tool_call_count: (finalizationResult.toolCalls ?? []).length,
        response_message_count: finalizationResult.response.messages.length,
        finalized: Boolean(runState.finalOutcome),
      });
      await compactMessages([...finalizationMessages, ...finalizationResult.response.messages]);
      return { text: finalizationResult.text.trim() || generatedText };
    }).finally(async () => {
      await fileToolsetAccess.cleanup?.().catch((error: unknown) => {
        logger.warn({ error, runId: input.runId }, "Personal intelligence Finn JS workspace cleanup failed");
      });
      await toolOutputArtifacts.cleanup().catch((error: unknown) => {
        logger.warn({ error, runId: input.runId }, "Personal intelligence tool output artifact cleanup failed");
      });
    });
    const finalOutcome = runState.finalOutcome;
    const status = retainFailures.length > 0 || runState.exhaustedStepBudget ? "partial" : finalOutcome?.status ?? "partial";
    const checkpoint = finalOutcome?.checkpoint ?? buildFallbackRunCheckpoint({
      summary: finalOutcome?.summary ?? result.text,
      runPlan: input.runPlan,
      retainedDocumentIds,
      skippedReasons,
    });
    const summary = finalOutcome
      ? formatFinalOutcomeSummary(finalOutcome, retainedDocumentIds.length)
      : truncate(result.text.trim(), maxRunSummaryLength) || `Retained ${retainedDocumentIds.length} personal intelligence item${retainedDocumentIds.length === 1 ? "" : "s"}.`;

    span.setAttribute("personal_intelligence.status", status);
    span.setAttribute("personal_intelligence.retained_count", retainedDocumentIds.length);
    span.setAttribute("personal_intelligence.retain_failure_count", retainFailures.length);
    span.setAttribute("personal_intelligence.exhausted_step_budget", runState.exhaustedStepBudget);

    return {
      status,
      retainedDocumentIds,
      retainFailures,
      skippedReasons,
      summary,
      checkpoint,
    };
    }, telemetryContext);
  }
}

export function shouldRunPersonalIntelligenceNow(input: {
  now: Date;
  timezone: string;
  refreshTimes: AppConfig["intervals"]["personalIntelligenceRefreshTimes"];
}): boolean {
  return getCurrentPersonalIntelligenceRefreshSlot(input) !== null;
}

function formatToolsetSummaries(summaries: CodeModeToolsetSummary[]): string {
  return summaries
    .map((summary) => {
      return `- ${summary.slug} (${summary.effects.join("/")}): ${summary.description} ${summary.commands.length} API(s).`;
    })
    .join("\n");
}

function buildPersonalIntelligenceRunSystemPrompt(toolsetSummaries: CodeModeToolsetSummary[] | undefined): string {
  if (!toolsetSummaries?.length) {
    return personalIntelligenceSystemPrompt;
  }

  return [
    personalIntelligenceSystemPrompt,
    "## Enabled Finn JS workspace toolsets",
    "Only the Finn API toolsets listed here are enabled for this run.",
    formatToolsetSummaries(toolsetSummaries),
  ].join("\n\n");
}

function getCurrentPersonalIntelligenceRefreshSlot(input: {
  now: Date;
  timezone: string;
  refreshTimes: AppConfig["intervals"]["personalIntelligenceRefreshTimes"];
}): Date | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(input.now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? -1);
  const month = Number(parts.find((part) => part.type === "month")?.value ?? -1);
  const day = Number(parts.find((part) => part.type === "day")?.value ?? -1);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? -1);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? -1);
  const currentMinute = hour * 60 + minute;

  const currentSlot = input.refreshTimes
    .map((time) => {
      const scheduledMinute = time.hour * 60 + time.minute;
      return {
        time,
        scheduledMinute,
        elapsedMinutes: (currentMinute - scheduledMinute + 24 * 60) % (24 * 60),
      };
    })
    .find((slot) => slot.elapsedMinutes < schedulerRunWindowMinutes);
  if (!currentSlot) {
    return null;
  }

  const slotDate = currentSlot.scheduledMinute > currentMinute
    ? addCalendarDays({ year, month, day }, -1)
    : { year, month, day };

  return localDateTimeToUtcDate(slotDate.year, slotDate.month, slotDate.day, currentSlot.time.hour, currentSlot.time.minute, input.timezone);
}

function getLatestPersonalIntelligenceRefreshSlot(input: {
  now: Date;
  timezone: string;
  refreshTimes: AppConfig["intervals"]["personalIntelligenceRefreshTimes"];
}): Date | null {
  if (input.refreshTimes.length === 0) {
    return null;
  }

  const parts = getTimeZoneParts(input.now, input.timezone, true);
  const currentMinute = parts.hour * 60 + parts.minute;
  const slots = input.refreshTimes
    .map((time) => ({
      time,
      scheduledMinute: time.hour * 60 + time.minute,
    }))
    .sort((left, right) => left.scheduledMinute - right.scheduledMinute);

  const currentDaySlot = slots
    .filter((slot) => slot.scheduledMinute <= currentMinute)
    .at(-1);
  const selectedSlot = currentDaySlot ?? slots.at(-1);
  if (!selectedSlot) {
    return null;
  }

  const slotDate = currentDaySlot
    ? { year: parts.year, month: parts.month, day: parts.day }
    : addCalendarDays({ year: parts.year, month: parts.month, day: parts.day }, -1);

  return localDateTimeToUtcDate(slotDate.year, slotDate.month, slotDate.day, selectedSlot.time.hour, selectedSlot.time.minute, input.timezone);
}

function addCalendarDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDateTimeToUtcDate(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  let utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
    utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }
  return new Date(utcGuess);
}

function getLocalDayStart(now: Date, timezone: string): Date {
  const parts = getTimeZoneParts(now, timezone);
  let utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
    utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - offset;
  }
  return new Date(utcGuess);
}

function getLocalDate(now: Date, timezone: string): string {
  const parts = getTimeZoneParts(now, timezone);
  return [
    parts.year.toString().padStart(4, "0"),
    parts.month.toString().padStart(2, "0"),
    parts.day.toString().padStart(2, "0"),
  ].join("-");
}

function getTimeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = getTimeZoneParts(date, timezone, true);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function getTimeZoneParts(date: Date, timezone: string, includeTime = false): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (includeTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.second = "2-digit";
    options.hourCycle = "h23";
  }
  const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function formatRefreshTime(time: AppConfig["intervals"]["personalIntelligenceRefreshTimes"][number]): string {
  return `${String(time.hour).padStart(2, "0")}${String(time.minute).padStart(2, "0")}`;
}

const finishPersonalIntelligenceRunStopCondition = ({ steps }: {
  steps: ReadonlyArray<{
    readonly toolCalls?: ReadonlyArray<{ readonly toolName: string }>;
  }>;
}): boolean => {
  return Boolean(steps.at(-1)?.toolCalls?.some((toolCall) => toolCall.toolName === finishPersonalIntelligenceRunToolName));
};

const personalIntelligenceFinalizationPrompt = [
  "Finalize this Personal Intelligence run now.",
  `Call ${finishPersonalIntelligenceRunToolName} exactly once.`,
  "Use the tool result history to report only a compact audit summary and checkpoint.",
  "If durable discoveries were mentioned in prose but not retained with retain_personal_intelligence_item, mark the run partial and list that as a coverage gap instead of repeating raw source content.",
  "Do not emit normal text.",
].join("\n");

const personalIntelligenceSystemPrompt = `You select source material for Finn's provider-neutral Personal Intelligence memory.

Workflow:
- Use only enabled read-only connector tools.
- Use only the server-authoritative allowed retain scopes listed in the run message. Do not invent account IDs. When a retain scope allows any source type, preserve the source's real type such as email, message, event, issue, document, or record. For Puter, the durable Personal Intelligence account scope is ${puterPersonalIntelligenceAccountScopeId}; Puter device IDs are transport-only.
- You must finish by calling ${finishPersonalIntelligenceRunToolName}. Free-form final text is not a valid outcome.
- If connector tools are available directly, use them. If Composio meta tools are available, search for the exact read tools first, then fetch the records needed to cover each durable life-context category.
- Finn JS workspace tools are generic framework tools, not Personal Intelligence-specific tools. If project-wide Finn JS workspace APIs are available, use workspace_search to inspect API names and input shapes, then compose calls through workspace_execute. For Puter, iMessage and Notes are separate namespaces and disabled sources must not be assumed or requested.
- User workspace paths use /workspace/...
- Temporary run artifacts are mounted at /artifacts; use /artifacts/... paths exactly as returned by tool results.
- The files APIs accept only workspace-relative, /workspace/..., and /artifacts/... paths. /workspace may be read-only, so use /artifacts for temporary downloads or outputs when workspace writes fail.
- If a tool result includes full_output_path, tool_output_artifact.path, or a /artifacts/... path, use the files APIs listed for this run. Prefer search-style file APIs for specific names, IDs, dates, or keywords; use read-style file APIs with modest byte limits only when you need a slice before finalizing.
- Use the listed image/document files APIs for images and readable attachment/document URLs or downloaded paths when available, especially PDFs, DOCX files, spreadsheets, HTML, and common Office documents. Document extraction is local-only and can OCR scanned PDFs.
- Stay connector-agnostic. Do not assume specific apps or tool names beyond the enabled toolkits and available read tools. Adapt to each source's fields, timestamps, actors, titles, URLs, IDs, and pagination.
- Use the primary inspection window. In initial_backfill mode this is a bounded historical backfill over the whole window: sample across the full period and connected sources, not just the newest page or obvious senders. In incremental mode, focus on records changed or created since the window start, with the small overlap used only for safety.
- Start by using search_memory for a compact understanding of known relationships, projects, preferences, responsibilities, and source IDs. Use that understanding to avoid duplicate retains, not to narrow the search prematurely.
- Personal Intelligence is for understanding the user's life and context, not task execution. My Day and Patterns handle day-level tasks and automations; this system should capture durable context about what is happening in the user's life, relationships, household, responsibilities, work, projects, preferences, constraints, recurring obligations, and meaningful changes over time.
- Initial backfill coverage loop: enumerate or query broad source categories before finalizing. For every connector, cover the full window by source type, timestamp distribution, sender/actor, recipient/participant, thread/project/document grouping, attachments, labels/statuses, and authored-by-user records when available. Use connector-native categories instead of hardcoded domain keywords.
- Do not stop after the first page of a broad query when more pages or targeted category searches are available. If a tool exposes pagination, use it until the relevant category is exhausted or a reasonable bounded sample has covered the full window. If you deliberately leave a category incomplete, record the gap and keep searching other categories before finalizing.
- Exploration loop: seed broadly from source categories and memory, inspect representative records, retain durable evidence immediately, then continue with the next category. Do not collect a giant candidate list and wait until the end; retain as you go so earlier discoveries are not lost to context pressure.
- When a record reveals a person, organization, place, household signal, recurring collaborator, active project, or repeated obligation, classify the relationship strength from evidence: close relationship, recurring contact, service provider, vendor, organization, colleague, incidental sender, or unknown. Do not call someone important just because they emailed the user, and do not infer exact relationship labels unless source evidence supports that specific role.
- Relationship intelligence is a first-class PI goal. Across any connector, look for repeated direct-address patterns, contact names, thread/project membership, authored replies, shared responsibilities, care/household signals, and other converging evidence. When multiple records support a durable relationship or role, retain one concise evidence-backed relationship/context summary immediately, using the most stable entity/thread/project/source ID available and listing supporting source/message IDs in metadata.
- Infer cautiously but usefully: labels like spouse, child, sibling, close friend, manager, or collaborator require repeated or explicit source evidence. Age/life-stage, household, school, game/app, medical, financial, or care context should be stored as approximate or uncertain when the evidence is indirect.
- Inspect bidirectional or authored-by-user records when available because sent/authored items often reveal the user's own commitments, tone, priorities, relationships, and corrections. When an email or message is interesting enough to inspect and it has attachments, inspect readable attachments too: use connector-native attachment text/fetch tools when present, and use the listed finn.files.extract API on attachment URLs or downloaded paths for PDFs, documents, and spreadsheets that can be read locally. If an attachment cannot be read, record the gap instead of inferring from the filename alone.
- For event-like sources, inspect current/upcoming and recently changed items in the window plus recurring participants/locations when the tool supports it, looking for durable responsibilities and relationships.
- For task/project/document/chat-like sources, inspect enough records across all active/recent visible workstreams to understand durable relationships, responsibilities, preferences, commitments, projects, decisions, or constraints. Avoid raw bulk exports, but do not skip whole workstreams or source categories just because they look secondary.
- Treat active work/project context as personal intelligence when records reveal what the user is building, responsible for, repeatedly working on, or making product/engineering decisions about. A single task may be short-lived, but a project, initiative, cluster of related records, or stable workstream can be durable.
- Use search_memory before retain_personal_intelligence_item unless the current tool result history already clearly proves whether the candidate is new.
- Search memory using stable app IDs when available (sourceId, messageId, threadId, eventId), then by title/person/project if ID search is inconclusive.
- The retain tool performs an additional source-aware memory search before writing; still do your own search first so duplicate and contradiction checks are explicit in the reasoning trace.
- Call ${finishPersonalIntelligenceRunToolName} once at the end with a compact audit summary, coverage timestamps, important explored entities/projects, and known gaps. Do not include raw source bodies in the checkpoint.

Selection rules:
- Retain only durable, high-signal source material about core relationships, recurring responsibilities, preferences, commitments, important projects, home/location context, or long-lived constraints.
- Retain durable personal-life context even when it is not a task: evidence of household/family structure, health or care context, money/admin/legal/insurance-like matters, recurring services, important organizations, meaningful relationships, responsibilities, constraints, routines, and life changes. Keep sensitive records narrow, factual, and provenance-backed.
- Retain concise project/workstream summaries when source records show a durable direction: project name, user's role or responsibility if evident, current focus, product/technical principles, and stable source IDs/URLs. Preserve enough source excerpt for memory extraction to understand the project, not just the ticket title.
- Do not dismiss work records solely because their individual tickets/tasks are complete or sprint-sized. Skip isolated operational chores; retain when the surrounding project or repeated work reveals ongoing user context Finn should understand.
- Do not retain raw bulk mailbox dumps; retain concise evidence-backed summaries or representative source excerpts for durable categories discovered during broad coverage.
- Do not retain promotions, receipts, newsletters, routine one-off logistics, low-signal notifications, or every person ever contacted.
- Treat vendors, support reps, automated senders, and companies as organizations or service contacts unless source evidence shows a personal relationship. Do not promote them into the user's important relationships.
- Treat Patterns, My Day todos, reminders, run history, and other Finn operational records as runtime state unless the source shows a durable user preference, decision, relationship, or life context. Operational status changes should be remembered as state changes, not as personal goals or relationships.
- Do not retain facts, source records, or relationship/context summaries that existing memory already contains.
- Prefer rich structured source excerpts over weak items, but do not stop because an arbitrary number of retained items has been reached. Continue until the inspection window, time budget, or available tool results are exhausted.
- Every retain call must include toolkitSlug, accountScopeId when shown in tool output or run scope, connectedAccountId, sourceType, a stable sourceId from the app, timestamp when available, title, selected body/description excerpt, and why it matters. The server validates and may override accountScopeId/connectedAccountId to the allowed run scope.
- For message-like sources include messageId and threadId when available plus senderEmail and recipientEmails.
- For mailbox/message sources, state the direction explicitly in content and metadata: this was from the user's connected account/mailbox; whether the user received it, sent/authored it, or was only copied/mentioned; who the sender was; who the recipients were. Do not identify the sender as the user unless the source account or authored/sent evidence proves it. For Puter iMessage, direction sent_by_user, sender me, metadata.localUser, or metadata.isFromMe proves local-user authorship; metadata.localSenderHandle is the user's own Messages/iCloud alias, not a separate person. If the user's exact recipient address is not visible, say the record was inspected from the user's connected mailbox/account instead of inventing a recipient.
- Do not infer family roles from school invoices, forwarded bills, claim documents, or shared household admin. Use explicit labels only when source evidence supports the exact relationship; otherwise use neutral wording like "Cheyenne sent/forwarded this record to the user's connected mailbox" or "the record concerns Cheyenne".
- For event-like sources include eventId when available plus attendeeEmails.
- For all sources include sourceUrl when available and preserve app-specific IDs in metadata as flat scalar values.
- Call retain_personal_intelligence_item immediately for each high-signal source worth retaining.
- Do not build or return a giant JSON candidate list at the end.
- Finalize with ${finishPersonalIntelligenceRunToolName}; do not write a prose final response. The audit summary should cover category coverage, what you retained, what you skipped as noise, and any remaining coverage gaps. Do not claim the run was complete if you skipped important available categories or obvious pagination.`;

export function buildPersonalIntelligenceSystemPromptForTest(): string {
  return personalIntelligenceSystemPrompt;
}

export function createRetainPersonalIntelligenceTool(input: {
  recorder: MemoryRecorder;
  user?: UserContext;
  memory?: MemoryRuntimeService;
  sourceStore?: Pick<PersonalIntelligenceSourceStore, "hasSource" | "recordRetainedSource">;
  runId?: string;
  allowedScopes?: AllowedPersonalIntelligenceScope[];
  retainedDocumentIds: string[];
  retainFailures?: string[];
  skippedReasons: Record<string, unknown>;
  seenSources: Set<string>;
}) {
  return tool({
    description: "Retain one high-signal connected-app source or evidence-backed entity/thread/project summary into the configured memory provider immediately. Include stable app provenance IDs: connectedAccountId, sourceId, message/thread/event IDs when available, participants, timestamp, sourceUrl, and supportingSourceIds/supportingMessageIds for synthesized relationship or context summaries. Use only after inspecting the source and deciding it is durable, specific, and worth remembering.",
    inputSchema: personalIntelligenceCandidateSchema,
    execute: async (candidate) => {
      const scopedCandidate = normalizeCandidateForAllowedScope(candidate, input.allowedScopes);
      const sourceKey = buildPersonalIntelligenceSourceKey(scopedCandidate);
      if (input.seenSources.has(sourceKey)) {
        input.skippedReasons[sourceKey] = "duplicate_source_in_run";
        return { ok: false, skipped: true, reason: "duplicate_source_in_run" };
      }
      try {
        const existingMemory = await recallCandidateBeforeRetain(input.memory, input.user, scopedCandidate);
        if (existingMemory.duplicate) {
          input.seenSources.add(sourceKey);
          clearRetainFailure(input.retainFailures, sourceKey);
          input.skippedReasons[sourceKey] = "duplicate_memory_recall";
          return { ok: false, skipped: true, reason: "duplicate_memory_recall", recall: existingMemory.summary };
        }

        if (input.sourceStore && await input.sourceStore.hasSource(scopedCandidate)) {
          input.seenSources.add(sourceKey);
          clearRetainFailure(input.retainFailures, sourceKey);
          input.skippedReasons[sourceKey] = "duplicate_source_retained";
          return { ok: false, skipped: true, reason: "duplicate_source_retained" };
        }

        const sourceDirection = inferCandidateDirection(input.user, scopedCandidate);
        const metadata = buildCandidateMetadata(input.user, scopedCandidate, sourceDirection);
        const senderEmail = USER_AUTHORED_DIRECTIONS.has(sourceDirection) ? null : scopedCandidate.senderEmail ?? null;
        const retained = await input.recorder.recordPersonalIntelligenceItem({
          toolkitSlug: scopedCandidate.toolkitSlug,
          accountScopeId: scopedCandidate.accountScopeId,
          connectedAccountId: scopedCandidate.connectedAccountId,
          sourceType: scopedCandidate.sourceType,
          sourceId: scopedCandidate.sourceId,
          messageId: scopedCandidate.messageId ?? null,
          threadId: scopedCandidate.threadId ?? null,
          eventId: scopedCandidate.eventId ?? null,
          senderEmail,
          recipientEmails: scopedCandidate.recipientEmails,
          attendeeEmails: scopedCandidate.attendeeEmails,
          sourceUrl: scopedCandidate.sourceUrl ?? null,
          title: scopedCandidate.title || null,
          timestamp: scopedCandidate.timestamp || null,
          content: buildCandidateContent(input.user, scopedCandidate, sourceDirection),
          reason: scopedCandidate.reason,
          metadata,
        });
        if (!retained) {
          input.skippedReasons[sourceKey] = "retain_returned_empty";
          recordRetainFailure(input.retainFailures, sourceKey, "retain_returned_empty");
          return { ok: false, skipped: true, reason: "retain_returned_empty" };
        }

        input.seenSources.add(sourceKey);
        clearRetainFailure(input.retainFailures, sourceKey);
        delete input.skippedReasons[sourceKey];
        input.retainedDocumentIds.push(retained.id);
        await recordRetainedSource(input.sourceStore, {
          runId: input.runId,
          toolkitSlug: scopedCandidate.toolkitSlug,
          accountScopeId: scopedCandidate.accountScopeId,
          connectedAccountId: scopedCandidate.connectedAccountId,
          sourceType: scopedCandidate.sourceType,
          sourceId: scopedCandidate.sourceId,
          retainedDocumentId: retained.id,
          title: scopedCandidate.title || null,
          sourceUrl: scopedCandidate.sourceUrl ?? null,
          sourceTimestamp: scopedCandidate.timestamp || null,
          metadata,
        });
        return { ok: true, retainedDocumentId: retained.id };
      } catch (error) {
        const reason = getErrorMessage(error);
        input.skippedReasons[sourceKey] = reason;
        recordRetainFailure(input.retainFailures, sourceKey, reason);
        return { ok: false, skipped: true, reason };
      }
    },
    });
  }

function normalizeCandidateForAllowedScope(
  candidate: PersonalIntelligenceCandidate,
  allowedScopes: AllowedPersonalIntelligenceScope[] | undefined,
): PersonalIntelligenceCandidate & { accountScopeId: string } {
  const toolkitSlug = candidate.toolkitSlug.trim().toLowerCase();
  const sourceType = candidate.sourceType.trim().toLowerCase();
  if (!allowedScopes?.length) {
    const accountScopeId = getPersonalIntelligenceAccountScopeId(candidate);
    if (!accountScopeId) {
      throw new Error("No Personal Intelligence account scope is available for this retain candidate.");
    }
    return {
      ...candidate,
      toolkitSlug,
      accountScopeId,
      connectedAccountId: candidate.connectedAccountId.trim(),
      sourceType,
    };
  }

  const matches = allowedScopes.filter((scope) => scope.toolkitSlug === toolkitSlug
    && (scope.enforceSourceType === false || scope.sourceType === sourceType));
  if (matches.length === 0) {
    throw new Error(`Source type ${toolkitSlug}/${sourceType} is not enabled for this Personal Intelligence run.`);
  }

  const explicitScope = candidate.accountScopeId?.trim();
  const explicitConnectedAccount = candidate.connectedAccountId.trim();
  const selected = matches.find((scope) => explicitScope && scope.accountScopeId === explicitScope)
    ?? matches.find((scope) => scope.connectedAccountId === explicitConnectedAccount)
    ?? (matches.length === 1 ? matches[0] : null);
  if (!selected) {
    throw new Error(`Retain candidate ${toolkitSlug}/${sourceType} matches multiple account scopes; use source provenance from this run to disambiguate.`);
  }

  return {
    ...candidate,
    toolkitSlug: selected.toolkitSlug,
    accountScopeId: selected.accountScopeId,
    connectedAccountId: selected.connectedAccountId,
    sourceType: selected.enforceSourceType === false ? sourceType : selected.sourceType,
  };
}

function recordRetainFailure(retainFailures: string[] | undefined, sourceKey: string, reason: string): void {
  if (!retainFailures) {
    return;
  }
  clearRetainFailure(retainFailures, sourceKey);
  retainFailures.push(`${sourceKey}: ${reason}`);
}

function clearRetainFailure(retainFailures: string[] | undefined, sourceKey: string): void {
  if (!retainFailures) {
    return;
  }
  const prefix = `${sourceKey}: `;
  for (let index = retainFailures.length - 1; index >= 0; index -= 1) {
    if (retainFailures[index]?.startsWith(prefix)) {
      retainFailures.splice(index, 1);
    }
  }
}

async function recallCandidateBeforeRetain(
  memory: MemoryRuntimeService | undefined,
  user: UserContext | undefined,
  candidate: PersonalIntelligenceCandidate & { accountScopeId: string },
): Promise<{ duplicate: boolean; summary: string }> {
  if (!memory || !user) {
    return { duplicate: false, summary: "memory_recall_unavailable" };
  }
  const supportingSourceIds = getCandidateList(candidate.supportingSourceIds);
  const supportingMessageIds = getCandidateList(candidate.supportingMessageIds);
  const supportingThreadIds = getCandidateList(candidate.supportingThreadIds);
  const sourceDirection = inferCandidateDirection(user, candidate);

  const query = [
    "Before retaining this connected-app source, check whether Finn already knows this source or the durable fact it contains.",
    `Source: ${candidate.toolkitSlug}/${candidate.sourceType}`,
    `Source ID: ${candidate.sourceId}`,
    supportingSourceIds.length ? `Supporting source IDs: ${supportingSourceIds.join(", ")}` : null,
    candidate.messageId ? `Message ID: ${candidate.messageId}` : null,
    supportingMessageIds.length ? `Supporting message IDs: ${supportingMessageIds.join(", ")}` : null,
    candidate.threadId ? `Thread ID: ${candidate.threadId}` : null,
    supportingThreadIds.length ? `Supporting thread IDs: ${supportingThreadIds.join(", ")}` : null,
    candidate.eventId ? `Event ID: ${candidate.eventId}` : null,
    candidate.title ? `Title: ${candidate.title}` : null,
    USER_AUTHORED_DIRECTIONS.has(sourceDirection) ? "Sender: local user" : candidate.senderEmail ? `Sender: ${candidate.senderEmail}` : null,
    candidate.recipientEmails.length ? `Recipients: ${candidate.recipientEmails.join(", ")}` : null,
    `Reason: ${candidate.reason}`,
  ].filter((line): line is string => Boolean(line)).join("\n");

  const response = await memory.searchDocuments({
    query,
    limit: 5,
    metadata: {
      kind: "personal_intelligence_source",
      source: candidate.toolkitSlug,
      accountScopeId: candidate.accountScopeId,
      connectedAccountId: candidate.connectedAccountId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      ...(candidate.messageId ? { messageId: candidate.messageId } : {}),
      ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
    },
    observability: { operation: "search_memory" },
  });

  if (!response.ok) {
    return { duplicate: false, summary: `memory_recall_failed:${response.error}` };
  }

  const matchingResult = response.results.find((result) => {
    const metadata = result.metadata as Record<string, unknown>;
    const sameAccountScope = metadata["accountScopeId"] === candidate.accountScopeId;
    return (sameAccountScope && metadata["sourceId"] === candidate.sourceId)
      || (sameAccountScope && candidate.messageId && metadata["messageId"] === candidate.messageId)
      || (sameAccountScope && candidate.threadId && metadata["threadId"] === candidate.threadId)
      || result.documentId.endsWith(`_${candidate.toolkitSlug}_${candidate.accountScopeId}_${candidate.sourceType}_${candidate.sourceId}`);
  });

  return matchingResult
    ? { duplicate: true, summary: matchingResult.title ?? matchingResult.summary ?? matchingResult.documentId }
    : { duplicate: false, summary: `${response.results.length} related memories checked` };
}

function buildCandidateMetadata(user: UserContext | undefined, candidate: PersonalIntelligenceCandidate & { accountScopeId: string }, direction = inferCandidateDirection(user, candidate)): MemoryMetadata {
  const metadata = sanitizeCandidateMetadata(candidate.metadata);
  const supportingSourceIds = getCandidateList(candidate.supportingSourceIds);
  const supportingMessageIds = getCandidateList(candidate.supportingMessageIds);
  const supportingThreadIds = getCandidateList(candidate.supportingThreadIds);
  return {
    ...metadata,
    sourcePerspective: "user_connected_account",
    sourceDirection: direction,
    sourceAccountUserId: user?.userId ?? "unknown",
    accountScopeId: candidate.accountScopeId,
    connectedAccountId: candidate.connectedAccountId,
    ...(supportingSourceIds.length > 0 ? { supportingSourceIds } : {}),
    ...(supportingMessageIds.length > 0 ? { supportingMessageIds } : {}),
    ...(supportingThreadIds.length > 0 ? { supportingThreadIds } : {}),
    ...(user?.displayName ? { sourceAccountDisplayName: user.displayName } : {}),
  };
}

function buildCandidateContent(user: UserContext | undefined, candidate: PersonalIntelligenceCandidate, direction = inferCandidateDirection(user, candidate)): string {
  const supportingSourceIds = getCandidateList(candidate.supportingSourceIds);
  const supportingMessageIds = getCandidateList(candidate.supportingMessageIds);
  const supportingThreadIds = getCandidateList(candidate.supportingThreadIds);
  return [
    "Source perspective: inspected from the user's connected account/mailbox.",
    `Source direction: ${direction}.`,
    formatCandidateSenderLine(candidate, direction),
    candidate.recipientEmails.length > 0
      ? `Recipients in source record: ${candidate.recipientEmails.join(", ")}`
      : "Recipients in source record: unavailable; do not infer exact recipient from the absence of recipient metadata.",
    supportingSourceIds.length > 0 ? `Supporting source IDs: ${supportingSourceIds.join(", ")}` : null,
    supportingMessageIds.length > 0 ? `Supporting message IDs: ${supportingMessageIds.join(", ")}` : null,
    supportingThreadIds.length > 0 ? `Supporting thread IDs: ${supportingThreadIds.join(", ")}` : null,
    "Interpretation rule: do not treat the sender as the user unless the source account/authored-by evidence proves it. For received mailbox records, the sender is an external actor and the source was found in the user's connected account.",
    "",
    candidate.content,
  ].filter((line): line is string => line !== null).join("\n");
}

function getCandidateList(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function inferCandidateDirection(user: UserContext | undefined, candidate: PersonalIntelligenceCandidate): string {
  const metadata: MemoryMetadata = sanitizeCandidateMetadata(candidate.metadata);
  const explicitDirection = normalizeDirectionMetadataValue(metadata.sourceDirection);
  if (explicitDirection) {
    return explicitDirection;
  }

  const sender = candidate.senderEmail?.trim().toLowerCase() || null;
  if (sender === "me" || isTruthyMetadataFlag(metadata.localUser) || isTruthyMetadataFlag(metadata.isFromMe)) {
    return "sent_or_authored_by_user";
  }
  const metadataDirection = typeof metadata.direction === "string" ? metadata.direction.trim().toLowerCase() : "";
  if (metadataDirection === "sent" || metadataDirection === "sent_by_user") {
    return "sent_or_authored_by_user";
  }
  if (metadataDirection === "received" || metadataDirection === "received_by_user") {
    return "received_by_user";
  }

  const userEmail = getUserEmailFromMetadata(user, metadata);
  if (sender && userEmail && sender === userEmail) {
    return "sent_or_authored_by_user";
  }

  if (candidate.recipientEmails.length > 0 && userEmail && candidate.recipientEmails.some((email) => email.trim().toLowerCase() === userEmail)) {
    return "received_by_user";
  }

  if (candidate.toolkitSlug.toLowerCase().includes("mail") || candidate.sourceType.toLowerCase().includes("email")) {
    return sender ? "received_or_visible_in_user_mailbox" : "visible_in_user_mailbox";
  }

  return "visible_in_user_connected_account";
}

function formatCandidateSenderLine(candidate: PersonalIntelligenceCandidate, direction: string): string {
  if (USER_AUTHORED_DIRECTIONS.has(direction)) {
    return "Sender in source record: local user.";
  }

  return candidate.senderEmail
    ? `Sender in source record: ${candidate.senderEmail}`
    : "Sender in source record: unknown or unavailable.";
}

const USER_AUTHORED_DIRECTIONS = new Set<string>([
  "sent_or_authored_by_user",
  "authored_by_user",
  "sent_by_user",
]);

function normalizeDirectionMetadataValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const direction = value.trim().toLowerCase();
  if (!direction) {
    return null;
  }
  if (direction === "sent" || direction === "sent_by_user" || direction === "authored_by_user") {
    return "sent_or_authored_by_user";
  }
  if (direction === "received") {
    return "received_by_user";
  }
  return direction;
}

function isTruthyMetadataFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "null";
  }
  return false;
}

function getUserEmailFromMetadata(user: UserContext | undefined, metadata: MemoryMetadata): string | null {
  const possibleValues = [metadata["sourceAccountEmail"], metadata["accountEmail"], metadata["userEmail"], metadata["mailboxEmail"]];
  for (const value of possibleValues) {
    if (typeof value === "string" && value.includes("@")) {
      return value.trim().toLowerCase();
    }
  }

  return user?.phoneNumber?.includes("@") ? user.phoneNumber.trim().toLowerCase() : null;
}

async function recordRetainedSource(
  sourceStore: Pick<PersonalIntelligenceSourceStore, "recordRetainedSource"> | undefined,
  params: RecordPersonalIntelligenceSourceParams,
): Promise<void> {
  if (!sourceStore) {
    return;
  }

  try {
    await sourceStore.recordRetainedSource(params);
  } catch (error) {
    logger.warn({ error, sourceId: params.sourceId, toolkitSlug: params.toolkitSlug }, "Personal intelligence source ledger write failed");
  }
}

function buildCheckpointScopes(connectors: UserConnectorConfig[]): PersonalIntelligenceCheckpointScope[] {
  return connectors.flatMap((connector) => {
    const connectorScope = getPersonalIntelligenceConnectorScope(connector);
    if (!connectorScope) {
      return [];
    }

    const sourceTypes = connector.toolkitSlug === puterToolkitSlug
      ? getPuterCheckpointSourceTypes(connector.enabledTools)
      : checkpointSourceTypes;

    return sourceTypes.map((sourceType) => ({
      toolkitSlug: connectorScope.toolkitSlug,
      accountScopeId: connectorScope.accountScopeId,
      connectedAccountId: connectorScope.connectedAccountId,
      sourceType,
    }));
  });
}

function buildAllowedPersonalIntelligenceScopes(connectors: UserConnectorConfig[]): AllowedPersonalIntelligenceScope[] {
  return connectors.flatMap((connector): AllowedPersonalIntelligenceScope[] => {
    const connectorScope = getPersonalIntelligenceConnectorScope(connector);
    if (!connectorScope) {
      return [];
    }

    if (connector.toolkitSlug === puterToolkitSlug) {
      return getPuterCheckpointSourceTypes(connector.enabledTools).map((sourceType) => ({
        toolkitSlug: connectorScope.toolkitSlug,
        accountScopeId: connectorScope.accountScopeId,
        connectedAccountId: connectorScope.connectedAccountId,
        sourceType: sourceType.trim().toLowerCase(),
        enforceSourceType: true,
      }));
    }

    return [{
      toolkitSlug: connectorScope.toolkitSlug,
      accountScopeId: connectorScope.accountScopeId,
      connectedAccountId: connectorScope.connectedAccountId,
      sourceType: "any-source",
      enforceSourceType: false,
    }];
  });
}

function connectorRunScope(connector: Pick<UserConnectorConfig, "toolkitSlug" | "connectedAccountId"> & { personalIntelligenceAccountScopeId?: string | null; accountScopeId?: string | null }): { toolkitSlug: string; accountScopeId: string; connectedAccountId: string } {
  const scope = getPersonalIntelligenceConnectorScope(connector);
  return {
    toolkitSlug: connector.toolkitSlug,
    accountScopeId: scope?.accountScopeId ?? "",
    connectedAccountId: scope?.connectedAccountId ?? "",
  };
}

function isResolvedComposioPersonalIntelligenceConnector(connector: UserConnectorConfig): boolean {
  const enriched = connector as UserConnectorConfig & {
    personalIntelligenceAccountScopeId?: string | null;
    personalIntelligenceIdentityStatus?: string | null;
  };
  return enriched.personalIntelligenceIdentityStatus === "resolved"
    && Boolean(enriched.personalIntelligenceAccountScopeId?.trim());
}

function getPuterPersonalIntelligenceToolsets(enabledTools: string[] | null | undefined): Set<string> {
  const toolsets = new Set<string>();
  for (const enabledTool of enabledTools ?? []) {
    if (!puterPersonalIntelligenceToolSlugs.has(enabledTool)) {
      continue;
    }
    const toolset = puterToolsetForPersonalIntelligenceMarker(enabledTool);
    if (toolset) {
      toolsets.add(toolset);
    }
  }
  return toolsets;
}

function getPuterCheckpointSourceTypes(enabledTools: string[] | null | undefined): string[] {
  return [...getPuterPersonalIntelligenceToolsets(enabledTools)]
    .map((toolset) => toolset.slice(`${puterToolkitSlug}.`.length))
    .filter((sourceType) => sourceType.length > 0);
}

function getPendingAvailablePuterToolsets(
  run: { contributorStatus: unknown } | null,
  enabledSources: ReadonlySet<string>,
  access: PuterLocalAccessStatus | null | undefined,
): Set<string> {
  const available = filterAvailablePuterToolsets(enabledSources, access ?? undefined);
  const completed = getCompletedPuterSources(run);
  return new Set([...available].filter((source) => !completed.has(source)));
}

function getCompletedPuterSources(run: { contributorStatus: unknown } | null): Set<string> {
  if (!run || !isRecord(run.contributorStatus)) {
    return new Set();
  }

  const completedSources = run.contributorStatus["enabledLocalSources"];
  if (!Array.isArray(completedSources)) {
    return new Set();
  }

  return new Set(completedSources.filter((source): source is string => typeof source === "string"));
}

function getBlockedPuterToolsets(
  requested: ReadonlySet<string>,
  available: ReadonlySet<string>,
  access: PuterLocalAccessStatus | null | undefined,
): Array<{ toolset: string; message: string }> {
  return [...requested]
    .filter((toolset) => !available.has(toolset))
    .flatMap((toolset) => {
      const source = puterSourceForToolset(toolset);
      if (!source) {
        return [];
      }

      return [{
        toolset,
        message: getPuterSourceAvailability(access ?? undefined, source).message,
      }];
    });
}

function decoratePuterCommandResult(result: unknown, provenance: {
  accountScopeId: string;
  currentConnectedAccountId: string;
  deviceId: string;
}): unknown {
  const provenancePayload = {
    personalIntelligenceAccountScopeId: provenance.accountScopeId,
    currentConnectedAccountId: provenance.currentConnectedAccountId,
    puterDeviceId: provenance.deviceId,
  };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...(result as Record<string, unknown>),
      provenance: {
        ...((result as Record<string, unknown>).provenance as Record<string, unknown> | undefined),
        ...provenancePayload,
      },
      personalIntelligenceAccountScopeId: provenance.accountScopeId,
      currentConnectedAccountId: provenance.currentConnectedAccountId,
    };
  }
  return {
    result,
    provenance: provenancePayload,
  };
}

function mergePuterBlockedSkippedReasons(
  skippedReasons: Record<string, unknown>,
  blockedToolsets: Array<{ toolset: string; message: string }>,
): Record<string, unknown> {
  if (blockedToolsets.length === 0) {
    return skippedReasons;
  }

  return {
    ...skippedReasons,
    puterBlockedLocalSources: blockedToolsets,
  };
}

function formatAllowedPersonalIntelligenceScopes(scopes: AllowedPersonalIntelligenceScope[]): string {
  if (scopes.length === 0) {
    return "none";
  }
  return scopes
    .map((scope) => `${scope.toolkitSlug}/${scope.enforceSourceType === false ? "any-source" : scope.sourceType} accountScopeId=${scope.accountScopeId} currentConnectedAccountId=${scope.connectedAccountId}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildCheckpointUpdates(input: {
  connectors: UserConnectorConfig[];
  runPlan: PersonalIntelligenceRunPlan;
  runId: string;
  selection: PersonalIntelligenceRunSelection;
}): PersonalIntelligenceCheckpointUpdate[] {
  const coverageEnd = input.selection.checkpoint.coverageEnd ?? input.runPlan.windowEnd;
  const lastProcessedSourceTimestamp = input.selection.checkpoint.lastProcessedSourceTimestamp ?? coverageEnd;
  return buildCheckpointScopes(input.connectors).map((scope) => ({
    ...scope,
    runId: input.runId,
    coverageStart: input.runPlan.windowStart,
    coverageEnd,
    lastProcessedSourceTimestamp,
    sourceCursor: input.selection.checkpoint.sourceCursor,
    initialBackfillCompletedAt: coverageEnd,
    handoffSummary: input.selection.checkpoint.summary,
    lastExploredEntities: input.selection.checkpoint.exploredEntities,
    knownGaps: input.selection.checkpoint.knownGaps,
    metadata: {
      mode: input.runPlan.mode,
      retainedCount: input.selection.retainedDocumentIds.length,
      skippedCount: Object.keys(input.selection.skippedReasons).length,
    },
  }));
}

function getEarliestCoverageEnd(checkpoints: StoredPersonalIntelligenceCheckpoint[]): Date | null {
  let earliest: Date | null = null;
  for (const checkpoint of checkpoints) {
    if (!checkpoint.coverageEnd) {
      continue;
    }
    if (!earliest || checkpoint.coverageEnd < earliest) {
      earliest = checkpoint.coverageEnd;
    }
  }
  return earliest;
}

function formatCheckpointContext(checkpoints: StoredPersonalIntelligenceCheckpoint[]): string {
  if (checkpoints.length === 0) {
    return "No previous coverage checkpoints. Treat this as a bounded initial backfill.";
  }

  const sorted = [...checkpoints]
    .sort((left, right) => (right.coverageEnd?.getTime() ?? 0) - (left.coverageEnd?.getTime() ?? 0))
    .slice(0, maxCheckpointContextItems);
  const sections = sorted.map((checkpoint) => [
    `- scope: ${checkpoint.toolkitSlug}/${checkpoint.sourceType} accountScope=${checkpoint.accountScopeId} currentConnectedAccount=${checkpoint.connectedAccountId}`,
    checkpoint.coverageStart ? `  coverageStart: ${checkpoint.coverageStart.toISOString()}` : null,
    checkpoint.coverageEnd ? `  coverageEnd: ${checkpoint.coverageEnd.toISOString()}` : null,
    checkpoint.lastProcessedSourceTimestamp ? `  lastProcessedSourceTimestamp: ${checkpoint.lastProcessedSourceTimestamp.toISOString()}` : null,
    checkpoint.handoffSummary ? `  handoff: ${truncate(checkpoint.handoffSummary, 600)}` : null,
    checkpoint.lastExploredEntities && checkpoint.lastExploredEntities.length > 0 ? `  explored: ${truncate(formatJsonForPrompt(checkpoint.lastExploredEntities.slice(0, 5)), 500)}` : null,
    checkpoint.knownGaps && checkpoint.knownGaps.length > 0 ? `  gaps: ${truncate(formatJsonForPrompt(checkpoint.knownGaps.slice(0, 5)), 500)}` : null,
  ].filter((line): line is string => line !== null).join("\n"));
  const text = sections.join("\n");

  return estimateTokens(text) > 3_000 ? truncate(text, 12_000) : text;
}

function normalizeRunCheckpoint(input: z.infer<typeof checkpointInputSchema>, fallbackCoverageEnd: Date): PersonalIntelligenceRunCheckpoint {
  const coverageEnd = normalizeDate(input.coverageEnd) ?? fallbackCoverageEnd;
  const lastProcessedSourceTimestamp = normalizeDate(input.lastProcessedSourceTimestamp) ?? coverageEnd;
  return {
    summary: truncate(input.summary, maxHandoffSummaryLength),
    coverageEnd,
    lastProcessedSourceTimestamp,
    sourceCursor: input.sourceCursor.trim() || null,
    exploredEntities: sanitizeCheckpointRecords(input.exploredEntities),
    knownGaps: sanitizeCheckpointRecords(input.knownGaps),
  };
}

function normalizeFinalOutcome(
  input: z.infer<typeof personalIntelligenceFinalOutcomeSchema>,
  fallbackCoverageEnd: Date,
): PersonalIntelligenceFinalOutcome {
  return {
    status: input.status,
    summary: truncate(input.auditSummary, maxRunSummaryLength),
    retainedItems: input.retainedItems,
    skippedNoise: input.skippedNoise.map((item) => truncate(item, 200)),
    checkpoint: normalizeRunCheckpoint(input.checkpoint, fallbackCoverageEnd),
  };
}

function formatFinalOutcomeSummary(outcome: PersonalIntelligenceFinalOutcome, actualRetainedItems: number): string {
  const status = outcome.status === "completed" ? "Completed" : "Partially completed";
  const retained = `retained ${actualRetainedItems} item${actualRetainedItems === 1 ? "" : "s"}`;
  const skippedNoise = outcome.skippedNoise.length > 0
    ? ` Skipped noise: ${outcome.skippedNoise.join("; ")}.`
    : "";
  const modelCountNote = outcome.retainedItems !== actualRetainedItems
    ? ` Model reported ${outcome.retainedItems} retained.`
    : "";

  return truncate(`${status}: ${outcome.summary} (${retained}).${skippedNoise}${modelCountNote}`, maxRunSummaryLength);
}

function buildFallbackRunCheckpoint(input: {
  summary: string;
  runPlan: PersonalIntelligenceRunPlan;
  retainedDocumentIds: string[];
  skippedReasons: Record<string, unknown>;
}): PersonalIntelligenceRunCheckpoint {
  const summary = input.summary.trim()
    || `Inspected ${input.runPlan.mode} window and retained ${input.retainedDocumentIds.length} item${input.retainedDocumentIds.length === 1 ? "" : "s"}.`;
  return {
    summary: truncate(summary, maxHandoffSummaryLength),
    coverageEnd: input.runPlan.windowEnd,
    lastProcessedSourceTimestamp: input.runPlan.windowEnd,
    sourceCursor: null,
    exploredEntities: [],
    knownGaps: Object.keys(input.skippedReasons).length > 0
      ? [{ reason: `Skipped ${Object.keys(input.skippedReasons).length} candidate(s); see automation run skippedReasons.` }]
      : [],
  };
}

function sanitizeCheckpointRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        sanitized[key] = value;
      } else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) {
        sanitized[key] = value.slice(0, 12);
      }
    }
    return sanitized;
  });
}

function normalizeDate(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatJsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function buildPersonalIntelligenceSourceKey(candidate: Pick<PersonalIntelligenceCandidate, "toolkitSlug" | "connectedAccountId" | "sourceType" | "sourceId"> & { accountScopeId?: string | null }): string {
  const accountScopeId = candidate.accountScopeId?.trim() || getPersonalIntelligenceAccountScopeId(candidate);
  if (!accountScopeId) {
    throw new Error("Personal Intelligence source key requires an account scope.");
  }
  return `${candidate.toolkitSlug.trim().toLowerCase()}:${accountScopeId}:${candidate.sourceType.trim().toLowerCase()}:${candidate.sourceId.trim()}`;
}

function sanitizeCandidateMetadata(metadata: Record<string, unknown>): MemoryMetadata {
  const sanitized: MemoryMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function getErrorMessage(error: unknown): string {
  const abortMessage = getAbortErrorMessage(error);
  if (abortMessage) {
    return abortMessage;
  }

  return error instanceof Error && error.message.length > 0 ? error.message : "unknown";
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup("hour")}:${lookup("minute")}:${lookup("second")} ${lookup("timeZoneName")}`.trim();
}
