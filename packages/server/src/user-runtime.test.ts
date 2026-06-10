import { describe, expect, it } from "bun:test";

import {
  assertComposioPatternAvailability,
  canExposeVoiceReplyTool,
  resolveUserRuntimeRoot,
  resolveWorkerWorkspaceRoot,
  shouldConvertInboundAudioToWav,
  UserRuntimeRegistry,
} from "./user-runtime.js";
import { UserRegistry } from "./user-registry.js";

describe("canExposeVoiceReplyTool", () => {
  it("requires only TTS capability and a TTS client", () => {
    expect(canExposeVoiceReplyTool({
      textToSpeechAvailable: true,
      hasTextToSpeechClient: true,
    })).toBe(true);

    expect(canExposeVoiceReplyTool({ textToSpeechAvailable: false, hasTextToSpeechClient: true })).toBe(false);
    expect(canExposeVoiceReplyTool({ textToSpeechAvailable: true, hasTextToSpeechClient: false })).toBe(false);
  });
});

describe("shouldConvertInboundAudioToWav", () => {
  it("converts iMessage CAF audio before STT provider calls", () => {
    expect(shouldConvertInboundAudioToWav({ mimeType: "audio/x-caf" })).toBe(true);
    expect(shouldConvertInboundAudioToWav({ mimeType: "audio/wav" })).toBe(false);
    expect(shouldConvertInboundAudioToWav({ mimeType: "audio/mpeg" })).toBe(false);
  });
});

describe("UserRegistry.listExistingUsers", () => {
  it("returns users ordered by most recently updated first", async () => {
    const rows = [
      {
        id: "usr_newer",
        tenantId: "tenant_default",
        phoneNumber: "+15550000002",
        displayName: "Newer",
        timezone: "UTC",
        location: null,
        kidsMode: false,
        metadata: { profile: { timezoneSource: "server" } },
        createdAt: new Date("2026-04-30T00:00:00.000Z"),
        updatedAt: new Date("2026-04-30T02:00:00.000Z"),
      },
      {
        id: "usr_older",
        tenantId: "tenant_default",
        phoneNumber: "+15550000001",
        displayName: "Older",
        timezone: "UTC",
        location: null,
        kidsMode: true,
        metadata: { profile: { timezoneSource: "server" } },
        createdAt: new Date("2026-04-30T00:00:00.000Z"),
        updatedAt: new Date("2026-04-30T01:00:00.000Z"),
      },
    ];

    const registry = new UserRegistry({
      config: { userTimezone: "UTC" } as never,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => rows,
                then: undefined,
                [Symbol.asyncIterator]: undefined,
              }),
            }),
          }),
        }),
      } as never,
    });

    const users = await registry.listExistingUsers(2);

    expect(users.map((user) => user.userId)).toEqual(["usr_newer", "usr_older"]);
    expect(users.map((user) => user.kidsMode)).toEqual([false, true]);
  });

  it("returns all users when no limit is provided", async () => {
    const rows = [
      {
        id: "usr_only",
        tenantId: "tenant_default",
        phoneNumber: "+15550000001",
        displayName: null,
        timezone: "UTC",
        location: null,
        kidsMode: true,
        metadata: { profile: { timezoneSource: "server" } },
        createdAt: new Date("2026-04-30T00:00:00.000Z"),
        updatedAt: new Date("2026-04-30T01:00:00.000Z"),
      },
    ];

    const registry = new UserRegistry({
      config: { userTimezone: "UTC" } as never,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => rows,
            }),
          }),
        }),
      } as never,
    });

    const users = await registry.listExistingUsers();

    expect(users.map((user) => user.userId)).toEqual(["usr_only"]);
    expect(users[0]?.kidsMode).toBe(true);
  });
});

describe("UserRuntimeRegistry", () => {
  it("keys runtimes by tenant and user id", () => {
    const registry = new UserRuntimeRegistry({
      config: {} as never,
      db: {} as never,
      llmManager: {} as never,
      eventBus: {} as never,
      spectrumClient: {} as never,
      integrations: {} as never,
      userRegistry: {} as never,
    });

    expect((registry as unknown as { runtimeKey(user: { tenantId: string; userId: string }): string }).runtimeKey({
      tenantId: "tenant_a",
      userId: "usr_1",
    })).toBe("tenant_a:usr_1");

    expect((registry as unknown as { runtimeKey(user: { tenantId: string; userId: string }): string }).runtimeKey({
      tenantId: "tenant_b",
      userId: "usr_1",
    })).toBe("tenant_b:usr_1");
  });

  it("refreshes an existing runtime when kids mode changes", async () => {
    const adultUser = {
      tenantId: "tenant_a",
      userId: "usr_1",
      phoneNumber: "+10000000000",
      displayName: "Test User",
      timezone: "UTC",
      timezoneSource: "server" as const,
      location: null,
      kidsMode: false,
    };
    const kidsUser = { ...adultUser, kidsMode: true };
    const hotPathAgent = { setIdentityFiles: () => undefined };
    const runtime = {
      user: { ...adultUser },
      ingress: { updateUser: () => undefined },
      workerToolsDeps: { allowComposioConnectionRequests: true },
      hotPathAgent,
      messageSender: { setRecipient: () => undefined },
      mcpService: { loadConfigs: async () => undefined },
    };
    const registry = new UserRuntimeRegistry({
      config: {
        capabilities: {
          media: { fileStorage: true, textToSpeech: false, voiceRoundTrip: false },
          tools: { worker: {} },
        },
      } as never,
      db: {} as never,
      llmManager: {} as never,
      eventBus: {} as never,
      spectrumClient: {} as never,
      integrations: {} as never,
      userRegistry: {} as never,
    });

    (registry as unknown as { runtimes: Map<string, Promise<typeof runtime>> }).runtimes.set(
      "tenant_a:usr_1",
      Promise.resolve(runtime),
    );
    (registry as unknown as { reloadMcpServers: () => Promise<void> }).reloadMcpServers = async () => undefined;

    const refreshed = await registry.ensure(kidsUser);

    expect(refreshed.user.kidsMode).toBe(true);
    expect(refreshed.workerToolsDeps.allowComposioConnectionRequests).toBe(false);
  });

  it("resolves stored-file runtime access without starting the full user runtime", async () => {
    const user = {
      tenantId: "tenant_a",
      userId: "usr_1",
      phoneNumber: "+10000000000",
      displayName: null,
      timezone: "UTC",
      timezoneSource: "server" as const,
      location: null,
      kidsMode: false,
    };
    const registry = new UserRuntimeRegistry({
      config: {
        workerSandbox: { workspacesPath: "/tmp/finn-workspaces" },
        fileStorage: { maxFileSizeMb: 10 },
        publicUrl: "http://localhost",
      } as never,
      db: {} as never,
      llmManager: {} as never,
      eventBus: {} as never,
      spectrumClient: {} as never,
      integrations: {} as never,
      userRegistry: { requireUser: async () => user } as never,
    });

    const runtime = await registry.getFilesRuntime({ tenantId: "tenant_a", userId: "usr_1" });

    expect(runtime.workspaceRoot).toBe("/tmp/finn-workspaces/tenant_a/usr_1/workspace");
    expect((registry as unknown as { runtimes: Map<string, unknown> }).runtimes.size).toBe(0);
  });

  it("resolves a Composio service without starting unrelated runtime services", async () => {
    const user = {
      tenantId: "tenant_a",
      userId: "usr_1",
      phoneNumber: "+10000000000",
      displayName: null,
      timezone: "UTC",
      timezoneSource: "server" as const,
      location: null,
      kidsMode: false,
    };
    const registry = new UserRuntimeRegistry({
      config: {
        workerSandbox: { workspacesPath: "/tmp/finn-workspaces" },
        fileStorage: { maxFileSizeMb: 10 },
        publicUrl: "http://localhost",
      } as never,
      db: {} as never,
      llmManager: {} as never,
      eventBus: {} as never,
      spectrumClient: {} as never,
      integrations: {
        composio: {
          getAllowedToolkits: () => ["gmail"],
        },
      } as never,
      userRegistry: { requireUser: async () => user } as never,
    });

    const composio = await registry.getComposioService({ tenantId: "tenant_a", userId: "usr_1" });

    expect(composio?.composioUserId).toBe("tenant_a_usr_1");
    expect((registry as unknown as { runtimes: Map<string, unknown> }).runtimes.size).toBe(0);
  });
});

describe("assertComposioPatternAvailability", () => {
  it("checks system toolkit availability before user connection state", async () => {
    const calls: string[] = [];

    await expect(assertComposioPatternAvailability({
      toolkitSlug: "slack",
      triggerSlug: "new_message",
      connectedAccountId: "acct_123",
      allowedToolkits: ["gmail"],
      listTriggerTypes: async () => {
        calls.push("triggers");
        return [];
      },
      getConnectorConfig: async () => {
        calls.push("connector");
        return null;
      },
    })).rejects.toThrow("Composio toolkit is not enabled: slack");

    expect(calls).toEqual([]);
  });

  it("checks trigger availability before user connection state", async () => {
    const calls: string[] = [];

    await expect(assertComposioPatternAvailability({
      toolkitSlug: "gmail",
      triggerSlug: "new_email",
      connectedAccountId: "acct_123",
      allowedToolkits: ["gmail"],
      listTriggerTypes: async () => {
        calls.push("triggers");
        return [{ slug: "email_sent" }];
      },
      getConnectorConfig: async () => {
        calls.push("connector");
        return null;
      },
    })).rejects.toThrow("Composio trigger is not enabled for gmail: new_email");

    expect(calls).toEqual(["triggers"]);
  });

  it("requires the connected account to belong to the user", async () => {
    await expect(assertComposioPatternAvailability({
      toolkitSlug: "gmail",
      triggerSlug: "new_email",
      connectedAccountId: "acct_requested",
      allowedToolkits: ["gmail"],
      listTriggerTypes: async () => [{ slug: "new_email" }],
      getConnectorConfig: async () => ({ connected: true, connectedAccountId: "acct_other" }),
    })).rejects.toThrow("Composio toolkit is not connected for this user: gmail");
  });

  it("requires the selected trigger type to belong to the requested toolkit", async () => {
    await expect(assertComposioPatternAvailability({
      toolkitSlug: "gmail",
      triggerSlug: "slack_message",
      connectedAccountId: "acct_123",
      allowedToolkits: ["gmail", "slack"],
      listTriggerTypes: async () => [{ slug: "slack_message" }],
      getTriggerType: async () => ({ slug: "slack_message", toolkitSlug: "slack" }),
      getConnectorConfig: async () => ({ connected: true, connectedAccountId: "acct_123" }),
    })).rejects.toThrow("Composio trigger slack_message belongs to slack, not gmail");
  });

  it("allows enabled triggers for the user's connected account", async () => {
    await expect(assertComposioPatternAvailability({
      toolkitSlug: "gmail",
      triggerSlug: "new_email",
      connectedAccountId: "acct_123",
      allowedToolkits: ["gmail"],
      listTriggerTypes: async () => [{ slug: "new_email" }],
      getTriggerType: async () => ({ slug: "new_email", toolkitSlug: "gmail" }),
      getConnectorConfig: async () => ({ connected: true, connectedAccountId: "acct_123" }),
    })).resolves.toBeUndefined();
  });
});

describe("worker workspace paths", () => {
  const user = {
    tenantId: "tenant_a",
    userId: "usr_1",
  } as never;

  it("scopes worker workspaces by tenant and user", () => {
    const userRoot = resolveUserRuntimeRoot({
      workerSandbox: { workspacesPath: "/data/workspaces" },
    } as never, user);
    const workspaceRoot = resolveWorkerWorkspaceRoot({
      workerSandbox: { workspacesPath: "/data/workspaces" },
    } as never, user);

    expect(userRoot).toBe("/data/workspaces/tenant_a/usr_1");
    expect(workspaceRoot).toBe("/data/workspaces/tenant_a/usr_1/workspace");
  });

});
