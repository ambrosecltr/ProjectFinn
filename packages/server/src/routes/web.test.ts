import { createHash } from "node:crypto";
import { describe, expect, it, mock } from "bun:test";

import type { MyDayTodoRecord, PatternRecord, UserContext } from "@finn/core";
import { applyPuterConfigPatchForTest, buildMcpMetadataForTest, buildMyDayHandoffMessageForTest, createWebRoutes, formatMcpSetupError, getOnboardingCompletedAtForTest, getTimezoneSource, getUnsupportedMcpOAuthMessage, isComposioManagedConnectorSlug, parseConnectorConfigForTest, resolveUserTimezone, serializeConnectorConfig, shouldPrependPuterConnectorForTest, validateMcpAuthInput } from "./web.js";
import type { PuterSourceAvailability } from "../puter-connector.js";

function hashTestValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultPuterSourceAvailability(): { imessage: PuterSourceAvailability; notes: PuterSourceAvailability } {
  return {
    imessage: {
      available: false,
      message: "Full Disk Access and Contacts access are required in Finn Puter.",
      missingAccess: ["imessage", "contacts"],
    },
    notes: {
      available: false,
      message: "Full Disk Access is required in Finn Puter.",
      missingAccess: ["notes"],
    },
  };
}

function createRouteDb(selectResponses: unknown[][], updateResponses: unknown[][] = []) {
  let selectIndex = 0;
  let updateIndex = 0;
  const createQueryResult = (rows: unknown[]) => {
    const promise = Promise.resolve(rows);
    return {
      limit: async () => rows,
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };
  const createUpdateResult = (rows: unknown[]) => {
    const promise = Promise.resolve(rows);
    return {
      returning: async () => rows,
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };

  return {
    select: () => ({
      from: () => ({
        where: () => createQueryResult(selectResponses[selectIndex++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => createUpdateResult(updateResponses[updateIndex++] ?? []),
      }),
    }),
  } as never;
}

function createRouteUser() {
  return {
    tenantId: "tenant_default",
    id: "usr_test",
    phoneNumber: "+15551234567",
    displayName: null,
    timezone: "UTC",
    location: null,
    kidsMode: false,
    metadata: { profile: { timezoneSource: "server" } },
  };
}

function createRouteSession(token: string) {
  return {
    id: "sess_test",
    tenantId: "tenant_default",
    userId: "usr_test",
    tokenHash: hashTestValue(token),
    expiresAt: new Date("2026-05-21T00:00:00.000Z"),
  };
}

function createRoutePattern(active: boolean): PatternRecord {
  return {
    id: "ptn_123",
    tenantId: "tenant_default",
    userId: "usr_test",
    name: "Daily briefing",
    description: null,
    userDescription: "Send a briefing.",
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
    connectorScope: { composio: [], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    workerType: "pattern_worker",
    taskPrompt: "Send a briefing.",
    reminderContext: null,
    timezone: "UTC",
    active,
    failureCount: 0,
    lastRunAt: null,
    nextRunAt: active ? new Date("2026-05-20T08:00:00.000Z") : null,
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: new Date("2026-05-19T00:00:00.000Z"),
  };
}

function createRouteConnectorConfig(overrides: Partial<{
  toolkitSlug: string;
  toolkitName: string;
  connected: boolean;
  connectedAccountId: string | null;
}> = {}) {
  return {
    id: `ucc_${overrides.toolkitSlug ?? "gmail"}`,
    tenantId: "tenant_default",
    userId: "usr_test",
    toolkitSlug: overrides.toolkitSlug ?? "gmail",
    toolkitName: overrides.toolkitName ?? "Gmail",
    connected: overrides.connected ?? true,
    connectedAccountId: overrides.connectedAccountId ?? "acct_gmail",
    connectionStatus: "connected",
    permissionMode: "read_only",
    myDayEnabled: false,
    personalIntelligenceEnabled: false,
    enabledTools: null,
    lastNotifiedConnectedAccountId: overrides.connectedAccountId ?? "acct_gmail",
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T00:00:00.000Z"),
  };
}

function createRouteDeps(params: { db: never; composio?: unknown; connectorCatalog?: unknown; patternStore?: unknown; runtimes?: unknown }): Parameters<typeof createWebRoutes>[0] {
  return {
    config: {
      userTimezone: "UTC",
      publicUrl: "http://localhost",
      capabilities: {
        integrations: { memory: true },
      },
    } as never,
    db: params.db,
    messaging: {} as never,
    users: {} as never,
    ...(params.composio ? { composio: params.composio as never } : {}),
    ...(params.connectorCatalog ? { connectorCatalog: params.connectorCatalog as never } : {}),
    eventBus: { emit: mock(async () => undefined) } as never,
    patternStore: (params.patternStore ?? {}) as never,
    patternScheduler: { runPattern: mock(async () => "wrk_123") } as never,
    ...(params.runtimes ? { runtimes: params.runtimes as never } : {}),
  } as never;
}

describe("validateMcpAuthInput", () => {
  it("requires API key header fields before probing", () => {
    expect(validateMcpAuthInput({ authMode: "api_key" })).toBe("Enter the API key header name and value before connecting.");
    expect(validateMcpAuthInput({ authMode: "api_key", authHeaderValue: "secret" })).toBe("Enter the API key header name before connecting.");
    expect(validateMcpAuthInput({ authMode: "api_key", authHeaderName: "x-api-key" })).toBe("Enter the API key value before connecting.");
  });

  it("accepts complete header credentials and legacy bearer tokens", () => {
    expect(validateMcpAuthInput({ authMode: "api_key", authHeaderName: "x-api-key", authHeaderValue: "secret" })).toBeUndefined();
    expect(validateMcpAuthInput({ authMode: "api_key", authToken: "github_pat" })).toBeUndefined();
    expect(validateMcpAuthInput({ authMode: "none" })).toBeUndefined();
  });
});

describe("getUnsupportedMcpOAuthMessage", () => {
  it("explains that GitHub remote MCP needs token auth", () => {
    expect(getUnsupportedMcpOAuthMessage("https://api.githubcopilot.com/mcp/"))
      .toContain("Choose API key auth");
  });

  it("does not block non-GitHub MCP OAuth", () => {
    expect(getUnsupportedMcpOAuthMessage("https://mcp.example.com/oauth"))
      .toBeUndefined();
  });
});

describe("formatMcpSetupError", () => {
  it("keeps MCP setup failures actionable by auth mode", () => {
    expect(formatMcpSetupError(new Error("401 Unauthorized"), "api_key"))
      .toBe("Could not connect to the MCP server with those API key settings: 401 Unauthorized");
    expect(formatMcpSetupError(new Error("401 Unauthorized"), "none"))
      .toBe("Could not connect to the MCP server: 401 Unauthorized");
    expect(formatMcpSetupError(new Error("OAuth metadata missing"), "oauth"))
      .toBe("Could not start OAuth for this MCP server: OAuth metadata missing");
  });
});

describe("buildMcpMetadataForTest", () => {
  it("removes stale auth metadata when auth is disabled", () => {
    expect(buildMcpMetadataForTest({
      auth: { type: "api_key" },
      logoUrl: "https://mcp.example.com/logo.png",
    }, "none")).toEqual({
      logoUrl: "https://mcp.example.com/logo.png",
    });
  });

  it("replaces stale auth metadata when auth mode changes", () => {
    expect(buildMcpMetadataForTest({
      auth: { type: "api_key" },
      logoUrl: "https://mcp.example.com/logo.png",
    }, "oauth")).toEqual({
      auth: { type: "oauth" },
      logoUrl: "https://mcp.example.com/logo.png",
    });
  });
});

describe("timezone source handling", () => {
  it("recognizes browser captured timezones as user-specific", () => {
    const user = {
      timezone: "Australia/Brisbane",
      metadata: { profile: { timezoneSource: "browser" } },
    };

    expect(getTimezoneSource(user as never)).toBe("browser");
    expect(resolveUserTimezone(user as never, { userTimezone: "UTC" })).toBe("Australia/Brisbane");
  });

  it("falls back to config timezone for server source", () => {
    const user = {
      timezone: "Australia/Brisbane",
      metadata: { profile: { timezoneSource: "server" } },
    };

    expect(getTimezoneSource(user as never)).toBe("server");
    expect(resolveUserTimezone(user as never, { userTimezone: "America/Los_Angeles" })).toBe("America/Los_Angeles");
  });
});

describe("onboarding metadata", () => {
  it("treats missing onboarding metadata as incomplete", () => {
    expect(getOnboardingCompletedAtForTest({ profile: { timezoneSource: "server" } })).toBeNull();
  });

  it("reads completed onboarding timestamps from profile metadata", () => {
    expect(getOnboardingCompletedAtForTest({
      profile: {
        onboarding: { completedAt: "2026-05-21T00:00:00.000Z" },
      },
    })).toBe("2026-05-21T00:00:00.000Z");
  });

  it("blocks completion when Composio is configured without a connected mail connector", async () => {
    const token = "session-token";
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail", "outlook"],
      },
    }));

    const response = await app.request("/onboarding/complete", {
      method: "POST",
      headers: { cookie: `finn_session=${token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Connect Gmail or Outlook before finishing setup." });
  });

  it("allows completion when a required mail connector is connected", async () => {
    const token = "session-token";
    const updatedUser = {
      ...createRouteUser(),
      metadata: { profile: { onboarding: { completedAt: "2026-05-21T00:00:00.000Z" } } },
    };
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [createRouteConnectorConfig()],
      ], [
        [],
        [updatedUser],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail", "outlook"],
      },
    }));

    const response = await app.request("/onboarding/complete", {
      method: "POST",
      headers: { cookie: `finn_session=${token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { user: { onboarding: { completedAt: string | null } } };
    expect(body.user.onboarding.completedAt).toBe("2026-05-21T00:00:00.000Z");
  });
});

describe("Pattern web routes", () => {
  it("keeps fallback Pattern access scoped to the authenticated user", async () => {
    const token = "session-token";
    const globalGetById = mock(async () => ({
      ...createRoutePattern(true),
      tenantId: "tenant_other",
      userId: "usr_other",
    }));
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
      ]),
      patternStore: { getById: globalGetById },
    }));

    const response = await app.request("/patterns/ptn_123/toggle", {
      method: "POST",
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(404);
    expect(globalGetById).not.toHaveBeenCalled();
  });

  it("preserves the user's toggle target when connector sync refreshes the Pattern", async () => {
    const token = "session-token";
    const getByIdResponses = [
      createRoutePattern(false),
      createRoutePattern(true),
    ];
    const setActive = mock(async (_id: string, active: boolean) => createRoutePattern(active));
    const userPatternStore = {
      getById: mock(async () => getByIdResponses.shift() ?? createRoutePattern(true)),
      setActive,
      hasOtherActiveComposioTriggerUsers: mock(async () => false),
    };
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
        [],
      ]),
      patternStore: {
        isOneShotSchedule: () => false,
        computeNextRun: () => new Date("2026-05-20T08:00:00.000Z"),
      },
      runtimes: {
        getPatternStore: mock(async () => userPatternStore),
      },
    }));

    const response = await app.request("/patterns/ptn_123/toggle", {
      method: "POST",
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(200);
    expect(setActive).toHaveBeenCalledWith("ptn_123", true);
  });

  it("passes a blocked Pattern's previous connector account into reconnect OAuth", async () => {
    const token = "session-token";
    const authorizeToolkit = mock(async () => "https://composio.example/auth");
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [{
          toolkitSlug: "gmail",
          toolkitName: "Gmail",
          connected: false,
          connectedAccountId: null,
        }],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail"],
        authorizeToolkit,
      },
    }));

    const response = await app.request("/connectors/gmail/reconnect", {
      method: "POST",
      headers: { cookie: `finn_session=${token}` },
      body: JSON.stringify({ previousConnectedAccountId: "acct_old" }),
    });

    expect(response.status).toBe(200);
    expect(authorizeToolkit).toHaveBeenCalledWith(
      "tenant_default_usr_test",
      "gmail",
      "http://localhost/api/web/connectors/oauth/callback?slug=gmail&previousConnectedAccountId=acct_old",
    );
  });
});

describe("Connector web routes", () => {
  it("loads lean Composio toolkit pages and decorates connector metadata from the shared catalog", async () => {
    const token = "session-token";
    const decorateToolkits = mock(async (connectors: Array<{ slug: string; name: string }>) => connectors.map((connector) => ({
      ...connector,
      name: "Finn Gmail",
      description: "Custom Gmail connector copy.",
      logo: "/icons/connectors/gmail.svg",
    })));
    const getToolkits = mock(async () => ({
      connectors: [{
        slug: "gmail",
        name: "Gmail",
        requiresAuth: true,
        connected: false,
        enabled: true,
      }],
      nextCursor: null,
    }));
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
        [],
        [],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => []),
        getToolkits,
        getToolkitMetadata: mock(async () => {
          throw new Error("route should delegate metadata decisions to the catalog service");
        }),
      },
      connectorCatalog: { decorateToolkits },
    }));

    const response = await app.request("/connectors", {
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(200);
    expect(getToolkits).toHaveBeenCalledWith("tenant_default_usr_test", {
      limit: 10,
      cursor: undefined,
      search: undefined,
      includeMetadata: false,
    });
    expect(decorateToolkits).toHaveBeenCalledTimes(1);
    const body = await response.json() as { connectors: Array<{ slug: string; name: string; description?: string; logo?: string }> };
    expect(body.connectors.find((connector) => connector.slug === "gmail")).toMatchObject({
      name: "Finn Gmail",
      description: "Custom Gmail connector copy.",
      logo: "/icons/connectors/gmail.svg",
    });
  });

  it("keeps Composio connector metadata when the shared catalog is unavailable", async () => {
    const token = "session-token";
    const getToolkits = mock(async () => ({
      connectors: [{
        slug: "gmail",
        name: "Gmail",
        description: "Composio Gmail copy.",
        logo: "https://cdn.example.com/gmail.svg",
        requiresAuth: true,
        connected: false,
        enabled: true,
      }],
      nextCursor: null,
    }));
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
        [],
        [],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => []),
        getToolkits,
      },
    }));

    const response = await app.request("/connectors", {
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(200);
    expect(getToolkits).toHaveBeenCalledWith("tenant_default_usr_test", {
      limit: 10,
      cursor: undefined,
      search: undefined,
    });
    const body = await response.json() as { connectors: Array<{ slug: string; description?: string; logo?: string }> };
    expect(body.connectors.find((connector) => connector.slug === "gmail")).toMatchObject({
      description: "Composio Gmail copy.",
      logo: "https://cdn.example.com/gmail.svg",
    });
  });

  it("keeps Composio connector metadata on detail routes when the shared catalog is unavailable", async () => {
    const token = "session-token";
    const getToolkits = mock(async () => ({
      connectors: [{
        slug: "gmail",
        name: "Gmail",
        description: "Composio Gmail copy.",
        logo: "https://cdn.example.com/gmail.svg",
        requiresAuth: true,
        connected: false,
        enabled: true,
      }],
      nextCursor: null,
    }));
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail"],
        getToolkits,
      },
      runtimes: {
        getComposioService: mock(async () => ({
          composioUserId: "tenant_default_usr_test",
          getConnectorConfig: mock(async () => null),
          mergeConnectorCatalog: (connector: unknown) => connector,
        })),
      },
    }));

    const response = await app.request("/connectors/gmail", {
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(200);
    expect(getToolkits).toHaveBeenCalledWith("tenant_default_usr_test", {
      limit: 1,
      toolkits: ["gmail"],
    });
    const body = await response.json() as { connector: { description?: string; logo?: string } };
    expect(body.connector).toMatchObject({
      description: "Composio Gmail copy.",
      logo: "https://cdn.example.com/gmail.svg",
    });
  });

  it("returns canonical user-scoped connection state instead of raw Composio catalog state", async () => {
    const token = "session-token";
    const gmailConfig = {
      id: "ucc_gmail",
      tenantId: "tenant_default",
      userId: "usr_test",
      toolkitSlug: "gmail",
      toolkitName: "Gmail",
      connected: false,
      connectedAccountId: "acct_old",
      connectionStatus: null,
      permissionMode: "all",
      myDayEnabled: false,
      personalIntelligenceEnabled: false,
      enabledTools: null,
      lastNotifiedConnectedAccountId: "acct_old",
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      updatedAt: new Date("2026-05-20T00:00:00.000Z"),
    };
    const ensureRuntime = mock(async () => {
      throw new Error("full runtime should not be created for connector listing");
    });
    const app = createWebRoutes(createRouteDeps({
      db: createRouteDb([
        [createRouteSession(token)],
        [createRouteUser()],
        [],
        [gmailConfig],
        [gmailConfig],
      ]),
      composio: {
        getAllowedToolkits: () => ["gmail"],
        listConnectedAccounts: mock(async () => []),
        getToolkits: mock(async () => ({
          connectors: [{
            slug: "gmail",
            name: "Gmail",
            requiresAuth: true,
            connected: true,
            enabled: true,
            connectedAccountId: "acct_old",
            connectionStatus: "ACTIVE",
          }],
          nextCursor: null,
        })),
      },
      runtimes: {
        ensure: ensureRuntime,
      },
    }));

    const response = await app.request("/connectors", {
      headers: { cookie: `finn_session=${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { connectors: Array<{ slug: string; connected: boolean; connectedAccountId?: string; connectionStatus?: string }> };
    const gmail = body.connectors.find((connector) => connector.slug === "gmail");
    expect(gmail).toMatchObject({
      slug: "gmail",
      connected: false,
      connectedAccountId: "acct_old",
    });
    expect(gmail?.connectionStatus).toBeUndefined();
    expect(ensureRuntime).not.toHaveBeenCalled();
  });
});

describe("serializeConnectorConfig", () => {
  it("defaults connector automation settings off when memory is available", () => {
    expect(serializeConnectorConfig(undefined, true)).toEqual({
      permissionMode: "all",
      myDayEnabled: false,
      personalIntelligenceAvailable: false,
      personalIntelligenceEnabled: false,
      personalIntelligenceIdentityStatus: "pending",
      personalIntelligenceAccount: null,
      enabledTools: [],
      puter: {
        imessageEnabled: false,
        imessagePersonalIntelligenceEnabled: false,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
        sources: defaultPuterSourceAvailability(),
      },
    });
  });

  it("preserves disabled connector automation settings", () => {
    expect(serializeConnectorConfig({
      permissionMode: "read_only",
      myDayEnabled: false,
      personalIntelligenceEnabled: false,
    } as never, true)).toEqual({
      permissionMode: "read_only",
      myDayEnabled: false,
      personalIntelligenceAvailable: false,
      personalIntelligenceEnabled: false,
      personalIntelligenceIdentityStatus: "pending",
      personalIntelligenceAccount: null,
      enabledTools: [],
      puter: {
        imessageEnabled: false,
        imessagePersonalIntelligenceEnabled: false,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
        sources: defaultPuterSourceAvailability(),
      },
    });
  });

  it("hides personal intelligence when memory is unavailable", () => {
    expect(serializeConnectorConfig({
      permissionMode: "all",
      myDayEnabled: true,
      personalIntelligenceEnabled: true,
    } as never, false)).toEqual({
      permissionMode: "all",
      myDayEnabled: true,
      personalIntelligenceAvailable: false,
      personalIntelligenceEnabled: false,
      personalIntelligenceIdentityStatus: "pending",
      personalIntelligenceAccount: null,
      enabledTools: [],
      puter: {
        imessageEnabled: false,
        imessagePersonalIntelligenceEnabled: false,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
        sources: defaultPuterSourceAvailability(),
      },
    });
  });

  it("maps Puter enabled tools into source toggles", () => {
    expect(serializeConnectorConfig({
      toolkitSlug: "puter",
      connected: true,
      connectedAccountId: "puter:mac",
      permissionMode: "read_only",
      enabledTools: ["puter.imessage"],
    } as never, true)).toEqual({
      permissionMode: "read_only",
      myDayEnabled: false,
      personalIntelligenceAvailable: true,
      personalIntelligenceEnabled: false,
      personalIntelligenceIdentityStatus: "resolved",
      personalIntelligenceAccount: null,
      enabledTools: ["puter.imessage"],
      puter: {
        imessageEnabled: true,
        imessagePersonalIntelligenceEnabled: false,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
        sources: defaultPuterSourceAvailability(),
      },
    });
  });

  it("maps Puter Personal Intelligence markers separately from tool access", () => {
    expect(serializeConnectorConfig({
      toolkitSlug: "puter",
      connected: true,
      connectedAccountId: "puter:mac",
      permissionMode: "read_only",
      personalIntelligenceEnabled: true,
      enabledTools: ["puter.imessage", "puter.imessage.personal_intelligence"],
    } as never, true)).toEqual({
      permissionMode: "read_only",
      myDayEnabled: false,
      personalIntelligenceAvailable: true,
      personalIntelligenceEnabled: true,
      personalIntelligenceIdentityStatus: "resolved",
      personalIntelligenceAccount: null,
      enabledTools: ["puter.imessage", "puter.imessage.personal_intelligence"],
      puter: {
        imessageEnabled: true,
        imessagePersonalIntelligenceEnabled: true,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
        sources: defaultPuterSourceAvailability(),
      },
    });
  });
});

describe("parseConnectorConfigForTest", () => {
  it("treats null Puter source toggles as omitted fields", () => {
    expect(parseConnectorConfigForTest({
      puter: {
        deviceId: "mac-test",
        imessageEnabled: null,
        imessagePersonalIntelligenceEnabled: null,
        notesEnabled: null,
        notesPersonalIntelligenceEnabled: null,
      },
    })).toEqual({
      puter: {
        deviceId: "mac-test",
        imessageEnabled: undefined,
        imessagePersonalIntelligenceEnabled: undefined,
        notesEnabled: undefined,
        notesPersonalIntelligenceEnabled: undefined,
      },
    });
  });
});

describe("applyPuterConfigPatchForTest", () => {
  it("keeps source access enabled when Personal Intelligence is disabled", () => {
    expect(new Set(applyPuterConfigPatchForTest(
      ["puter.imessage", "puter.imessage.personal_intelligence"],
      { imessagePersonalIntelligenceEnabled: false },
    ))).toEqual(new Set(["puter.imessage"]));
  });

  it("enables source access when Personal Intelligence is enabled", () => {
    expect(new Set(applyPuterConfigPatchForTest(
      [],
      { notesPersonalIntelligenceEnabled: true },
    ))).toEqual(new Set(["puter.notes", "puter.notes.personal_intelligence"]));
  });

  it("disables Personal Intelligence when source access is disabled", () => {
    expect(new Set(applyPuterConfigPatchForTest(
      ["puter.notes", "puter.notes.personal_intelligence"],
      { notesEnabled: false },
    ))).toEqual(new Set());
  });
});

describe("Puter connector route helpers", () => {
  it("keeps project-owned Puter out of generic Composio connector handling", () => {
    expect(isComposioManagedConnectorSlug("puter")).toBe(false);
    expect(isComposioManagedConnectorSlug("gmail")).toBe(true);
  });

  it("only prepends the synthetic Puter connector on the first connector page", () => {
    expect(shouldPrependPuterConnectorForTest({ limit: 10 }, false)).toBe(true);
    expect(shouldPrependPuterConnectorForTest({ limit: 10, cursor: "next-page" }, false)).toBe(false);
  });

  it("still honors Puter connector filters on the first page", () => {
    expect(shouldPrependPuterConnectorForTest({ connected: "true" }, false)).toBe(false);
    expect(shouldPrependPuterConnectorForTest({ search: "gmail" }, false)).toBe(false);
    expect(shouldPrependPuterConnectorForTest({ search: "puter" }, false)).toBe(true);
  });
});

describe("buildMyDayHandoffMessageForTest", () => {
  it("routes handoffs as user messages with todo context for delegation linking", () => {
    const user: UserContext = {
      tenantId: "tenant_test",
      userId: "usr_test",
      phoneNumber: "+15555555555",
      displayName: "Test User",
      timezone: "UTC",
      timezoneSource: "server",
      location: null,
      kidsMode: false,
    };
    const todo: MyDayTodoRecord = {
      id: "todo_123",
      tenantId: "tenant_test",
      userId: "usr_test",
      myDayId: "day_123",
      title: "Reply to insurance email",
      notes: "Needs claim details",
      status: "open",
      source: { type: "my_day_refresh", evidence: "Email from insurer", reason: "Needs response today" },
      handoffAt: null,
      handoffWorkerId: null,
      createdAt: new Date("2026-05-12T00:00:00.000Z"),
      updatedAt: new Date("2026-05-12T00:00:00.000Z"),
      completedAt: null,
      deletedAt: null,
    };

    const message = buildMyDayHandoffMessageForTest(user, todo, "Use a concise tone.");

    expect(message.source).toBe("user");
    expect(message.content).toContain("Todo ID: todo_123");
    expect(message.content).toContain("Evidence: Email from insurer");
    expect(message.content).toContain("User handoff context: Use a concise tone.");
    expect(message.context).toEqual({ myDayHandoffTodoId: "todo_123" });
  });
});
