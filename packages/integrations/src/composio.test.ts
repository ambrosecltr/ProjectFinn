import { beforeEach, describe, expect, it, mock } from "bun:test";

const listTypesMock = mock();
const getTypeMock = mock();
const listConnectedAccountsMock = mock();
const createSessionMock = mock();
const getToolkitMock = mock();

mock.module("@composio/core", () => ({
  Composio: class {
    triggers = {
      listTypes: listTypesMock,
      getType: getTypeMock,
    };
    connectedAccounts = {
      list: listConnectedAccountsMock,
    };
    toolkits = {
      get: getToolkitMock,
    };
    create = createSessionMock;
  },
}));

mock.module("@composio/vercel", () => ({
  VercelProvider: class {},
}));

import { ComposioClient, createComposioSessionConfig } from "./composio.js";

describe("createComposioSessionConfig", () => {
  it("disables connection management and scopes kids-mode sessions to configured toolkits", () => {
    expect(createComposioSessionConfig({
      callbackUrl: "https://example.com/composio/callback",
      allowConnectionRequests: false,
      allowedToolkits: ["gmail", "slack"],
      configuredToolkits: [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "read_only" }],
    })).toEqual({
      manageConnections: false,
      workbench: { enable: false },
      toolkits: { enable: ["gmail"] },
      tools: { gmail: { tags: ["readOnlyHint"] } },
      connectedAccounts: { gmail: ["acct_123"] },
    });
  });

  it("limits configured toolkits to explicit allowed tools when provided", () => {
    expect(createComposioSessionConfig({
      allowConnectionRequests: false,
      configuredToolkits: [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "all", allowedTools: ["GMAIL_FETCH_EMAILS"] }],
    })).toEqual({
      manageConnections: false,
      workbench: { enable: false },
      toolkits: { enable: ["gmail"] },
      tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } },
      connectedAccounts: { gmail: ["acct_123"] },
    });
  });

  it("does not let explicit allowed tools override read-only toolkit scopes", () => {
    expect(createComposioSessionConfig({
      allowConnectionRequests: false,
      configuredToolkits: [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "read_only", allowedTools: ["GMAIL_SEND_EMAIL"] }],
    })).toEqual({
      manageConnections: false,
      workbench: { enable: false },
      toolkits: { enable: ["gmail"] },
      tools: { gmail: { tags: ["readOnlyHint"] } },
      connectedAccounts: { gmail: ["acct_123"] },
    });
  });

  it("preserves allowed toolkit connection setup without configured accounts", () => {
    expect(createComposioSessionConfig({
      callbackUrl: "https://example.com/composio/callback",
      allowConnectionRequests: true,
      allowedToolkits: ["gmail", "slack"],
    })).toEqual({
      manageConnections: { callbackUrl: "https://example.com/composio/callback" },
      workbench: { enable: false },
      toolkits: { enable: ["gmail", "slack"] },
    });
  });

  it("disables connection management when no scoped toolkits are available", () => {
    expect(createComposioSessionConfig({
      allowConnectionRequests: false,
      configuredToolkits: [],
    })).toEqual({
      manageConnections: false,
      workbench: { enable: false },
    });
  });
});

describe("ComposioClient", () => {
  beforeEach(() => {
    listTypesMock.mockReset();
    listTypesMock.mockResolvedValue({ items: [] });
    getTypeMock.mockReset();
    getTypeMock.mockResolvedValue({ slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    listConnectedAccountsMock.mockReset();
    listConnectedAccountsMock.mockResolvedValue({ items: [] });
    createSessionMock.mockReset();
    getToolkitMock.mockReset();
    getToolkitMock.mockResolvedValue({ meta: {} });
  });

  it("does not list trigger types for disallowed toolkits", async () => {
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["outlook"] });

    const triggers = await client.listTriggerTypes("gmail");

    expect(triggers).toEqual([]);
    expect(listTypesMock).not.toHaveBeenCalled();
  });

  it("scopes trigger type listing to allowed toolkits", async () => {
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["gmail", "outlook"] });

    await client.listTriggerTypes();

    expect(listTypesMock).toHaveBeenCalledWith({
      limit: 100,
      toolkits: ["gmail", "outlook"],
    });
  });

  it("returns trigger config and payload schemas from getTriggerType", async () => {
    getTypeMock.mockResolvedValue({
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      toolkit: { slug: "gmail" },
      config: { properties: { query: { type: "string" } } },
      payload: { properties: { sender: { type: "string" } } },
    });
    const client = new ComposioClient({ apiKey: "test" });

    const triggerType = await client.getTriggerType("GMAIL_NEW_GMAIL_MESSAGE");

    expect(triggerType).toEqual({
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      toolkitSlug: "gmail",
      inputSchema: { properties: { query: { type: "string" } } },
      payloadSchema: { properties: { sender: { type: "string" } } },
    });
  });

  it("skips malformed connected account rows from Composio", async () => {
    listConnectedAccountsMock.mockResolvedValue({
      items: [
        {
          id: "acct_123",
          toolkit: { slug: "gmail" },
          status: "ACTIVE",
          statusReason: null,
          alias: "primary",
          isDisabled: false,
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
        },
        {
          id: "",
          toolkit: { slug: "gmail" },
          status: "ACTIVE",
          isDisabled: false,
        },
        {
          id: "acct_missing_toolkit",
          status: "ACTIVE",
          isDisabled: false,
        },
        {
          id: "acct_missing_status",
          toolkit: { slug: "gmail" },
          isDisabled: false,
        },
      ],
    });
    const client = new ComposioClient({ apiKey: "test" });

    const accounts = await client.listConnectedAccounts("tenant_default_usr_test", { statuses: ["ACTIVE"] });

    expect(accounts).toEqual([{
      id: "acct_123",
      toolkitSlug: "gmail",
      status: "ACTIVE",
      statusReason: null,
      alias: "primary",
      isDisabled: false,
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    }]);
    expect(listConnectedAccountsMock).toHaveBeenCalledWith({
      userIds: ["tenant_default_usr_test"],
      limit: 100,
      statuses: ["ACTIVE"],
    });
  });

  it("does not broaden connected account queries to disallowed toolkits", async () => {
    listConnectedAccountsMock.mockResolvedValue({
      items: [{
        id: "acct_slack",
        toolkit: { slug: "slack" },
        status: "ACTIVE",
        isDisabled: false,
      }],
    });
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["gmail"] });

    const accounts = await client.listConnectedAccounts("tenant_default_usr_test", {
      toolkitSlugs: ["slack"],
      statuses: ["ACTIVE"],
    });

    expect(accounts).toEqual([]);
    expect(listConnectedAccountsMock).not.toHaveBeenCalled();
  });

  it("skips per-toolkit metadata fetches when toolkit metadata is disabled", async () => {
    const toolkits = mock(async () => ({
      items: [{
        slug: "gmail",
        name: "Gmail",
        noAuth: false,
      }],
    }));
    createSessionMock.mockResolvedValue({ toolkits });
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["gmail"] });

    const page = await client.getToolkits("tenant_default_usr_test", { includeMetadata: false });

    expect(page.connectors).toEqual([{
      slug: "gmail",
      name: "Gmail",
      requiresAuth: true,
      connected: false,
      enabled: true,
    }]);
    expect(getToolkitMock).not.toHaveBeenCalled();
  });

  it("rejects connected-account tool execution for disallowed toolkits", async () => {
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["gmail"] });

    await expect(client.executeToolForConnectedAccount({
      userId: "tenant_default_usr_test",
      toolkitSlug: "slack",
      connectedAccountId: "acct_slack",
      toolSlug: "SLACK_TEST_AUTH",
    })).rejects.toThrow("Composio toolkit is not enabled: slack");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects connected-account proxy requests for disallowed toolkits", async () => {
    const client = new ComposioClient({ apiKey: "test", allowedToolkits: ["gmail"] });

    await expect(client.proxyExecuteForConnectedAccount({
      userId: "tenant_default_usr_test",
      toolkitSlug: "github",
      connectedAccountId: "acct_github",
      method: "GET",
      endpoint: "/user",
    })).rejects.toThrow("Composio toolkit is not enabled: github");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("proxies connected-account requests through a single Composio session params object", async () => {
    const proxyExecuteMock = mock(async () => ({ status: 200, data: { id: 123 } }));
    createSessionMock.mockResolvedValue({ proxyExecute: proxyExecuteMock });
    const client = new ComposioClient({ apiKey: "test" });

    const result = await client.proxyExecuteForConnectedAccount({
      userId: "tenant_default_usr_test",
      toolkitSlug: "github",
      connectedAccountId: "acct_github",
      method: "GET",
      endpoint: "/user",
      parameters: { page: 1, query: "octo", ignored: null },
    });

    expect(result).toEqual({ status: 200, data: { id: 123 } });
    expect(createSessionMock).toHaveBeenCalledWith("tenant_default_usr_test", {
      manageConnections: false,
      workbench: { enable: false },
      toolkits: { enable: ["github"] },
      tools: { github: { tags: ["readOnlyHint"] } },
      connectedAccounts: { github: ["acct_github"] },
    });
    expect(proxyExecuteMock).toHaveBeenCalledWith({
      toolkit: "github",
      method: "GET",
      endpoint: "/user",
      parameters: [
        { in: "query", name: "page", value: 1 },
        { in: "query", name: "query", value: "octo" },
      ],
    });
  });
});
