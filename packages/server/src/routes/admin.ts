import { createLogger, type AppConfig } from "@finn/core";
import type { WorkerManager } from "@finn/agents";
import type { PatternStore } from "@finn/patterns";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import { resolveTimeZone, type UserContext, type UserTimezoneSource } from "@finn/core";
import type { MyDayRefreshService } from "../my-day-refresh-service.js";
import type { PersonalIntelligenceService } from "../personal-intelligence-service.js";
import type { GraphileSchedulerService } from "../graphile-scheduler-service.js";
import { desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";

const logger = createLogger("admin");

export interface AdminDeps {
  config: AppConfig;
  db: Database;
  patternStore: PatternStore;
  workerManager?: WorkerManager;
  scheduler?: GraphileSchedulerService;
  automation?: {
    myDay?: MyDayRefreshService;
    personalIntelligence?: PersonalIntelligenceService;
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Internal server error";
}

function handleError(c: Context, error: unknown, message: string) {
  logger.error({ error }, message);
  return c.json({ error: getErrorMessage(error) }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTimezoneSource(user: Pick<schema.StoredUser, "metadata">): UserTimezoneSource {
  const source = isRecord(user.metadata?.profile) ? user.metadata.profile.timezoneSource : null;
  return source === "manual" || source === "browser" ? source : "server";
}

function resolveUserTimezone(user: Pick<schema.StoredUser, "metadata" | "timezone">, config: Pick<AppConfig, "userTimezone">): string {
  return resolveTimeZone(getTimezoneSource(user) === "server" ? config.userTimezone : user.timezone, config.userTimezone);
}

function toUserContext(user: schema.StoredUser, config: AppConfig): UserContext {
  return {
    tenantId: user.tenantId,
    userId: user.id,
    phoneNumber: user.phoneNumber,
    displayName: user.displayName,
    timezone: resolveUserTimezone(user, config),
    timezoneSource: getTimezoneSource(user),
    location: user.location,
    kidsMode: user.kidsMode,
  };
}

function splitCapabilityKeys(capabilities: Record<string, boolean>): { enabled: string[]; disabled: string[] } {
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [name, available] of Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b))) {
    if (available) {
      enabled.push(name);
    } else {
      disabled.push(name);
    }
  }

  return { enabled, disabled };
}

export function buildRuntimeGatingStatus(config: AppConfig) {
  return {
    integrations: splitCapabilityKeys(config.capabilities.integrations),
    media: splitCapabilityKeys(config.capabilities.media),
    configuredToolFamilies: {
      hotPath: splitCapabilityKeys(config.capabilities.tools.hotPath),
      worker: splitCapabilityKeys(config.capabilities.tools.worker),
    },
  };
}

export function buildMemoryProviderStatus(config: AppConfig) {
  const providers = {
    supermemory: {
      configured: Boolean(config.integrations?.supermemory?.apiKey),
      selected: config.memory.provider === "supermemory",
    },
    hindsight: {
      configured: Boolean(config.integrations?.hindsight?.baseUrl),
      selected: config.memory.provider === "hindsight",
    },
  };
  const selectedProvider = config.memory.provider;
  const selectedProviderStatus = selectedProvider === "none" ? null : providers[selectedProvider];

  return {
    selectedProvider,
    mode: config.memory.mode,
    configured: Boolean(selectedProviderStatus?.configured),
    providers,
  };
}

export function createAdminRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const token = deps.config.admin?.bearerToken;
    if (!token) return next();

    const authHeader = c.req.header("Authorization");
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  });

  app.get("/", async (c) => {
    try {
      let database: "ok" | "error" = "ok";
      try {
        await deps.db.select({ count: sql<number>`1` }).from(schema.conversations).limit(1);
      } catch (error) {
        database = "error";
        logger.error({ error }, "Admin health database check failed");
      }

      const [activeWorkers, activePatternCount] = await Promise.all([
        deps.workerManager?.getActive() ?? Promise.resolve([]),
        deps.patternStore.getActiveCount(),
      ]);

      return c.json({
        status: database === "ok" ? "ok" : "degraded",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        components: {
          database,
          workers: {
            activeCount: activeWorkers.length,
          },
          patterns: {
            activeCount: activePatternCount,
          },
          automation: {
            scheduler: deps.scheduler?.getStatus() ?? { enabled: false },
            myDay: deps.automation?.myDay?.getStatus() ?? { enabled: false },
            personalIntelligence: deps.automation?.personalIntelligence?.getStatus() ?? { enabled: false },
          },
        },
      });
    } catch (error) {
      return handleError(c, error, "Failed to get admin health");
    }
  });

  app.get("/status", async (c) => {
    try {
      const [activeWorkers, activePatternCount] = await Promise.all([
        deps.workerManager?.getActive() ?? Promise.resolve([]),
        deps.patternStore.getActiveCount(),
      ]);

      return c.json({
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        process: {
          pid: process.pid,
          memory: process.memoryUsage(),
        },
        runtime: {
          models: {
            hotPath: deps.config.models.hotPath,
            worker: deps.config.models.worker,
            compactor: deps.config.models.compactor,
          },
          memory: buildMemoryProviderStatus(deps.config),
          runtimeGating: buildRuntimeGatingStatus(deps.config),
          limits: {
            maxTurns: deps.config.maxTurns,
            workerLimits: deps.config.workerLimits,
          },
        },
        stats: {
          workers: {
            activeCount: activeWorkers.length,
          },
          patterns: {
            activeCount: activePatternCount,
          },
          automation: {
            scheduler: deps.scheduler?.getStatus() ?? { enabled: false },
            myDay: deps.automation?.myDay?.getStatus() ?? { enabled: false },
            personalIntelligence: deps.automation?.personalIntelligence?.getStatus() ?? { enabled: false },
          },
        },
      });
    } catch (error) {
      return handleError(c, error, "Failed to get admin status");
    }
  });

  app.get("/workers", async (c) => {
    try {
      const active = await deps.workerManager?.getActive() ?? [];

      return c.json({ active });
    } catch (error) {
      return handleError(c, error, "Failed to get worker status");
    }
  });

  app.get("/patterns", async (c) => {
    try {
      const patterns = await deps.patternStore.listActive();
      return c.json(patterns);
    } catch (error) {
      return handleError(c, error, "Failed to get patterns");
    }
  });

  app.get("/events", async (c) => {
    try {
      const events = await deps.db.select().from(schema.events).orderBy(desc(schema.events.createdAt)).limit(50);
      return c.json(events);
    } catch (error) {
      return handleError(c, error, "Failed to get recent events");
    }
  });

  app.post("/users/:id/refresh-intelligence", async (c) => {
    try {
      const userId = c.req.param("id");
      const [user] = await deps.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }

      const userContext = toUserContext(user, deps.config);
      const personalIntelligence = deps.automation?.personalIntelligence
        ? await deps.automation.personalIntelligence.ingestUser(userContext)
        : null;
      const myDay = deps.automation?.myDay
        ? await deps.automation.myDay.refreshUser(userContext, { reason: "manual" })
        : null;

      return c.json({ userId, personalIntelligence, myDay });
    } catch (error) {
      return handleError(c, error, "Failed to refresh user intelligence");
    }
  });

  app.post("/patterns/:id/toggle", async (c) => {
    try {
      const id = c.req.param("id");
      const result = await deps.patternStore.toggle(id);

      if (!result) {
        return c.json({ error: "Pattern not found" }, 404);
      }

      return c.json({ id, active: result.active });
    } catch (error) {
      return handleError(c, error, "Failed to toggle pattern");
    }
  });

  return app;
}
