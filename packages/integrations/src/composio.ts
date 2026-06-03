import {
  Composio,
  type ConnectedAccountListParams,
  type ConnectedAccountStatus,
  type IncomingTriggerPayload,
  type ToolRouterCreateSessionConfig,
  type TriggerInstanceUpsertParams,
  type TriggerInstanceUpsertResponse,
  type TriggersTypeListResponse,
  type TriggersTypeRetrieveResponse,
  type ToolkitRetrieveResponse,
  type VerifyWebhookResult,
} from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";
import type { ToolSet } from "ai";

const logger = createLogger("composio");
const tracer = getTracer("composio");
const readOnlyTag = "readOnlyHint" as const;

type ToolkitToolFilter = { enable: string[] } | { tags: [typeof readOnlyTag] };

export interface ComposioSessionOptions {
  userId: string;
  sessionConfig?: ToolRouterCreateSessionConfig;
}

export interface ComposioConnectedAccountToolExecuteOptions {
  userId: string;
  toolkitSlug: string;
  connectedAccountId: string;
  toolSlug: string;
  arguments?: Record<string, unknown>;
}

export interface ComposioConnectedAccountProxyExecuteOptions {
  userId: string;
  toolkitSlug: string;
  connectedAccountId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: Record<string, unknown>;
  parameters?: ComposioProxyExecuteParameter[] | Record<string, string | number | null | undefined>;
}

type ComposioProxyExecuteParameter = {
  in: "query" | "header";
  name: string;
  value: string | number;
};

export interface ComposioConfiguredToolkit {
  slug: string;
  connectedAccountId?: string;
  permissionMode?: "read_only" | "all";
  allowedTools?: string[];
}

export interface ComposioToolkitPageResult {
  connectors: ComposioToolkitSummary[];
  nextCursor?: string;
}

export interface ComposioConnectedToolkitSummary {
  slug: string;
  name?: string;
  connectedAccountId: string;
  connectionStatus?: string;
}

export type ComposioConnectedAccountStatus = ConnectedAccountStatus;

export interface ComposioConnectedAccountSummary {
  id: string;
  toolkitSlug: string;
  status: ComposioConnectedAccountStatus;
  statusReason?: string | null;
  alias?: string | null;
  isDisabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ComposioToolkitSummary {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  requiresAuth: boolean;
  connected: boolean;
  enabled: boolean;
  connectionStatus?: string;
  connectedAccountId?: string;
}

export interface ComposioTriggerTypeSummary {
  slug: string;
  name?: string;
  description?: string;
  toolkitSlug?: string;
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
}

export type ComposioTriggerCreateParams = TriggerInstanceUpsertParams;
export type ComposioTriggerCreateResult = TriggerInstanceUpsertResponse;
export type ComposioIncomingTriggerPayload = IncomingTriggerPayload;
export type ComposioWebhookVerifyResult = VerifyWebhookResult;

type TriggerTypeItem = {
  slug?: string;
  name?: string;
  description?: string;
  toolkitSlug?: string;
  toolkit?: { slug?: string };
  inputSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
};

interface ComposioConnectedAccount {
  id?: string;
  status?: string;
}

interface ComposioToolkitConnection {
  isActive?: boolean;
  connectedAccount?: ComposioConnectedAccount;
}

export interface ComposioToolkitMetadata {
  description?: string;
  logo?: string;
}

interface ComposioToolkitItem {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  meta?: ComposioToolkitMetadata;
  noAuth?: boolean;
  isNoAuth?: boolean;
  connection?: ComposioToolkitConnection;
}

interface ComposioToolkitPage {
  items?: ComposioToolkitItem[];
  cursor?: string;
}

function toToolkitSummary(toolkit: ComposioToolkitItem, metadata?: ComposioToolkitMetadata): ComposioToolkitSummary {
  const description = toolkit.description ?? toolkit.meta?.description ?? metadata?.description;
  const logo = toolkit.logo ?? toolkit.meta?.logo ?? metadata?.logo;

  return {
    slug: toolkit.slug,
    name: toolkit.name,
    ...(description ? { description } : {}),
    ...(logo ? { logo } : {}),
    requiresAuth: toolkit.noAuth !== true && toolkit.isNoAuth !== true,
    connected: toolkit.connection?.isActive ?? false,
    enabled: true,
    ...(toolkit.connection?.connectedAccount?.status
      ? { connectionStatus: toolkit.connection.connectedAccount.status }
      : {}),
    ...(toolkit.connection?.connectedAccount?.id
      ? { connectedAccountId: toolkit.connection.connectedAccount.id }
      : {}),
  };
}

export function createComposioSessionConfig(options: {
  callbackUrl?: string;
  allowConnectionRequests?: boolean;
  allowedToolkits?: string[];
  configuredToolkits?: ComposioConfiguredToolkit[];
} = {}): ToolRouterCreateSessionConfig | undefined {
  const configuredToolkitSlugs = options.configuredToolkits?.map((toolkit) => toolkit.slug).filter(Boolean);
  const toolkitToolFilterEntries: Array<[string, ToolkitToolFilter]> = options.configuredToolkits
      ?.flatMap((toolkit): Array<[string, ToolkitToolFilter]> => {
        if (toolkit.permissionMode === "read_only") {
          return [[toolkit.slug, { tags: [readOnlyTag] }]];
        }
        if (toolkit.allowedTools?.length) {
          return [[toolkit.slug, { enable: toolkit.allowedTools }]];
        }

        return [];
      }) ?? [];
  const toolkitToolFilters = Object.fromEntries(toolkitToolFilterEntries);
  const connectedAccounts = Object.fromEntries(
    options.configuredToolkits
      ?.filter((toolkit) => toolkit.connectedAccountId)
      .map((toolkit) => [toolkit.slug, [toolkit.connectedAccountId!]]) ?? [],
  );

  const allowConnectionRequests = options.allowConnectionRequests ?? true;
  const baseConfig = {
    workbench: { enable: false },
  } satisfies ToolRouterCreateSessionConfig;

  if (!allowConnectionRequests && !configuredToolkitSlugs?.length) {
    return { ...baseConfig, manageConnections: false };
  }

  if (allowConnectionRequests && !options.callbackUrl && !options.allowedToolkits?.length && !configuredToolkitSlugs?.length) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    ...(allowConnectionRequests && options.callbackUrl
      ? {
          manageConnections: {
            callbackUrl: options.callbackUrl,
          },
        }
      : { manageConnections: false }),
    ...(configuredToolkitSlugs?.length
      ? { toolkits: { enable: configuredToolkitSlugs } }
      : allowConnectionRequests && options.allowedToolkits?.length
        ? { toolkits: { enable: options.allowedToolkits } }
        : {}),
    ...(Object.keys(toolkitToolFilters).length > 0
      ? { tools: toolkitToolFilters }
      : {}),
    ...(Object.keys(connectedAccounts).length > 0
      ? { connectedAccounts }
      : {}),
  };
}

function normalizeProxyExecuteParameters(
  parameters: ComposioConnectedAccountProxyExecuteOptions["parameters"],
): ComposioProxyExecuteParameter[] | undefined {
  if (!parameters) {
    return undefined;
  }
  if (Array.isArray(parameters)) {
    const normalized = parameters
      .map((parameter) => ({
        in: parameter.in,
        name: parameter.name.trim(),
        value: parameter.value,
      }))
      .filter((parameter) => parameter.name.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }

  const normalized = Object.entries(parameters)
    .flatMap(([name, value]): ComposioProxyExecuteParameter[] => {
      const trimmedName = name.trim();
      if (!trimmedName || value === null || value === undefined) {
        return [];
      }
      return [{ in: "query", name: trimmedName, value }];
    });
  return normalized.length > 0 ? normalized : undefined;
}

export class ComposioClient {
  private readonly client: Composio<VercelProvider>;
  private readonly allowedToolkits?: string[];

  constructor(opts: { apiKey: string; allowedToolkits?: string[] }) {
    this.client = new Composio({
      apiKey: opts.apiKey,
      provider: new VercelProvider(),
    });
    this.allowedToolkits = opts.allowedToolkits?.length ? opts.allowedToolkits : undefined;
  }

  getAllowedToolkits(): string[] | undefined {
    return this.allowedToolkits;
  }

  private getEffectiveToolkitSlugs(requestedToolkits?: string[]): string[] | undefined {
    if (!requestedToolkits?.length) {
      return this.allowedToolkits;
    }
    if (!this.allowedToolkits) {
      return requestedToolkits;
    }

    const allowedToolkits = new Set(this.allowedToolkits);
    return requestedToolkits.filter((toolkit) => allowedToolkits.has(toolkit));
  }

  async getToolkitMetadata(slug: string): Promise<ComposioToolkitMetadata> {
    const toolkit: ToolkitRetrieveResponse = await this.client.toolkits.get(slug);
    return {
      ...(toolkit.meta.description ? { description: toolkit.meta.description } : {}),
      ...(toolkit.meta.logo ? { logo: toolkit.meta.logo } : {}),
    };
  }

  private assertToolkitAllowed(toolkitSlug: string): void {
    if (this.allowedToolkits && !this.allowedToolkits.includes(toolkitSlug)) {
      throw new IntegrationError(`Composio toolkit is not enabled: ${toolkitSlug}`, "composio");
    }
  }

  async getTools(options: ComposioSessionOptions): Promise<ToolSet> {
    return withSpan(tracer, "composio.tools", { "composio.userId": options.userId }, async () => {
      try {
        const session = await this.client.create(options.userId, options.sessionConfig);
        const tools = await session.tools();

        logger.info(
          { userId: options.userId, toolCount: Object.keys(tools).length },
          "Loaded Composio session tools",
        );

        return tools;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load Composio tools";
        logger.error({ error, userId: options.userId }, "Failed to initialize Composio session");
        throw new IntegrationError(message, "composio");
      }
    });
  }

  async executeToolForConnectedAccount(options: ComposioConnectedAccountToolExecuteOptions): Promise<unknown> {
    return withSpan(tracer, "composio.executeTool", {
      "composio.userId": options.userId,
      "composio.toolkit": options.toolkitSlug,
      "composio.tool": options.toolSlug,
    }, async () => {
      try {
        this.assertToolkitAllowed(options.toolkitSlug);
        const session = await this.client.create(options.userId, createComposioSessionConfig({
          allowConnectionRequests: false,
          configuredToolkits: [{
            slug: options.toolkitSlug,
            connectedAccountId: options.connectedAccountId,
            permissionMode: "read_only",
            allowedTools: [options.toolSlug],
          }],
        }));
        const sessionWithExecute = session as unknown as {
          execute?: (toolSlug: string, args?: Record<string, unknown>) => Promise<unknown>;
          tools?: () => Promise<Record<string, unknown>>;
        };
        if (typeof sessionWithExecute.execute === "function") {
          return sessionWithExecute.execute(options.toolSlug, options.arguments ?? {});
        }
        if (typeof sessionWithExecute.tools === "function") {
          const tools = await sessionWithExecute.tools();
          const selectedTool = tools[options.toolSlug] as unknown;
          if (typeof selectedTool === "function") {
            return selectedTool(options.arguments ?? {});
          }
          if (selectedTool && typeof selectedTool === "object" && typeof (selectedTool as { execute?: unknown }).execute === "function") {
            return (selectedTool as { execute: (args?: Record<string, unknown>) => Promise<unknown> }).execute(options.arguments ?? {});
          }
        }
        throw new IntegrationError(`Composio session cannot execute tool ${options.toolSlug}`, "composio");
      } catch (error) {
        if (error instanceof IntegrationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : `Failed to execute Composio tool ${options.toolSlug}`;
        logger.error({
          error,
          userId: options.userId,
          toolkitSlug: options.toolkitSlug,
          connectedAccountId: options.connectedAccountId,
          toolSlug: options.toolSlug,
        }, "Failed to execute Composio connected-account tool");
        throw new IntegrationError(message, "composio");
      }
    });
  }

  async proxyExecuteForConnectedAccount(options: ComposioConnectedAccountProxyExecuteOptions): Promise<unknown> {
    return withSpan(tracer, "composio.proxyExecute", {
      "composio.userId": options.userId,
      "composio.toolkit": options.toolkitSlug,
    }, async () => {
      try {
        this.assertToolkitAllowed(options.toolkitSlug);
        const session = await this.client.create(options.userId, createComposioSessionConfig({
          allowConnectionRequests: false,
          configuredToolkits: [{
            slug: options.toolkitSlug,
            connectedAccountId: options.connectedAccountId,
            permissionMode: "read_only",
          }],
        }));
        const proxyExecute = (session as unknown as {
          proxyExecute?: (request: {
            toolkit: string;
            endpoint: string;
            method: ComposioConnectedAccountProxyExecuteOptions["method"];
            body?: Record<string, unknown>;
            parameters?: ComposioProxyExecuteParameter[];
          }) => Promise<unknown>;
        }).proxyExecute;
        if (typeof proxyExecute !== "function") {
          throw new IntegrationError(`Composio session cannot proxy ${options.toolkitSlug}`, "composio");
        }
        const parameters = normalizeProxyExecuteParameters(options.parameters);
        return proxyExecute.call(session, {
          toolkit: options.toolkitSlug,
          method: options.method,
          endpoint: options.endpoint,
          ...(parameters ? { parameters } : {}),
          ...(options.body ? { body: options.body } : {}),
        });
      } catch (error) {
        if (error instanceof IntegrationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : `Failed to proxy Composio toolkit ${options.toolkitSlug}`;
        logger.error({
          error,
          userId: options.userId,
          toolkitSlug: options.toolkitSlug,
          connectedAccountId: options.connectedAccountId,
        }, "Failed to proxy Composio connected-account request");
        throw new IntegrationError(message, "composio");
      }
    });
  }

  async listConnectedToolkits(userId: string, toolkitSlugs?: string[]): Promise<ComposioConnectedToolkitSummary[]> {
    return withSpan(tracer, "composio.connectedToolkits", { "composio.userId": userId }, async () => {
      const toolkits = toolkitSlugs?.length ? toolkitSlugs : this.allowedToolkits;
      const sessionConfig: ToolRouterCreateSessionConfig = {
        manageConnections: false,
        ...(this.allowedToolkits ? { toolkits: { enable: this.allowedToolkits } } : {}),
      };
      const session = await this.client.create(userId, sessionConfig);
      const result = await session.toolkits({
        limit: Math.max(toolkits?.length ?? 25, 1),
        isConnected: true,
        ...(toolkits?.length ? { toolkits } : {}),
      }) as ComposioToolkitPage;

      return (result.items ?? [])
        .filter((item) => item.connection?.isActive && item.connection.connectedAccount?.id)
        .map((item) => ({
          slug: item.slug,
          name: item.name,
          connectedAccountId: item.connection!.connectedAccount!.id!,
          ...(item.connection!.connectedAccount!.status ? { connectionStatus: item.connection!.connectedAccount!.status } : {}),
        }));
    });
  }

  async listConnectedAccounts(
    userId: string,
    options: {
      toolkitSlugs?: string[];
      statuses?: ComposioConnectedAccountStatus[];
    } = {},
  ): Promise<ComposioConnectedAccountSummary[]> {
    return withSpan(tracer, "composio.connectedAccounts", { "composio.userId": userId }, async () => {
      const toolkitSlugs = this.getEffectiveToolkitSlugs(options.toolkitSlugs);
      if (options.toolkitSlugs?.length && toolkitSlugs?.length === 0) {
        return [];
      }

      const accounts: ComposioConnectedAccountSummary[] = [];
      let cursor: string | null | undefined;

      do {
        const query: ConnectedAccountListParams = {
          userIds: [userId],
          limit: 100,
          ...(cursor ? { cursor } : {}),
          ...(toolkitSlugs?.length ? { toolkitSlugs } : {}),
          ...(options.statuses?.length ? { statuses: options.statuses } : {}),
        };
        const page = await this.client.connectedAccounts.list(query);
        accounts.push(...(page.items ?? [])
          .filter((account) => account.id && account.toolkit?.slug && account.status)
          .map((account) => ({
            id: account.id,
            toolkitSlug: account.toolkit.slug,
            status: account.status,
            statusReason: account.statusReason,
            alias: account.alias ?? null,
            isDisabled: account.isDisabled === true,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          })));
        cursor = page.nextCursor;
      } while (cursor);

      return accounts;
    });
  }

  async getToolkits(userId: string, options: { limit?: number; cursor?: string; search?: string; connected?: boolean; toolkits?: string[]; includeMetadata?: boolean } = {}): Promise<ComposioToolkitPageResult> {
    return withSpan(tracer, "composio.toolkits", { "composio.userId": userId }, async () => {
      try {
        const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
        const sessionConfig: ToolRouterCreateSessionConfig = {
          manageConnections: false,
          ...(this.allowedToolkits ? { toolkits: { enable: this.allowedToolkits } } : {}),
        };
        const session = await this.client.create(userId, sessionConfig);
        const result = await session.toolkits({
          limit,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.search ? { search: options.search } : {}),
          ...(options.connected !== undefined ? { isConnected: options.connected } : {}),
          ...(options.toolkits?.length ? { toolkits: options.toolkits } : this.allowedToolkits ? { toolkits: this.allowedToolkits } : {}),
        }) as ComposioToolkitPage;

        const metadataBySlug = options.includeMetadata === false
          ? new Map<string, ComposioToolkitMetadata>()
          : new Map(
            await Promise.all(
              (result.items ?? []).map(async (toolkit) => [toolkit.slug, await this.getToolkitMetadata(toolkit.slug)] as const),
            ),
          );

        return {
          connectors: (result.items ?? [])
            .map((toolkit) => toToolkitSummary(toolkit, metadataBySlug.get(toolkit.slug)))
            .filter((toolkit) => toolkit.requiresAuth)
            .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
          ...(result.cursor ? { nextCursor: result.cursor } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load Composio toolkits";
        logger.error({ error, userId }, "Failed to load Composio toolkits");
        throw new IntegrationError(message, "composio");
      }
    });
  }

  async authorizeToolkit(userId: string, toolkitSlug: string, callbackUrl?: string): Promise<string> {
    return withSpan(
      tracer,
      "composio.authorizeToolkit",
      { "composio.userId": userId, "composio.toolkit": toolkitSlug },
      async () => {
        if (this.allowedToolkits && !this.allowedToolkits.includes(toolkitSlug)) {
          throw new IntegrationError(`Composio toolkit is not enabled: ${toolkitSlug}`, "composio");
        }

        const session = await this.client.create(userId, { manageConnections: false });
        const request = await session.authorize(toolkitSlug, callbackUrl ? { callbackUrl } : undefined);

        if (!request.redirectUrl) {
          throw new IntegrationError("Composio did not return a redirect URL", "composio");
        }

        return request.redirectUrl;
      },
    );
  }

  async refreshConnectedAccount(connectedAccountId: string, callbackUrl?: string): Promise<string | null> {
    const result = await this.client.connectedAccounts.refresh(
      connectedAccountId,
      callbackUrl ? { redirectUrl: callbackUrl } : undefined,
    ) as { redirectUrl?: string | null; redirect_url?: string | null };
    return result.redirectUrl ?? result.redirect_url ?? null;
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    await this.client.connectedAccounts.delete(connectedAccountId);
  }

  async listTriggerTypes(toolkitSlug?: string): Promise<ComposioTriggerTypeSummary[]> {
    if (this.allowedToolkits && toolkitSlug && !this.allowedToolkits.includes(toolkitSlug)) {
      return [];
    }

    const result = await this.client.triggers.listTypes({
      limit: 100,
      ...(toolkitSlug ? { toolkits: [toolkitSlug] } : this.allowedToolkits ? { toolkits: this.allowedToolkits } : {}),
    }) as TriggersTypeListResponse & { items?: TriggerTypeItem[] };

    return (result.items ?? [])
      .map((item) => this.toTriggerTypeSummary(item))
      .filter((item): item is ComposioTriggerTypeSummary => Boolean(item));
  }

  async getTriggerType(slug: string): Promise<ComposioTriggerTypeSummary> {
    const item = await this.client.triggers.getType(slug) as TriggersTypeRetrieveResponse & TriggerTypeItem;
    const summary = this.toTriggerTypeSummary(item);
    if (!summary) {
      throw new IntegrationError(`Composio trigger type not found: ${slug}`, "composio");
    }
    return summary;
  }

  async createTrigger(userId: string, slug: string, body: ComposioTriggerCreateParams): Promise<ComposioTriggerCreateResult> {
    return this.client.triggers.create(userId, slug, body);
  }

  async enableTrigger(triggerId: string): Promise<void> {
    await this.client.triggers.enable(triggerId);
  }

  async disableTrigger(triggerId: string): Promise<void> {
    await this.client.triggers.disable(triggerId);
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.client.triggers.delete(triggerId);
  }

  async verifyWebhook(params: {
    payload: string;
    signature: string;
    id: string;
    timestamp: string;
    secret: string;
  }): Promise<ComposioWebhookVerifyResult> {
    return this.client.triggers.verifyWebhook(params);
  }

  private toTriggerTypeSummary(item: TriggerTypeItem): ComposioTriggerTypeSummary | null {
    if (!item.slug) return null;
    return {
      slug: item.slug,
      ...(item.name ? { name: item.name } : {}),
      ...(item.description ? { description: item.description } : {}),
      ...(item.toolkitSlug ?? item.toolkit?.slug ? { toolkitSlug: item.toolkitSlug ?? item.toolkit?.slug } : {}),
      ...(item.inputSchema ?? item.config ? { inputSchema: item.inputSchema ?? item.config } : {}),
      ...(item.payloadSchema ?? item.payload ? { payloadSchema: item.payloadSchema ?? item.payload } : {}),
    };
  }
}
