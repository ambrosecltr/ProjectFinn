import { describe, expect, it, mock } from "bun:test";
import type { MessageInput, PeerAddition, SessionConfig, WorkspaceConfig } from "@honcho-ai/sdk";

import { buildHonchoFilters, HonchoClient } from "./honcho.js";

const user = {
  tenantId: "tenant.test",
  userId: "usr:test/one",
};

interface FakeMessage {
  id: string;
  content: string;
  peerId: string;
  sessionId: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  tokenCount: number;
}

class FakePeer {
  readonly id: string;
  readonly context = mock(async () => ({
    representation: null as string | null,
    peerCard: null as string[] | null,
  }));
  readonly chat = mock(async () => null as string | null);

  constructor(id: string) {
    this.id = id;
  }

  message(content: string, options: {
    metadata?: Record<string, unknown>;
    configuration?: { reasoning?: { enabled?: boolean | null; customInstructions?: string | null } | null } | null;
    createdAt?: string | Date;
  } = {}): MessageInput {
    return {
      peerId: this.id,
      content,
      metadata: options.metadata,
      configuration: options.configuration,
      createdAt: options.createdAt instanceof Date ? options.createdAt.toISOString() : options.createdAt,
    };
  }
}

class FakeSession {
  readonly id: string;
  readonly workspaceId: string;
  addedMessages: MessageInput[] = [];
  readonly addMessages = mock(async (messages: MessageInput | MessageInput[]) => {
    this.addedMessages = Array.isArray(messages) ? messages : [messages];
    return this.addedMessages.map((message, index): FakeMessage => ({
      id: `created_${index}`,
      content: message.content,
      peerId: message.peerId,
      sessionId: this.id,
      workspaceId: this.workspaceId,
      metadata: message.metadata ?? {},
      createdAt: message.createdAt ?? "2026-06-04T00:00:00.000Z",
      tokenCount: 1,
    }));
  });

  constructor(id: string, workspaceId: string) {
    this.id = id;
    this.workspaceId = workspaceId;
  }
}

class FakeHonchoSdkClient {
  readonly workspaceId: string;
  readonly peers = new Map<string, FakePeer>();
  readonly sessions = new Map<string, FakeSession>();
  readonly peerCalls: Array<{ id: string; options?: { metadata?: Record<string, unknown>; configuration?: { observeMe?: boolean | null } } }> = [];
  readonly sessionCalls: Array<{ id: string; options?: { metadata?: Record<string, unknown>; configuration?: SessionConfig; peers?: PeerAddition } }> = [];
  searchResults: FakeMessage[] = [];

  readonly setMetadata = mock(async (_metadata: Record<string, unknown>) => {});
  readonly setConfiguration = mock(async (_configuration: WorkspaceConfig) => {});
  readonly peer = mock(async (id: string, options?: { metadata?: Record<string, unknown>; configuration?: { observeMe?: boolean | null } }) => {
    this.peerCalls.push({ id, options });
    let peer = this.peers.get(id);
    if (!peer) {
      peer = new FakePeer(id);
      this.peers.set(id, peer);
    }
    return peer;
  });
  readonly session = mock(async (id: string, options?: { metadata?: Record<string, unknown>; configuration?: SessionConfig; peers?: PeerAddition }) => {
    this.sessionCalls.push({ id, options });
    let session = this.sessions.get(id);
    if (!session) {
      session = new FakeSession(id, this.workspaceId);
      this.sessions.set(id, session);
    }
    return session;
  });
  readonly search = mock(async (_query: string, _options?: { filters?: Record<string, unknown>; limit?: number }) => this.searchResults);

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  getPeer(id: string): FakePeer {
    const peer = this.peers.get(id);
    if (!peer) {
      throw new Error(`Missing fake peer ${id}`);
    }
    return peer;
  }

  getLastSession(): FakeSession {
    const id = this.sessionCalls.at(-1)?.id;
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) {
      throw new Error("Missing fake session");
    }
    return session;
  }
}

function createClient() {
  let sdkClient: FakeHonchoSdkClient | null = null;
  const client = new HonchoClient({
    apiKey: "test",
    workspacePrefix: "finn-dev",
    sdkClientFactory: (workspaceId: string) => {
      sdkClient = new FakeHonchoSdkClient(workspaceId);
      return sdkClient as never;
    },
  } as never);

  return {
    client,
    get sdkClient(): FakeHonchoSdkClient {
      if (!sdkClient) {
        throw new Error("SDK client was not created");
      }
      return sdkClient;
    },
  };
}

describe("HonchoClient", () => {
  it("builds stable provider-safe workspace and custom IDs", () => {
    const { client } = createClient();

    expect(client.getUserWorkspaceId(user).startsWith("finn-dev_user_tenant.test_usr_test_one_")).toBe(true);
    expect(client.buildHotPathTurnCustomId("msg:abc/123").startsWith("hot-path-turn_msg_abc_123_")).toBe(true);
    expect(client.buildPatternRunCustomId("ptrun:abc/123").startsWith("pattern-run_ptrun_abc_123_")).toBe(true);
  });

  it("stores Finn/user conversation turns in a user-scoped workspace with Finn observing the user peer", async () => {
    const setup = createClient();
    const { client } = setup;

    const result = await client.addDocument({
      user,
      customId: "hot-path-turn_msg_123",
      content: "user: coffee please\nassistant: yep",
      conversationMessages: [
        {
          role: "user",
          content: "I like coffee in the morning.",
          timestamp: "2026-06-04T08:00:00.000Z",
          messageId: "msg_user",
          attachments: [{ filename: "menu.png", mimeType: "image/png", context: "coffee menu" }],
        },
        {
          role: "assistant",
          content: "noted",
          timestamp: "2026-06-04T08:00:02.000Z",
          delivered: true,
        },
      ],
      source: { provider: "imessage", type: "conversation", id: "msg_123", timestamp: "2026-06-04T08:00:00.000Z" },
      metadata: { kind: "hot_path_turn", source: "hot_path", conversationId: "conv_1", day: "2026-06-04" },
    });
    const sdkClient = setup.sdkClient;

    expect(result).toEqual({ id: "created_0", status: "queued" });
    expect(sdkClient.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      peerCard: { use: true, create: true },
      summary: expect.objectContaining({ enabled: true }),
    }));
    expect(sdkClient.peerCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "user", options: expect.objectContaining({ configuration: { observeMe: true } }) }),
      expect.objectContaining({ id: "finn", options: expect.objectContaining({ configuration: { observeMe: false } }) }),
    ]));
    expect(sdkClient.sessionCalls[0]?.options?.peers).toEqual([
      ["user", { observeMe: true, observeOthers: false }],
      ["finn", { observeMe: false, observeOthers: true }],
    ]);
    expect(sdkClient.sessionCalls[0]?.options?.configuration?.reasoning?.customInstructions).toContain("single-user personal intelligence companion");

    const messages = sdkClient.getLastSession().addedMessages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      peerId: "user",
      content: "I like coffee in the morning.\n\nAttachments:\n- menu.png (image/png): coffee menu",
      metadata: expect.objectContaining({
        customId: "hot-path-turn_msg_123",
        role: "user",
        messageId: "msg_user",
        sourceProvider: "imessage",
      }),
      configuration: { reasoning: { enabled: true } },
      createdAt: "2026-06-04T08:00:00.000Z",
    });
    expect(messages[1]).toMatchObject({
      peerId: "finn",
      content: "noted",
      metadata: expect.objectContaining({ role: "assistant", delivered: true }),
      configuration: { reasoning: { enabled: false } },
    });
  });

  it("searches concrete Honcho messages with Finn metadata filters", async () => {
    const setup = createClient();
    const { client } = setup;
    await client.provisionUserBank(user);
    const sdkClient = setup.sdkClient;
    sdkClient.searchResults = [{
      id: "msg_search",
      content: "User prefers concise morning updates.",
      peerId: "user",
      sessionId: "session_1",
      workspaceId: "workspace_1",
      metadata: { kind: "hot_path_turn", messageId: "msg_1" },
      createdAt: "2026-06-04T08:00:00.000Z",
      tokenCount: 8,
    }];

    const response = await client.searchDocuments({
      user,
      query: "morning updates",
      limit: 3,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]).toMatchObject({
      documentId: "msg_search",
      content: "User prefers concise morning updates.",
      metadata: expect.objectContaining({ peerId: "user", sessionId: "session_1", messageId: "msg_1" }),
    });
    expect(sdkClient.search).toHaveBeenCalledWith("morning updates", {
      filters: { metadata: { kind: "hot_path_turn", source: "hot_path" } },
      limit: 3,
    });
  });

  it("builds automatic context from Finn's cross-session representation of the user peer", async () => {
    const setup = createClient();
    const { client } = setup;
    await client.provisionUserBank(user);
    const sdkClient = setup.sdkClient;
    const finn = sdkClient.getPeer("finn");
    finn.context.mockResolvedValueOnce({
      representation: [
        "## Explicit Observations",
        "",
        "[2025-10-16 06:31:10] User's WorkCover claim reference is C0007474115.",
        "[2026-04-01 00:04:02] User has an active personal injury damages claim with TPIL Lawyers Pty Ltd.",
        "",
        "## Inductive Observations",
        "",
        " **Pattern** [medium]: User tracks legal and financial disputes carefully.",
        " **Pattern** [medium]: User often keeps detailed records for grievances.",
      ].join("\n"),
      peerCard: null,
    });

    const response = await client.buildContext({
      user,
      query: "communication style",
      limit: 3,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    });

    const contextOptions = (finn.context.mock.calls as unknown as Array<[{
      target?: string;
      searchQuery?: string;
      searchTopK?: number;
      maxConclusions?: number;
    }]>)[0]?.[0];
    expect(contextOptions?.target).toBe("user");
    expect(finn.context).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: "communication style",
      searchTopK: 3,
      maxConclusions: 8,
    }));
    expect(sdkClient.search).not.toHaveBeenCalled();
    expect(response).toEqual({
      ok: true,
      results: [
        {
          text: "User's WorkCover claim reference is C0007474115.",
          type: "explicit_observation",
          occurredAt: "2025-10-16 06:31:10",
        },
        {
          text: "User has an active personal injury damages claim with TPIL Lawyers Pty Ltd.",
          type: "explicit_observation",
          occurredAt: "2026-04-01 00:04:02",
        },
        {
          text: "User tracks legal and financial disputes carefully.",
          type: "inductive_observation",
          occurredAt: null,
        },
      ],
    });
  });

  it("returns the peer card and broad representation for profile context", async () => {
    const setup = createClient();
    const { client } = setup;
    const response = {
      representation: "User prefers concise updates.\nUser is planning a product launch.",
      peerCard: ["Alex lives in Brisbane.", "Alex likes direct answers."],
    };

    await client.provisionUserBank(user);
    const sdkClient = setup.sdkClient;
    sdkClient.getPeer("finn").context.mockResolvedValueOnce(response);

    await expect(client.buildProfileContext({ user })).resolves.toEqual({
      ok: true,
      profile: {
        static: response.peerCard,
        dynamic: ["User prefers concise updates.", "User is planning a product launch."],
      },
    });
    expect(sdkClient.getPeer("finn").context).toHaveBeenCalledWith({
      target: "user",
      includeMostFrequent: true,
      maxConclusions: 30,
    });
  });

  it("uses peer.chat with a target peer only for explicit memory reflection", async () => {
    const setup = createClient();
    const { client } = setup;

    await client.provisionUserBank(user);
    const sdkClient = setup.sdkClient;
    sdkClient.getPeer("finn").chat.mockResolvedValueOnce("The user prefers concise morning updates.");

    await expect(client.reflectMemory({
      user,
      query: "how should Finn brief the user?",
      budget: "high",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
    })).resolves.toEqual({
      ok: true,
      answer: "The user prefers concise morning updates.",
      evidence: null,
    });

    const chatOptions = (sdkClient.getPeer("finn").chat.mock.calls as unknown as Array<[string, {
      target?: string;
      reasoningLevel?: string;
    }]>)[0]?.[1];
    expect(chatOptions?.target).toBe("user");
    expect(chatOptions?.reasoningLevel).toBe("high");
  });

  it("scopes Pattern reflection to the Pattern peer instead of the user peer", async () => {
    const setup = createClient();
    const { client } = setup;

    await client.reflectMemory({
      user,
      query: "what changed in prior runs?",
      budget: "low",
      metadata: { kind: "pattern_run_outcome", source: "pattern_worker", patternId: "pat:abc/123" },
    });

    const sdkClient = setup.sdkClient;
    const chatOptions = (sdkClient.getPeer("finn").chat.mock.calls as unknown as Array<[string, {
      target?: string;
      reasoningLevel?: string;
    }]>)[0]?.[1];
    expect(chatOptions?.target?.startsWith("pattern_pat_abc_123_")).toBe(true);
    expect(chatOptions?.reasoningLevel).toBe("low");
  });
});

describe("buildHonchoFilters", () => {
  it("builds Honcho metadata and peer filters", () => {
    expect(buildHonchoFilters({
      kind: "hot_path_turn",
      source: "hot_path",
      supportingMessageIds: ["msg_1", "msg_2"],
    }, ["user", "finn"])).toEqual({
      AND: [
        {
          metadata: {
            kind: "hot_path_turn",
            source: "hot_path",
          },
        },
        {
          OR: [
            { metadata: { supportingMessageIds: { contains: "msg_1" } } },
            { metadata: { supportingMessageIds: { contains: "msg_2" } } },
          ],
        },
        { peer_id: { in: ["user", "finn"] } },
      ],
    });
  });
});
