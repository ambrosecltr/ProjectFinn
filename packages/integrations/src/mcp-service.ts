import { createLogger, generateId, getTracer, truncate, withSpan } from "@finn/core";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const logger = createLogger("mcp-service");
const tracer = getTracer("mcp");
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_RESOURCE_TEXT_CHARS = 12_000;

const httpTransportSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const sseTransportSchema = z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const stdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional(),
});

const oauthAuthSchema = z.object({
  type: z.literal("oauth"),
});

const mcpServerConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  alwaysOn: z.boolean().optional(),
  auth: oauthAuthSchema.optional(),
  transport: z.discriminatedUnion("type", [httpTransportSchema, sseTransportSchema, stdioTransportSchema]),
});

const toolArgumentsSchema = z.record(z.string(), z.unknown());

export type McpTransportConfig = z.infer<typeof mcpServerConfigSchema>["transport"];
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export interface McpOAuthState {
  state?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthStore {
  redirectUrl(server: string): string | URL;
  clientMetadata(server: string): OAuthClientMetadata;
  clientMetadataUrl?(server: string): string | undefined;
  loadState(server: string): Promise<McpOAuthState | undefined>;
  saveState(server: string, state: McpOAuthState): Promise<void>;
  onRedirect?(server: string, authorizationUrl: URL): void | Promise<void>;
}

export interface McpToolSummary {
  server: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  annotations?: ToolAnnotations;
}

export interface McpResourceSummary {
  server: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpServerStatus {
  server: string;
  description?: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  resourceCount: number;
  alwaysOn: boolean;
  error?: string;
}

export interface McpBroker {
  getConnectedServers(): string[];
  getStatuses(): McpServerStatus[];
  searchTools(params: {
    query: string;
    server?: string;
    limit?: number;
  }): Promise<McpToolSummary[]>;
  callTool(params: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    server: string;
    tool: string;
    isError: boolean;
    content: string;
    structuredContent?: Record<string, unknown>;
  }>;
  listResources(params?: {
    server?: string;
  }): Promise<McpResourceSummary[]>;
  readResource(params: {
    server: string;
    uri: string;
  }): Promise<{
    server: string;
    uri: string;
    contents: McpResourceContent[];
  }>;
}

type ConnectedServer = {
  config: McpServerConfig;
  client: Client;
  tools: Tool[];
  resources: Resource[];
};

type FailedServer = {
  config: McpServerConfig;
  error: string;
};

type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

class PersistedOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  constructor(
    private readonly serverName: string,
    private readonly store: McpOAuthStore,
  ) {
    this.clientMetadataUrl = store.clientMetadataUrl?.(serverName);
  }

  get redirectUrl(): string | URL {
    return this.store.redirectUrl(this.serverName);
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.store.clientMetadata(this.serverName);
  }

  async state(): Promise<string> {
    const current = await this.store.loadState(this.serverName) ?? {};
    if (current.state) {
      return current.state;
    }

    const state = generateId("mcp_oauth");
    await this.store.saveState(this.serverName, { ...current, state });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.loadState(this.serverName))?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.mergeState({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.loadState(this.serverName))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.mergeState({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.store.onRedirect?.(this.serverName, authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.mergeState({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = (await this.store.loadState(this.serverName))?.codeVerifier;
    if (!codeVerifier) {
      throw new Error(`Missing OAuth code verifier for MCP server: ${this.serverName}`);
    }
    return codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.mergeState({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.loadState(this.serverName))?.discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const current = await this.store.loadState(this.serverName) ?? {};
    const next: McpOAuthState = { ...current };
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "verifier") delete next.codeVerifier;
    if (scope === "all" || scope === "discovery") delete next.discoveryState;
    await this.store.saveState(this.serverName, next);
  }

  private async mergeState(patch: McpOAuthState): Promise<void> {
    const current = await this.store.loadState(this.serverName) ?? {};
    await this.store.saveState(this.serverName, { ...current, ...patch });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toolSearchText(tool: Tool): string {
  return [tool.name, tool.title, tool.description]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function scoreTextMatch(haystack: string, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return 0;
  }

  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function resultToDisplayText(result: CallToolResult): string {
  const parts = result.content.map((content) => {
    if (content.type === "text") {
      return content.text;
    }

    if (content.type === "resource") {
      if ("text" in content.resource) {
        return content.resource.text;
      }
      return `[resource ${content.resource.uri}]`;
    }

    if (content.type === "resource_link") {
      return `[resource link ${content.uri}]`;
    }

    if (content.type === "image") {
      return `[image ${content.mimeType}]`;
    }

    if (content.type === "audio") {
      return `[audio ${content.mimeType}]`;
    }

    return JSON.stringify(content);
  });

  if (result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent));
  }

  return truncate(parts.filter((part) => part.length > 0).join("\n").trim(), MAX_TOOL_OUTPUT_CHARS);
}

function isCallToolContentResult(result: ClientCallToolResult): result is CallToolResult {
  return "content" in result;
}

function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function truncateBlob(blob: string | undefined): string | undefined {
  if (!blob) {
    return undefined;
  }

  return truncate(blob, MAX_RESOURCE_TEXT_CHARS);
}

function supportsTools(client: Client): boolean {
  return Boolean(client.getServerCapabilities()?.tools);
}

function supportsResources(client: Client): boolean {
  return Boolean(client.getServerCapabilities()?.resources);
}

async function collectAllTools(client: Client): Promise<Tool[]> {
  if (!supportsTools(client)) {
    return [];
  }

  const tools: Tool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

async function collectAllResources(client: Client): Promise<Resource[]> {
  if (!supportsResources(client)) {
    return [];
  }

  const resources: Resource[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listResources(cursor ? { cursor } : undefined);
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);

  return resources;
}

function createOAuthProvider(config: McpServerConfig, oauthStore?: McpOAuthStore): OAuthClientProvider | undefined {
  if (config.auth?.type !== "oauth") {
    return undefined;
  }

  if (!oauthStore) {
    throw new Error(`MCP OAuth store is not configured for server: ${config.name}`);
  }

  return new PersistedOAuthProvider(config.name, oauthStore);
}

async function createClient(config: McpServerConfig, oauthStore?: McpOAuthStore): Promise<Client> {
  const client = new Client({ name: "Finn MCP broker", version: "1.0.0" });
  const authProvider = createOAuthProvider(config, oauthStore);

  if (config.transport.type === "stdio") {
    if (authProvider) {
      throw new Error("OAuth is not supported for stdio MCP transports.");
    }
    await client.connect(new StdioClientTransport({
      command: config.transport.command,
      args: config.transport.args,
      env: config.transport.env,
      cwd: config.transport.cwd,
      stderr: "inherit",
    }));
    return client;
  }

  if (config.transport.type === "sse") {
    const headers = config.transport.headers;
    await client.connect(new SSEClientTransport(new URL(config.transport.url), {
      authProvider,
      requestInit: {
        headers,
      },
      eventSourceInit: {
        fetch: (input, init) => fetch(input, {
          ...init,
          headers,
        }),
      },
    }));
    return client;
  }

  const headers = config.transport.headers;
  await client.connect(new StreamableHTTPClientTransport(new URL(config.transport.url), {
    authProvider,
    requestInit: {
      headers,
    },
  }));
  return client;
}

export class McpService implements McpBroker {
  private readonly initialConfigs?: McpServerConfig[];
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly connectedServers = new Map<string, ConnectedServer>();
  private readonly failedServers = new Map<string, FailedServer>();
  private readonly oauthStore?: McpOAuthStore;

  constructor(opts: { configs?: McpServerConfig[]; oauthStore?: McpOAuthStore }) {
    this.oauthStore = opts.oauthStore;
    this.initialConfigs = opts.configs ?? [];
  }

  async initialize(): Promise<void> {
    await this.loadConfigs(this.initialConfigs ?? []);
  }

  async loadConfigs(configs: McpServerConfig[]): Promise<void> {
    await this.close();
    this.configs.clear();
    this.failedServers.clear();

    for (const config of configs) {
      this.configs.set(config.name, config);

      if (config.alwaysOn === false) {
        continue;
      }

      await this.connectServer(config.name);
    }
  }

  async close(): Promise<void> {
    const connected = Array.from(this.connectedServers.values());
    this.connectedServers.clear();

    for (const server of connected) {
      await server.client.close();
    }
  }

  getConnectedServers(): string[] {
    return Array.from(this.connectedServers.keys());
  }

  getStatuses(): McpServerStatus[] {
    const configured = Array.from(this.configs.values()).map((config) => {
      const connected = this.connectedServers.get(config.name);
      if (connected) {
        return {
          server: config.name,
          description: config.description,
          transport: config.transport.type,
          connected: true,
          toolCount: connected.tools.length,
          resourceCount: connected.resources.length,
          alwaysOn: config.alwaysOn ?? true,
        } satisfies McpServerStatus;
      }

      const failed = this.failedServers.get(config.name);
      return {
        server: config.name,
        description: config.description,
        transport: config.transport.type,
        connected: false,
        toolCount: 0,
        resourceCount: 0,
        alwaysOn: config.alwaysOn ?? true,
        error: failed?.error,
      } satisfies McpServerStatus;
    });

    return configured.sort((left, right) => left.server.localeCompare(right.server));
  }

  async finishOAuth(serverName: string, authorizationCode: string): Promise<void> {
    if (!this.configs.has(serverName) && this.initialConfigs) {
      for (const config of this.initialConfigs) {
        this.configs.set(config.name, config);
      }
    }

    const config = this.configs.get(serverName);
    if (!config) {
      throw new Error(`MCP server not configured: ${serverName}`);
    }
    if (config.auth?.type !== "oauth") {
      throw new Error(`MCP server does not use OAuth: ${serverName}`);
    }
    if (!this.oauthStore) {
      throw new Error(`MCP OAuth store is not configured for server: ${serverName}`);
    }

    const authProvider = createOAuthProvider(config, this.oauthStore);
    if (!authProvider) {
      throw new Error(`MCP OAuth provider could not be created for server: ${serverName}`);
    }

    if (config.transport.type === "http") {
      const transport = new StreamableHTTPClientTransport(new URL(config.transport.url), {
        authProvider,
        requestInit: { headers: config.transport.headers },
      });
      await transport.finishAuth(authorizationCode);
      await transport.close();
    } else if (config.transport.type === "sse") {
      const headers = config.transport.headers;
      const transport = new SSEClientTransport(new URL(config.transport.url), {
        authProvider,
        requestInit: { headers },
        eventSourceInit: {
          fetch: (input, init) => fetch(input, {
            ...init,
            headers,
          }),
        },
      });
      await transport.finishAuth(authorizationCode);
      await transport.close();
    } else {
      throw new Error("OAuth is not supported for stdio MCP transports.");
    }

    await this.connectServer(serverName);
  }

  async searchTools(params: {
    query: string;
    server?: string;
    limit?: number;
  }): Promise<McpToolSummary[]> {
    const limit = Math.max(1, Math.min(params.limit ?? 10, 25));
    const candidates = await this.getSearchableServers(params.server);
    const scored: Array<{ score: number; tool: McpToolSummary }> = [];

    for (const server of candidates) {
      for (const tool of server.tools) {
        const haystack = `${server.config.name.toLowerCase()} ${toolSearchText(tool)}`;
        const score = scoreTextMatch(haystack, params.query);
        if (score === 0) {
          continue;
        }

        scored.push({
          score,
          tool: {
            server: server.config.name,
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
        });
      }
    }

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.tool.server !== right.tool.server) {
        return left.tool.server.localeCompare(right.tool.server);
      }
      return left.tool.name.localeCompare(right.tool.name);
    });

    return scored.slice(0, limit).map((entry) => entry.tool);
  }

  async callTool(params: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    server: string;
    tool: string;
    isError: boolean;
    content: string;
    structuredContent?: Record<string, unknown>;
  }> {
    const args = toolArgumentsSchema.parse(params.arguments ?? {});
    const server = await this.requireServer(params.server);
    const tool = server.tools.find((entry) => entry.name === params.tool);

    if (!tool) {
      throw new Error(`MCP tool not found: ${params.server}.${params.tool}`);
    }

    return withSpan(tracer, "mcp.call_tool", {
      "mcp.server": params.server,
      "mcp.tool": params.tool,
    }, async () => {
      const result = await server.client.callTool({
        name: params.tool,
        arguments: args,
      });

        return {
          server: params.server,
          tool: params.tool,
          isError: isCallToolContentResult(result) ? result.isError === true : false,
          content: isCallToolContentResult(result)
            ? resultToDisplayText(result)
          : truncate(JSON.stringify(result.toolResult), MAX_TOOL_OUTPUT_CHARS),
          structuredContent: isCallToolContentResult(result)
            ? toStructuredContent(result.structuredContent)
            : undefined,
      };
    });
  }

  async listResources(params?: {
    server?: string;
  }): Promise<McpResourceSummary[]> {
    const servers = await this.getSearchableServers(params?.server);
    return servers
      .flatMap((server) => server.resources.map((resource) => ({
        server: server.config.name,
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        size: resource.size,
      } satisfies McpResourceSummary)))
      .sort((left, right) => {
        if (left.server !== right.server) {
          return left.server.localeCompare(right.server);
        }
        return left.name.localeCompare(right.name);
      });
  }

  async readResource(params: {
    server: string;
    uri: string;
  }): Promise<{
    server: string;
    uri: string;
    contents: McpResourceContent[];
  }> {
    const server = await this.requireServer(params.server);

    if (!supportsResources(server.client)) {
      throw new Error(`MCP server does not support resources: ${params.server}`);
    }

    return withSpan(tracer, "mcp.read_resource", {
      "mcp.server": params.server,
      "mcp.uri": params.uri,
    }, async () => {
      const result = await server.client.readResource({ uri: params.uri });
      return {
        server: params.server,
        uri: params.uri,
        contents: result.contents.map((content) => ({
          uri: content.uri,
          mimeType: content.mimeType,
          text: "text" in content ? truncate(content.text, MAX_RESOURCE_TEXT_CHARS) : undefined,
          blob: "blob" in content ? truncateBlob(content.blob) : undefined,
        } satisfies McpResourceContent)),
      };
    });
  }

  private async getSearchableServers(serverName?: string): Promise<ConnectedServer[]> {
    if (serverName) {
      return [await this.requireServer(serverName)];
    }

    const results: ConnectedServer[] = [];
    for (const config of this.configs.values()) {
      results.push(await this.requireServer(config.name));
    }
    return results;
  }

  private async requireServer(serverName: string): Promise<ConnectedServer> {
    const existing = this.connectedServers.get(serverName);
    if (existing) {
      return existing;
    }

    if (!this.configs.has(serverName)) {
      throw new Error(`MCP server not configured: ${serverName}`);
    }

    await this.connectServer(serverName);
    const connected = this.connectedServers.get(serverName);
    if (!connected) {
      const failed = this.failedServers.get(serverName);
      throw new Error(failed?.error ?? `Failed to connect MCP server: ${serverName}`);
    }

    return connected;
  }

  private async connectServer(serverName: string): Promise<void> {
    const config = this.configs.get(serverName);
    if (!config) {
      throw new Error(`MCP server not configured: ${serverName}`);
    }

    try {
      const client = await createClient(config, this.oauthStore);
      const [tools, resources] = await Promise.all([collectAllTools(client), collectAllResources(client)]);

      const connected: ConnectedServer = {
        config,
        client,
        tools,
        resources,
      };

      this.connectedServers.set(serverName, connected);
      this.failedServers.delete(serverName);
      logger.info({
        server: serverName,
        transport: config.transport.type,
        toolCount: tools.length,
        resourceCount: resources.length,
      }, "Connected MCP server");
    } catch (error) {
      const message = getErrorMessage(error);
      this.failedServers.set(serverName, { config, error: message });
      logger.error({ error, server: serverName }, "Failed to connect MCP server");
    }
  }
}
