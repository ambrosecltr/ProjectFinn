import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { createLogger, generateId, isValidTimeZone, normalizePhoneNumber, publicPatternScheduleSchema, requiredComposioToolkits, resolveTimeZone, StorageError, type AppConfig, type EventBus, type FinnUserRecord, type PatternRecord, type PatternRunRecord, type UserContext, type UserMessage, type UserTimezoneSource } from "@finn/core";
import type { Database, UserConnectorConfig } from "@finn/db";
import * as schema from "@finn/db";
import { buildStoredFileUrl } from "@finn/media";
import type { FilesRuntime } from "@finn/runtime";
import { PatternStore, type PatternScheduler } from "@finn/patterns";
import { McpService, type ComposioClient, type ComposioToolkitSummary, type McpServerConfig, type McpServerStatus, type MemoryClient } from "@finn/integrations";
import type { SpectrumClient } from "@finn/messaging";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { z } from "zod";
import type { UserRegistry } from "../user-registry.js";
import { resolveUserRuntimeRoot, type UserRuntimeRegistry } from "../user-runtime.js";
import type { MyDayRefreshService } from "../my-day-refresh-service.js";
import type { PersonalIntelligenceService } from "../personal-intelligence-service.js";
import {
  getConnectorConfig,
  isPrimaryComposioConnectorSlug,
  listConnectorConfigs,
  normalizeConnectorPermissionMode,
  upsertConnectorConfig,
} from "../connector-config.js";
import { isComposioManagedConnectorSlug as isComposioManagedConnectorSlugValue } from "../connector-ownership.js";
import { createMcpOAuthStore, McpServerStore } from "../mcp-store.js";
import { MyDayStore, type MyDayPageRecord } from "../my-day-store.js";
import { emitPatternActivity } from "../activity-feed.js";
import {
  getComposioConnectorDisconnectImpact,
  resolvePatternConnectorIssues,
} from "../composio-pattern-lifecycle.js";
import {
  removePatternWithComposioTriggerLifecycle,
  setPatternActiveWithComposioTriggerLifecycle,
} from "../composio-trigger-lifecycle.js";
import {
  getPuterSourceAvailability,
  puterDeviceIdFromConnectedAccount,
  puterPersonalIntelligenceTools,
  puterPersonalIntelligenceToolSlugs,
  puterSourceTools,
  puterToolkitName,
  puterToolkitSlug,
  type PuterSourceKey,
} from "../puter-connector.js";
import type { PuterBridge, PuterBridgeStatus } from "../puter-bridge.js";
import { UserComposioService } from "../user-composio-service.js";
import type { ConnectorCatalogService } from "../connector-catalog.js";
import { syncUserProfileSeedToMemory } from "../memory-profile-seed.js";

const logger = createLogger("web");
const tenantId = "tenant_default";
const sessionCookieName = "finn_session";
const loginCodeTtlMs = 10 * 60 * 1000;
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;

const requestCodeSchema = z.object({
  phoneNumber: z.string().min(6).max(32),
});

const verifyCodeSchema = z.object({
  phoneNumber: z.string().min(6).max(32),
  code: z.string().regex(/^\d{6}$/),
});

const profileSchema = z.object({
  displayName: z.string().trim().max(80),
  phoneNumber: z.string().trim().min(6).max(32),
  timezone: z.string().trim().max(80).optional(),
  timezoneSource: z.enum(["server", "browser", "manual"]).optional(),
  location: z.string().trim().max(120).nullable(),
  kidsMode: z.boolean().optional(),
});

const onboardingCompleteSchema = z.object({
  firstMessageContext: z.string().trim().max(500).optional(),
}).optional();

const authorizeConnectorSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  returnTo: z.enum(["connectors", "onboarding"]).optional(),
});

const notifyConnectorSchema = authorizeConnectorSchema.extend({
  previousConnectedAccountId: z.string().trim().min(1).max(200).optional(),
});

const reconnectConnectorSchema = z.object({
  previousConnectedAccountId: z.string().trim().min(1).max(200).optional(),
}).strict();

const optionalPatchBooleanSchema = z.preprocess((value) => value === null ? undefined : value, z.boolean().optional());

const connectorConfigSchema = z.object({
  permissionMode: z.enum(["read_only", "all"]).optional(),
  myDayEnabled: z.boolean().optional(),
  personalIntelligenceEnabled: z.boolean().optional(),
  puter: z.object({
    deviceId: z.string().trim().min(1).max(160).optional(),
    imessageEnabled: optionalPatchBooleanSchema,
    imessagePersonalIntelligenceEnabled: optionalPatchBooleanSchema,
    notesEnabled: optionalPatchBooleanSchema,
    notesPersonalIntelligenceEnabled: optionalPatchBooleanSchema,
  }).optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: "At least one connector setting is required.",
});

const puterDeviceSchema = z.object({
  deviceId: z.string().trim().min(1).max(160),
});

const mcpServerMutationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  url: z.string().trim().url().max(2000),
  authMode: z.enum(["none", "api_key", "oauth"]).default("none"),
  authHeaderName: z.string().trim().min(1).max(120).optional(),
  authHeaderValue: z.string().trim().min(1).max(4000).optional(),
  authToken: z.string().trim().max(4000).optional(),
  alwaysOn: z.boolean().default(true),
  active: z.boolean().default(true),
});

const mcpServerUpdateSchema = mcpServerMutationSchema.partial().extend({
  active: z.boolean().optional(),
  alwaysOn: z.boolean().optional(),
});

type McpServerMutationInput = z.infer<typeof mcpServerMutationSchema>;
type McpAuthMode = McpServerMutationInput["authMode"];

const patternUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  userDescription: z.string().trim().max(1000).nullable().optional(),
  taskPrompt: z.string().trim().min(1).max(8000).optional(),
  triggerFilters: z.array(z.object({
    path: z.string().trim().min(1),
    operator: z.enum(["equals", "not_equals", "contains", "exists"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })).optional(),
  notifyCondition: z.union([
    z.object({ type: z.literal("always") }),
    z.object({ type: z.literal("never") }),
    z.object({ type: z.literal("worker_decision"), instruction: z.string().trim().min(1) }),
  ]).optional(),
});

const patternActiveSchema = z.object({
  active: z.boolean(),
});

const patternCreateSchema = patternUpdateSchema.extend({
  name: z.string().trim().min(1).max(160),
  userDescription: z.string().trim().max(1000).nullable().optional(),
  taskPrompt: z.string().trim().min(1).max(8000),
  triggerType: z.literal("schedule"),
  schedule: publicPatternScheduleSchema,
});

const connectorsQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  search: z.string().trim().max(100).optional(),
  connected: z.enum(["true", "false"]).optional(),
});

const patternRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  beforeRunId: z.string().trim().min(1).optional(),
});

const myDayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, "Date must be a real calendar day.");

const myDayQuerySchema = z.object({
  date: myDayDateSchema.optional(),
});

const myDaySummarySchema = z.object({
  date: myDayDateSchema.optional(),
  summary: z.string().trim().max(4000).nullable().optional(),
  sourceSummary: z.string().trim().max(4000).nullable().optional(),
  refreshed: z.boolean().optional(),
}).refine((input) => input.summary !== undefined || input.sourceSummary !== undefined || input.refreshed === true, {
  message: "At least one My Day summary field is required.",
});

const myDayTodoCreateSchema = z.object({
  date: myDayDateSchema.optional(),
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const myDayTodoUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: "At least one todo field is required.",
});

const myDayTodoHandoffSchema = z.object({
  context: z.string().trim().max(2000).optional(),
});

const libraryFolderQuerySchema = z.object({
  folderId: z.string().trim().min(1).optional(),
});

const libraryFolderCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().trim().min(1).nullable().optional(),
});

const libraryFileUpdateSchema = z.object({
  folderId: z.string().trim().min(1).nullable().optional(),
  userVisible: z.boolean().optional(),
}).refine((input) => input.folderId !== undefined || input.userVisible !== undefined, {
  message: "At least one file field is required.",
});

export interface WebRoutesDeps {
  config: AppConfig;
  db: Database;
  messaging: SpectrumClient;
  users: UserRegistry;
  memory?: MemoryClient;
  composio?: ComposioClient;
  connectorCatalog?: ConnectorCatalogService;
  eventBus: EventBus;
  runtimes?: UserRuntimeRegistry;
  patternStore: PatternStore;
  patternScheduler: PatternScheduler;
  myDayRefreshService?: MyDayRefreshService;
  personalIntelligenceService?: PersonalIntelligenceService;
  puterBridge?: PuterBridge;
  upgradeWebSocket?: UpgradeWebSocket;
}

function syncProfileSeedAfterUserChange(deps: WebRoutesDeps, storedUser: schema.StoredUser, user: UserContext): void {
  void syncUserProfileSeedToMemory({
    db: deps.db,
    memory: deps.memory,
    storedUser,
    user,
  }).catch((error: unknown) => {
    logger.warn({ error, tenantId: user.tenantId, userId: user.userId }, "User profile memory seed sync failed");
  });
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

function isAllowedPhoneNumber(config: AppConfig, phoneNumber: string): boolean {
  const allowed = config.spectrum.allowedNumbers?.map(normalizePhoneNumber);
  return !allowed?.length || allowed.includes(phoneNumber);
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLocalRequest(c: Context): boolean {
  const host = c.req.header("host")?.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function sessionCookieOptions(config: AppConfig, c: Context) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: config.publicUrl.startsWith("https://") && !isLocalRequest(c),
    path: "/",
    maxAge: Math.floor(sessionTtlMs / 1000),
  };
}

type ProfileImageMetadata = {
  fileId: string;
  updatedAt: string;
};

type UserMetadata = Record<string, unknown> & {
  profile?: {
    timezoneSource?: UserTimezoneSource;
    profileImage?: ProfileImageMetadata;
    onboarding?: {
      completedAt?: string;
      firstMessageContext?: string;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getTimezoneSource(user: Pick<schema.StoredUser, "metadata">): UserTimezoneSource {
  const source = isRecord(user.metadata?.profile) ? user.metadata.profile.timezoneSource : null;
  return source === "manual" || source === "browser" ? source : "server";
}

function withTimezoneSource(metadata: Record<string, unknown> | null, timezoneSource: UserTimezoneSource): UserMetadata {
  const profile = isRecord(metadata?.profile) ? metadata.profile : {};
  return {
    ...(metadata ?? {}),
    profile: {
      ...profile,
      timezoneSource,
    },
  };
}

function getProfileImage(metadata: Record<string, unknown> | null): ProfileImageMetadata | null {
  const profile = isRecord(metadata?.profile) ? metadata.profile : {};
  const image = isRecord(profile.profileImage) ? profile.profileImage : null;
  if (!image) return null;

  return typeof image.fileId === "string"
    && typeof image.updatedAt === "string"
    ? image as ProfileImageMetadata
    : null;
}

function withProfileImage(
  metadata: Record<string, unknown> | null,
  profileImage: ProfileImageMetadata,
): UserMetadata {
  const profile = isRecord(metadata?.profile) ? metadata.profile : {};
  return {
    ...(metadata ?? {}),
    profile: {
      ...profile,
      profileImage,
    },
  };
}

function getOnboardingCompletedAt(metadata: Record<string, unknown> | null): string | null {
  const profile = isRecord(metadata?.profile) ? metadata.profile : {};
  const onboarding = isRecord(profile.onboarding) ? profile.onboarding : {};
  return typeof onboarding.completedAt === "string" && onboarding.completedAt.trim()
    ? onboarding.completedAt
    : null;
}

function withOnboardingCompleted(
  metadata: Record<string, unknown> | null,
  completedAt: Date,
  firstMessageContext?: string,
): UserMetadata {
  const profile = isRecord(metadata?.profile) ? metadata.profile : {};
  const onboarding = isRecord(profile.onboarding) ? profile.onboarding : {};
  return {
    ...(metadata ?? {}),
    profile: {
      ...profile,
      onboarding: {
        ...onboarding,
        completedAt: completedAt.toISOString(),
        ...(firstMessageContext ? { firstMessageContext } : {}),
      },
    },
  };
}

function hasConnectedRequiredOnboardingConnector(configs: UserConnectorConfig[]): boolean {
  const requiredToolkits = new Set<string>(requiredComposioToolkits);
  return configs.some((config) => (
    requiredToolkits.has(config.toolkitSlug)
    && config.connected
    && Boolean(config.connectedAccountId)
  ));
}

export function getOnboardingCompletedAtForTest(metadata: Record<string, unknown> | null): string | null {
  return getOnboardingCompletedAt(metadata);
}

export function resolveUserTimezone(user: Pick<schema.StoredUser, "metadata" | "timezone">, config: Pick<AppConfig, "userTimezone">): string {
  return resolveTimeZone(getTimezoneSource(user) === "server" ? config.userTimezone : user.timezone, config.userTimezone);
}

function serializeUser(user: schema.StoredUser, config: AppConfig) {
  const profileImage = getProfileImage(user.metadata);
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    displayName: user.displayName ?? "",
    timezone: resolveUserTimezone(user, config),
    timezoneSource: getTimezoneSource(user),
    location: user.location ?? "",
    kidsMode: user.kidsMode,
    onboarding: {
      completedAt: getOnboardingCompletedAt(user.metadata),
      requiredConnectorSlugs: [...requiredComposioToolkits],
    },
    profileImageUrl: profileImage
      ? `${buildStoredFileUrl("", { tenantId: user.tenantId, userId: user.id, id: profileImage.fileId })}?v=${encodeURIComponent(profileImage.updatedAt)}`
      : null,
  };
}

async function serializeSession(user: schema.StoredUser | null, config: AppConfig, users: UserRegistry) {
  return {
    user: user ? serializeUser(user, config) : null,
    finnPhoneNumber: user ? await users.getSpectrumAssignedPhoneNumber(user.id) ?? config.spectrum.dedicatedLinePhone ?? "" : "",
  };
}

function toUserContext(user: FinnUserRecord, config: AppConfig): UserContext {
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

function toConnectorUser(user: schema.StoredUser): Pick<UserContext, "tenantId" | "userId"> {
  return { tenantId: user.tenantId, userId: user.id };
}

function profileImageExtension(mimeType: string, filename: string): string | null {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/avif") return ".avif";

  const extension = extname(filename).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".avif"].includes(extension) ? extension : null;
}

async function getWebFilesRuntime(deps: WebRoutesDeps, user: UserContext): Promise<FilesRuntime> {
  if (!deps.runtimes) {
    throw new HTTPException(503, { message: "File runtime not configured." });
  }

  return deps.runtimes.getFilesRuntime(user);
}

async function getWebPatternStore(deps: WebRoutesDeps, user: UserContext): Promise<PatternStore> {
  if (deps.runtimes && typeof deps.runtimes.getPatternStore === "function") {
    return deps.runtimes.getPatternStore(user);
  }
  return new PatternStore({ db: deps.db, user });
}

function requireStoredFiles(runtime: FilesRuntime): NonNullable<FilesRuntime["storedFiles"]> {
  if (!runtime.storedFiles) {
    throw new HTTPException(503, { message: "Stored file runtime not configured." });
  }

  return runtime.storedFiles;
}

function getMcpUserRootResolver(deps: WebRoutesDeps) {
  return (user: Pick<UserContext, "tenantId" | "userId">) => {
    if (deps.runtimes && typeof deps.runtimes.getUserRoot === "function") {
      return deps.runtimes.getUserRoot(user);
    }
    return Promise.resolve(resolveUserRuntimeRoot(deps.config, user));
  };
}

function createMcpStore(deps: WebRoutesDeps): McpServerStore {
  return new McpServerStore(deps.db, { getUserRoot: getMcpUserRootResolver(deps) });
}

function serializeLibraryFolder(folder: schema.StoredFileFolder) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

function serializeLibraryFile(file: schema.StoredFile, publicUrl: string) {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
    folderId: file.folderId,
    userVisible: file.userVisible,
    origin: file.origin,
    url: buildStoredFileUrl(publicUrl, file),
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

function maxUploadSizeBytes(config: AppConfig): number {
  return config.fileStorage.maxFileSizeMb * 1024 * 1024;
}

function maxUploadSizeMessage(config: AppConfig): string {
  return `File must be smaller than ${config.fileStorage.maxFileSizeMb} MB.`;
}

function isDatabaseErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function getLibraryFolder(db: Database, user: UserContext, folderId: string): Promise<schema.StoredFileFolder | null> {
  const [folder] = await db
    .select()
    .from(schema.fileFolders)
    .where(and(
      eq(schema.fileFolders.id, folderId),
      eq(schema.fileFolders.tenantId, user.tenantId),
      eq(schema.fileFolders.userId, user.userId),
    ))
    .limit(1);

  return folder ?? null;
}

async function ensureLibraryFolder(db: Database, user: UserContext, folderId: string | null | undefined): Promise<schema.StoredFileFolder | null> {
  if (!folderId) {
    return null;
  }

  const folder = await getLibraryFolder(db, user, folderId);
  if (!folder) {
    throw new Error("Folder not found.");
  }

  return folder;
}

async function getLibraryBreadcrumbs(db: Database, user: UserContext, folder: schema.StoredFileFolder | null): Promise<Array<ReturnType<typeof serializeLibraryFolder>>> {
  const breadcrumbs: schema.StoredFileFolder[] = [];
  let current = folder;
  while (current) {
    breadcrumbs.unshift(current);
    current = current.parentId ? await getLibraryFolder(db, user, current.parentId) : null;
  }

  return breadcrumbs.map(serializeLibraryFolder);
}

async function hasSiblingLibraryFolder(db: Database, user: UserContext, name: string, parentId: string | null): Promise<boolean> {
  const [existing] = await db
    .select({ id: schema.fileFolders.id })
    .from(schema.fileFolders)
    .where(and(
      eq(schema.fileFolders.tenantId, user.tenantId),
      eq(schema.fileFolders.userId, user.userId),
      eq(schema.fileFolders.name, name),
      parentId ? eq(schema.fileFolders.parentId, parentId) : isNull(schema.fileFolders.parentId),
    ))
    .limit(1);

  return Boolean(existing);
}

async function rescheduleUserScheduledPatterns(db: Database, user: UserContext, timezone: string): Promise<void> {
  const patternStore = new PatternStore({ db, user });
  const patterns = await patternStore.list();

  await Promise.all(patterns
    .filter((pattern) => pattern.active && pattern.triggerConfig.type === "schedule" && pattern.triggerConfig.timezoneSource !== "fixed" && !patternStore.isOneShotSchedule(pattern.triggerConfig))
    .map((pattern) => patternStore.update(pattern.id, {
      timezone,
      nextRunAt: patternStore.computeNextRun(pattern.triggerConfig, timezone),
    })));
}

export function serializeConnectorConfig(config: schema.UserConnectorConfig | undefined, memoryAvailable: boolean, bridgeStatus?: PuterBridgeStatus) {
  const piStatus = getPersonalIntelligenceIdentityStatus(config);
  const personalIntelligenceAvailable = memoryAvailable && (
    config?.toolkitSlug === puterToolkitSlug
      ? config.connected
      : piStatus === "resolved"
  );
  return {
    permissionMode: normalizeConnectorPermissionMode(config?.permissionMode),
    myDayEnabled: config?.myDayEnabled ?? false,
    personalIntelligenceAvailable,
    personalIntelligenceEnabled: personalIntelligenceAvailable ? config?.personalIntelligenceEnabled ?? false : false,
    personalIntelligenceIdentityStatus: piStatus,
    personalIntelligenceAccount: serializePersonalIntelligenceAccount(config),
    enabledTools: config?.enabledTools ?? [],
    puter: serializePuterConfig(config, bridgeStatus),
  };
}

function getPersonalIntelligenceIdentityStatus(config: schema.UserConnectorConfig | undefined): "unsupported" | "pending" | "resolved" | "failed" {
  if (!config?.connected || !config.connectedAccountId) {
    return "pending";
  }
  if (config.toolkitSlug === puterToolkitSlug) {
    return "resolved";
  }
  const status = (config as schema.UserConnectorConfig & { personalIntelligenceIdentityStatus?: unknown }).personalIntelligenceIdentityStatus;
  return status === "unsupported" || status === "pending" || status === "resolved" || status === "failed"
    ? status
    : "pending";
}

function serializePersonalIntelligenceAccount(config: schema.UserConnectorConfig | undefined) {
  const account = (config as schema.UserConnectorConfig & { personalIntelligenceAccount?: unknown } | undefined)?.personalIntelligenceAccount;
  return isRecord(account) ? account : null;
}

export function parseConnectorConfigForTest(input: unknown): z.infer<typeof connectorConfigSchema> {
  return connectorConfigSchema.parse(input);
}

function serializePuterConfig(config: schema.UserConnectorConfig | undefined, bridgeStatus?: PuterBridgeStatus) {
  const enabledTools = new Set(config?.enabledTools ?? []);
  return {
    imessageEnabled: enabledTools.has(puterSourceTools.imessage),
    imessagePersonalIntelligenceEnabled: enabledTools.has(puterPersonalIntelligenceTools.imessage),
    notesEnabled: enabledTools.has(puterSourceTools.notes),
    notesPersonalIntelligenceEnabled: enabledTools.has(puterPersonalIntelligenceTools.notes),
    sources: {
      imessage: getPuterSourceAvailability(bridgeStatus?.access ?? undefined, "imessage"),
      notes: getPuterSourceAvailability(bridgeStatus?.access ?? undefined, "notes"),
    },
  };
}

function serializePuterConnector(
  config: schema.UserConnectorConfig | undefined,
  memoryAvailable: boolean,
  bridgeStatus?: PuterBridgeStatus,
) {
  const paired = config?.connected ?? false;
  const active = paired && bridgeStatus?.active === true;
  return {
    slug: puterToolkitSlug,
    name: puterToolkitName,
    description: "Puter allows Finn to connect to apps on your Mac.",
    requiresAuth: false,
    connected: paired,
    enabled: true,
    connectionStatus: paired ? (active ? "connected" : "offline") : "needs_pairing",
    connectedAccountId: config?.connectedAccountId ?? undefined,
    config: serializeConnectorConfig(config, memoryAvailable, bridgeStatus),
  };
}

function shouldIncludePuterConnector(query: z.infer<typeof connectorsQuerySchema>, connector: ReturnType<typeof serializePuterConnector>): boolean {
  if (query.connected === "true" && !connector.connected) {
    return false;
  }
  if (query.connected === "false" && connector.connected) {
    return false;
  }
  const search = query.search?.trim().toLowerCase();
  if (!search) {
    return true;
  }
  return connector.name.toLowerCase().includes(search) || connector.slug.includes(search);
}

function shouldPrependPuterConnector(query: z.infer<typeof connectorsQuerySchema>, connector: ReturnType<typeof serializePuterConnector>): boolean {
  return !query.cursor && shouldIncludePuterConnector(query, connector);
}

export function shouldPrependPuterConnectorForTest(query: z.input<typeof connectorsQuerySchema>, connected: boolean): boolean {
  return shouldPrependPuterConnector(connectorsQuerySchema.parse(query), {
    slug: puterToolkitSlug,
    name: puterToolkitName,
    description: "",
    requiresAuth: false,
    connected,
    enabled: true,
    connectionStatus: connected ? "connected" : "needs_pairing",
    connectedAccountId: undefined,
    config: serializeConnectorConfig(undefined, true),
  });
}

export function isComposioManagedConnectorSlug(slug: string): boolean {
  return isComposioManagedConnectorSlugValue(slug);
}

function getPuterBridgeStatus(deps: WebRoutesDeps, user: schema.StoredUser, config: schema.UserConnectorConfig | null | undefined): PuterBridgeStatus | undefined {
  const deviceId = puterDeviceIdFromConnectedAccount(config?.connectedAccountId);
  if (!deviceId || !deps.puterBridge) {
    return undefined;
  }
  return deps.puterBridge.getStatus(toUserContext(user, deps.config), deviceId);
}

async function sendPuterConnectorConfigSnapshot(
  deps: WebRoutesDeps,
  user: UserContext,
  deviceId: string,
): Promise<boolean> {
  if (!deps.puterBridge) {
    return false;
  }
  const config = await getConnectorConfig(deps.db, user, puterToolkitSlug);
  return deps.puterBridge.sendConfigUpdate(user, deviceId, serializeConnectorConfig(
    config ?? undefined,
    deps.config.capabilities.integrations.memory,
    deps.puterBridge.getStatus(user, deviceId),
  ));
}

function getPuterSocketMessageType(rawMessage: string): string | null {
  try {
    const parsed = JSON.parse(rawMessage) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

async function getWebComposioService(deps: WebRoutesDeps, user: schema.StoredUser): Promise<UserComposioService | null> {
  if (!deps.composio) {
    return null;
  }

  const userContext = toUserContext(user, deps.config);
  const runtimeService = deps.runtimes && typeof deps.runtimes.getComposioService === "function"
    ? await deps.runtimes.getComposioService(userContext)
    : undefined;
  if (runtimeService) {
    return runtimeService;
  }

  return new UserComposioService({
    db: deps.db,
    user: userContext,
    composio: deps.composio,
    patternStore: await getWebPatternStore(deps, userContext),
    eventBus: deps.eventBus,
  });
}

async function decorateConnectorCatalog(deps: WebRoutesDeps, connectors: ComposioToolkitSummary[]): Promise<ComposioToolkitSummary[]> {
  const composio = deps.composio;
  const connectorCatalog = deps.connectorCatalog;
  if (!composio || !connectorCatalog) {
    return connectors;
  }
  return connectorCatalog.decorateToolkits(connectors, (toolkitSlug) => composio.getToolkitMetadata(toolkitSlug));
}

async function upsertPuterConnectorConfig(
  db: Database,
  user: schema.StoredUser,
  patch: z.infer<typeof connectorConfigSchema>["puter"],
): Promise<UserConnectorConfig> {
  const existing = await getConnectorConfig(db, toConnectorUser(user), puterToolkitSlug);
  const currentTools = new Set(existing?.enabledTools ?? []);
  applyPuterConfigPatch(currentTools, patch);

  const enabledTools = [...currentTools];
  const deviceId = patch?.deviceId?.trim();
  const connectedAccountId = deviceId ? `puter:${deviceId}` : existing?.connectedAccountId ?? null;
  return upsertConnectorConfig(db, {
    tenantId: user.tenantId,
    userId: user.id,
    toolkitSlug: puterToolkitSlug,
    toolkitName: puterToolkitName,
    connected: Boolean(connectedAccountId),
    connectedAccountId,
    connectionStatus: connectedAccountId ? "connected" : "needs_pairing",
    permissionMode: "read_only",
    myDayEnabled: false,
    personalIntelligenceEnabled: enabledTools.some((tool) => puterPersonalIntelligenceToolSlugs.has(tool)),
    enabledTools,
    lastNotifiedConnectedAccountId: existing?.lastNotifiedConnectedAccountId,
  });
}

function enablesPuterPersonalIntelligence(patch: z.infer<typeof connectorConfigSchema>["puter"]): boolean {
  return patch?.imessagePersonalIntelligenceEnabled === true || patch?.notesPersonalIntelligenceEnabled === true;
}

function changesPuterSourceSettings(patch: z.infer<typeof connectorConfigSchema>["puter"]): boolean {
  return patch?.imessageEnabled !== undefined
    || patch?.imessagePersonalIntelligenceEnabled !== undefined
    || patch?.notesEnabled !== undefined
    || patch?.notesPersonalIntelligenceEnabled !== undefined;
}

function puterSourcesRequestedForEnable(patch: z.infer<typeof connectorConfigSchema>["puter"]): PuterSourceKey[] {
  const sources = new Set<PuterSourceKey>();
  if (patch?.imessageEnabled === true || patch?.imessagePersonalIntelligenceEnabled === true) {
    sources.add("imessage");
  }
  if (patch?.notesEnabled === true || patch?.notesPersonalIntelligenceEnabled === true) {
    sources.add("notes");
  }
  return [...sources];
}

function updatePuterTool(tools: Set<string>, tool: string, enabled: boolean): void {
  if (enabled) {
    tools.add(tool);
  } else {
    tools.delete(tool);
  }
}

function applyPuterConfigPatch(currentTools: Set<string>, patch: z.infer<typeof connectorConfigSchema>["puter"]): void {
  if (patch?.imessageEnabled !== undefined) {
    updatePuterTool(currentTools, puterSourceTools.imessage, patch.imessageEnabled);
    if (!patch.imessageEnabled) {
      currentTools.delete(puterPersonalIntelligenceTools.imessage);
    }
  }
  if (patch?.imessagePersonalIntelligenceEnabled !== undefined) {
    if (patch.imessagePersonalIntelligenceEnabled) {
      currentTools.add(puterSourceTools.imessage);
      currentTools.add(puterPersonalIntelligenceTools.imessage);
    } else {
      currentTools.delete(puterPersonalIntelligenceTools.imessage);
    }
  }
  if (patch?.notesEnabled !== undefined) {
    updatePuterTool(currentTools, puterSourceTools.notes, patch.notesEnabled);
    if (!patch.notesEnabled) {
      currentTools.delete(puterPersonalIntelligenceTools.notes);
    }
  }
  if (patch?.notesPersonalIntelligenceEnabled !== undefined) {
    if (patch.notesPersonalIntelligenceEnabled) {
      currentTools.add(puterSourceTools.notes);
      currentTools.add(puterPersonalIntelligenceTools.notes);
    } else {
      currentTools.delete(puterPersonalIntelligenceTools.notes);
    }
  }
}

export function applyPuterConfigPatchForTest(
  enabledTools: string[],
  patch: z.infer<typeof connectorConfigSchema>["puter"],
): string[] {
  const currentTools = new Set(enabledTools);
  applyPuterConfigPatch(currentTools, patch);
  return [...currentTools];
}

async function ensurePuterDeviceConnector(deps: WebRoutesDeps, user: schema.StoredUser, deviceId: string): Promise<void> {
  const config = await getConnectorConfig(deps.db, toConnectorUser(user), puterToolkitSlug);
  if (config?.connected && config.connectedAccountId === `puter:${deviceId}`) {
    return;
  }

  if (config?.connectedAccountId && config.connectedAccountId !== `puter:${deviceId}`) {
    logger.info({
      userId: user.id,
      previousConnectedAccountId: config.connectedAccountId,
      nextConnectedAccountId: `puter:${deviceId}`,
    }, "Re-pairing Finn Puter device for signed-in Mac app");
  }

  await upsertPuterConnectorConfig(deps.db, user, { deviceId });
}

function serializeMcpTransport(row: schema.McpServer) {
  const transport = row.transport as Record<string, unknown>;
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const auth = isRecord(metadata.auth) ? metadata.auth : {};
  return {
    type: typeof transport.type === "string" ? transport.type : "unknown",
    url: typeof transport.url === "string" ? transport.url : undefined,
    command: typeof transport.command === "string" ? transport.command : undefined,
    hasAuthToken: auth.type === "api_key",
  };
}

function serializeMcpServer(row: schema.McpServer, status?: McpServerStatus) {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const auth = isRecord(metadata.auth) ? metadata.auth : {};
  const transport = serializeMcpTransport(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    logo: typeof metadata.logoUrl === "string" ? metadata.logoUrl : undefined,
    authMode: auth.type === "oauth" ? "oauth" : auth.type === "api_key" ? "api_key" : "none",
    transport,
    alwaysOn: row.alwaysOn,
    active: row.active,
    connected: status?.connected ?? false,
    toolCount: status?.toolCount ?? 0,
    resourceCount: status?.resourceCount ?? 0,
    error: status?.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildMcpMetadata(metadata: unknown, authMode: McpAuthMode): Record<string, unknown> {
  const currentMetadata = isRecord(metadata) ? metadata : {};
  const { auth: _auth, ...metadataWithoutAuth } = currentMetadata;
  return authMode === "none"
    ? metadataWithoutAuth
    : { ...metadataWithoutAuth, auth: { type: authMode } };
}

function getMcpAuthModeFromMetadata(metadata: unknown): McpAuthMode | null {
  if (!isRecord(metadata) || !isRecord(metadata.auth)) {
    return null;
  }

  const type = metadata.auth.type;
  return type === "none" || type === "api_key" || type === "oauth" ? type : null;
}

export function buildMcpMetadataForTest(metadata: unknown, authMode: McpAuthMode): Record<string, unknown> {
  return buildMcpMetadata(metadata, authMode);
}

function toRemoteMcpTransport(
  type: "http" | "sse",
  url: string,
  auth?: { headerName?: string; headerValue?: string; legacyToken?: string },
): McpServerConfig["transport"] {
  const headerName = auth?.headerName?.trim();
  const headerValue = auth?.headerValue?.trim();
  const legacyToken = auth?.legacyToken?.trim();
  return {
    type,
    url,
    ...(headerName && headerValue ? { headers: { [headerName]: headerValue } } : {}),
    ...(!headerName && legacyToken ? { headers: { Authorization: `Bearer ${legacyToken}` } } : {}),
  };
}

export function validateMcpAuthInput(input: Pick<McpServerMutationInput, "authMode" | "authHeaderName" | "authHeaderValue" | "authToken">): string | undefined {
  if (input.authMode !== "api_key") {
    return undefined;
  }

  const headerName = input.authHeaderName?.trim();
  const headerValue = input.authHeaderValue?.trim();
  const legacyToken = input.authToken?.trim();
  if (!headerName && !headerValue && legacyToken) {
    return undefined;
  }
  if (!headerName && !headerValue) {
    return "Enter the API key header name and value before connecting.";
  }
  if (!headerName) {
    return "Enter the API key header name before connecting.";
  }
  if (!headerValue) {
    return "Enter the API key value before connecting.";
  }

  return undefined;
}

export function getUnsupportedMcpOAuthMessage(rawUrl: string): string | undefined {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const isGitHubRemoteMcp = host === "api.githubcopilot.com" || (host.endsWith("github.com") && path.includes("mcp"));

  if (!isGitHubRemoteMcp) {
    return undefined;
  }

  return "GitHub's remote MCP does not support Finn's generic OAuth setup. Choose API key auth, set the header to Authorization, and use Bearer <your GitHub token> as the value.";
}

export function formatMcpSetupError(error: unknown, authMode: McpAuthMode): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (authMode === "api_key") {
    return message
      ? `Could not connect to the MCP server with those API key settings: ${message}`
      : "Could not connect to the MCP server with those API key settings. Check the URL, header name, and value.";
  }
  if (authMode === "oauth") {
    return message
      ? `Could not start OAuth for this MCP server: ${message}`
      : "Could not start OAuth for this MCP server. If it needs a provider-specific token, choose API key auth instead.";
  }

  return message
    ? `Could not connect to the MCP server: ${message}`
    : "Could not connect to the MCP server. If it requires auth, choose API key and enter the required header.";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Could not save connector settings.";
}

async function detectRemoteMcpTransport(params: {
  name: string;
  description?: string;
  url: string;
  auth?: { headerName?: string; headerValue?: string; legacyToken?: string };
  alwaysOn: boolean;
}): Promise<McpServerConfig["transport"]> {
  let fallbackError = "Could not connect to MCP server.";

  for (const type of ["http", "sse"] as const) {
    const transport = toRemoteMcpTransport(type, params.url, params.auth);
    const service = new McpService({
      configs: [{
        name: params.name,
        description: params.description,
        alwaysOn: params.alwaysOn,
        transport,
      }],
    });

    try {
      await service.initialize();
      const [status] = service.getStatuses();
      if (status?.connected) {
        return transport;
      }
      fallbackError = status?.error ?? fallbackError;
    } finally {
      await service.close();
    }
  }

  throw new Error(fallbackError);
}

async function startMcpOAuth(params: {
  deps: WebRoutesDeps;
  user: schema.StoredUser;
  row: schema.McpServer;
}): Promise<{ redirectUrl?: string; status?: McpServerStatus }> {
  let redirectUrl: string | undefined;
  const store = createMcpStore(params.deps);
  const userRef = toConnectorUser(params.user);
  const service = new McpService({
    configs: [await store.configForRow(userRef, params.row)],
    oauthStore: createMcpOAuthStore({
      db: params.deps.db,
      getUserRoot: getMcpUserRootResolver(params.deps),
      user: userRef,
      publicUrl: params.deps.config.publicUrl,
      onRedirect: (_server, authorizationUrl) => {
        redirectUrl = authorizationUrl.toString();
      },
    }),
  });

  try {
    await service.initialize();
    const [status] = service.getStatuses();
    return { redirectUrl, status };
  } finally {
    await service.close();
  }
}

function serializePattern(pattern: PatternRecord, patternStore?: PatternStore) {
  const nextRunAt = pattern.nextRunAt
    ?? (patternStore && pattern.active && pattern.triggerConfig.type === "schedule" && !patternStore.isOneShotSchedule(pattern.triggerConfig)
      ? patternStore.computeNextRun(pattern.triggerConfig, pattern.timezone)
      : null);

  return {
    id: pattern.id,
    name: pattern.name,
    description: pattern.description,
    userDescription: pattern.userDescription,
    triggerType: pattern.triggerType,
    triggerConfig: pattern.triggerConfig,
    connectorScope: pattern.connectorScope,
    triggerFilters: pattern.triggerFilters,
    notifyCondition: pattern.notifyCondition,
    taskPrompt: pattern.taskPrompt,
    reminderContext: pattern.reminderContext,
    workerType: pattern.workerType,
    timezone: pattern.timezone,
    active: pattern.active,
    failureCount: pattern.failureCount,
    lastRunAt: pattern.lastRunAt?.toISOString() ?? null,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    createdAt: pattern.createdAt.toISOString(),
    updatedAt: pattern.updatedAt.toISOString(),
  };
}

function serializePatternRun(run: PatternRunRecord) {
  return {
    id: run.id,
    patternId: run.patternId,
    triggeredBy: run.triggeredBy,
    triggerPayload: run.triggerPayload,
    workerId: run.workerId,
    state: run.state,
    result: run.result,
    error: run.error,
    skipReason: run.skipReason,
    notifyOutcome: run.notifyOutcome,
    surfacedAt: run.surfacedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function getDefaultLocalDate(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildMyDayHandoffMessageForTest(user: UserContext, todo: MyDayPageRecord["todos"][number], context?: string): UserMessage {
  const content = [
    "[My Day handoff]",
    "The user tapped Handoff to Finn for this My Day todo. They want Finn to take on this task or decide the right delegation path.",
    `Todo ID: ${todo.id}`,
    `Todo title: ${todo.title}`,
    todo.notes ? `Notes: ${todo.notes}` : null,
    todo.source?.evidence ? `Evidence: ${todo.source.evidence}` : null,
    todo.source?.reason ? `Reason: ${todo.source.reason}` : null,
    context ? `User handoff context: ${context}` : null,
    "If this needs background work, delegate it. If you need clarification, ask the user. When delegated work completes successfully, Finn can mark the todo done.",
  ].filter((line): line is string => Boolean(line)).join("\n");

  return {
    source: "user",
    tenantId: user.tenantId,
    userId: user.userId,
    phoneNumber: user.phoneNumber,
    content,
    context: { myDayHandoffTodoId: todo.id },
    messageId: generateId("myday_handoff"),
    timestamp: new Date(),
  };
}

function serializeMyDay(page: MyDayPageRecord) {
  return {
    day: {
      id: page.day.id,
      userLocalDate: page.day.userLocalDate,
      timezone: page.day.timezone,
      summary: page.day.summary,
      sourceSummary: page.day.sourceSummary,
      lastRefreshedAt: page.day.lastRefreshedAt?.toISOString() ?? null,
      createdAt: page.day.createdAt.toISOString(),
      updatedAt: page.day.updatedAt.toISOString(),
    },
    todos: page.todos.map((todo) => ({
      id: todo.id,
      title: todo.title,
      notes: todo.notes,
      status: todo.status,
      source: todo.source,
      handoffAt: todo.handoffAt?.toISOString() ?? null,
      handoffWorkerId: todo.handoffWorkerId,
      createdAt: todo.createdAt.toISOString(),
      updatedAt: todo.updatedAt.toISOString(),
      completedAt: todo.completedAt?.toISOString() ?? null,
      archivedAt: todo.deletedAt?.toISOString() ?? null,
    })),
  };
}

function serializeMyDayTodo(todo: MyDayPageRecord["todos"][number]) {
  return {
    id: todo.id,
    title: todo.title,
    notes: todo.notes,
    status: todo.status,
    source: todo.source,
    handoffAt: todo.handoffAt?.toISOString() ?? null,
    handoffWorkerId: todo.handoffWorkerId,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
    completedAt: todo.completedAt?.toISOString() ?? null,
    archivedAt: todo.deletedAt?.toISOString() ?? null,
  };
}

function serializePatternWithConnectors(pattern: PatternRecord, connectors: Map<string, UserConnectorConfig>, patternStore?: PatternStore) {
  const serialized = serializePattern(pattern, patternStore);
  const connector = pattern.triggerConfig.type === "composio"
    ? connectors.get(pattern.triggerConfig.toolkitSlug)
    : undefined;
  return {
    ...serialized,
    connectorIssues: resolvePatternConnectorIssues(pattern, connectors),
    ...(pattern.triggerConfig.type === "composio"
      ? {
          triggerConfig: {
            ...serialized.triggerConfig,
            toolkitName: connector?.toolkitName ?? undefined,
          },
        }
      : {}),
  };
}

function composioConnectorCallbackUrl(deps: WebRoutesDeps, slug: string, previousConnectedAccountId?: string | null, returnTo?: "connectors" | "onboarding"): string {
  const params = new URLSearchParams({ slug });
  if (previousConnectedAccountId) {
    params.set("previousConnectedAccountId", previousConnectedAccountId);
  }
  if (returnTo === "onboarding") {
    params.set("returnTo", "onboarding");
  }
  return `${deps.config.publicUrl.replace(/\/+$/, "")}/api/web/connectors/oauth/callback?${params}`;
}

function patternComposioToolkitSlugs(pattern: PatternRecord): string[] {
  const slugs = new Set(pattern.connectorScope.composio.map((scope) => scope.toolkitSlug));
  if (pattern.triggerConfig.type === "composio") {
    slugs.add(pattern.triggerConfig.toolkitSlug);
  }
  return [...slugs].filter(isComposioManagedConnectorSlug);
}

async function resolveSyncedPatternConnectorIssues(
  deps: WebRoutesDeps,
  user: schema.StoredUser,
  patternStore: PatternStore,
  pattern: PatternRecord,
): Promise<{ pattern: PatternRecord; connectorIssues: ReturnType<typeof resolvePatternConnectorIssues> }> {
  const composio = await getWebComposioService(deps, user);
  const toolkitSlugs = patternComposioToolkitSlugs(pattern);
  if (composio && toolkitSlugs.length > 0) {
    await composio.reconcileConnectorConfigs({ toolkitSlugs, origin: "system" });
  }

  const refreshedPattern = await patternStore.getById(pattern.id) ?? pattern;
  const connectorConfigs = await listConnectorConfigs(deps.db, toUserContext(user, deps.config));
  const connectors = new Map(connectorConfigs.map((config) => [config.toolkitSlug, config]));
  return {
    pattern: refreshedPattern,
    connectorIssues: resolvePatternConnectorIssues(refreshedPattern, connectors),
  };
}

async function syncConnectorConfigForSlug(
  deps: WebRoutesDeps,
  user: schema.StoredUser,
  slug: string,
): Promise<schema.UserConnectorConfig | null> {
  if (!isComposioManagedConnectorSlug(slug)) {
    return getConnectorConfig(deps.db, toConnectorUser(user), slug);
  }
  const composio = await getWebComposioService(deps, user);
  if (!composio) {
    return getConnectorConfig(deps.db, toConnectorUser(user), slug);
  }
  return composio.getConnectorConfig(slug);
}

async function getSessionUser(c: Context, deps: WebRoutesDeps): Promise<schema.StoredUser | null> {
  const token = getCookie(c, sessionCookieName);
  if (!token) {
    return null;
  }

  const tokenHash = hashValue(token);
  const now = new Date();
  const [session] = await deps.db
    .select()
    .from(schema.webSessions)
    .where(and(eq(schema.webSessions.tokenHash, tokenHash), gt(schema.webSessions.expiresAt, now)))
    .limit(1);

  if (!session) {
    deleteCookie(c, sessionCookieName, { path: "/" });
    return null;
  }

  const [user] = await deps.db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, session.tenantId), eq(schema.users.id, session.userId)))
    .limit(1);

  if (!user) {
    deleteCookie(c, sessionCookieName, { path: "/" });
    return null;
  }

  await deps.db
    .update(schema.webSessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.webSessions.id, session.id));

  return user;
}

async function requireSessionUser(c: Context, deps: WebRoutesDeps): Promise<schema.StoredUser | Response> {
  const user = await getSessionUser(c, deps);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return user;
}

export function createWebRoutes(deps: WebRoutesDeps): Hono {
  const app = new Hono();

  app.get("/session", async (c) => {
    const user = await getSessionUser(c, deps);
    return c.json(await serializeSession(user, deps.config, deps.users));
  });

  app.post("/auth/request", async (c) => {
    const body = requestCodeSchema.parse(await c.req.json());
    const phoneNumber = normalizePhoneNumber(body.phoneNumber);

    if (!isAllowedPhoneNumber(deps.config, phoneNumber)) {
      return c.json({ error: "This phone number is not allowed for Finn." }, 403);
    }

    const { created } = await deps.users.getOrCreateByPhone(phoneNumber);

    const code = createCode();
    const now = new Date();
    await deps.db.insert(schema.webLoginCodes).values({
      id: generateId("wlc"),
      tenantId,
      phoneNumber,
      codeHash: hashValue(code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + loginCodeTtlMs),
      createdAt: now,
    });

    await deps.messaging.sendText(phoneNumber, `your Finn login code is ${code}`);

    logger.info({ phoneNumber }, "Sent web login code");
    return c.json({ ok: true, isNewUser: created });
  });

  app.post("/auth/verify", async (c) => {
    const body = verifyCodeSchema.parse(await c.req.json());
    const phoneNumber = normalizePhoneNumber(body.phoneNumber);
    const now = new Date();

    const [loginCode] = await deps.db
      .select()
      .from(schema.webLoginCodes)
      .where(and(
        eq(schema.webLoginCodes.tenantId, tenantId),
        eq(schema.webLoginCodes.phoneNumber, phoneNumber),
        isNull(schema.webLoginCodes.consumedAt),
        gt(schema.webLoginCodes.expiresAt, now),
      ))
      .orderBy(desc(schema.webLoginCodes.createdAt))
      .limit(1);

    if (!loginCode) {
      return c.json({ error: "Code expired. Request a new one." }, 400);
    }

    if (loginCode.attempts >= 5) {
      return c.json({ error: "Too many attempts. Request a new code." }, 429);
    }

    if (!sameHash(loginCode.codeHash, hashValue(body.code))) {
      await deps.db
        .update(schema.webLoginCodes)
        .set({ attempts: loginCode.attempts + 1 })
        .where(eq(schema.webLoginCodes.id, loginCode.id));
      return c.json({ error: "That code did not match." }, 400);
    }

    const { user } = await deps.users.getOrCreateByPhone(phoneNumber);
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionExpiresAt = new Date(now.getTime() + sessionTtlMs);

    await deps.db
      .update(schema.webLoginCodes)
      .set({ consumedAt: now })
      .where(eq(schema.webLoginCodes.id, loginCode.id));

    await deps.db.insert(schema.webSessions).values({
      id: generateId("wsn"),
      tenantId: user.tenantId,
      userId: user.userId,
      tokenHash: hashValue(sessionToken),
      expiresAt: sessionExpiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    setCookie(c, sessionCookieName, sessionToken, sessionCookieOptions(deps.config, c));

    const storedUser = await deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.userId))
      .limit(1)
      .then(([row]) => row);

    return c.json(await serializeSession(storedUser ?? null, deps.config, deps.users));
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, sessionCookieName);
    if (token) {
      await deps.db
        .delete(schema.webSessions)
        .where(eq(schema.webSessions.tokenHash, hashValue(token)));
    }
    deleteCookie(c, sessionCookieName, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/my-day", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const query = myDayQuerySchema.parse(c.req.query());
    const userLocalDate = query.date ?? getDefaultLocalDate(userContext.timezone);
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const page = await store.getForDate(userLocalDate, userContext.timezone);
    return c.json(serializeMyDay(page));
  });

  app.patch("/my-day", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const body = myDaySummarySchema.parse(await c.req.json());
    const userLocalDate = body.date ?? getDefaultLocalDate(userContext.timezone);
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const page = await store.updateSummary(userLocalDate, userContext.timezone, {
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.sourceSummary !== undefined ? { sourceSummary: body.sourceSummary } : {}),
      ...(body.refreshed ? { lastRefreshedAt: new Date() } : {}),
    });
    return c.json(serializeMyDay(page));
  });

  app.post("/my-day/refresh", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }
    if (!deps.myDayRefreshService) {
      return c.json({ error: "My Day refresh is not configured." }, 503);
    }

    const userContext = toUserContext(user, deps.config);
    const result = await deps.myDayRefreshService.refreshUser(userContext);
    const page = await new MyDayStore({ db: deps.db, user: userContext })
      .getForDate(getDefaultLocalDate(userContext.timezone), userContext.timezone);
    return c.json({ ...serializeMyDay(page), runId: result.runId, acceptedTodoIds: result.acceptedTodoIds });
  });

  app.post("/my-day/todos", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const body = myDayTodoCreateSchema.parse(await c.req.json());
    const userLocalDate = body.date ?? getDefaultLocalDate(userContext.timezone);
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const todo = await store.createTodo(userLocalDate, userContext.timezone, {
      title: body.title,
      notes: body.notes,
      source: { type: "user", label: "My Day" },
    });
    return c.json({ todo: serializeMyDayTodo(todo) }, 201);
  });

  app.patch("/my-day/todos/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const body = myDayTodoUpdateSchema.parse(await c.req.json());
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const todo = await store.updateTodo(c.req.param("id"), body);
    if (!todo) {
      return c.json({ error: "Todo not found." }, 404);
    }
    return c.json({ todo: serializeMyDayTodo(todo) });
  });

  app.post("/my-day/todos/:id/handoff", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }
    if (!deps.runtimes) {
      return c.json({ error: "Hot path runtime is not configured." }, 503);
    }

    const userContext = toUserContext(user, deps.config);
    const body = myDayTodoHandoffSchema.parse(await c.req.json().catch(() => ({})));
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const todo = await store.getTodo(c.req.param("id"));
    if (!todo || todo.status === "deleted" || todo.status === "archived") {
      return c.json({ error: "Todo not found." }, 404);
    }
    if (todo.status === "done") {
      return c.json({ error: "Todo is already done." }, 409);
    }
    if (todo.handoffAt) {
      return c.json({ error: "Todo is already handed off.", todo: serializeMyDayTodo(todo) }, 409);
    }

    const handedOff = await store.markTodoHandoffQueued(todo.id);
    if (!handedOff) {
      const current = await store.getTodo(todo.id);
      if (current?.handoffAt) {
        return c.json({ error: "Todo is already handed off.", todo: serializeMyDayTodo(current) }, 409);
      }
      return c.json({ error: "Todo could not be handed off." }, 409);
    }

    await deps.runtimes.enqueueUserHandoff(buildMyDayHandoffMessageForTest(userContext, handedOff, body.context));
    return c.json({ todo: serializeMyDayTodo(handedOff), queued: true });
  });

  app.delete("/my-day/todos/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const store = new MyDayStore({ db: deps.db, user: userContext });
    const todo = await store.deleteTodo(c.req.param("id"));
    if (!todo) {
      return c.json({ error: "Todo not found." }, 404);
    }
    return c.json({ archived: true, todo: serializeMyDayTodo(todo) });
  });

  app.get("/patterns", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const [patterns, connectorConfigs] = await Promise.all([
      deps.patternStore.listForUser(userContext),
      listConnectorConfigs(deps.db, userContext),
    ]);
    const connectors = new Map(connectorConfigs.map((config) => [config.toolkitSlug, config]));
    return c.json({ patterns: patterns.map((pattern) => serializePatternWithConnectors(pattern, connectors, deps.patternStore)) });
  });

  app.post("/patterns", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const body = patternCreateSchema.parse(await c.req.json());
    const pattern = await deps.patternStore.createForUser(userContext, {
      name: body.name,
      userDescription: body.userDescription ?? null,
      triggerType: "schedule",
      triggerConfig: { type: "schedule", schedule: body.schedule, timezoneSource: "user" },
      triggerFilters: body.triggerFilters,
      notifyCondition: body.notifyCondition,
      workerType: "pattern_worker",
      taskPrompt: body.taskPrompt,
      timezone: userContext.timezone,
    });
    emitPatternActivity({ eventBus: deps.eventBus, pattern, action: "created", origin: "web" });

    return c.json({ pattern: serializePattern(pattern, deps.patternStore) }, 201);
  });

  app.get("/patterns/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const pattern = await deps.patternStore.getByIdForUser(toUserContext(user, deps.config), c.req.param("id"));
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }

    const connectorConfigs = await listConnectorConfigs(deps.db, toUserContext(user, deps.config));
    const connectors = new Map(connectorConfigs.map((config) => [config.toolkitSlug, config]));
    return c.json({ pattern: serializePatternWithConnectors(pattern, connectors, deps.patternStore) });
  });

  app.get("/patterns/:id/runs", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const pattern = await deps.patternStore.getByIdForUser(userContext, c.req.param("id"));
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }

    const query = patternRunsQuerySchema.parse(c.req.query());
    const runs = await deps.patternStore.listRuns({
      patternId: pattern.id,
      limit: query.limit,
      beforeRunId: query.beforeRunId,
    });

    return c.json({ runs: runs.map(serializePatternRun) });
  });

  app.patch("/patterns/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const body = patternUpdateSchema.parse(await c.req.json());
    if (Object.keys(body).length === 0) {
      return c.json({ error: "No Pattern fields provided." }, 400);
    }
    const userContext = toUserContext(user, deps.config);
    const pattern = await deps.patternStore.updateForUser(userContext, c.req.param("id"), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.userDescription !== undefined ? { userDescription: body.userDescription } : {}),
      ...(body.taskPrompt !== undefined ? { taskPrompt: body.taskPrompt } : {}),
      ...(body.triggerFilters !== undefined ? { triggerFilters: body.triggerFilters } : {}),
      ...(body.notifyCondition !== undefined ? { notifyCondition: body.notifyCondition } : {}),
    });
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }
    emitPatternActivity({ eventBus: deps.eventBus, pattern, action: "edited", origin: "web" });

    return c.json({ pattern: serializePattern(pattern, deps.patternStore) });
  });

  app.post("/patterns/:id/toggle", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const userPatternStore = await getWebPatternStore(deps, userContext);
    const bodyText = await c.req.text();
    let body: unknown | null = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        return c.json({ error: "Invalid JSON." }, 400);
      }
    }
    const desiredState = body === null ? null : patternActiveSchema.safeParse(body);
    if (desiredState !== null && !desiredState.success) {
      return c.json({ error: "Invalid Pattern state." }, 400);
    }

    let currentPattern = await userPatternStore.getById(c.req.param("id"));
    if (!currentPattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }
    const nextActive = desiredState ? desiredState.data.active : !currentPattern.active;
    if (nextActive) {
      const synced = await resolveSyncedPatternConnectorIssues(deps, user, userPatternStore, currentPattern);
      currentPattern = synced.pattern;
      const connectorIssues = synced.connectorIssues;
      if (connectorIssues.length > 0) {
        return c.json({ error: "Reconnect this Pattern's connector before resuming it." }, 409);
      }
    }

    const composio = await getWebComposioService(deps, user);
    const pattern = await setPatternActiveWithComposioTriggerLifecycle({
      patternStore: userPatternStore,
      composio: composio ?? undefined,
      patternId: c.req.param("id"),
      active: nextActive,
    });
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }

    emitPatternActivity({ eventBus: deps.eventBus, pattern, action: pattern.active ? "resumed" : "paused", origin: "web" });

    const connectorConfigs = await listConnectorConfigs(deps.db, userContext);
    const connectors = new Map(connectorConfigs.map((config) => [config.toolkitSlug, config]));
    return c.json({ pattern: serializePatternWithConnectors(pattern, connectors, deps.patternStore) });
  });

  app.post("/patterns/:id/run", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const userPatternStore = await getWebPatternStore(deps, userContext);
    let pattern = await userPatternStore.getById(c.req.param("id"));
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }
    const synced = await resolveSyncedPatternConnectorIssues(deps, user, userPatternStore, pattern);
    pattern = synced.pattern;
    if (synced.connectorIssues.length > 0) {
      return c.json({ error: "Reconnect this Pattern's connector before running it." }, 409);
    }

    const workerId = await deps.patternScheduler.runPattern(pattern, "manual");
    return c.json({ workerId, started: true });
  });

  app.delete("/patterns/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const pattern = await deps.patternStore.getByIdForUser(toUserContext(user, deps.config), c.req.param("id"));
    if (!pattern) {
      return c.json({ error: "Pattern not found." }, 404);
    }

    const userPatternStore = await getWebPatternStore(deps, toUserContext(user, deps.config));
    const composio = await getWebComposioService(deps, user);
    const deleted = await removePatternWithComposioTriggerLifecycle({
      patternStore: userPatternStore,
      composio: composio ?? undefined,
      patternId: pattern.id,
    });
    if (deleted) {
      emitPatternActivity({ eventBus: deps.eventBus, pattern: deleted, action: "deleted", origin: "web" });
    }
    return c.json({ ok: true });
  });

  app.get("/library", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const query = libraryFolderQuerySchema.parse(c.req.query());
    const userContext = toUserContext(user, deps.config);
    const currentFolder = query.folderId ? await getLibraryFolder(deps.db, userContext, query.folderId) : null;
    if (query.folderId && !currentFolder) {
      return c.json({ error: "Folder not found." }, 404);
    }

    const folderWhere = and(
      eq(schema.fileFolders.tenantId, userContext.tenantId),
      eq(schema.fileFolders.userId, userContext.userId),
      currentFolder ? eq(schema.fileFolders.parentId, currentFolder.id) : isNull(schema.fileFolders.parentId),
    );
    const storedFiles = requireStoredFiles(await getWebFilesRuntime(deps, userContext));
    const [folders, files, breadcrumbs] = await Promise.all([
      deps.db
        .select()
        .from(schema.fileFolders)
        .where(folderWhere)
        .orderBy(asc(schema.fileFolders.name)),
      storedFiles.list(200, 0, { userVisible: true, folderId: currentFolder?.id ?? null }),
      getLibraryBreadcrumbs(deps.db, userContext, currentFolder),
    ]);

    return c.json({
      folder: currentFolder ? serializeLibraryFolder(currentFolder) : null,
      breadcrumbs,
      folders: folders.map(serializeLibraryFolder),
      files: files.map((file) => serializeLibraryFile(file, deps.config.publicUrl)),
    });
  });

  app.post("/library/folders", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const body = libraryFolderCreateSchema.parse(await c.req.json());
    const userContext = toUserContext(user, deps.config);
    const parent = await ensureLibraryFolder(deps.db, userContext, body.parentId ?? null).catch((error) => error);
    if (parent instanceof Error) {
      return c.json({ error: parent.message }, 404);
    }

    if (await hasSiblingLibraryFolder(deps.db, userContext, body.name, parent?.id ?? null)) {
      return c.json({ error: "A folder with that name already exists here." }, 409);
    }

    const now = new Date();
    let folder: schema.StoredFileFolder;
    try {
      [folder] = await deps.db
        .insert(schema.fileFolders)
        .values({
          id: generateId("fld"),
          tenantId: userContext.tenantId,
          userId: userContext.userId,
          parentId: parent?.id ?? null,
          name: body.name,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (isDatabaseErrorCode(error, "23505")) {
        return c.json({ error: "A folder with that name already exists here." }, 409);
      }
      throw error;
    }

    return c.json({ folder: serializeLibraryFolder(folder) });
  });

  app.delete("/library/folders/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const userContext = toUserContext(user, deps.config);
    const folder = await getLibraryFolder(deps.db, userContext, c.req.param("id"));
    if (!folder) {
      return c.json({ error: "Folder not found." }, 404);
    }

    await deps.db
      .delete(schema.fileFolders)
      .where(and(
        eq(schema.fileFolders.id, folder.id),
        eq(schema.fileFolders.tenantId, userContext.tenantId),
        eq(schema.fileFolders.userId, userContext.userId),
      ));

    return c.json({ ok: true });
  });

  app.post("/library/files", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const formData = await c.req.raw.formData();
    const uploaded = formData.get("file");
    if (!(uploaded instanceof File)) {
      return c.json({ error: "Choose a file to upload." }, 400);
    }
    if (uploaded.size > maxUploadSizeBytes(deps.config)) {
      return c.json({ error: maxUploadSizeMessage(deps.config) }, 400);
    }

    const userContext = toUserContext(user, deps.config);
    const rawFolderId = formData.get("folderId");
    const folderId = typeof rawFolderId === "string" && rawFolderId.trim() ? rawFolderId.trim() : null;
    const folder = await ensureLibraryFolder(deps.db, userContext, folderId).catch((error) => error);
    if (folder instanceof Error) {
      return c.json({ error: folder.message }, 404);
    }

    const data = Buffer.from(await uploaded.arrayBuffer());
    const storedFiles = requireStoredFiles(await getWebFilesRuntime(deps, userContext));
    let stored: schema.StoredFile;
    try {
      stored = await storedFiles.store({
        filename: uploaded.name || "uploaded-file",
        mimeType: uploaded.type || "application/octet-stream",
        data,
        userVisible: true,
        folderId: folder?.id ?? null,
        origin: "user_upload",
      });
    } catch (error) {
      if (error instanceof StorageError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    return c.json({ file: serializeLibraryFile(stored, deps.config.publicUrl) });
  });

  app.patch("/library/files/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const body = libraryFileUpdateSchema.parse(await c.req.json());
    const userContext = toUserContext(user, deps.config);
    const storedFiles = requireStoredFiles(await getWebFilesRuntime(deps, userContext));
    let file = await storedFiles.getMetadata(c.req.param("id"));
    if (!file) {
      return c.json({ error: "File not found." }, 404);
    }

    if (body.folderId !== undefined) {
      const folder = await ensureLibraryFolder(deps.db, userContext, body.folderId).catch((error) => error);
      if (folder instanceof Error) {
        return c.json({ error: folder.message }, 404);
      }
      file = await storedFiles.moveToFolder(file.id, folder?.id ?? null);
    }

    if (body.userVisible !== undefined && file) {
      file = await storedFiles.setUserVisible(file.id, body.userVisible);
    }

    if (!file) {
      return c.json({ error: "File not found." }, 404);
    }

    return c.json({ file: serializeLibraryFile(file, deps.config.publicUrl) });
  });

  app.delete("/library/files/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const storedFiles = requireStoredFiles(await getWebFilesRuntime(deps, toUserContext(user, deps.config)));
    const deleted = await storedFiles.delete(c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "File not found." }, 404);
    }

    return c.json({ ok: true });
  });

  app.patch("/profile", async (c) => {
    const currentUser = await requireSessionUser(c, deps);
    if (currentUser instanceof Response) {
      return currentUser;
    }

    const body = profileSchema.parse(await c.req.json());
    const phoneNumber = normalizePhoneNumber(body.phoneNumber);

    if (!isAllowedPhoneNumber(deps.config, phoneNumber)) {
      return c.json({ error: "This phone number is not allowed for Finn." }, 403);
    }

    const now = new Date();
    const timezoneSource = body.timezoneSource ?? "server";
    const manualTimezone = body.timezone?.trim();
    const displayName = body.displayName.trim() || currentUser.displayName;

    if (timezoneSource !== "server" && !isValidTimeZone(manualTimezone)) {
      return c.json({ error: "Choose a valid timezone from the list." }, 400);
    }

    const timezone = timezoneSource !== "server"
      ? manualTimezone!
      : resolveTimeZone(deps.config.userTimezone);
    const [updated] = await deps.db
      .update(schema.users)
      .set({
        displayName,
        phoneNumber,
        timezone,
        location: body.location || null,
        ...(typeof body.kidsMode === "boolean" ? { kidsMode: body.kidsMode } : {}),
        metadata: withTimezoneSource(currentUser.metadata, timezoneSource),
        updatedAt: now,
      })
      .where(eq(schema.users.id, currentUser.id))
      .returning();

    await deps.users.updateSpectrumChannelPhone(currentUser.id, phoneNumber);

    const userContext = toUserContext(updated, deps.config);
    await rescheduleUserScheduledPatterns(deps.db, userContext, userContext.timezone);
    await deps.runtimes?.refresh(userContext);
    syncProfileSeedAfterUserChange(deps, updated, userContext);

    return c.json({ user: serializeUser(updated, deps.config) });
  });

  app.post("/onboarding/complete", async (c) => {
    const currentUser = await requireSessionUser(c, deps);
    if (currentUser instanceof Response) {
      return currentUser;
    }

    const body = onboardingCompleteSchema.parse(await c.req.json().catch(() => undefined));
    const currentUserContext = toUserContext(currentUser, deps.config);
    if (deps.composio) {
      const connectorConfigs = await listConnectorConfigs(deps.db, currentUserContext);
      if (!hasConnectedRequiredOnboardingConnector(connectorConfigs)) {
        return c.json({ error: "Connect Gmail or Outlook before finishing setup." }, 409);
      }
    }

    const now = new Date();
    const [updated] = await deps.db
      .update(schema.users)
      .set({
        metadata: withOnboardingCompleted(currentUser.metadata, now, body?.firstMessageContext),
        updatedAt: now,
      })
      .where(eq(schema.users.id, currentUser.id))
      .returning();

    const updatedUserContext = toUserContext(updated, deps.config);
    await deps.runtimes?.refresh(updatedUserContext);
    syncProfileSeedAfterUserChange(deps, updated, updatedUserContext);

    return c.json({ user: serializeUser(updated, deps.config) });
  });

  app.post("/profile/image", async (c) => {
    const currentUser = await requireSessionUser(c, deps);
    if (currentUser instanceof Response) {
      return currentUser;
    }

    const formData = await c.req.raw.formData();
    const uploaded = formData.get("image");
    if (!(uploaded instanceof File)) {
      return c.json({ error: "Choose an image to upload." }, 400);
    }

    const extension = profileImageExtension(uploaded.type, uploaded.name);
    if (!extension) {
      return c.json({ error: "Choose a JPG, PNG, WebP, or AVIF image." }, 400);
    }

    const data = Buffer.from(await uploaded.arrayBuffer());
    const maxProfileImageBytes = 8 * 1024 * 1024;
    if (data.length > maxProfileImageBytes) {
      return c.json({ error: "Profile image must be smaller than 8 MB." }, 400);
    }

    const now = new Date();
    const filename = `profile-image${extension}`;
    const previousProfileImage = getProfileImage(currentUser.metadata);
    const userContext = toUserContext(currentUser, deps.config);
    const storedFiles = requireStoredFiles(await getWebFilesRuntime(deps, userContext));

    const stored = await storedFiles.store({
      filename,
      mimeType: uploaded.type || "application/octet-stream",
      data,
      userVisible: false,
      origin: "user_upload",
    });

    const [updated] = await deps.db
      .update(schema.users)
      .set({
        metadata: withProfileImage(currentUser.metadata, {
          fileId: stored.id,
          updatedAt: now.toISOString(),
        }),
        updatedAt: now,
      })
      .where(eq(schema.users.id, currentUser.id))
      .returning();

    if (previousProfileImage?.fileId && previousProfileImage.fileId !== stored.id) {
      await storedFiles.delete(previousProfileImage.fileId).catch(() => false);
    }

    await deps.runtimes?.refresh(toUserContext(updated, deps.config));

    return c.json({ user: serializeUser(updated, deps.config) });
  });

  app.get("/mcp-servers", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    try {
      const store = createMcpStore(deps);
      const rows = await store.listForUser(toConnectorUser(user));
      const statuses = deps.runtimes
        ? await deps.runtimes.getMcpStatuses(toUserContext(user, deps.config))
        : [];
      const statusByName = new Map(statuses.map((status) => [status.server, status]));
      return c.json({
        servers: rows.map((row) => serializeMcpServer(row, statusByName.get(row.name))),
      });
    } catch (error) {
      logger.error({ error, userId: user.id }, "Failed to load MCP servers");
      return c.json({ error: "Could not load MCP servers right now." }, 502);
    }
  });

  app.post("/mcp-servers", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const body = mcpServerMutationSchema.parse(await c.req.json());
    const authError = validateMcpAuthInput(body);
    if (authError) {
      return c.json({ error: authError }, 400);
    }

    if (body.authMode === "oauth") {
      const oauthError = getUnsupportedMcpOAuthMessage(body.url);
      if (oauthError) {
        return c.json({ error: oauthError }, 400);
      }
    }

    try {
      const store = createMcpStore(deps);

      if (body.authMode === "oauth") {
        const created = await store.createForUser(toConnectorUser(user), {
          name: body.name,
          description: body.description,
          transport: toRemoteMcpTransport("http", body.url),
          alwaysOn: body.alwaysOn,
          active: body.active,
          metadata: {
            auth: { type: "oauth" },
          },
        });
        await store.saveOAuthState(toConnectorUser(user), created.id, { state: generateId("mcp_oauth") });
        try {
          const { redirectUrl, status } = await startMcpOAuth({ deps, user, row: created });
          if (!redirectUrl && status?.connected) {
            await deps.runtimes?.refreshMcpServers(toUserContext(user, deps.config));
            return c.json({ server: serializeMcpServer(created, status) }, 201);
          }
          if (!redirectUrl) {
            await store.deleteForUser(toConnectorUser(user), created.id);
            return c.json({
              error: formatMcpSetupError(
                new Error(status?.error ?? "MCP server did not return an OAuth authorization URL."),
                "oauth",
              ),
            }, 502);
          }
          return c.json({ server: serializeMcpServer(created, status), redirectUrl }, 201);
        } catch (error) {
          await store.deleteForUser(toConnectorUser(user), created.id);
          throw error;
        }
      }

      const transport = await detectRemoteMcpTransport({
        name: body.name,
        description: body.description,
        url: body.url,
        auth: body.authMode === "api_key"
          ? {
              headerName: body.authHeaderName,
              headerValue: body.authHeaderValue,
              legacyToken: body.authToken,
            }
          : undefined,
        alwaysOn: body.alwaysOn,
      });
      const created = await store.createForUser(toConnectorUser(user), {
        name: body.name,
        description: body.description,
        transport,
        alwaysOn: body.alwaysOn,
        active: body.active,
        metadata: body.authMode === "api_key" ? { auth: { type: "api_key" } } : undefined,
      });
      if (body.authMode === "api_key") {
        if (body.authHeaderName || body.authHeaderValue) {
          await store.saveAuthHeader(toConnectorUser(user), created.id, {
            name: body.authHeaderName,
            value: body.authHeaderValue,
          });
        } else {
          await store.saveAuthToken(toConnectorUser(user), created.id, body.authToken);
        }
      }
      await deps.runtimes?.refreshMcpServers(toUserContext(user, deps.config));
      return c.json({ server: serializeMcpServer(created, {
        server: created.name,
        description: created.description ?? undefined,
        transport: transport.type,
        connected: true,
        toolCount: 0,
        resourceCount: 0,
        alwaysOn: created.alwaysOn,
      }) }, 201);
    } catch (error) {
      logger.error({ error, userId: user.id, mcpName: body.name, authMode: body.authMode }, "Failed to create MCP server");
      return c.json({ error: formatMcpSetupError(error, body.authMode) }, 502);
    }
  });

  app.get("/mcp-servers/oauth/callback", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    if (oauthError) {
      return c.redirect("/connectors");
    }
    if (!code || !state) {
      return c.json({ error: "Missing OAuth callback code or state." }, 400);
    }

    try {
      const userRef = toConnectorUser(user);
      const store = createMcpStore(deps);
      const row = await store.findByOAuthState(userRef, state);
      if (!row) {
        return c.json({ error: "OAuth state was not recognized." }, 400);
      }

      const service = new McpService({
        configs: [await store.configForRow(userRef, row)],
        oauthStore: createMcpOAuthStore({
          db: deps.db,
          getUserRoot: getMcpUserRootResolver(deps),
          user: userRef,
          publicUrl: deps.config.publicUrl,
        }),
      });
      try {
        await service.finishOAuth(row.name, code);
      } finally {
        await service.close();
      }
      await store.clearOAuthChallenge(userRef, row.id);
      await deps.runtimes?.refreshMcpServers(toUserContext(user, deps.config));
      return c.redirect("/connectors");
    } catch (error) {
      logger.error({ error, userId: user.id }, "Failed to finish MCP OAuth");
      return c.json({ error: "Could not finish MCP OAuth." }, 502);
    }
  });

  app.patch("/mcp-servers/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const id = c.req.param("id");
    const body = mcpServerUpdateSchema.parse(await c.req.json());
    if (body.authMode === "oauth" && body.url) {
      const oauthError = getUnsupportedMcpOAuthMessage(body.url);
      if (oauthError) {
        return c.json({ error: oauthError }, 400);
      }
    }

    try {
      const userRef = toConnectorUser(user);
      const store = createMcpStore(deps);
      const current = await store.getForUser(userRef, id);
      if (!current) {
        return c.json({ error: "MCP server not found." }, 404);
      }

      const nextAuthMode = body.authMode ?? getMcpAuthModeFromMetadata(current.metadata) ?? "none";
      const currentAuth = nextAuthMode === "api_key" ? await store.getAuthHeader(userRef, id) : undefined;
      if (nextAuthMode === "api_key" && (body.url || body.authMode === "api_key")) {
        const authError = validateMcpAuthInput({
          authMode: "api_key",
          authHeaderName: body.authHeaderName ?? currentAuth?.name,
          authHeaderValue: body.authHeaderValue ?? currentAuth?.value,
          authToken: body.authToken,
        });
        if (authError) {
          return c.json({ error: authError }, 400);
        }
      }
      const transport = body.url
        ? await detectRemoteMcpTransport({
            name: body.name ?? current.name,
            description: body.description ?? current.description ?? undefined,
            url: body.url,
            auth: nextAuthMode === "api_key"
              ? {
                  headerName: body.authHeaderName ?? currentAuth?.name,
                  headerValue: body.authHeaderValue ?? currentAuth?.value,
                  legacyToken: body.authToken,
                }
              : undefined,
            alwaysOn: body.alwaysOn ?? current.alwaysOn,
          })
        : undefined;

      const updated = await store.updateForUser(userRef, id, {
        name: body.name,
        description: body.description,
        transport,
        alwaysOn: body.alwaysOn,
        active: body.active,
        metadata: buildMcpMetadata(current.metadata, nextAuthMode),
      });
      if (nextAuthMode === "api_key") {
        if (body.authHeaderName || body.authHeaderValue) {
          await store.saveAuthHeader(userRef, id, {
            name: body.authHeaderName ?? (await store.getAuthHeader(userRef, id)).name,
            value: body.authHeaderValue ?? (await store.getAuthHeader(userRef, id)).value,
          });
        } else if (body.authToken !== undefined) {
          await store.saveAuthToken(userRef, id, body.authToken);
        }
        await store.clearOAuthState(userRef, id);
      } else if (nextAuthMode === "oauth") {
        await store.saveAuthToken(userRef, id, undefined);
        await store.saveAuthHeader(userRef, id, undefined);
      } else {
        await store.saveAuthToken(userRef, id, undefined);
        await store.saveAuthHeader(userRef, id, undefined);
        await store.clearOAuthState(userRef, id);
      }

      await deps.runtimes?.refreshMcpServers(toUserContext(user, deps.config));
      return c.json({ server: serializeMcpServer(updated ?? current) });
    } catch (error) {
      const authMode = body.authMode ?? "none";
      logger.error({ error, userId: user.id, mcpServerId: id, authMode }, "Failed to update MCP server");
      return c.json({ error: formatMcpSetupError(error, authMode) }, 502);
    }
  });

  app.delete("/mcp-servers/:id", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    try {
      const id = c.req.param("id");
      const store = createMcpStore(deps);
      const deleted = await store.deleteForUser(toConnectorUser(user), id);
      if (!deleted) {
        return c.json({ error: "MCP server not found." }, 404);
      }
      await deps.runtimes?.refreshMcpServers(toUserContext(user, deps.config));
      return c.json({ ok: true });
    } catch (error) {
      logger.error({ error, userId: user.id, mcpServerId: c.req.param("id") }, "Failed to delete MCP server");
      return c.json({ error: "Could not delete MCP server right now." }, 502);
    }
  });

  app.get("/connectors", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const query = connectorsQuerySchema.parse(c.req.query());
    const puterConfig = await getConnectorConfig(deps.db, toConnectorUser(user), puterToolkitSlug);
    const puterConnector = serializePuterConnector(
      puterConfig ?? undefined,
      deps.config.capabilities.integrations.memory,
      getPuterBridgeStatus(deps, user, puterConfig),
    );
    const puterConnectors = shouldPrependPuterConnector(query, puterConnector) ? [puterConnector] : [];

    if (!deps.composio) {
      return c.json({ connectors: puterConnectors, configured: true, nextCursor: null });
    }

    try {
      const composio = await getWebComposioService(deps, user);
      if (!composio) {
        return c.json({ error: "Composio is not configured." }, 503);
      }
      const result = await deps.composio.getToolkits(composio.composioUserId, {
        limit: query.limit,
        cursor: query.cursor,
        search: query.search,
        ...(deps.connectorCatalog ? { includeMetadata: false } : {}),
      });
      const catalogConnectors = await decorateConnectorCatalog(deps, result.connectors);
      const toolkitNames = new Map(catalogConnectors.map((connector) => [connector.slug, connector.name]));
      const configs = await composio.reconcileConnectorConfigs({ toolkitNames, origin: "system" });
      const configByToolkit = new Map(configs.map((config) => [config.toolkitSlug, config]));
      const connectors = catalogConnectors.map((connector) => {
        const view = composio.mergeConnectorCatalog(connector, configByToolkit.get(connector.slug));
        return {
          ...view,
          config: serializeConnectorConfig(view.config ?? undefined, deps.config.capabilities.integrations.memory),
        };
      }).filter((connector) => {
        if (query.connected === "true") {
          return connector.connected;
        }
        if (query.connected === "false") {
          return !connector.connected;
        }
        return true;
      });
      return c.json({
        ...result,
        connectors: [
          ...puterConnectors,
          ...connectors,
        ],
        configured: true,
      });
    } catch (error) {
      logger.error({ error, userId: user.id }, "Failed to load web connectors");
      return c.json({ error: "Could not load connectors right now." }, 502);
    }
  });

  app.post("/connectors/authorize", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }

    const body = authorizeConnectorSchema.parse(await c.req.json());
    if (!isComposioManagedConnectorSlug(body.slug)) {
      return c.json({ error: "Puter is managed by Finn Puter setup, not Composio." }, 400);
    }
    if (deps.composio.getAllowedToolkits()?.includes(body.slug) === false) {
      return c.json({ error: "Connector is not enabled for this project." }, 403);
    }

    const composio = await getWebComposioService(deps, user);
    if (!composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    const existing = await getConnectorConfig(deps.db, toConnectorUser(user), body.slug);
    await upsertConnectorConfig(deps.db, {
      tenantId: user.tenantId,
      userId: user.id,
      toolkitSlug: body.slug,
      toolkitName: existing?.toolkitName ?? undefined,
      connected: existing?.connected ?? false,
      connectedAccountId: existing?.connectedAccountId,
      connectionStatus: existing?.connectionStatus,
      permissionMode: normalizeConnectorPermissionMode(existing?.permissionMode),
      myDayEnabled: existing?.myDayEnabled,
      personalIntelligenceEnabled: existing?.personalIntelligenceEnabled,
      lastNotifiedConnectedAccountId: existing?.lastNotifiedConnectedAccountId,
    });
    const redirectUrl = await composio.createConnectionLink(
      body.slug,
      composioConnectorCallbackUrl(deps, body.slug, existing?.connectedAccountId, body.returnTo),
    );
    return c.json({ redirectUrl });
  });

  app.post("/connectors/notify", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }

    const body = notifyConnectorSchema.parse(await c.req.json());
    if (!isComposioManagedConnectorSlug(body.slug)) {
      return c.json({ error: "Puter is managed by Finn Puter setup, not Composio." }, 400);
    }
    if (deps.composio.getAllowedToolkits()?.includes(body.slug) === false) {
      return c.json({ error: "Connector is not enabled for this project." }, 403);
    }

    try {
      const composio = await getWebComposioService(deps, user);
      if (!composio) {
        return c.json({ error: "Composio is not configured." }, 503);
      }
      const { connector: config, rehydratedPatterns } = await composio.finalizeConnection({
        toolkitSlug: body.slug,
        previousConnectedAccountId: body.previousConnectedAccountId,
        origin: "web",
      });
      if (!config?.connectedAccountId) {
        return c.json({ notified: false, reason: "Connector is not connected." }, 409);
      }

      const alreadyNotified = config.lastNotifiedConnectedAccountId === config.connectedAccountId;
      const replacedAccount = Boolean(body.previousConnectedAccountId && body.previousConnectedAccountId !== config.connectedAccountId);

      await upsertConnectorConfig(deps.db, {
        tenantId: user.tenantId,
        userId: user.id,
        toolkitSlug: config.toolkitSlug,
        toolkitName: config.toolkitName ?? undefined,
        connected: true,
        connectedAccountId: config.connectedAccountId,
        connectionStatus: config.connectionStatus,
        permissionMode: normalizeConnectorPermissionMode(config.permissionMode),
        myDayEnabled: config.myDayEnabled,
        personalIntelligenceEnabled: config.personalIntelligenceEnabled,
        lastNotifiedConnectedAccountId: alreadyNotified ? config.lastNotifiedConnectedAccountId : config.connectedAccountId,
      });

      return c.json({
        notified: !alreadyNotified || replacedAccount || rehydratedPatterns.length > 0,
        connector: {
          slug: config.toolkitSlug,
          name: config.toolkitName ?? config.toolkitSlug,
          connected: config.connected,
          connectedAccountId: config.connectedAccountId ?? undefined,
          connectionStatus: config.connectionStatus ?? undefined,
          config: serializeConnectorConfig(config, deps.config.capabilities.integrations.memory),
        },
      });
    } catch (error) {
      logger.error({ error, userId: user.id, toolkitSlug: body.slug }, "Failed to notify connector enablement");
      return c.json({ error: "Could not notify Finn about this connector." }, 502);
    }
  });

  app.get("/connectors/oauth/callback", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return c.redirect("/connectors");
    }

    if (!deps.composio) {
      return c.redirect("/connectors");
    }

    const parsed = notifyConnectorSchema.safeParse({
      slug: c.req.query("slug"),
      previousConnectedAccountId: c.req.query("previousConnectedAccountId") || undefined,
      returnTo: c.req.query("returnTo") || undefined,
    });
    if (!parsed.success || !isComposioManagedConnectorSlug(parsed.data.slug)) {
      return c.redirect("/connectors");
    }

    try {
      const composio = await getWebComposioService(deps, user);
      const { connector: config } = composio
        ? await composio.finalizeConnection({
            toolkitSlug: parsed.data.slug,
            previousConnectedAccountId: parsed.data.previousConnectedAccountId,
            connectedAccountId: c.req.query("connected_account_id") || c.req.query("connectedAccountId") || undefined,
            origin: "web",
          })
        : { connector: null };
      if (config?.connectedAccountId) {
        await upsertConnectorConfig(deps.db, {
          tenantId: user.tenantId,
          userId: user.id,
          toolkitSlug: config.toolkitSlug,
          toolkitName: config.toolkitName ?? undefined,
          connected: true,
          connectedAccountId: config.connectedAccountId,
          connectionStatus: config.connectionStatus,
          permissionMode: normalizeConnectorPermissionMode(config.permissionMode),
          myDayEnabled: config.myDayEnabled,
          personalIntelligenceEnabled: config.personalIntelligenceEnabled,
          lastNotifiedConnectedAccountId: config.connectedAccountId,
        });
      }
    } catch (error) {
      logger.error({ error, userId: user.id, toolkitSlug: parsed.data.slug }, "Failed to finalize connector auth callback");
    }

    return c.redirect(parsed.data.returnTo === "onboarding" ? "/onboarding" : "/connectors");
  });

  app.get("/connectors/:slug", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const slug = c.req.param("slug");
    if (slug === puterToolkitSlug) {
      const config = await getConnectorConfig(deps.db, toConnectorUser(user), puterToolkitSlug);
      return c.json({
        connector: serializePuterConnector(
          config ?? undefined,
          deps.config.capabilities.integrations.memory,
          getPuterBridgeStatus(deps, user, config),
        ),
      });
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }

    if (deps.composio.getAllowedToolkits()?.includes(slug) === false) {
      return c.json({ error: "Connector is not enabled for this project." }, 403);
    }

    const composio = await getWebComposioService(deps, user);
    if (!composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    const [toolkitPage, syncedConfig] = await Promise.all([
      deps.composio.getToolkits(composio.composioUserId, {
        limit: 1,
        toolkits: [slug],
        ...(deps.connectorCatalog ? { includeMetadata: false } : {}),
      }),
      composio.getConnectorConfig(slug),
    ]);
    const catalogConnectors = await decorateConnectorCatalog(deps, toolkitPage.connectors);
    const connector = catalogConnectors.find((item) => item.slug === slug);
    if (!connector) {
      return c.json({ error: "Connector not found." }, 404);
    }

    const config = syncedConfig ?? await getConnectorConfig(deps.db, toConnectorUser(user), slug);
    const view = composio.mergeConnectorCatalog(connector, config);
    return c.json({
      connector: {
        ...view,
        config: serializeConnectorConfig(view.config ?? undefined, deps.config.capabilities.integrations.memory),
      },
    });
  });

  app.patch("/connectors/:slug/config", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const slug = c.req.param("slug");
    const body = connectorConfigSchema.parse(await c.req.json());
    if (slug === puterToolkitSlug) {
      const puterPatch = body.puter ?? {};
      const userContext = toUserContext(user, deps.config);
      const sourceSettingsChanged = changesPuterSourceSettings(puterPatch);
      if (sourceSettingsChanged) {
        const existing = await getConnectorConfig(deps.db, toConnectorUser(user), puterToolkitSlug);
        const deviceId = puterPatch.deviceId?.trim() || puterDeviceIdFromConnectedAccount(existing?.connectedAccountId);
        const bridgeStatus = deviceId ? deps.puterBridge?.getStatus(userContext, deviceId) : undefined;
        if (!deviceId || !existing?.connected || !existing.connectedAccountId) {
          return c.json({ error: "Set up Finn Puter on your Mac before changing local source settings." }, 409);
        }
        if (bridgeStatus?.active !== true) {
          return c.json({ error: "Open Finn Puter on your Mac before changing local source settings." }, 409);
        }
        for (const source of puterSourcesRequestedForEnable(puterPatch)) {
          const availability = getPuterSourceAvailability(bridgeStatus.access ?? undefined, source);
          if (!availability.available) {
            return c.json({ error: availability.message }, 409);
          }
        }
      }

      const updated = await upsertPuterConnectorConfig(deps.db, user, puterPatch);
      const deviceId = puterDeviceIdFromConnectedAccount(updated.connectedAccountId);
      const bridgeStatus = getPuterBridgeStatus(deps, user, updated);
      const serializedConfig = serializeConnectorConfig(updated, deps.config.capabilities.integrations.memory, bridgeStatus);
      if (deviceId) {
        const sent = deps.puterBridge?.sendConfigUpdate(userContext, deviceId, serializedConfig) ?? false;
        if (!sent) {
          logger.warn({ userId: user.id, deviceId }, "Finn Puter config changed without an active Mac socket to notify");
        } else {
          logger.info({ userId: user.id, deviceId }, "Sent Finn Puter config update to Mac");
        }
      }
      if (enablesPuterPersonalIntelligence(puterPatch)) {
        if (deviceId && bridgeStatus?.active) {
          void deps.personalIntelligenceService?.ingestPuterLive(userContext, { deviceId }).catch((error: unknown) => {
            logger.warn({ error, userId: user.id, deviceId }, "Puter personal intelligence enable ingestion failed");
          });
        }
      }
      return c.json({
        config: serializedConfig,
        connector: serializePuterConnector(
          updated,
          deps.config.capabilities.integrations.memory,
          bridgeStatus,
        ),
      });
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    if (isPrimaryComposioConnectorSlug(slug) && (body.myDayEnabled === false || body.personalIntelligenceEnabled === false)) {
      return c.json({ error: "My Day and Personal Intelligence stay enabled for primary connectors." }, 409);
    }

    const composio = await getWebComposioService(deps, user);
    if (!composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    const updated = await composio.applyConnectorConfig(slug, {
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
      ...(body.myDayEnabled !== undefined ? { myDayEnabled: body.myDayEnabled } : {}),
      ...(body.personalIntelligenceEnabled !== undefined ? { personalIntelligenceEnabled: body.personalIntelligenceEnabled } : {}),
    }).catch((error: unknown) => {
      if (body.personalIntelligenceEnabled === true) {
        throw new HTTPException(409, { message: getErrorMessage(error) });
      }
      throw error;
    });
    if (!updated) {
      return c.json({ error: "Connector is not connected." }, 409);
    }

    if (body.personalIntelligenceEnabled === true) {
      void deps.personalIntelligenceService?.ingestUser(toUserContext(user, deps.config), { toolkitSlug: slug }).catch((error: unknown) => {
        logger.warn({ error, userId: user.id, toolkitSlug: slug }, "Personal intelligence connector enable ingestion failed");
      });
    }

    return c.json({
      config: serializeConnectorConfig(updated, deps.config.capabilities.integrations.memory),
    });
  });

  app.post("/puter/socket-token", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }
    if (!deps.puterBridge) {
      return c.json({ error: "Puter bridge is not configured." }, 503);
    }

    const body = puterDeviceSchema.parse(await c.req.json());
    await ensurePuterDeviceConnector(deps, user, body.deviceId);

    logger.info({ userId: user.id, deviceId: body.deviceId }, "Issuing Finn Puter socket token");
    const token = deps.puterBridge.createSocketToken(toUserContext(user, deps.config), body.deviceId);
    return c.json(token);
  });

  if (deps.upgradeWebSocket) {
    app.get("/puter/socket", deps.upgradeWebSocket((c) => {
      const token = c.req.query("token");
      let user: UserContext | null = null;
      let deviceId: string | null = null;
      let socketRef: WSContext | null = null;
      let bridgeSocket: { send(data: string): void; close(code?: number, reason?: string): void } | null = null;

      return {
        onOpen: (_event, ws) => {
          socketRef = ws;
          if (!token || !deps.puterBridge) {
            ws.close(4001, "Missing Puter socket token.");
            return;
          }

          bridgeSocket = {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          };
          const connection = deps.puterBridge.connectSocket(token, bridgeSocket);
          if (!connection) {
            ws.close(4001, "Invalid or expired Puter socket token.");
            return;
          }

          user = connection.user;
          deviceId = connection.deviceId;
          ws.send(JSON.stringify({ type: "ready" }));
          void sendPuterConnectorConfigSnapshot(deps, connection.user, connection.deviceId).then((sent) => {
            if (!sent) {
              logger.warn(
                {
                  tenantId: connection.user.tenantId,
                  userId: connection.user.userId,
                  deviceId: connection.deviceId,
                },
                "Finn Puter socket connected without receiving initial config snapshot",
              );
            }
          }).catch((error: unknown) => {
            logger.warn(
              {
                error,
                tenantId: connection.user.tenantId,
                userId: connection.user.userId,
                deviceId: connection.deviceId,
              },
              "Failed to send Finn Puter connector config snapshot",
            );
          });
        },
        onMessage: (event) => {
          if (!user || !deviceId || !deps.puterBridge || typeof event.data !== "string") {
            return;
          }
          const messageType = getPuterSocketMessageType(event.data);
          deps.puterBridge.handleSocketMessage(user, deviceId, event.data);
          if (messageType === "config_request" && bridgeSocket) {
            void sendPuterConnectorConfigSnapshot(deps, user, deviceId).then((sent) => {
              if (!sent) {
                logger.warn({ tenantId: user?.tenantId, userId: user?.userId, deviceId }, "Finn Puter config sync request had no active Mac socket");
              }
            }).catch((error: unknown) => {
              logger.warn({ error, tenantId: user?.tenantId, userId: user?.userId, deviceId }, "Failed to answer Finn Puter config sync request");
            });
          }
        },
        onClose: () => {
          if (user && deviceId && bridgeSocket && deps.puterBridge) {
            deps.puterBridge.disconnectSocket(user, deviceId, bridgeSocket);
          }
        },
        onError: () => {
          if (user && deviceId && bridgeSocket && deps.puterBridge) {
            deps.puterBridge.disconnectSocket(user, deviceId, bridgeSocket);
          }
        },
      };
    }));
  }

  app.get("/connectors/:slug/disconnect-impact", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    const slug = c.req.param("slug");
    if (!isComposioManagedConnectorSlug(slug)) {
      return c.json({ error: "Puter is managed by Finn Puter setup, not Composio." }, 400);
    }

    const composio = await getWebComposioService(deps, user);
    const config = composio
      ? await composio.getConnectorConfig(slug)
      : await getConnectorConfig(deps.db, toConnectorUser(user), slug);
    const userPatternStore = await getWebPatternStore(deps, toUserContext(user, deps.config));
    const impact = await getComposioConnectorDisconnectImpact(userPatternStore, {
      toolkitSlug: slug,
      toolkitName: config?.toolkitName ?? undefined,
      connectedAccountId: config?.connectedAccountId,
    });
    return c.json({ impact });
  });

  app.post("/connectors/:slug/reconnect", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }

    const slug = c.req.param("slug");
    if (!isComposioManagedConnectorSlug(slug)) {
      return c.json({ error: "Puter is managed by Finn Puter setup, not Composio." }, 400);
    }
    if (deps.composio.getAllowedToolkits()?.includes(slug) === false) {
      return c.json({ error: "Connector is not enabled for this project." }, 403);
    }
    const bodyText = await c.req.text();
    let previousConnectedAccountId: string | undefined;
    if (bodyText.trim()) {
      try {
        previousConnectedAccountId = reconnectConnectorSchema.parse(JSON.parse(bodyText)).previousConnectedAccountId;
      } catch {
        return c.json({ error: "Invalid reconnect request." }, 400);
      }
    }
    const composio = await getWebComposioService(deps, user);
    if (!composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    const config = await getConnectorConfig(deps.db, toConnectorUser(user), slug);

    const redirectUrl = await composio.createConnectionLink(
      slug,
      composioConnectorCallbackUrl(deps, slug, previousConnectedAccountId ?? config?.connectedAccountId),
    );
    return c.json({ redirectUrl });
  });

  app.delete("/connectors/:slug", async (c) => {
    const user = await requireSessionUser(c, deps);
    if (user instanceof Response) {
      return user;
    }

    if (!deps.composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }

    const slug = c.req.param("slug");
    if (!isComposioManagedConnectorSlug(slug)) {
      return c.json({ error: "Puter is managed by Finn Puter setup, not Composio." }, 400);
    }
    if (isPrimaryComposioConnectorSlug(slug)) {
      return c.json({ error: "Primary connectors cannot be disconnected." }, 409);
    }
    const composio = await getWebComposioService(deps, user);
    if (!composio) {
      return c.json({ error: "Composio is not configured." }, 503);
    }
    const config = await composio.disconnectConnector(slug, { origin: "web" });

    return c.json({
      ok: true,
      connector: {
        slug: config.toolkitSlug,
        name: config.toolkitName ?? config.toolkitSlug,
        connected: false,
        connectedAccountId: config.connectedAccountId ?? undefined,
        connectionStatus: config.connectionStatus ?? undefined,
        config: serializeConnectorConfig(config, deps.config.capabilities.integrations.memory),
      },
    });
  });

  return app;
}
