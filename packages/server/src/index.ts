import "@finn/core/otel-bootstrap";
import {
  EventBus,
  createLogger,
  loadConfig,
  resolveConfiguredSpeechToTextProvider,
  resolveConfiguredTextToSpeechProvider,
  type PatternRecord,
  type UserContext,
} from "@finn/core";
import { getDb } from "@finn/db";
import { PatternScheduler, PatternStore } from "@finn/patterns";
import { createIntegrationClients } from "@finn/integrations";
import { LLMManager } from "@finn/llm";
import {
  DeepgramClient,
  ElevenLabsClient,
  XaiMediaClient,
  type SpeechToTextClient,
  type TextToSpeechClient,
} from "@finn/media";
import { MessageRouter, SpectrumClient } from "@finn/messaging";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { readFile } from "node:fs/promises";
import { wireEventPersistence, wireTriggerDelivery, wireWorkerDelivery } from "./event-wiring.js";
import { wireMemoryActivityFeed } from "./activity-feed.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createAppRoutes } from "./routes/app.js";
import { createFileRoutes } from "./routes/files.js";
import { health } from "./routes/health.js";
import { createPublicAssetRoutes } from "./routes/public-assets.js";
import { createWebRoutes } from "./routes/web.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { SpectrumIngress } from "./spectrum-ingress.js";
import { UserRegistry } from "./user-registry.js";
import { UserRuntimeRegistry } from "./user-runtime.js";
import { MyDayStore } from "./my-day-store.js";
import { MyDayRefreshService } from "./my-day-refresh-service.js";
import { PersonalIntelligenceService } from "./personal-intelligence-service.js";
import { GraphileSchedulerService } from "./graphile-scheduler-service.js";
import { PuterBridge } from "./puter-bridge.js";
import { ConnectorCatalogService } from "./connector-catalog.js";

const logger = createLogger("server");
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

let patternScheduler: PatternScheduler | undefined;
let userRuntimeRegistry: UserRuntimeRegistry | undefined;
let myDayRefreshService: MyDayRefreshService | undefined;
let personalIntelligenceService: PersonalIntelligenceService | undefined;
let graphileSchedulerService: GraphileSchedulerService | undefined;
let spectrumIngress: SpectrumIngress | undefined;
let spectrumClient: SpectrumClient | undefined;
let isShuttingDown = false;

const startupPrewarmConcurrency = 2;

function patternComposioToolkitSlugs(pattern: PatternRecord): string[] {
  const slugs = new Set(pattern.connectorScope.composio.map((scope) => scope.toolkitSlug));
  if (pattern.triggerConfig.type === "composio") {
    slugs.add(pattern.triggerConfig.toolkitSlug);
  }
  return [...slugs];
}

function failStartup(error: unknown): never {
  logger.fatal({ error }, "Failed to initialize Finn server");
  process.exit(1);
}

async function prewarmExistingUserRuntimes(input: {
  users: UserRegistry;
  runtimes: UserRuntimeRegistry;
  bootstrapUserId?: string;
}): Promise<void> {
  const users = (await input.users.listExistingUsers())
    .filter((user) => user.userId !== input.bootstrapUserId);

  if (users.length === 0) {
    return;
  }

  logger.info({ userCount: users.length, concurrency: startupPrewarmConcurrency }, "Starting background user runtime prewarm");

  let cursor = 0;
  const workers = Array.from({ length: Math.min(startupPrewarmConcurrency, users.length) }, async () => {
    while (true) {
      const nextIndex = cursor;
      cursor += 1;
      const user = users[nextIndex];
      if (!user) {
        return;
      }

      try {
        await input.runtimes.ensure(user);
      } catch (error) {
        logger.error({ error, userId: user.userId }, "Failed to prewarm user runtime");
      }
    }
  });

  await Promise.all(workers);
  logger.info({ userCount: users.length }, "Completed background user runtime prewarm");
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timed out after 10 seconds. Forcing exit.");
    process.exit(1);
  }, 10_000);

  try {
    logger.info("Shutting down Finn server...");
    await graphileSchedulerService?.stop();
    myDayRefreshService?.stop();
    personalIntelligenceService?.stop();
    patternScheduler?.stop();
    await spectrumIngress?.stop();
    await spectrumClient?.stop();
    await userRuntimeRegistry?.shutdownAll();
    logger.info("Shutdown complete.");
    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.fatal({ error }, "Shutdown failed");
    process.exit(1);
  }
}

const server = await (async () => {
  try {
    const config = loadConfig();
    const db = getDb(config.databaseUrl);
    const llmManager = new LLMManager(config);
    const localSpectrumClient = (spectrumClient = new SpectrumClient({
      projectId: config.spectrum.projectId,
      projectSecret: config.spectrum.projectSecret,
      dedicatedLinePhone: config.spectrum.dedicatedLinePhone,
    }));
    await localSpectrumClient.start();
    const sendFinnContactCard = async (user: { userId: string; phoneNumber: string }) => {
      const photo = await readFile("assets/finn_profile.png").then((data) => ({
        mimeType: "image/png",
        data,
      })).catch(() => undefined);
      const assignedPhoneNumber = await userRegistry?.getSpectrumAssignedPhoneNumber(user.userId);
      await localSpectrumClient.sendContactCard(user.phoneNumber, {
        name: "Finn",
        phoneNumber: assignedPhoneNumber ?? config.spectrum.dedicatedLinePhone,
        ...(photo ? { photo } : {}),
      });
    };
    const messageRouter = new MessageRouter();
    const eventBus = new EventBus();

    const integrationClients = createIntegrationClients(config);
    const patternStore = new PatternStore({ db });
    const connectorCatalog = new ConnectorCatalogService({ db });
    const userRegistry = new UserRegistry({ db, config, spectrumClient: localSpectrumClient });
    // -----------------------------------------------------------------------
    // Voice & media clients (optional — only initialized when keys present)
    // -----------------------------------------------------------------------

    const selectedSpeechToTextProvider = resolveConfiguredSpeechToTextProvider({
      requested: config.mediaGeneration.speechToTextProvider,
      integrations: config.integrations ?? {},
    });
    const selectedTextToSpeechProvider = resolveConfiguredTextToSpeechProvider({
      requested: config.mediaGeneration.textToSpeechProvider,
      integrations: config.integrations ?? {},
    });

    const deepgramApiKey = selectedSpeechToTextProvider === "deepgram"
      ? config.integrations?.deepgram?.apiKey
      : undefined;
    const deepgramClient: SpeechToTextClient | undefined = deepgramApiKey
      ? new DeepgramClient({ apiKey: deepgramApiKey })
      : undefined;

    const elevenlabsApiKey = selectedTextToSpeechProvider === "elevenlabs"
      ? config.integrations?.elevenlabs?.apiKey
      : undefined;
    const elevenlabsClient: TextToSpeechClient | undefined = elevenlabsApiKey
      ? new ElevenLabsClient({
          apiKey: elevenlabsApiKey,
          voiceId: config.integrations?.elevenlabs?.voiceId,
          modelId: config.integrations?.elevenlabs?.modelId,
        })
      : undefined;
    const xaiMediaClient = config.integrations?.xai?.apiKey
      ? new XaiMediaClient({
          apiKey: config.integrations.xai.apiKey,
          baseUrl: config.integrations.xai.baseUrl,
          ttsVoiceId: config.integrations.xai.ttsVoiceId,
          ttsLanguage: config.integrations.xai.ttsLanguage,
          ttsOutputCodec: config.integrations.xai.ttsOutputCodec,
          ttsSampleRate: config.integrations.xai.ttsSampleRate,
          ttsBitRate: config.integrations.xai.ttsBitRate,
          sttLanguage: config.integrations.xai.sttLanguage,
          sttFormat: config.integrations.xai.sttFormat,
        })
      : undefined;
    const speechToTextClient = selectedSpeechToTextProvider === "xai"
      ? xaiMediaClient
      : deepgramClient;
    const textToSpeechClient = selectedTextToSpeechProvider === "xai"
      ? xaiMediaClient
      : elevenlabsClient;

    const puterBridge = new PuterBridge();

    const runtimes = (userRuntimeRegistry = new UserRuntimeRegistry({
      config,
      db,
      llmManager,
      eventBus,
      spectrumClient: localSpectrumClient,
      integrations: integrationClients,
      userRegistry,
      puterBridge,
      speechToTextClient,
      textToSpeechClient,
    }));

    await userRegistry.ensureAllowedUsers();
    const bootstrapUser = await userRegistry.ensureBootstrapUser();
    if (bootstrapUser) {
      await runtimes.ensure(bootstrapUser);
    }

    void prewarmExistingUserRuntimes({
      users: userRegistry,
      runtimes,
      bootstrapUserId: bootstrapUser?.userId,
    });

    const localPatternScheduler = (patternScheduler = new PatternScheduler({
      store: patternStore,
      spawnWorker: runtimes.spawnWorker,
      eventBus,
      config,
      beforeRunPattern: async (pattern) => {
        const toolkitSlugs = patternComposioToolkitSlugs(pattern);
        if (toolkitSlugs.length === 0) {
          return true;
        }

        const user = await userRegistry.requireUser(pattern.userId);
        if (user.tenantId !== pattern.tenantId) {
          return false;
        }

        const composio = await runtimes.getComposioService(user);
        if (!composio) {
          return false;
        }

        await composio.reconcileConnectorConfigs({ toolkitSlugs, origin: "system" });
        const refreshed = await patternStore.getById(pattern.id);
        return refreshed?.active === true
          && !refreshed.connectorScope.issues?.some((issue) => toolkitSlugs.includes(issue.toolkitSlug));
      },
      outcomeRecorder: {
        recordPatternRunOutcome: async ({ pattern, run, result, notifyOutcome }) => {
          await (await runtimes.getMemoryRuntime({ tenantId: run.tenantId, userId: run.userId }))?.recorder.recordPatternRunOutcome({
            pattern,
            run,
            result,
            notifyOutcome,
          });
        },
      },
    }));

    wireEventPersistence(eventBus, db);
    wireMemoryActivityFeed(eventBus, {
      getMemoryRuntime: (event) => runtimes.getMemoryRuntime({ tenantId: event.tenantId, userId: event.userId }),
    });
    wireWorkerDelivery(eventBus, runtimes, {
      markPatternRunSurfaced: (runId) => patternStore.markRunSurfaced(runId),
    });
    wireTriggerDelivery(eventBus, runtimes, {
      markPatternRunSurfaced: (runId) => patternStore.markRunSurfaced(runId),
    });
    const localMyDayRefreshService = (myDayRefreshService = new MyDayRefreshService({
      config,
      db,
      llmManager,
      users: userRegistry,
      runtimes,
    }));
    const localPersonalIntelligenceService = (personalIntelligenceService = new PersonalIntelligenceService({
      config,
      db,
      llmManager,
      users: userRegistry,
      runtimes,
      puterBridge,
    }));
    const ingestDeferredPuter = ({ user, deviceId }: { user: UserContext; deviceId: string }) => {
      void localPersonalIntelligenceService.ingestDeferredPuterIfDue(user, { deviceId }).catch((error: unknown) => {
        logger.warn({ error, tenantId: user.tenantId, userId: user.userId, deviceId }, "Deferred Puter personal intelligence ingestion failed");
      });
    };
    puterBridge.onConnect(ingestDeferredPuter);
    puterBridge.onAccessStatus(ingestDeferredPuter);

    const localGraphileSchedulerService = (graphileSchedulerService = new GraphileSchedulerService({
      config,
      patternScheduler: localPatternScheduler,
      myDayRefreshService: localMyDayRefreshService,
      personalIntelligenceService: localPersonalIntelligenceService,
      users: userRegistry,
    }));
    await localGraphileSchedulerService.start();

    spectrumIngress = new SpectrumIngress({
      config,
      client: localSpectrumClient,
      router: messageRouter,
      users: userRegistry,
      agent: runtimes,
      sendContactCard: sendFinnContactCard,
    });
    spectrumIngress.start();

    const app = new Hono();
    app.route(
      "/webhooks",
      createWebhookRoutes({
        config,
        composio: integrationClients.composio,
        patternStore,
        patternScheduler: localPatternScheduler,
      }),
    );
    app.route("/health", health);
    app.route("/files", createFileRoutes({ runtimes }));
    app.route("/public", createPublicAssetRoutes({ fromNumber: config.spectrum.dedicatedLinePhone }));
    app.route("/api/web", createWebRoutes({
      config,
      db,
      messaging: localSpectrumClient,
      users: userRegistry,
      memory: integrationClients.memory,
      composio: integrationClients.composio,
      connectorCatalog,
      eventBus,
      runtimes,
      patternStore,
      patternScheduler: localPatternScheduler,
      myDayRefreshService: localMyDayRefreshService,
      personalIntelligenceService: localPersonalIntelligenceService,
      puterBridge,
      upgradeWebSocket,
    }));
    app.route("/admin", createAdminRoutes({
      config,
      db,
      patternStore,
      scheduler: localGraphileSchedulerService,
      automation: {
        myDay: localMyDayRefreshService,
        personalIntelligence: localPersonalIntelligenceService,
      },
    }));
    app.route("/", createAppRoutes());

    logger.info({ host: config.server.host, port: config.server.port }, "Finn server listening");

    return {
      port: config.server.port,
      fetch: app.fetch,
      websocket,
    };
  } catch (error) {
    return failStartup(error);
  }
})();

process.on("SIGTERM", () => {
  void shutdown();
});

process.on("SIGINT", () => {
  void shutdown();
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ error: reason }, "Unhandled rejection");
  void shutdown();
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  void shutdown();
});

export default server;
