import { createLogger, formatComposioUserId, type EventBus, type PatternRecord, type UserContext } from "@finn/core";
import type { Database, StoredPersonalIntelligenceAccount, UserConnectorConfig } from "@finn/db";
import type {
  ComposioClient,
  ComposioConfiguredToolkit,
  ComposioConnectedAccountSummary,
  ComposioToolkitSummary,
  ComposioTriggerCreateParams,
  ComposioTriggerCreateResult,
  ComposioTriggerTypeSummary,
} from "@finn/integrations";
import { createComposioSessionConfig } from "@finn/integrations";
import type { ComposioRuntimeService } from "@finn/runtime";
import type { PatternStore } from "@finn/patterns";
import type { ToolSet } from "ai";
import { getEnabledAutomationConnectors } from "./automation-sources.js";
import {
  getComposioPersonalIntelligenceToolkitDefinition,
  isComposioPersonalIntelligenceToolkitSupported,
  resolveComposioPersonalIntelligenceIdentity,
} from "./composio-personal-intelligence.js";
import { pausePatternsForComposioConnector, rehydratePatternsForComposioConnector } from "./composio-pattern-lifecycle.js";
import {
  getConnectorConfig,
  isPrimaryComposioConnectorSlug,
  listConnectorConfigs,
  normalizeConnectorPermissionMode,
  upsertConnectorConfig,
} from "./connector-config.js";
import { filterComposioConnectorConfigs, isComposioManagedConnectorSlug } from "./connector-ownership.js";
import { PersonalIntelligenceAccountStore, type PersonalIntelligenceIdentityStatus } from "./personal-intelligence-account-store.js";

const disconnectingStatus = "disconnecting";
const logger = createLogger("user-composio-service");

type ConnectorLifecycleOrigin = "web" | "system";

interface UserComposioServiceDeps {
  db: Database;
  user: UserContext;
  composio: ComposioClient;
  patternStore: PatternStore;
  eventBus?: EventBus;
}

export interface ConnectorCatalogView {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  requiresAuth: boolean;
  connected: boolean;
  enabled: boolean;
  connectionStatus?: string;
  connectedAccountId?: string;
  config: UserConnectorConfig | null;
}

type PersonalIntelligenceAccountView = {
  toolkitSlug: string;
  accountScopeId: string;
  displayName?: string;
  email?: string;
  handle?: string;
  providerWorkspaceId?: string;
  providerWorkspaceName?: string;
  verifiedAt?: string;
};

type EnrichedConnectorConfig = UserConnectorConfig & {
  personalIntelligenceIdentityStatus?: PersonalIntelligenceIdentityStatus;
  personalIntelligenceAccountScopeId?: string | null;
  personalIntelligenceAccount?: PersonalIntelligenceAccountView | null;
};

type StoredPersonalIntelligenceAccountLike = Pick<
  StoredPersonalIntelligenceAccount,
  | "toolkitSlug"
  | "accountScopeId"
  | "currentConnectedAccountId"
  | "identityStatus"
  | "displayName"
  | "email"
  | "handle"
  | "providerWorkspaceId"
  | "metadata"
  | "verifiedAt"
> | {
  toolkitSlug: string;
  accountScopeId: string | null;
  currentConnectedAccountId: string | null;
  identityStatus: PersonalIntelligenceIdentityStatus;
  displayName?: string | null;
  email?: string | null;
  handle?: string | null;
  providerWorkspaceId?: string | null;
  metadata?: Record<string, unknown> | null;
  verifiedAt?: Date | null;
};

export class UserComposioService implements ComposioRuntimeService {
  readonly kind = "finn-composio-runtime" as const;
  readonly composioUserId: string;

  constructor(private readonly deps: UserComposioServiceDeps) {
    this.composioUserId = formatComposioUserId(deps.user);
  }

  getAllowedToolkits(): string[] | undefined {
    return this.deps.composio.getAllowedToolkits();
  }

  async createConnectionLink(toolkitSlug: string, callbackUrl?: string): Promise<string> {
    this.assertToolkitAllowed(toolkitSlug);
    return this.deps.composio.authorizeToolkit(this.composioUserId, toolkitSlug, callbackUrl);
  }

  async listTriggerTypes(toolkitSlug?: string): Promise<ComposioTriggerTypeSummary[]> {
    return this.deps.composio.listTriggerTypes(toolkitSlug);
  }

  async getTriggerType(triggerSlug: string): Promise<ComposioTriggerTypeSummary> {
    return this.deps.composio.getTriggerType(triggerSlug);
  }

  async createTrigger(triggerSlug: string, body: ComposioTriggerCreateParams): Promise<ComposioTriggerCreateResult> {
    return this.deps.composio.createTrigger(this.composioUserId, triggerSlug, body);
  }

  async enableTrigger(triggerId: string): Promise<void> {
    await this.deps.composio.enableTrigger(triggerId);
  }

  async disableTrigger(triggerId: string): Promise<void> {
    await this.deps.composio.disableTrigger(triggerId);
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.deps.composio.deleteTrigger(triggerId);
  }

  async getConnectorConfig(toolkitSlug: string): Promise<UserConnectorConfig | null> {
    if (!isComposioManagedConnectorSlug(toolkitSlug)) {
      return null;
    }
    const [config] = await this.reconcileConnectorConfigs({ toolkitSlugs: [toolkitSlug], origin: "system" });
    return config ?? await this.decorateConnectorConfigWithPersonalIntelligenceAccount(await getConnectorConfig(this.deps.db, this.deps.user, toolkitSlug));
  }

  async listConnectorConfigs(): Promise<UserConnectorConfig[]> {
    return this.reconcileConnectorConfigs({ origin: "system" });
  }

  async listConfiguredToolkits(options: {
    feature?: "my_day" | "personal_intelligence";
    toolkitSlugs?: string[];
    permissionMode?: "read_only" | "all";
  } = {}): Promise<ComposioConfiguredToolkit[]> {
    const configs = await this.reconcileConnectorConfigs({
      toolkitSlugs: options.toolkitSlugs,
      origin: "system",
    });
    const featureConfigs = options.feature
      ? getEnabledAutomationConnectors({ configs, feature: options.feature })
      : configs.filter((config) => config.connected && Boolean(config.connectedAccountId));

    return featureConfigs
      .filter((config) => Boolean(config.connectedAccountId))
      .map((config) => ({
        slug: config.toolkitSlug,
        connectedAccountId: config.connectedAccountId!,
        permissionMode: options.permissionMode ?? normalizeConnectorPermissionMode(config.permissionMode),
      }));
  }

  async getToolsForConfiguredToolkits(
    configuredToolkits: ComposioConfiguredToolkit[],
    options: {
      allowConnectionRequests?: boolean;
      callbackUrl?: string;
    } = {},
  ): Promise<ToolSet> {
    if (configuredToolkits.length === 0) {
      return {};
    }

    return this.deps.composio.getTools({
      userId: this.composioUserId,
      sessionConfig: createComposioSessionConfig({
        allowConnectionRequests: options.allowConnectionRequests ?? false,
        callbackUrl: options.callbackUrl,
        configuredToolkits,
      }),
    });
  }

  async listConfiguredConnectorConfigs(options: {
    feature?: "my_day" | "personal_intelligence";
    toolkitSlugs?: string[];
  } = {}): Promise<UserConnectorConfig[]> {
    const configs = await this.reconcileConnectorConfigs({
      toolkitSlugs: options.toolkitSlugs,
      origin: "system",
    });
    if (!options.feature) {
      return configs.filter((config) => config.connected && Boolean(config.connectedAccountId));
    }
    return getEnabledAutomationConnectors({ configs, feature: options.feature });
  }

  async reconcileConnectorConfigs(options: {
    toolkitSlugs?: string[];
    toolkitNames?: ReadonlyMap<string, string>;
    origin?: ConnectorLifecycleOrigin;
  } = {}): Promise<UserConnectorConfig[]> {
    const requestedSlugs = options.toolkitSlugs;
    const scopedSlugs = requestedSlugs?.filter(isComposioManagedConnectorSlug);
    if (requestedSlugs && scopedSlugs?.length === 0) {
      return [];
    }

    const liveAccounts = await this.listActiveAccounts(scopedSlugs);
    const liveByToolkit = groupAccountsByToolkit(liveAccounts);
    const existingConfigs = filterComposioConnectorConfigs(await listConnectorConfigs(this.deps.db, this.deps.user));
    const existingByToolkit = new Map(existingConfigs.map((config) => [config.toolkitSlug, config]));
    const slugsToReconcile = new Set<string>(scopedSlugs ?? []);

    if (!requestedSlugs) {
      for (const config of existingConfigs) {
        slugsToReconcile.add(config.toolkitSlug);
      }
    }
    for (const slug of liveByToolkit.keys()) {
      slugsToReconcile.add(slug);
    }

    for (const toolkitSlug of slugsToReconcile) {
      const existing = existingByToolkit.get(toolkitSlug);
      const activeAccounts = liveByToolkit.get(toolkitSlug) ?? [];
      if (isDisconnectingConnector(existing) && activeAccounts.length > 0) {
        continue;
      }
      const selectedAccount = selectAccountForConfig(existing, activeAccounts);

      if (selectedAccount) {
        if (existing?.connectedAccountId && existing.connectedAccountId !== selectedAccount.id) {
          await this.rehydrateConnectorPatterns(toolkitSlug, selectedAccount.id, existing.connectedAccountId, options.origin ?? "system");
        }
        await this.upsertFromAccount(toolkitSlug, selectedAccount, {
          toolkitName: options.toolkitNames?.get(toolkitSlug) ?? existing?.toolkitName ?? undefined,
          existing,
        });
        continue;
      }

      if (!existing) {
        continue;
      }

      if (existing.connected || isDisconnectingConnector(existing)) {
        if (existing.connected) {
          await this.pauseConnectorPatterns(toolkitSlug, existing.connectedAccountId, "disconnected", options.origin ?? "system");
        }
        await upsertConnectorConfig(this.deps.db, {
          tenantId: this.deps.user.tenantId,
          userId: this.deps.user.userId,
          toolkitSlug,
          toolkitName: existing.toolkitName ?? undefined,
          connected: false,
          connectedAccountId: existing.connectedAccountId,
          connectionStatus: null,
          permissionMode: normalizeConnectorPermissionMode(existing.permissionMode),
          myDayEnabled: existing.myDayEnabled,
          personalIntelligenceEnabled: existing.personalIntelligenceEnabled,
          enabledTools: existing.enabledTools,
          lastNotifiedConnectedAccountId: existing.lastNotifiedConnectedAccountId,
        });
      }
    }

    const configs = await this.decorateConnectorConfigsWithPersonalIntelligenceAccounts(
      filterComposioConnectorConfigs(await listConnectorConfigs(this.deps.db, this.deps.user)),
    );
    return requestedSlugs
      ? configs.filter((config) => (scopedSlugs ?? []).includes(config.toolkitSlug))
      : configs;
  }

  async finalizeConnection(input: {
    toolkitSlug: string;
    connectedAccountId?: string | null;
    previousConnectedAccountId?: string | null;
    origin?: ConnectorLifecycleOrigin;
  }): Promise<{ connector: UserConnectorConfig | null; rehydratedPatterns: PatternRecord[] }> {
    this.assertToolkitAllowed(input.toolkitSlug);
    const activeAccounts = await this.listActiveAccounts([input.toolkitSlug]);
    const account = input.connectedAccountId
      ? activeAccounts.find((candidate) => candidate.id === input.connectedAccountId) ?? null
      : pickPrimaryAccount(activeAccounts);

    if (!account || account.toolkitSlug !== input.toolkitSlug || !isActiveAccount(account)) {
      return { connector: null, rehydratedPatterns: [] };
    }

    const existing = await getConnectorConfig(this.deps.db, this.deps.user, input.toolkitSlug);
    const previousConnectedAccountId = input.previousConnectedAccountId ?? existing?.connectedAccountId ?? null;
    const connector = await this.upsertFromAccount(input.toolkitSlug, account, {
      toolkitName: existing?.toolkitName ?? undefined,
      existing,
    });
    const rehydratedPatterns = await rehydratePatternsForComposioConnector({
      patternStore: this.deps.patternStore,
      composio: this.deps.composio,
      eventBus: this.deps.eventBus,
    }, {
      composioUserId: this.composioUserId,
      toolkitSlug: input.toolkitSlug,
      connectedAccountId: account.id,
      previousConnectedAccountId,
      origin: input.origin ?? "web",
    });

    return { connector, rehydratedPatterns };
  }

  async disconnectConnector(toolkitSlug: string, options: { origin?: ConnectorLifecycleOrigin } = {}): Promise<UserConnectorConfig> {
    this.assertToolkitAllowed(toolkitSlug);
    if (isPrimaryComposioConnectorSlug(toolkitSlug)) {
      throw new Error("Primary connectors cannot be disconnected.");
    }

    const existing = await getConnectorConfig(this.deps.db, this.deps.user, toolkitSlug);
    const activeAccounts = await this.listActiveAccounts([toolkitSlug]);
    const accountIds = [...new Set([
      ...activeAccounts.map((account) => account.id),
      ...(existing?.connectedAccountId ? [existing.connectedAccountId] : []),
    ])];

    if (accountIds.length > 0) {
      for (const connectedAccountId of accountIds) {
        await this.pauseConnectorPatterns(toolkitSlug, connectedAccountId, "disconnected", options.origin ?? "web");
      }
    } else {
      await this.pauseConnectorPatterns(toolkitSlug, null, "disconnected", options.origin ?? "web");
    }

    for (const account of activeAccounts) {
      try {
        await this.deps.composio.deleteConnectedAccount(account.id);
      } catch (error) {
        logger.error({
          error,
          tenantId: this.deps.user.tenantId,
          userId: this.deps.user.userId,
          toolkitSlug,
          connectedAccountId: account.id,
        }, "Failed to delete Composio connected account during disconnect");
      }
    }

    const rememberedAccountId = existing?.connectedAccountId ?? accountIds[0] ?? null;
    return upsertConnectorConfig(this.deps.db, {
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      toolkitSlug,
      toolkitName: existing?.toolkitName ?? undefined,
      connected: false,
      connectedAccountId: rememberedAccountId,
      connectionStatus: rememberedAccountId ? disconnectingStatus : null,
      permissionMode: normalizeConnectorPermissionMode(existing?.permissionMode),
      myDayEnabled: existing?.myDayEnabled,
      personalIntelligenceEnabled: existing?.personalIntelligenceEnabled,
      enabledTools: existing?.enabledTools,
      lastNotifiedConnectedAccountId: existing?.lastNotifiedConnectedAccountId,
    });
  }

  async applyConnectorConfig(toolkitSlug: string, patch: {
    permissionMode?: "read_only" | "all";
    myDayEnabled?: boolean;
    personalIntelligenceEnabled?: boolean;
  }): Promise<UserConnectorConfig | null> {
    const config = await this.getConnectorConfig(toolkitSlug);
    if (!config?.connected) {
      return null;
    }
    if (isPrimaryComposioConnectorSlug(toolkitSlug) && (patch.myDayEnabled === false || patch.personalIntelligenceEnabled === false)) {
      throw new Error("My Day and Personal Intelligence stay enabled for primary connectors.");
    }

    if (patch.personalIntelligenceEnabled === true) {
      const availability = await this.getPersonalIntelligenceAvailability(config);
      if (availability.status !== "resolved" || !availability.accountScopeId) {
        throw new Error("Personal Intelligence is not available for this connector until Finn verifies a stable account identity.");
      }
    }

    const updated = await upsertConnectorConfig(this.deps.db, {
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      toolkitSlug,
      toolkitName: config.toolkitName ?? undefined,
      connected: true,
      connectedAccountId: config.connectedAccountId,
      connectionStatus: config.connectionStatus,
      permissionMode: patch.permissionMode ?? config.permissionMode,
      myDayEnabled: patch.myDayEnabled ?? config.myDayEnabled,
      personalIntelligenceEnabled: patch.personalIntelligenceEnabled ?? config.personalIntelligenceEnabled,
      enabledTools: config.enabledTools,
      lastNotifiedConnectedAccountId: config.lastNotifiedConnectedAccountId,
    });
    return this.decorateConnectorConfigWithPersonalIntelligenceAccount(updated);
  }

  mergeConnectorCatalog(connector: ComposioToolkitSummary, config: UserConnectorConfig | null | undefined): ConnectorCatalogView {
    return {
      ...connector,
      connected: config?.connected ?? false,
      connectedAccountId: config?.connectedAccountId ?? undefined,
      connectionStatus: config?.connectionStatus ?? undefined,
      config: config ?? null,
    };
  }

  private async listActiveAccounts(toolkitSlugs?: string[]): Promise<ComposioConnectedAccountSummary[]> {
    const accounts = await this.deps.composio.listConnectedAccounts(this.composioUserId, {
      toolkitSlugs,
      statuses: ["ACTIVE"],
    });
    return accounts.filter(isActiveAccount);
  }

  private async upsertFromAccount(
    toolkitSlug: string,
    account: ComposioConnectedAccountSummary,
    options: {
      toolkitName?: string;
      existing?: UserConnectorConfig | null;
      lastNotifiedConnectedAccountId?: string | null;
    } = {},
  ): Promise<UserConnectorConfig> {
    let config = await upsertConnectorConfig(this.deps.db, {
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      toolkitSlug,
      toolkitName: options.toolkitName ?? options.existing?.toolkitName ?? undefined,
      connected: true,
      connectedAccountId: account.id,
      connectionStatus: account.status,
      permissionMode: normalizeConnectorPermissionMode(options.existing?.permissionMode),
      myDayEnabled: options.existing?.myDayEnabled,
      personalIntelligenceEnabled: options.existing?.personalIntelligenceEnabled,
      enabledTools: options.existing?.enabledTools,
      lastNotifiedConnectedAccountId: options.lastNotifiedConnectedAccountId !== undefined
        ? options.lastNotifiedConnectedAccountId
        : options.existing?.lastNotifiedConnectedAccountId,
    });

    const accountIdentity = await this.resolveOrUpdatePersonalIntelligenceAccount(toolkitSlug, account, config);
    if (!isPrimaryComposioConnectorSlug(config.toolkitSlug) && config.personalIntelligenceEnabled && accountIdentity.identityStatus !== "resolved") {
      config = await upsertConnectorConfig(this.deps.db, {
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        toolkitSlug,
        toolkitName: config.toolkitName ?? undefined,
        connected: true,
        connectedAccountId: config.connectedAccountId,
        connectionStatus: config.connectionStatus,
        permissionMode: normalizeConnectorPermissionMode(config.permissionMode),
        myDayEnabled: config.myDayEnabled,
        personalIntelligenceEnabled: false,
        enabledTools: config.enabledTools,
        lastNotifiedConnectedAccountId: config.lastNotifiedConnectedAccountId,
      });
    }

    return this.decorateConnectorConfig(config, accountIdentity);
  }

  private async getPersonalIntelligenceAvailability(config: UserConnectorConfig): Promise<{
    status: PersonalIntelligenceIdentityStatus;
    accountScopeId: string | null;
  }> {
    if (!config.connectedAccountId || !isComposioPersonalIntelligenceToolkitSupported(config.toolkitSlug)) {
      return { status: "unsupported", accountScopeId: null };
    }
    const account = await new PersonalIntelligenceAccountStore({ db: this.deps.db, user: this.deps.user })
      .getByCurrentConnectedAccount(config.toolkitSlug, config.connectedAccountId);
    if (account?.identityStatus === "resolved") {
      return { status: "resolved", accountScopeId: account.accountScopeId };
    }
    return { status: account?.identityStatus ?? "pending", accountScopeId: null };
  }

  private async resolveOrUpdatePersonalIntelligenceAccount(
    toolkitSlug: string,
    account: ComposioConnectedAccountSummary,
    config: UserConnectorConfig,
  ): Promise<StoredPersonalIntelligenceAccountLike> {
    const normalizedToolkitSlug = toolkitSlug.trim().toLowerCase();
    const store = new PersonalIntelligenceAccountStore({ db: this.deps.db, user: this.deps.user });
    if (!isComposioPersonalIntelligenceToolkitSupported(normalizedToolkitSlug)) {
      logger.info({
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        toolkitSlug: normalizedToolkitSlug,
      }, "Composio connector is not Personal Intelligence eligible");
      return {
        toolkitSlug: normalizedToolkitSlug,
        accountScopeId: null,
        identityStatus: "unsupported",
        currentConnectedAccountId: account.id,
      };
    }

    const existingAccount = await store.getByCurrentConnectedAccount(normalizedToolkitSlug, account.id);
    if (existingAccount?.identityStatus === "resolved") {
      return existingAccount;
    }

    if (typeof this.deps.composio.executeToolForConnectedAccount !== "function") {
      return await store.upsert({
        toolkitSlug: normalizedToolkitSlug,
        accountScopeId: pendingPersonalIntelligenceAccountScopeId(account.id),
        providerAccountType: "composio_connected_account",
        providerAccountId: account.id,
        currentConnectedAccountId: account.id,
        identityStatus: "pending",
        displayName: config.toolkitName ?? getComposioPersonalIntelligenceToolkitDefinition(normalizedToolkitSlug)?.displayName ?? normalizedToolkitSlug,
        metadata: { reason: "resolver_unavailable" },
      });
    }

    logger.info({
      tenantId: this.deps.user.tenantId,
      userId: this.deps.user.userId,
      toolkitSlug: normalizedToolkitSlug,
      connectedAccountId: account.id,
    }, "Resolving Composio Personal Intelligence account identity");
    try {
      const resolved = await resolveComposioPersonalIntelligenceIdentity({
        composio: this.deps.composio,
        composioUserId: this.composioUserId,
        toolkitSlug: normalizedToolkitSlug,
        connectedAccountId: account.id,
      });
      const stored = await store.upsert(resolved);
      logger.info({
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        toolkitSlug: normalizedToolkitSlug,
        accountScopeId: stored.accountScopeId,
        connectedAccountId: account.id,
      }, "Resolved Composio Personal Intelligence account identity");
      return stored;
    } catch (error) {
      const failed = await store.upsert({
        toolkitSlug: normalizedToolkitSlug,
        accountScopeId: failedPersonalIntelligenceAccountScopeId(account.id),
        providerAccountType: "composio_connected_account",
        providerAccountId: account.id,
        currentConnectedAccountId: account.id,
        identityStatus: "failed",
        displayName: config.toolkitName ?? getComposioPersonalIntelligenceToolkitDefinition(normalizedToolkitSlug)?.displayName ?? normalizedToolkitSlug,
        metadata: { failureReason: getErrorMessage(error).slice(0, 500) },
      });
      logger.warn({
        error,
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        toolkitSlug: normalizedToolkitSlug,
        connectedAccountId: account.id,
      }, "Failed to resolve Composio Personal Intelligence account identity");
      return failed;
    }
  }

  private async decorateConnectorConfigWithPersonalIntelligenceAccount(config: UserConnectorConfig | null): Promise<UserConnectorConfig | null> {
    if (!config) {
      return null;
    }
    const [decorated] = await this.decorateConnectorConfigsWithPersonalIntelligenceAccounts([config]);
    return decorated ?? config;
  }

  private async decorateConnectorConfigsWithPersonalIntelligenceAccounts(configs: UserConnectorConfig[]): Promise<EnrichedConnectorConfig[]> {
    const store = new PersonalIntelligenceAccountStore({ db: this.deps.db, user: this.deps.user });
    const accounts = await store.listByCurrentConnectedAccounts(configs
      .filter((config) => config.connectedAccountId)
      .map((config) => ({
        toolkitSlug: config.toolkitSlug,
        connectedAccountId: config.connectedAccountId!,
      })));
    const accountsByCurrentId = new Map<string, StoredPersonalIntelligenceAccount>();
    for (const account of accounts) {
      const key = `${account.toolkitSlug}:${account.currentConnectedAccountId}`;
      if (!accountsByCurrentId.has(key)) {
        accountsByCurrentId.set(key, account);
      }
    }
    return configs.map((config) => {
      if (!config.connectedAccountId) {
        return this.decorateConnectorConfig(config, null);
      }
      const account = accountsByCurrentId.get(`${config.toolkitSlug}:${config.connectedAccountId}`) ?? null;
      return this.decorateConnectorConfig(config, account);
    });
  }

  private decorateConnectorConfig(config: UserConnectorConfig, account: StoredPersonalIntelligenceAccountLike | null): EnrichedConnectorConfig {
    if (!isComposioPersonalIntelligenceToolkitSupported(config.toolkitSlug)) {
      return {
        ...config,
        personalIntelligenceIdentityStatus: "unsupported",
        personalIntelligenceAccountScopeId: null,
        personalIntelligenceAccount: null,
      };
    }

    const status = account?.identityStatus ?? "pending";
    const accountScopeId = status === "resolved" ? account?.accountScopeId ?? null : null;
    return {
      ...config,
      personalIntelligenceIdentityStatus: status,
      personalIntelligenceAccountScopeId: accountScopeId,
      personalIntelligenceAccount: accountScopeId && account
        ? {
            toolkitSlug: account.toolkitSlug,
            accountScopeId,
            ...(account.displayName ? { displayName: account.displayName } : {}),
            ...(account.email ? { email: account.email } : {}),
            ...(account.handle ? { handle: account.handle } : {}),
            ...(account.providerWorkspaceId ? { providerWorkspaceId: account.providerWorkspaceId } : {}),
            ...(getProviderWorkspaceName(account.metadata) ? { providerWorkspaceName: getProviderWorkspaceName(account.metadata)! } : {}),
            ...(account.verifiedAt ? { verifiedAt: account.verifiedAt.toISOString() } : {}),
          }
        : null,
    };
  }

  private async pauseConnectorPatterns(
    toolkitSlug: string,
    connectedAccountId: string | null | undefined,
    reason: "disconnected" | "account_replaced",
    origin: ConnectorLifecycleOrigin,
  ): Promise<void> {
    await pausePatternsForComposioConnector({
      patternStore: this.deps.patternStore,
      composio: this.deps.composio,
      eventBus: this.deps.eventBus,
    }, {
      toolkitSlug,
      connectedAccountId,
      reason,
      origin,
    });
  }

  private async rehydrateConnectorPatterns(
    toolkitSlug: string,
    connectedAccountId: string,
    previousConnectedAccountId: string | null | undefined,
    origin: ConnectorLifecycleOrigin,
  ): Promise<void> {
    await rehydratePatternsForComposioConnector({
      patternStore: this.deps.patternStore,
      composio: this.deps.composio,
      eventBus: this.deps.eventBus,
    }, {
      composioUserId: this.composioUserId,
      toolkitSlug,
      connectedAccountId,
      previousConnectedAccountId,
      origin,
    });
  }

  private assertToolkitAllowed(toolkitSlug: string): void {
    if (!isComposioManagedConnectorSlug(toolkitSlug)) {
      throw new Error(`Connector is not managed by Composio: ${toolkitSlug}`);
    }
    const allowedToolkits = this.deps.composio.getAllowedToolkits();
    if (allowedToolkits && !allowedToolkits.includes(toolkitSlug)) {
      throw new Error(`Composio toolkit is not enabled: ${toolkitSlug}`);
    }
  }
}

function isActiveAccount(account: ComposioConnectedAccountSummary): boolean {
  return account.status === "ACTIVE" && !account.isDisabled;
}

function isDisconnectingConnector(config: UserConnectorConfig | null | undefined): config is UserConnectorConfig & { connectedAccountId: string } {
  return config?.connected === false
    && config.connectionStatus === disconnectingStatus
    && Boolean(config.connectedAccountId);
}

function groupAccountsByToolkit(accounts: ComposioConnectedAccountSummary[]): Map<string, ComposioConnectedAccountSummary[]> {
  const grouped = new Map<string, ComposioConnectedAccountSummary[]>();
  for (const account of accounts) {
    grouped.set(account.toolkitSlug, [...(grouped.get(account.toolkitSlug) ?? []), account]);
  }
  for (const [toolkitSlug, groupedAccounts] of grouped) {
    grouped.set(toolkitSlug, sortAccountsByRecency(groupedAccounts));
  }
  return grouped;
}

function selectAccountForConfig(
  config: UserConnectorConfig | null | undefined,
  activeAccounts: ComposioConnectedAccountSummary[],
): ComposioConnectedAccountSummary | null {
  if (activeAccounts.length === 0) {
    return null;
  }

  if (config?.connectedAccountId) {
    const existingAccount = activeAccounts.find((account) => account.id === config.connectedAccountId);
    if (existingAccount) {
      return existingAccount;
    }
  }

  return pickPrimaryAccount(activeAccounts);
}

function pickPrimaryAccount(accounts: ComposioConnectedAccountSummary[]): ComposioConnectedAccountSummary | null {
  return sortAccountsByRecency(accounts)[0] ?? null;
}

function sortAccountsByRecency(accounts: ComposioConnectedAccountSummary[]): ComposioConnectedAccountSummary[] {
  return [...accounts].sort((left, right) => accountTimestamp(right) - accountTimestamp(left));
}

function accountTimestamp(account: ComposioConnectedAccountSummary): number {
  const timestamp = account.updatedAt ?? account.createdAt;
  if (!timestamp) {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getProviderWorkspaceName(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.organizationName ?? metadata?.teamName ?? metadata?.workspaceName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pendingPersonalIntelligenceAccountScopeId(connectedAccountId: string): string {
  return `pending:composio:${connectedAccountId.trim()}`;
}

function failedPersonalIntelligenceAccountScopeId(connectedAccountId: string): string {
  return `failed:composio:${connectedAccountId.trim()}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown";
}
