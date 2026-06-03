import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { generateId, type UserContext } from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import type { McpOAuthState, McpOAuthStore, McpServerConfig } from "@finn/integrations";
import { and, asc, eq } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";

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

const transportSchema = z.discriminatedUnion("type", [
  httpTransportSchema,
  sseTransportSchema,
  stdioTransportSchema,
]);

const oauthStateSchema = z.object({
  state: z.string().optional(),
  codeVerifier: z.string().optional(),
  clientInformation: z.unknown().optional(),
  tokens: z.unknown().optional(),
  discoveryState: z.unknown().optional(),
});

const mcpServerSecretsSchema = z.object({
  authToken: z.string().min(1).optional(),
  authHeaderName: z.string().min(1).optional(),
  authHeaderValue: z.string().min(1).optional(),
  oauth: oauthStateSchema.optional(),
});

type UserRef = Pick<UserContext, "tenantId" | "userId">;
type McpAuthMode = "none" | "api_key" | "oauth";
type McpServerMetadata = Record<string, unknown> & {
  auth?: {
    type?: McpAuthMode;
  };
  logoUrl?: string;
  oauth?: McpOAuthState;
};
type McpServerSecrets = z.infer<typeof mcpServerSecretsSchema>;

export type McpUserRootResolver = (user: UserRef) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetadata(row: schema.McpServer): McpServerMetadata {
  return isRecord(row.metadata)
    ? row.metadata as McpServerMetadata
    : {};
}

function parseStoredTransport(row: schema.McpServer): z.infer<typeof transportSchema> {
  return transportSchema.parse(row.transport);
}

function parseAuthorizationToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const trimmed = header.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
}

function getLegacyAuthToken(row: schema.McpServer): string | undefined {
  const transport = parseStoredTransport(row);
  if (transport.type !== "http" && transport.type !== "sse") {
    return undefined;
  }

  return parseAuthorizationToken(getHeaderCaseInsensitive(transport.headers, "authorization"));
}

function getLegacyOAuthState(row: schema.McpServer): McpOAuthState | undefined {
  const parsed = oauthStateSchema.safeParse(getMetadata(row).oauth);
  return parsed.success ? parsed.data as McpOAuthState : undefined;
}

function getAuthMode(row: schema.McpServer): McpAuthMode {
  const metadata = getMetadata(row);
  if (metadata.auth?.type === "oauth" || metadata.auth?.type === "api_key") {
    return metadata.auth.type;
  }

  if (getLegacyOAuthState(row)) {
    return "oauth";
  }

  if (getLegacyAuthToken(row)) {
    return "api_key";
  }

  return "none";
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([headerName]) => headerName.toLowerCase() === normalizedName)?.[1];
}

function isSecretTransportHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  const compact = normalized.replace(/[-_\s]/g, "");
  return normalized === "authorization"
    || normalized === "proxy-authorization"
    || normalized === "cookie"
    || normalized === "set-cookie"
    || compact.includes("apikey")
    || compact.includes("authorization")
    || compact.includes("secret")
    || compact.includes("token");
}

function getMetadataAuthMode(metadata: Record<string, unknown> | null | undefined): McpAuthMode | undefined {
  const auth = isRecord(metadata?.auth) ? metadata.auth : null;
  const type = auth?.type;
  return type === "api_key" || type === "oauth" || type === "none" ? type : undefined;
}

function stripTransportAuthorization(
  transport: z.infer<typeof transportSchema>,
  options: { stripAllHeaders?: boolean } = {},
): z.infer<typeof transportSchema> {
  if (transport.type !== "http" && transport.type !== "sse") {
    return transport;
  }

  const { headers: inputHeaders, ...transportWithoutHeaders } = transport;
  const headers = options.stripAllHeaders
    ? {}
    : Object.fromEntries(
        Object.entries(inputHeaders ?? {}).filter(([headerName]) => !isSecretTransportHeaderName(headerName)),
      );
  return Object.keys(headers).length > 0
    ? { ...transportWithoutHeaders, headers }
    : transportWithoutHeaders;
}

function withAuthToken(
  transport: z.infer<typeof transportSchema>,
  secrets: McpServerSecrets,
): z.infer<typeof transportSchema> {
  if (transport.type !== "http" && transport.type !== "sse") {
    return transport;
  }

  const headerName = secrets.authHeaderName?.trim();
  const headerValue = secrets.authHeaderValue?.trim();
  if (!headerName && !secrets.authToken) {
    return transport;
  }

  return {
    ...transport,
    headers: {
      ...(transport.headers ?? {}),
      ...(headerName && headerValue ? { [headerName]: headerValue } : {}),
      ...(!headerName && secrets.authToken ? { Authorization: `Bearer ${secrets.authToken}` } : {}),
    },
  };
}

function cleanSecrets(secrets: McpServerSecrets): McpServerSecrets {
  return mcpServerSecretsSchema.parse({
    ...(secrets.authToken ? { authToken: secrets.authToken } : {}),
    ...(secrets.authHeaderName ? { authHeaderName: secrets.authHeaderName } : {}),
    ...(secrets.authHeaderValue ? { authHeaderValue: secrets.authHeaderValue } : {}),
    ...(secrets.oauth ? { oauth: secrets.oauth } : {}),
  });
}

class McpServerSecretStore {
  constructor(private readonly getUserRoot: McpUserRootResolver) {}

  async load(user: UserRef, id: string): Promise<McpServerSecrets> {
    try {
      const directory = await this.directoryPath(user);
      const raw = await readFile(this.filePath(directory, id), "utf8");
      return cleanSecrets(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async save(user: UserRef, id: string, secrets: McpServerSecrets): Promise<void> {
    const next = cleanSecrets(secrets);
    if (!next.authToken && !next.authHeaderName && !next.authHeaderValue && !next.oauth) {
      await this.delete(user, id);
      return;
    }

    const directory = await this.directoryPath(user);
    const filePath = this.filePath(directory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify(next), { mode: 0o600 });
    await Promise.all([
      chmod(directory, 0o700).catch(() => undefined),
      chmod(filePath, 0o600).catch(() => undefined),
    ]);
  }

  async update(user: UserRef, id: string, updater: (current: McpServerSecrets) => McpServerSecrets): Promise<McpServerSecrets> {
    const next = cleanSecrets(updater(await this.load(user, id)));
    await this.save(user, id, next);
    return next;
  }

  async delete(user: UserRef, id: string): Promise<void> {
    const directory = await this.directoryPath(user);
    await rm(this.filePath(directory, id), { force: true });
  }

  private async directoryPath(user: UserRef): Promise<string> {
    return join(await this.getUserRoot(user), ".finn", "mcp-secrets");
  }

  private filePath(directory: string, id: string): string {
    return join(directory, `${id}.json`);
  }
}

async function toConfig(row: schema.McpServer, secrets: McpServerSecrets): Promise<McpServerConfig> {
  const authMode = getAuthMode(row);
  return {
    name: row.name,
    description: row.description ?? undefined,
    alwaysOn: row.alwaysOn,
    auth: authMode === "oauth" ? { type: "oauth" } : undefined,
    transport: withAuthToken(stripTransportAuthorization(parseStoredTransport(row)), secrets),
  };
}

export class McpServerStore {
  private readonly secretStore: McpServerSecretStore;

  constructor(
    private readonly db: Database,
    options: { getUserRoot: McpUserRootResolver },
  ) {
    this.secretStore = new McpServerSecretStore(options.getUserRoot);
  }

  async listForUser(user: UserRef): Promise<schema.McpServer[]> {
    const rows = await this.db
      .select()
      .from(schema.mcpServers)
      .where(and(
        eq(schema.mcpServers.tenantId, user.tenantId),
        eq(schema.mcpServers.userId, user.userId),
      ))
      .orderBy(asc(schema.mcpServers.name));

    return Promise.all(rows.map((row) => this.externalizeLegacySecrets(user, row)));
  }

  async listActiveForUser(user: UserContext): Promise<McpServerConfig[]> {
    const rows = await this.listForUser(user);
    return Promise.all(rows.filter((row) => row.active).map((row) => this.configForRow(user, row)));
  }

  async configForRow(user: UserRef, row: schema.McpServer): Promise<McpServerConfig> {
    return toConfig(row, await this.secretStore.load(user, row.id));
  }

  async getForUser(user: UserRef, id: string): Promise<schema.McpServer | null> {
    const [row] = await this.db
      .select()
      .from(schema.mcpServers)
      .where(and(
        eq(schema.mcpServers.id, id),
        eq(schema.mcpServers.tenantId, user.tenantId),
        eq(schema.mcpServers.userId, user.userId),
      ))
      .limit(1);

    return row ? this.externalizeLegacySecrets(user, row) : null;
  }

  async createForUser(
    user: UserRef,
    params: {
      name: string;
      description?: string | null;
      transport: McpServerConfig["transport"];
      alwaysOn?: boolean;
      active?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<schema.McpServer> {
    const now = new Date();
    const [created] = await this.db
      .insert(schema.mcpServers)
      .values({
        id: generateId("mcp"),
        tenantId: user.tenantId,
        userId: user.userId,
        name: params.name,
        description: params.description || null,
        transport: transportSchema.parse(stripTransportAuthorization(params.transport, {
          stripAllHeaders: getMetadataAuthMode(params.metadata) === "api_key",
        })),
        alwaysOn: params.alwaysOn ?? true,
        active: params.active ?? true,
        metadata: params.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create MCP server.");
    }

    return created;
  }

  async updateForUser(
    user: UserRef,
    id: string,
    params: {
      name?: string;
      description?: string | null;
      transport?: McpServerConfig["transport"];
      alwaysOn?: boolean;
      active?: boolean;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<schema.McpServer | null> {
    const update: Partial<schema.NewMcpServer> = {
      updatedAt: new Date(),
    };

    if (params.name !== undefined) update.name = params.name;
    if (params.description !== undefined) update.description = params.description || null;
    if (params.transport !== undefined) {
      update.transport = transportSchema.parse(stripTransportAuthorization(params.transport, {
        stripAllHeaders: getMetadataAuthMode(params.metadata) === "api_key",
      }));
    }
    if (params.alwaysOn !== undefined) update.alwaysOn = params.alwaysOn;
    if (params.active !== undefined) update.active = params.active;
    if (params.metadata !== undefined) update.metadata = params.metadata;

    const [updated] = await this.db
      .update(schema.mcpServers)
      .set(update)
      .where(and(
        eq(schema.mcpServers.id, id),
        eq(schema.mcpServers.tenantId, user.tenantId),
        eq(schema.mcpServers.userId, user.userId),
      ))
      .returning();

    return updated ?? null;
  }

  async findByOAuthState(user: UserRef, state: string): Promise<schema.McpServer | null> {
    const rows = await this.listForUser(user);
    for (const row of rows) {
      if ((await this.secretStore.load(user, row.id)).oauth?.state === state) {
        return row;
      }
    }
    return null;
  }

  async getAuthToken(user: UserRef, id: string): Promise<string | undefined> {
    return (await this.secretStore.load(user, id)).authToken;
  }

  async getAuthHeader(user: UserRef, id: string): Promise<{ name?: string; value?: string }> {
    const secrets = await this.secretStore.load(user, id);
    return {
      name: secrets.authHeaderName,
      value: secrets.authHeaderValue,
    };
  }

  async saveAuthToken(user: UserRef, id: string, authToken?: string): Promise<void> {
    const row = await this.getForUser(user, id);
    if (!row) {
      throw new Error(`MCP server not found: ${id}`);
    }

    const nextToken = authToken?.trim();
    await this.secretStore.update(user, id, (current) => ({
      ...current,
      authToken: nextToken || undefined,
      authHeaderName: undefined,
      authHeaderValue: undefined,
    }));
  }

  async saveAuthHeader(user: UserRef, id: string, header?: { name?: string; value?: string }): Promise<void> {
    const row = await this.getForUser(user, id);
    if (!row) {
      throw new Error(`MCP server not found: ${id}`);
    }

    const name = header?.name?.trim();
    const value = header?.value?.trim();
    await this.secretStore.update(user, id, (current) => ({
      ...current,
      authToken: undefined,
      authHeaderName: name || undefined,
      authHeaderValue: value || undefined,
    }));
  }

  async clearOAuthState(user: UserRef, id: string): Promise<void> {
    const row = await this.getForUser(user, id);
    if (!row) {
      throw new Error(`MCP server not found: ${id}`);
    }

    await this.secretStore.update(user, id, (current) => {
      const next = { ...current };
      delete next.oauth;
      return next;
    });
  }

  async getOAuthState(user: UserRef, id: string): Promise<McpOAuthState | undefined> {
    const row = await this.getForUser(user, id);
    if (!row) {
      return undefined;
    }

    return (await this.secretStore.load(user, id)).oauth as McpOAuthState | undefined;
  }

  async saveOAuthState(user: UserRef, id: string, oauth: McpOAuthState): Promise<void> {
    const row = await this.getForUser(user, id);
    if (!row) {
      throw new Error(`MCP server not found: ${id}`);
    }

    await this.secretStore.update(user, id, (current) => ({
      ...current,
      oauth,
    }));
  }

  async clearOAuthChallenge(user: UserRef, id: string): Promise<void> {
    const row = await this.getForUser(user, id);
    if (!row) {
      throw new Error(`MCP server not found: ${id}`);
    }

    await this.secretStore.update(user, id, (current) => {
      const oauth = current.oauth ? { ...current.oauth } : undefined;
      if (oauth) {
        delete oauth.state;
        delete oauth.codeVerifier;
      }
      return {
        ...current,
        oauth,
      };
    });
  }

  async deleteForUser(user: UserRef, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.mcpServers)
      .where(and(
        eq(schema.mcpServers.id, id),
        eq(schema.mcpServers.tenantId, user.tenantId),
        eq(schema.mcpServers.userId, user.userId),
      ))
      .returning({ id: schema.mcpServers.id });

    if (deleted.length > 0) {
      await this.secretStore.delete(user, id);
      return true;
    }

    return false;
  }

  private async externalizeLegacySecrets(user: UserRef, row: schema.McpServer): Promise<schema.McpServer> {
    const legacyAuthToken = getLegacyAuthToken(row);
    const legacyOauth = getLegacyOAuthState(row);
    if (!legacyAuthToken && !legacyOauth) {
      return row;
    }

    await this.secretStore.update(user, row.id, (current) => ({
      ...current,
      authToken: current.authToken ?? legacyAuthToken,
      oauth: current.oauth ?? legacyOauth,
    }));

    const metadata = getMetadata(row);
    const nextMetadata: McpServerMetadata = {
      ...metadata,
      ...(getAuthMode(row) !== "none" ? { auth: { type: getAuthMode(row) } } : {}),
    };
    delete nextMetadata.oauth;

    return await this.updateForUser(user, row.id, {
      metadata: nextMetadata,
      transport: stripTransportAuthorization(parseStoredTransport(row)),
    }) ?? row;
  }
}

export function createMcpOAuthStore(params: {
  db: Database;
  getUserRoot: McpUserRootResolver;
  user: UserRef;
  publicUrl: string;
  onRedirect?: (server: string, authorizationUrl: URL) => void | Promise<void>;
}): McpOAuthStore {
  const store = new McpServerStore(params.db, { getUserRoot: params.getUserRoot });
  const redirectUrl = `${params.publicUrl.replace(/\/+$/, "")}/api/web/mcp-servers/oauth/callback`;

  async function getByServerName(server: string): Promise<schema.McpServer> {
    const rows = await store.listForUser(params.user);
    const row = rows.find((entry) => entry.name === server);
    if (!row) {
      throw new Error(`MCP server not found: ${server}`);
    }
    return row;
  }

  return {
    redirectUrl: () => redirectUrl,
    clientMetadata: () => ({
      redirect_uris: [redirectUrl],
      client_name: "Finn",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    loadState: async (server) => {
      const row = await getByServerName(server);
      return store.getOAuthState(params.user, row.id);
    },
    saveState: async (server, oauth) => {
      const row = await getByServerName(server);
      await store.saveOAuthState(params.user, row.id, oauth);
    },
    onRedirect: params.onRedirect,
  };
}
