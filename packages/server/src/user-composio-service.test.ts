import { describe, expect, it, mock } from "bun:test";
import type { UserContext } from "@finn/core";
import type { UserConnectorConfig } from "@finn/db";
import { patternUsesComposioConnector } from "@finn/patterns";
import { UserComposioService } from "./user-composio-service.js";

const user: UserContext = {
  tenantId: "tenant_default",
  userId: "usr_test",
  phoneNumber: "+15551234567",
  displayName: null,
  timezone: "UTC",
  timezoneSource: "server",
  location: null,
  kidsMode: false,
};

function connectorConfig(overrides: Partial<UserConnectorConfig> = {}): UserConnectorConfig {
  return {
    id: "ucc_gmail",
    tenantId: user.tenantId,
    userId: user.userId,
    toolkitSlug: "gmail",
    toolkitName: "Gmail",
    connected: true,
    connectedAccountId: "acct_old",
    connectionStatus: "ACTIVE",
    permissionMode: "all",
    myDayEnabled: true,
    personalIntelligenceEnabled: true,
    enabledTools: null,
    lastNotifiedConnectedAccountId: "acct_old",
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T00:00:00.000Z"),
    ...overrides,
  };
}

function activeAccount(id = "acct_old", toolkitSlug = "gmail") {
  return {
    id,
    toolkitSlug,
    status: "ACTIVE" as const,
    statusReason: null,
    alias: null,
    isDisabled: false,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

function puterConnectorConfig(): UserConnectorConfig {
  return connectorConfig({
    id: "ucc_puter",
    toolkitSlug: "puter",
    toolkitName: "Puter",
    connected: true,
    connectedAccountId: "puter:mac",
    connectionStatus: "connected",
    permissionMode: "read_only",
    myDayEnabled: false,
    personalIntelligenceEnabled: true,
    enabledTools: ["puter.imessage.personal_intelligence"],
    lastNotifiedConnectedAccountId: "puter:mac",
  });
}

function createMemoryDb(rows: UserConnectorConfig[]) {
  const createQueryResult = (data: UserConnectorConfig[]) => {
    const promise = Promise.resolve(data);
    return {
      limit: async () => data.slice(0, 1),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };

  return {
    select: () => ({
      from: () => ({
        where: () => createQueryResult(rows),
      }),
    }),
    update: () => ({
      set: (patch: Partial<UserConnectorConfig>) => ({
        where: () => ({
          returning: async () => {
            const updated = {
              ...rows[0],
              ...patch,
            } as UserConnectorConfig;
            rows[0] = updated;
            return [updated];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (value: UserConnectorConfig) => ({
        onConflictDoUpdate: () => ({
          returning: async () => [value],
        }),
        returning: async () => {
          rows.push(value);
          return [value];
        },
      }),
    }),
  } as never;
}

function createPatternStore() {
  return {
    listByComposioConnector: mock(async () => []),
    update: mock(async () => null),
    hasOtherComposioTriggerUsers: mock(async () => false),
  };
}

describe("UserComposioService", () => {
  it("disconnects through one lifecycle path and preserves the account id for reconnect", async () => {
    const rows = [connectorConfig({ toolkitSlug: "slack", toolkitName: "Slack" })];
    const listConnectedAccounts = mock()
      .mockResolvedValueOnce([activeAccount("acct_old", "slack")])
      .mockResolvedValueOnce([]);
    const deleteConnectedAccount = mock(async () => undefined);
    const patternStore = createPatternStore();
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: patternStore as never,
      eventBus: { emit: mock(async () => undefined) } as never,
      composio: {
        getAllowedToolkits: () => ["slack"],
        listConnectedAccounts,
        deleteConnectedAccount,
      } as never,
    });

    const config = await service.disconnectConnector("slack", { origin: "web" });

    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_old");
    expect(patternStore.listByComposioConnector).toHaveBeenCalledWith("slack", "acct_old");
    expect(config).toMatchObject({
      toolkitSlug: "slack",
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
      myDayEnabled: true,
      personalIntelligenceEnabled: true,
    });
  });

  it("rejects disconnecting primary connectors", async () => {
    const deleteConnectedAccount = mock(async () => undefined);
    const service = new UserComposioService({
      db: createMemoryDb([connectorConfig()]),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => [activeAccount("acct_old")]),
        deleteConnectedAccount,
      } as never,
    });

    await expect(service.disconnectConnector("gmail", { origin: "web" })).rejects.toThrow("Primary connectors cannot be disconnected.");
    expect(deleteConnectedAccount).not.toHaveBeenCalled();
  });

  it("keeps project-owned connectors out of Composio config reconciliation", async () => {
    const rows = [
      connectorConfig({ connectedAccountId: "acct_gmail" }),
      puterConnectorConfig(),
    ];
    const listConnectedAccounts = mock(async () => [activeAccount("acct_gmail")]);
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts,
      } as never,
    });

    const configs = await service.listConfiguredConnectorConfigs({ feature: "personal_intelligence" });
    const puterScoped = await service.reconcileConnectorConfigs({ toolkitSlugs: ["puter"], origin: "system" });

    expect(configs.map((config) => config.toolkitSlug)).toEqual([]);
    expect(puterScoped).toEqual([]);
    expect(listConnectedAccounts).toHaveBeenCalledTimes(1);
  });

  it("remembers the selected account when disconnecting multiple active accounts", async () => {
    const rows = [connectorConfig({ toolkitSlug: "slack", toolkitName: "Slack", connectedAccountId: "acct_selected" })];
    const listConnectedAccounts = mock(async () => [
      activeAccount("acct_other", "slack"),
      activeAccount("acct_selected", "slack"),
    ]);
    const deleteConnectedAccount = mock(async () => undefined);
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["slack"],
        listConnectedAccounts,
        deleteConnectedAccount,
      } as never,
    });

    const config = await service.disconnectConnector("slack", { origin: "web" });

    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_other");
    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_selected");
    expect(config).toMatchObject({
      connected: false,
      connectedAccountId: "acct_selected",
      connectionStatus: "disconnecting",
    });
  });

  it("continues deleting remaining active accounts when one Composio deletion fails", async () => {
    const rows = [connectorConfig({ toolkitSlug: "slack", toolkitName: "Slack", connectedAccountId: "acct_selected" })];
    const deleteConnectedAccount = mock(async (accountId: string) => {
      if (accountId === "acct_failed") {
        throw new Error("Composio delete failed");
      }
    });
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["slack"],
        listConnectedAccounts: mock(async () => [
          activeAccount("acct_failed", "slack"),
          activeAccount("acct_selected", "slack"),
          activeAccount("acct_other", "slack"),
        ]),
        deleteConnectedAccount,
      } as never,
    });

    const config = await service.disconnectConnector("slack", { origin: "web" });

    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_failed");
    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_selected");
    expect(deleteConnectedAccount).toHaveBeenCalledWith("acct_other");
    expect(config).toMatchObject({
      connected: false,
      connectedAccountId: "acct_selected",
      connectionStatus: "disconnecting",
    });
  });

  it("does not resurrect a connector while a disconnect is still visible in Composio", async () => {
    const rows = [connectorConfig({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    })];
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => [activeAccount("acct_old")]),
      } as never,
    });

    const [config] = await service.reconcileConnectorConfigs({ toolkitSlugs: ["gmail"], origin: "system" });

    expect(config).toMatchObject({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    });
  });

  it("does not passively hydrate a different account while disconnect is pending", async () => {
    const rows = [connectorConfig({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    })];
    const patternStore = createPatternStore();
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: patternStore as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => [activeAccount("acct_new")]),
      } as never,
    });

    const [config] = await service.reconcileConnectorConfigs({ toolkitSlugs: ["gmail"], origin: "system" });

    expect(config).toMatchObject({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    });
    expect(patternStore.update).not.toHaveBeenCalled();
  });

  it("only finalizes reconnects for accounts owned by the user runtime", async () => {
    const rows = [connectorConfig({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    })];
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: createPatternStore() as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => [activeAccount("acct_owned")]),
      } as never,
    });

    const result = await service.finalizeConnection({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_foreign",
      previousConnectedAccountId: "acct_old",
      origin: "web",
    });

    expect(result).toEqual({ connector: null, rehydratedPatterns: [] });
    expect(rows[0]).toMatchObject({
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: "disconnecting",
    });
  });

  it("rehydrates local overlay when Composio reports a replacement account", async () => {
    const rows = [connectorConfig({ connectedAccountId: "acct_old" })];
    const pattern = {
      id: "ptn_123",
      tenantId: user.tenantId,
      userId: user.userId,
      name: "Daily briefing",
      description: null,
      userDescription: "Send a briefing.",
      triggerType: "schedule" as const,
      triggerConfig: { type: "schedule" as const, schedule: { kind: "daily" as const, time: "08:00" }, timezoneSource: "user" as const },
      connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_old" }], mcpServerIds: [] },
      triggerFilters: [],
      notifyCondition: { type: "always" as const },
      workerType: "pattern_worker" as const,
      taskPrompt: "Send a briefing.",
      reminderContext: null,
      timezone: "UTC",
      active: false,
      failureCount: 0,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      updatedAt: new Date("2026-05-19T00:00:00.000Z"),
    };
    const patternStore = {
      listByComposioConnector: mock(async (toolkitSlug: string, connectedAccountId?: string) => (
        patternUsesComposioConnector(pattern, toolkitSlug, connectedAccountId) ? [pattern] : []
      )),
      update: mock(async (_id: string, patch: Record<string, unknown>) => ({ ...pattern, ...patch })),
      hasOtherComposioTriggerUsers: mock(async () => false),
    };
    const service = new UserComposioService({
      db: createMemoryDb(rows),
      user,
      patternStore: patternStore as never,
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => [activeAccount("acct_new")]),
      } as never,
    });

    const [config] = await service.reconcileConnectorConfigs({ toolkitSlugs: ["gmail"], origin: "system" });

    expect(config).toMatchObject({
      connected: true,
      connectedAccountId: "acct_new",
      myDayEnabled: true,
      personalIntelligenceEnabled: true,
      personalIntelligenceIdentityStatus: "pending",
    });
    expect(patternStore.update).toHaveBeenCalled();
  });
});
