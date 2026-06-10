import {
  Compactor,
  buildHotPathIdentityFiles,
  createHotPathAgent,
  WorkerManager,
} from "@finn/agents";
import type { Attachment, AppConfig, InboundMessage, PatternRecord, UserContext, UserMessage } from "@finn/core";
import { createLogger, formatComposioUserId, normalizePhoneNumber, type EventBus, type SpawnWorkerFn } from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import { PatternStore } from "@finn/patterns";
import { McpService, type ComposioTriggerTypeSummary, type IntegrationClients } from "@finn/integrations";
import { LLMManager } from "@finn/llm";
import { AttachmentProcessor, FileStorage, type SpeechToTextClient, type TextToSpeechClient } from "@finn/media";
import { MessageSender, SpectrumClient } from "@finn/messaging";
import {
  createFilesRuntime,
  createCreativeRuntimeService,
  createMcpRuntimeService,
  createMemoryRuntimeService,
  createPatternsRuntimeService,
  createProcessRuntimeServices,
  createUserRuntimeServices,
  createWebRuntimeService,
  finnInternalWorkspacePath,
  prepareImageForModelInput,
  type FilesRuntime,
  type MemoryRuntimeService,
  type UserRuntimeServices,
} from "@finn/runtime";
import {
  createGetWorkerTools,
  createHotPathTurnTools,
  type UserProfileUpdate,
  type WorkerToolsDeps,
} from "@finn/tools";
import { HotPathIngressCoordinator } from "./hot-path-ingress.js";
import { emitPatternActivity } from "./activity-feed.js";
import {
  deleteUnusedComposioTrigger,
  removePatternWithComposioTriggerLifecycle,
  updatePatternWithComposioTriggerLifecycle,
} from "./composio-trigger-lifecycle.js";
import { getConnectorConfig } from "./connector-config.js";
import { syncUserProfileSeedToMemory } from "./memory-profile-seed.js";
import { createMcpOAuthStore, McpServerStore } from "./mcp-store.js";
import { MyDayStore } from "./my-day-store.js";
import {
  filterAvailablePuterToolsets,
  puterDeviceIdFromConnectedAccount,
  puterEnabledToolsetSlugs,
  puterToolkitSlug,
} from "./puter-connector.js";
import type { PuterBridge } from "./puter-bridge.js";
import { UserComposioService } from "./user-composio-service.js";
import type { UserRegistry } from "./user-registry.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";

const logger = createLogger("user-runtime");

export function canExposeVoiceReplyTool(input: {
  textToSpeechAvailable: boolean;
  hasTextToSpeechClient: boolean;
}): boolean {
  return input.textToSpeechAvailable && input.hasTextToSpeechClient;
}

function isVoiceReplyAvailable(config: AppConfig, textToSpeechClient?: TextToSpeechClient): boolean {
  return canExposeVoiceReplyTool({
    textToSpeechAvailable: config.capabilities.media.textToSpeech,
    hasTextToSpeechClient: Boolean(textToSpeechClient),
  });
}

export function shouldConvertInboundAudioToWav(input: { mimeType: string }): boolean {
  return input.mimeType === "audio/x-caf";
}

function hotPathCodeModeRunId(message: InboundMessage): string {
  switch (message.source) {
    case "user":
      return `hot_path_${message.messageId}`;
    case "worker":
      return `hot_path_worker_${message.workerId}`;
    case "trigger":
      return `hot_path_trigger_${message.triggerId}`;
  }
}

export async function assertComposioPatternAvailability(params: {
  toolkitSlug: string;
  triggerSlug: string;
  connectedAccountId: string;
  allowedToolkits?: string[];
  listTriggerTypes: (toolkitSlug: string) => Promise<Array<{ slug: string }>>;
  getTriggerType?: (triggerSlug: string) => Promise<ComposioTriggerTypeSummary>;
  getConnectorConfig: (toolkitSlug: string) => Promise<{ connected: boolean; connectedAccountId: string | null } | null>;
}): Promise<void> {
  if (params.allowedToolkits && !params.allowedToolkits.includes(params.toolkitSlug)) {
    throw new Error(`Composio toolkit is not enabled: ${params.toolkitSlug}`);
  }

  const triggerTypes = await params.listTriggerTypes(params.toolkitSlug);
  if (!triggerTypes.some((trigger) => trigger.slug === params.triggerSlug)) {
    throw new Error(`Composio trigger is not enabled for ${params.toolkitSlug}: ${params.triggerSlug}`);
  }

  if (params.getTriggerType) {
    const triggerType = await params.getTriggerType(params.triggerSlug);
    if (triggerType.toolkitSlug && triggerType.toolkitSlug !== params.toolkitSlug) {
      throw new Error(`Composio trigger ${params.triggerSlug} belongs to ${triggerType.toolkitSlug}, not ${params.toolkitSlug}`);
    }
  }

  const connector = await params.getConnectorConfig(params.toolkitSlug);
  if (!connector?.connected || connector.connectedAccountId !== params.connectedAccountId) {
    throw new Error(`Composio toolkit is not connected for this user: ${params.toolkitSlug}`);
  }
}

type UserRuntime = {
  user: UserContext;
  userRoot: string;
  services: UserRuntimeServices;
  files: FilesRuntime;
  ingress: HotPathIngressCoordinator;
  workerManager: WorkerManager;
  patternStore: PatternStore;
  composio?: UserComposioService;
  mcpService: McpService;
  messageSender: MessageSender;
  hotPathAgent: ReturnType<typeof createHotPathAgent>;
  workerToolsDeps: WorkerToolsDeps;
  stopConversationMaintenance: () => void;
};

function hasUserRuntimeChanges(current: UserContext, next: UserContext): boolean {
  return current.displayName !== next.displayName
    || current.phoneNumber !== next.phoneNumber
    || current.timezone !== next.timezone
    || current.timezoneSource !== next.timezoneSource
    || current.location !== next.location
    || current.kidsMode !== next.kidsMode;
}

function getNextRolloverDelayMs(now: Date, timeZone: string, hour: number, minute: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const localHour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const localMinute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const localSecond = Number(parts.find((part) => part.type === "second")?.value ?? 0);
  const localElapsedSeconds = localHour * 3600 + localMinute * 60 + localSecond;
  const targetSeconds = hour * 3600 + minute * 60;
  const secondsUntilTarget = targetSeconds > localElapsedSeconds
    ? targetSeconds - localElapsedSeconds
    : 24 * 3600 - localElapsedSeconds + targetSeconds;

  return Math.max(60_000, secondsUntilTarget * 1000);
}

function startConversationMaintenance(user: UserContext, config: AppConfig, compactor: Compactor): () => void {
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (stopped) {
      return;
    }

    compactor.ensureCurrentChapter(new Date(), { waitForSummary: true }).catch((error: unknown) => {
      logger.error({ error, userId: user.userId }, "Conversation chapter maintenance failed");
    });

    const delayMs = getNextRolloverDelayMs(
      new Date(),
      user.timezone || config.userTimezone,
      config.context.dailyRolloverHour,
      config.context.dailyRolloverMinute,
    );
    timeout = setTimeout(run, delayMs);
  };

  timeout = setTimeout(run, 1_000);

  return () => {
    stopped = true;
    if (timeout) {
      clearTimeout(timeout);
    }
  };
}

function getLocalDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function resolveUserRuntimeRoot(config: AppConfig, user: Pick<UserContext, "tenantId" | "userId">): string {
  return resolve(config.workerSandbox.workspacesPath, user.tenantId, user.userId);
}

export function resolveWorkerWorkspaceRoot(config: AppConfig, user: Pick<UserContext, "tenantId" | "userId">): string {
  return resolve(resolveUserRuntimeRoot(config, user), "workspace");
}

export function resolveWorkerArtifactsRoot(config: AppConfig, user: Pick<UserContext, "tenantId" | "userId">): string {
  return resolve(resolveUserRuntimeRoot(config, user), "artifacts");
}

export class UserRuntimeRegistry {
  private readonly runtimes = new Map<string, Promise<UserRuntime>>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      db: Database;
      llmManager: LLMManager;
      eventBus: EventBus;
      spectrumClient: SpectrumClient;
      integrations: IntegrationClients;
      userRegistry: UserRegistry;
      puterBridge?: PuterBridge;
      speechToTextClient?: SpeechToTextClient;
      textToSpeechClient?: TextToSpeechClient;
    },
  ) {}

  private runtimeKey(user: Pick<UserContext, "tenantId" | "userId">): string {
    return `${user.tenantId}:${user.userId}`;
  }

  private async requireRuntimeUser(user: Pick<UserContext, "tenantId" | "userId">): Promise<UserContext> {
    const resolved = await this.deps.userRegistry.requireUser(user.userId);
    if (resolved.tenantId !== user.tenantId) {
      throw new Error(`Runtime tenant mismatch for user ${user.userId}`);
    }

    return resolved;
  }

  async ensure(user: UserContext): Promise<UserRuntime> {
    const key = this.runtimeKey(user);
    const existing = this.runtimes.get(key);
    if (existing) {
      const runtime = await existing;
      return hasUserRuntimeChanges(runtime.user, user) ? this.refresh(user) : runtime;
    }

    const created = this.createRuntime(user);
    this.runtimes.set(key, created);
    return created;
  }

  async enqueueUser(message: UserMessage): Promise<void> {
    const user = await this.deps.userRegistry.requireUser(message.userId);
    const runtime = await this.ensure(user);
    runtime.ingress.enqueueUser(message);
  }

  async enqueueInternal(message: Exclude<InboundMessage, UserMessage>): Promise<void> {
    const user = await this.deps.userRegistry.requireUser(message.userId);
    const runtime = await this.ensure(user);
    runtime.ingress.enqueueInternal(message);
  }

  async enqueueUserHandoff(message: UserMessage): Promise<void> {
    const user = await this.deps.userRegistry.requireUser(message.userId);
    if (user.tenantId !== message.tenantId) {
      throw new Error(`Hot-path handoff tenant mismatch for user ${message.userId}`);
    }

    const runtime = await this.ensure(user);
    runtime.ingress.enqueueUser(message);
  }

  readonly spawnWorker: SpawnWorkerFn = async (opts) => {
    const user = await this.deps.userRegistry.requireUser(opts.userId);
    if (user.tenantId !== opts.tenantId) {
      throw new Error(`Worker tenant mismatch for user ${opts.userId}`);
    }

    const runtime = await this.ensure(user);
    return runtime.workerManager.spawn(opts);
  };

  async cancelWorker(user: UserContext, workerId: string): Promise<void> {
    const runtime = await this.ensure(user);
    await runtime.workerManager.cancel(workerId);
  }

  async getPatternStore(user: UserContext): Promise<PatternStore> {
    const resolved = await this.requireRuntimeUser(user);
    return new PatternStore({ db: this.deps.db, user: resolved });
  }

  async shutdownAll(): Promise<void> {
    const runtimes = await Promise.all(this.runtimes.values());
    await Promise.all(runtimes.map(async (runtime) => {
      runtime.stopConversationMaintenance();
      await runtime.mcpService.close();
      await runtime.workerManager.shutdownAll();
    }));
  }

  async refresh(user: UserContext): Promise<UserRuntime> {
    const existing = this.runtimes.get(this.runtimeKey(user));
    if (!existing) {
      return this.ensure(user);
    }

    const runtime = await existing;
    runtime.user.displayName = user.displayName;
    runtime.user.phoneNumber = user.phoneNumber;
    runtime.user.timezone = user.timezone;
    runtime.user.timezoneSource = user.timezoneSource;
    runtime.user.location = user.location;
    runtime.user.kidsMode = user.kidsMode;
    runtime.workerToolsDeps.allowComposioConnectionRequests = !user.kidsMode;
    runtime.hotPathAgent.setIdentityFiles(buildHotPathIdentityFiles({ config: this.deps.config, user: runtime.user }));
    runtime.ingress.updateUser(runtime.user);
    runtime.messageSender.setRecipient(user.phoneNumber);
    await this.reloadMcpServers(runtime);
    return runtime;
  }

  async getMcpStatuses(user: UserContext) {
    const runtime = await this.ensure(user);
    return runtime.mcpService.getStatuses();
  }

  async getUserRuntimeServices(user: Pick<UserContext, "tenantId" | "userId">): Promise<UserRuntimeServices> {
    return (await this.ensure(await this.requireRuntimeUser(user))).services;
  }

  async getUserRoot(user: Pick<UserContext, "tenantId" | "userId">): Promise<string> {
    return resolveUserRuntimeRoot(this.deps.config, await this.requireRuntimeUser(user));
  }

  async getFilesRuntime(user: Pick<UserContext, "tenantId" | "userId">): Promise<FilesRuntime> {
    return this.createFilesRuntimeForUser(await this.requireRuntimeUser(user)).filesRuntime;
  }

  async getAutomationRuntimeServices(user: Pick<UserContext, "tenantId" | "userId">): Promise<UserRuntimeServices> {
    const resolved = await this.requireRuntimeUser(user);
    const { workspaceRoot, artifactsRoot, filesRuntime } = this.createFilesRuntimeForUser(resolved);
    const memoryRuntime = this.createMemoryRuntimeForUser(resolved);
    return createUserRuntimeServices({
      user: resolved,
      workspace: { workspaceRoot, artifactsRoot },
      files: filesRuntime,
      ...(memoryRuntime ? { memory: memoryRuntime } : {}),
    });
  }

  async getMemoryRuntime(user: Pick<UserContext, "tenantId" | "userId">): Promise<MemoryRuntimeService | undefined> {
    return this.createMemoryRuntimeForUser(await this.requireRuntimeUser(user));
  }

  async getComposioService(user: Pick<UserContext, "tenantId" | "userId">): Promise<UserComposioService | undefined> {
    const resolved = await this.requireRuntimeUser(user);
    if (!this.deps.integrations.composio) {
      return undefined;
    }

    return new UserComposioService({
      db: this.deps.db,
      user: resolved,
      composio: this.deps.integrations.composio,
      patternStore: new PatternStore({ db: this.deps.db, user: resolved }),
      eventBus: this.deps.eventBus,
    });
  }

  async refreshMcpServers(user: UserContext): Promise<void> {
    const runtime = await this.ensure(user);
    await this.reloadMcpServers(runtime);
  }

  private async updateUserProfile(user: UserContext, update: UserProfileUpdate): Promise<UserContext> {
    const [updated] = await this.deps.db
      .update(schema.users)
      .set({
        ...(update.displayName ? { displayName: update.displayName } : {}),
        ...(update.location ? { location: update.location } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, user.userId))
      .returning();

    if (!updated) {
      throw new Error(`User not found: ${user.userId}`);
    }

    const userContext = await this.deps.userRegistry.requireUser(user.userId);
    await this.refresh(userContext);
    void syncUserProfileSeedToMemory({
      db: this.deps.db,
      memory: this.deps.integrations.memory,
      storedUser: updated,
      user: userContext,
    }).catch((error: unknown) => {
      logger.warn({ error, tenantId: userContext.tenantId, userId: userContext.userId }, "User profile memory seed sync failed");
    });
    return userContext;
  }

  private async reloadMcpServers(runtime: UserRuntime): Promise<void> {
    const mcpStore = new McpServerStore(this.deps.db, {
      getUserRoot: async () => runtime.userRoot,
    });
    await runtime.mcpService.loadConfigs(await mcpStore.listActiveForUser(runtime.user));
  }

  private createFilesRuntimeForUser(user: UserContext): {
    userRoot: string;
    workspaceRoot: string;
    artifactsRoot: string;
    fileStorage: FileStorage;
    filesRuntime: FilesRuntime;
  } {
    const userRoot = resolveUserRuntimeRoot(this.deps.config, user);
    const workspaceRoot = resolveWorkerWorkspaceRoot(this.deps.config, user);
    const artifactsRoot = resolveWorkerArtifactsRoot(this.deps.config, user);
    const fileStorage = new FileStorage({
      storagePath: `${workspaceRoot}/files`,
      maxFileSizeMb: this.deps.config.fileStorage.maxFileSizeMb,
      db: this.deps.db,
      user,
    });
    const filesRuntime = createFilesRuntime({
      access: "write",
      workspaceRoot,
      artifactsRoot,
      blockedWorkspacePaths: [finnInternalWorkspacePath],
      fileStorage,
      publicUrl: this.deps.config.publicUrl,
      documentExtraction: {
        tempRoot: `${workspaceRoot}/tmp/document-extraction`,
      },
    });

    return { userRoot, workspaceRoot, artifactsRoot, fileStorage, filesRuntime };
  }

  private createMemoryRuntimeForUser(user: UserContext) {
    return this.deps.integrations.memory
      ? createMemoryRuntimeService({ client: this.deps.integrations.memory, user })
      : undefined;
  }

  private async createRuntime(user: UserContext): Promise<UserRuntime> {
    const config = this.deps.config;
    const db = this.deps.db;
    const { userRoot, workspaceRoot, artifactsRoot, fileStorage: userFileStorage, filesRuntime } = this.createFilesRuntimeForUser(user);
    await mkdir(`${userRoot}/.finn`, { recursive: true, mode: 0o700 });
    await mkdir(`${workspaceRoot}/skills`, { recursive: true });
    await mkdir(artifactsRoot, { recursive: true });
    const preliminaryUserRuntimeServices = createUserRuntimeServices({
      user,
      workspace: { workspaceRoot, artifactsRoot },
      files: filesRuntime,
    });
    const getCurrentUserRoot = async () => userRoot;
    const mcpStore = new McpServerStore(db, { getUserRoot: getCurrentUserRoot });
    const userMcpService = new McpService({
      configs: await mcpStore.listActiveForUser(user),
      oauthStore: createMcpOAuthStore({
        db,
        getUserRoot: getCurrentUserRoot,
        user,
        publicUrl: config.publicUrl,
      }),
    });
    await userMcpService.initialize();
    const messageSender = new MessageSender(this.deps.spectrumClient, {
      recipientPhoneNumber: user.phoneNumber,
      fileStorage: userFileStorage,
    });
    const patternStore = new PatternStore({ db, user });
    const userComposio = this.deps.integrations.composio
      ? new UserComposioService({
          db,
          user,
          composio: this.deps.integrations.composio,
          patternStore,
          eventBus: this.deps.eventBus,
        })
      : undefined;
    const compactor = new Compactor({
      db,
      llmManager: this.deps.llmManager,
      eventBus: this.deps.eventBus,
      config,
      user,
    });
    const memoryRuntime = this.createMemoryRuntimeForUser(user);
    const emitPatternLifecycleActivity = (pattern: PatternRecord, action: "created" | "edited" | "paused" | "resumed" | "deleted", origin: "hot_path" | "pattern_management") => {
      emitPatternActivity({
        eventBus: this.deps.eventBus,
        pattern,
        action,
        origin,
      });
    };
    const getActivityActionForUpdate = (before: PatternRecord | null, pattern: PatternRecord): "edited" | "paused" | "resumed" => before && before.active !== pattern.active
      ? pattern.active ? "resumed" : "paused"
      : "edited";
    const patternsRuntime = createPatternsRuntimeService({
      user,
      create: async (params) => {
        const pattern = await patternStore.create(params);
        emitPatternLifecycleActivity(pattern, "created", "pattern_management");
        return pattern;
      },
      list: () => patternStore.list(),
      listRuns: (params) => patternStore.listRuns(params),
      getRun: (patternId, runId) => patternStore.getRun(patternId, runId),
      get: (id) => patternStore.getById(id),
      update: async (id, params) => {
        const before = params.active !== undefined ? await patternStore.getById(id) : null;
        const pattern = await updatePatternWithComposioTriggerLifecycle({
          patternStore,
          composio: userComposio,
          patternId: id,
          params,
        });
        if (pattern) {
          emitPatternLifecycleActivity(pattern, getActivityActionForUpdate(before, pattern), "pattern_management");
        }
        return pattern;
      },
      deleteComposioTrigger: async (triggerId, params) => {
        if (!userComposio) {
          return;
        }
        await deleteUnusedComposioTrigger({
          patternStore,
          composio: userComposio,
          triggerId,
          excludedPatternId: params?.excludedPatternId,
        });
      },
      remove: async (id) => {
        const deleted = await removePatternWithComposioTriggerLifecycle({
          patternStore,
          composio: userComposio,
          patternId: id,
        });
        if (deleted) {
          emitPatternLifecycleActivity(deleted, "deleted", "pattern_management");
        }
        return deleted;
      },
      listTriggerTypes: async (toolkitSlug) => userComposio?.listTriggerTypes(toolkitSlug) ?? [],
      getTriggerType: async (triggerSlug) => {
        if (!userComposio) {
          throw new Error("Composio is not configured.");
        }
        return userComposio.getTriggerType(triggerSlug);
      },
      createComposioConnectionLink: async (toolkitSlug) => {
        if (!userComposio) {
          throw new Error("Composio is not configured.");
        }
        return userComposio.createConnectionLink(toolkitSlug, config.integrations?.composio?.callbackUrl);
      },
      createComposioTrigger: async (params) => {
        if (!userComposio) {
          throw new Error("Composio is not configured.");
        }
        await assertComposioPatternAvailability({
          toolkitSlug: params.toolkitSlug,
          triggerSlug: params.triggerSlug,
          connectedAccountId: params.connectedAccountId,
          allowedToolkits: userComposio.getAllowedToolkits(),
          listTriggerTypes: (toolkitSlug) => userComposio.listTriggerTypes(toolkitSlug),
          getTriggerType: (triggerSlug) => userComposio.getTriggerType(triggerSlug),
          getConnectorConfig: (toolkitSlug) => userComposio.getConnectorConfig(toolkitSlug),
        });

        const created = await userComposio.createTrigger(params.triggerSlug, {
          connectedAccountId: params.connectedAccountId,
          ...(params.triggerConfig ? { triggerConfig: params.triggerConfig } : {}),
        });
        const trigger = created as { triggerId?: string; id?: string };
        const triggerId = trigger.triggerId ?? trigger.id;
        if (!triggerId) {
          throw new Error("Composio did not return a trigger ID.");
        }
        return triggerId;
      },
    });
    const userRuntimeServices = createUserRuntimeServices({
      user,
      workspace: { workspaceRoot, artifactsRoot },
      files: filesRuntime,
      ...(this.deps.integrations.web ? { web: createWebRuntimeService(this.deps.integrations.web) } : {}),
      ...(this.deps.integrations.creative ? { creative: createCreativeRuntimeService({ client: this.deps.integrations.creative, files: filesRuntime }) } : {}),
      ...(memoryRuntime ? { memory: memoryRuntime } : {}),
      mcp: createMcpRuntimeService(userMcpService),
      ...(userComposio ? { composio: userComposio } : {}),
      patterns: patternsRuntime,
    });
    const myDayStore = new MyDayStore({ db, user });
    const workerToolsDeps: WorkerToolsDeps = {
      integrations: this.deps.integrations,
      user,
      capabilities: config.capabilities.tools.worker,
      runtime: userRuntimeServices,
      composioUserId: userComposio?.composioUserId ?? formatComposioUserId(user),
      composioCallbackUrl: config.integrations?.composio?.callbackUrl,
      allowComposioConnectionRequests: !user.kidsMode,
      composioToolkits: async () => userComposio?.listConfiguredToolkits() ?? [],
      puterToolsets: async () => {
        if (!this.deps.puterBridge) {
          return [];
        }
        const connector = await getConnectorConfig(db, user, puterToolkitSlug);
        const deviceId = puterDeviceIdFromConnectedAccount(connector?.connectedAccountId);
        const status = deviceId ? this.deps.puterBridge.getStatus(user, deviceId) : null;
        if (!connector?.connected || !deviceId || status?.active !== true) {
          return [];
        }
        return [...filterAvailablePuterToolsets(getWorkerPuterToolsets(connector.enabledTools), status.access ?? undefined)];
      },
      puterContext: async ({ workerId }) => {
        const bridge = this.deps.puterBridge;
        if (!bridge) {
          return undefined;
        }
        const connector = await getConnectorConfig(db, user, puterToolkitSlug);
        const deviceId = puterDeviceIdFromConnectedAccount(connector?.connectedAccountId);
        const status = deviceId ? bridge.getStatus(user, deviceId) : null;
        if (!connector?.connected || !connector.connectedAccountId || !deviceId || status?.active !== true) {
          return undefined;
        }
        const enabledTools = [...filterAvailablePuterToolsets(getWorkerPuterToolsets(connector.enabledTools), status.access ?? undefined)];
        if (enabledTools.length === 0) {
          return undefined;
        }
        const excludedHandles = await getPuterExcludedImessageHandles({
          config,
          users: this.deps.userRegistry,
          user,
        });
        const leaseId = bridge.createLease(user, {
          deviceId,
          runId: workerId ?? "worker",
          enabledTools,
        });
        return {
          connectedAccountId: connector.connectedAccountId,
          windowStart: new Date(0),
          windowEnd: new Date(),
          executeCommand: (input, options) => bridge.executeCommand(user, {
            deviceId,
            leaseId,
            windowStart: new Date(0),
            windowEnd: new Date(),
            excludedHandles,
            ...input,
          }, options),
          cleanup: () => bridge.releaseLease(user, deviceId, leaseId),
        };
      },
      mcp: userMcpService,
    };
    const workerManager = new WorkerManager({
      db,
      llmManager: this.deps.llmManager,
      eventBus: this.deps.eventBus,
      config,
      user,
      getWorkerTools: createGetWorkerTools(workerToolsDeps),
    });
    await workerManager.reconcileInterrupted();
    const voiceReplyAvailable = isVoiceReplyAvailable(config, this.deps.textToSpeechClient);
    const hotPathAgent = createHotPathAgent({
      db,
      config,
      user,
      llmManager: this.deps.llmManager,
      messageSender,
      eventBus: this.deps.eventBus,
      workerManager,
      memory: userRuntimeServices.memory,
      getActivePatternCount: () => patternStore.getActiveCount(),
      listActivePatterns: () => patternStore.listActive(),
      getMyDay: () => myDayStore.getForDate(getLocalDate(user.timezone), user.timezone),
      getDelegateToolContext: (message) => {
        const todoId = message.context?.myDayHandoffTodoId;
        return todoId
          ? { onDelegated: async (workerId) => { await myDayStore.markTodoHandedOff(todoId, workerId); } }
          : undefined;
      },
      attachmentStorageRoot: `${workspaceRoot}/files`,
      prepareImageForModelInput: (input) => prepareImageForModelInput({
        ...input,
        tempRoot: `${workspaceRoot}/tmp/model-images`,
      }),
      createTurnTools: ({ message }) => createHotPathTurnTools({
        sender: messageSender,
        runtime: createProcessRuntimeServices(userRuntimeServices, {
          processType: "hot_path",
          runId: hotPathCodeModeRunId(message),
          filesAccess: "write",
        }),
        memory: userRuntimeServices.memory && (config.capabilities.tools.hotPath.search_memory || config.capabilities.tools.hotPath.reflect_memory)
          ? userRuntimeServices.memory
          : undefined,
        reflectMemory: config.capabilities.tools.hotPath.reflect_memory,
        profile: {
          user,
          updateProfile: (update) => this.updateUserProfile(user, update),
        },
        patterns: { list: () => patternStore.list() },
        reminders: {
          user,
          create: async (params) => {
            const pattern = await patternStore.create(params);
            emitPatternLifecycleActivity(pattern, "created", "hot_path");
            return pattern;
          },
          list: () => patternStore.list(),
          get: (id) => patternStore.getById(id),
          update: async (id, params) => {
            const before = params.active !== undefined ? await patternStore.getById(id) : null;
            const pattern = await patternStore.update(id, params);
            if (pattern) {
              emitPatternLifecycleActivity(pattern, getActivityActionForUpdate(before, pattern), "hot_path");
            }
            return pattern;
          },
          remove: async (id) => {
            const deleted = await patternStore.remove(id);
            if (deleted) {
              emitPatternLifecycleActivity(deleted, "deleted", "hot_path");
            }
            return deleted;
          },
        },
        myDay: config.capabilities.tools.hotPath.my_day
          ? {
              user,
              getTodayLocalDate: () => getLocalDate(user.timezone),
              store: myDayStore,
            }
          : undefined,
        voice: voiceReplyAvailable && this.deps.textToSpeechClient
          ? { tts: this.deps.textToSpeechClient, tempRoot: `${workspaceRoot}/tmp` }
          : undefined,
      }),
      compactor,
      hotPathTurnRecorder: userRuntimeServices.memory?.recorder,
    });

    const attachmentProcessor = new AttachmentProcessor({
      fileStorage: userFileStorage,
      publicUrl: config.publicUrl,
      tempRoot: `${workspaceRoot}/tmp`,
      transcribe: this.deps.speechToTextClient
        ? (buf, options) => this.deps.speechToTextClient!.transcribe(buf, options)
        : undefined,
      shouldConvertAudioToWav: shouldConvertInboundAudioToWav,
    });

    const voiceAwareAgent = {
      handleMessage: async (message: InboundMessage): Promise<string | null> => {
        let processedMessage = message;

        if (message.source === "user" && (message as UserMessage).parts?.length) {
          processedMessage = await this.processUserAttachments(message as UserMessage, attachmentProcessor);
        }

        return hotPathAgent.handleMessage(processedMessage);
      },
    };

    const ingress = new HotPathIngressCoordinator({
      config,
      handler: voiceAwareAgent,
    });
    const stopConversationMaintenance = startConversationMaintenance(user, config, compactor);

    const memoryClient = this.deps.integrations.memory;
    if (memoryClient?.provisionUserBank) {
      void memoryClient.provisionUserBank(user).catch((error: unknown) => {
        logger.warn({ error, tenantId: user.tenantId, userId: user.userId }, "Memory user bank provisioning failed");
      });
    }

    logger.info({ userId: user.userId, tenantId: user.tenantId }, "Initialized user runtime");

    return {
      user,
      userRoot,
      services: userRuntimeServices,
      files: filesRuntime,
      ingress,
      workerManager,
      patternStore,
      ...(userComposio ? { composio: userComposio } : {}),
      mcpService: userMcpService,
      messageSender,
      hotPathAgent,
      workerToolsDeps,
      stopConversationMaintenance,
    };
  }

  private async processUserAttachments(
    message: UserMessage,
    attachmentProcessor: AttachmentProcessor,
  ): Promise<UserMessage> {
    const processedParts: NonNullable<UserMessage["parts"]> = [];

    for (const part of message.parts ?? []) {
      const contentParts: string[] = part.content ? [part.content] : [];
      const processedAttachments: Attachment[] = [];

      for (const attachment of part.attachments ?? []) {
        try {
          const result = await attachmentProcessor.process(attachment);
          const processedAttachment = result.attachment;
          if (result.audioKind) {
            contentParts.unshift(result.processedContent);
          }

          processedAttachments.push(processedAttachment);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          logger.error({ error: msg, attachment: attachment.filename }, "Attachment processing failed");
          contentParts.push(`[Attachment processing failed: ${msg}]`);
          processedAttachments.push(attachment);
        }
      }

      processedParts.push({
        ...part,
        content: contentParts.join("\n\n"),
        attachments: processedAttachments,
      });
    }

    const latestPart = processedParts.at(-1) ?? processedParts[0];
    if (!latestPart) {
      return message;
    }

    return {
      ...message,
      content: processedParts.map((part) => part.content).join("\n\n"),
      ...(processedParts.some((part) => (part.attachments?.length ?? 0) > 0)
        ? { attachments: processedParts.flatMap((part) => part.attachments ?? []) }
        : {}),
      messageId: latestPart.messageId,
      timestamp: latestPart.timestamp,
      parts: processedParts,
    };
  }
}

function getWorkerPuterToolsets(enabledTools: string[] | null | undefined): string[] {
  return [...new Set((enabledTools ?? []).filter((tool) => puterEnabledToolsetSlugs.has(tool)))];
}

async function getPuterExcludedImessageHandles(input: {
  config: AppConfig;
  users: UserRegistry;
  user: UserContext;
}): Promise<string[]> {
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
      handles.add(trimmed);
    }
  };

  addHandle(input.config.spectrum.dedicatedLinePhone);
  addHandle(await input.users.getSpectrumAssignedPhoneNumber(input.user.userId));
  return [...handles];
}
