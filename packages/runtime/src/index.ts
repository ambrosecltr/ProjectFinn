import type { PatternConnectorScope, PatternNotifyCondition, PatternRecord, PatternReminderContext, PatternRunRecord, PatternTriggerConfig, PatternTriggerFilter, UserContext, WorkerToolOutputArtifactStore, WorkerType } from "@finn/core";
import type { ComposioConfiguredToolkit } from "@finn/integrations";
import { join } from "node:path";
import { createFilesRuntime, type FilesRuntime, type FilesRuntimeOptions, type RuntimeAccess } from "./files.js";
import type { CreativeRuntimeService } from "./creative.js";
import type { MemoryRuntimeService } from "./memory.js";

export * from "./files.js";
export * from "./creative.js";
export * from "./memory.js";
export * from "./workspace-patch.js";

export type RuntimeServiceSlot =
  | "files"
  | "workspace"
  | "artifacts"
  | "web"
  | "creative"
  | "mcp"
  | "composio"
  | "memory"
  | "patterns"
  | "myDay";

export type RuntimeProcessType =
  | "hot_path"
  | "worker"
  | "pattern_management"
  | "pattern_worker"
  | "personal_intelligence"
  | "my_day";

export type ToolRuntimeRequirement =
  | RuntimeServiceSlot
  | "my_day";

export type RuntimeUser = Pick<UserContext, "tenantId" | "userId"> & Partial<Pick<UserContext, "kidsMode">>;

export interface WorkspaceRuntimeService {
  readonly workspaceRoot: string;
  readonly artifactsRoot: string;
}

export type ArtifactsRuntimeService = WorkerToolOutputArtifactStore;

export type WebProvider = "exa" | "parallel";

export type WebSearchMode = "basic" | "advanced";

export type WebSourcePolicy = {
  includeDomains?: string[];
  excludeDomains?: string[];
  afterDate?: string;
};

export type WebFetchPolicy = {
  maxAgeSeconds?: number;
  timeoutSeconds?: number;
  disableCacheFallback?: boolean;
};

export type WebContentLimit = {
  maxCharsPerResult?: number;
};

export type WebSearchOptions = {
  query?: string;
  objective?: string;
  searchQueries?: string[];
  numResults: number;
  maxAgeHours?: number;
  vertical?: "company" | "people";
  mode?: WebSearchMode;
  maxCharsTotal?: number;
  sessionId?: string;
  clientModel?: string;
  sourcePolicy?: WebSourcePolicy;
  fetchPolicy?: WebFetchPolicy;
  maxCharsPerResult?: number;
  location?: string;
};

export type WebSearchResult = {
  url: string;
  title: string | null;
  score?: number;
  publishedDate?: string;
  author?: string;
  id?: string;
  highlights?: string[];
  excerpts?: string[];
};

export type WebUsageItem = {
  name: string;
  count: number;
};

export type WebWarning = {
  type: string;
  message: string;
  detail?: Record<string, unknown> | null;
};

export type WebSearchResponse = {
  provider: WebProvider;
  results: WebSearchResult[];
  searchId?: string;
  sessionId?: string;
  warnings?: WebWarning[];
  usage?: WebUsageItem[];
};

export type WebExtractError = {
  url: string;
  errorType: string;
  httpStatusCode?: number | null;
  content?: string | null;
};

export type WebContent = {
  url: string;
  title: string | null;
  publishedDate?: string;
  text?: string;
  fullContent?: string;
  highlights?: string[];
  excerpts?: string[];
};

export type WebFetchOptions = {
  includeText?: boolean;
  objective?: string;
  searchQueries?: string[];
  maxCharsTotal?: number;
  sessionId?: string;
  clientModel?: string;
  fetchPolicy?: WebFetchPolicy;
  maxCharsPerResult?: number;
  fullContent?: boolean | WebContentLimit;
};

export type WebFetchResponse = {
  provider: WebProvider;
  contents: WebContent[];
  extractId?: string;
  sessionId?: string;
  errors?: WebExtractError[];
  warnings?: WebWarning[];
  usage?: WebUsageItem[];
};

export interface McpToolSummary {
  server: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
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

export interface McpRuntimeClient {
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

export interface WebRuntimeClient {
  readonly provider?: WebProvider;
  search(options: WebSearchOptions): Promise<WebSearchResponse>;
  getContents(url: string | string[], options?: WebFetchOptions): Promise<WebFetchResponse>;
}

export interface WebRuntimeService {
  readonly kind: "finn-web-runtime";
  readonly provider?: WebProvider;
  search(options: WebSearchOptions): Promise<WebSearchResponse>;
  fetch(url: string | string[], options?: WebFetchOptions): Promise<WebFetchResponse>;
}

export interface McpRuntimeService extends McpRuntimeClient {
  readonly kind: "finn-mcp-runtime";
}

export interface ComposioRuntimeService {
  readonly kind: "finn-composio-runtime";
  listConfiguredToolkits(options?: {
    feature?: "my_day" | "personal_intelligence";
    toolkitSlugs?: string[];
    permissionMode?: "read_only" | "all";
  }): Promise<ComposioConfiguredToolkit[]>;
}

export interface PatternTriggerTypeSummary {
  slug: string;
  name?: string;
  description?: string;
  toolkitSlug?: string;
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
}

export interface PatternsRuntimeService {
  readonly kind: "finn-patterns-runtime";
  readonly user?: Pick<UserContext, "timezone">;
  create(params: {
    name: string;
    description?: string | null;
    userDescription?: string | null;
    triggerType: "schedule" | "composio";
    triggerConfig: PatternTriggerConfig;
    connectorScope?: Partial<PatternConnectorScope>;
    triggerFilters?: PatternTriggerFilter[];
    notifyCondition?: PatternNotifyCondition;
    workerType: WorkerType;
    taskPrompt: string;
    reminderContext?: PatternReminderContext | null;
    timezone?: string;
    nextRunAt?: Date;
  }): Promise<PatternRecord>;
  list(): Promise<PatternRecord[]>;
  update(id: string, params: {
    name?: string;
    userDescription?: string | null;
    taskPrompt?: string;
    active?: boolean;
    triggerType?: "schedule" | "composio";
    triggerConfig?: PatternTriggerConfig;
    connectorScope?: Partial<PatternConnectorScope>;
    triggerFilters?: PatternTriggerFilter[];
    notifyCondition?: PatternNotifyCondition;
    reminderContext?: PatternReminderContext | null;
    timezone?: string;
    nextRunAt?: Date | null;
  }): Promise<PatternRecord | null>;
  get?(id: string): Promise<PatternRecord | null>;
  remove(id: string): Promise<PatternRecord | null>;
  listRuns?(params: { patternId: string; limit?: number; beforeRunId?: string }): Promise<PatternRunRecord[]>;
  getRun?(patternId: string, runId: string): Promise<PatternRunRecord | null>;
  listTriggerTypes?(toolkitSlug?: string): Promise<PatternTriggerTypeSummary[]>;
  getTriggerType?(triggerSlug: string): Promise<PatternTriggerTypeSummary>;
  createComposioTrigger?(params: {
    toolkitSlug: string;
    triggerSlug: string;
    connectedAccountId: string;
    triggerConfig?: Record<string, unknown>;
  }): Promise<string>;
  deleteComposioTrigger?(triggerId: string, params?: { excludedPatternId?: string }): Promise<void>;
  createComposioConnectionLink?(toolkitSlug: string): Promise<string>;
}

export interface MyDayRuntimeService {
  readonly kind: "finn-my-day-runtime";
}

export interface ToolRuntimeServices {
  files?: FilesRuntime;
  workspace?: WorkspaceRuntimeService;
  artifacts?: ArtifactsRuntimeService;
  web?: WebRuntimeService;
  creative?: CreativeRuntimeService;
  mcp?: McpRuntimeService;
  composio?: ComposioRuntimeService;
  memory?: MemoryRuntimeService;
  patterns?: PatternsRuntimeService;
  myDay?: MyDayRuntimeService;
}

export interface UserRuntimeServices extends ToolRuntimeServices {
  user?: RuntimeUser;
  workspace: WorkspaceRuntimeService;
}

export interface ProcessRuntimeServices extends ToolRuntimeServices {
  processType: RuntimeProcessType;
  runId?: string;
  user?: RuntimeUser;
  workspace: WorkspaceRuntimeService;
}

export type UserFilesRuntimeInput =
  | FilesRuntime
  | (Omit<FilesRuntimeOptions, "workspaceRoot"> & { workspaceRoot?: string });

export interface UserRuntimeServicesOptions extends Omit<ToolRuntimeServices, "files" | "workspace"> {
  user?: RuntimeUser;
  workspace: string | WorkspaceRuntimeService;
  files?: UserFilesRuntimeInput;
}

export interface ProcessRuntimeServicesOptions {
  processType: RuntimeProcessType;
  runId?: string;
  grants?: readonly RuntimeServiceSlot[];
  filesAccess?: RuntimeAccess;
  services?: ToolRuntimeServices;
}

export function createWorkspaceRuntimeService(input: string | WorkspaceRuntimeService): WorkspaceRuntimeService {
  if (typeof input === "string") {
    return { workspaceRoot: input, artifactsRoot: `${input}/../artifacts` };
  }

  return input.artifactsRoot ? input : { ...input, artifactsRoot: `${input.workspaceRoot}/../artifacts` };
}

export function createUserRuntimeServices(options: UserRuntimeServicesOptions): UserRuntimeServices {
  const workspace = createWorkspaceRuntimeService(options.workspace);
  const files = options.files ? createUserFilesRuntime(options.files, workspace.workspaceRoot) : undefined;

  return {
    ...(options.user ? { user: options.user } : {}),
    workspace,
    ...(files ? { files } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.web ? { web: options.web } : {}),
    ...(options.creative ? { creative: options.creative } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.composio ? { composio: options.composio } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.patterns ? { patterns: options.patterns } : {}),
    ...(options.myDay ? { myDay: options.myDay } : {}),
  };
}

export function createProcessRuntimeServices(
  userRuntime: UserRuntimeServices,
  options: ProcessRuntimeServicesOptions,
): ProcessRuntimeServices {
  const workspace = options.services?.workspace ?? userRuntime.workspace;
  const filesSource = options.services?.files
    ?? (shouldIncludeRuntimeSlot("files", options) ? userRuntime.files : undefined);
  const narrowedFiles = filesSource && options.filesAccess
    ? narrowFilesRuntimeAccess(filesSource, options.filesAccess)
    : filesSource;
  const files = narrowedFiles
    ? {
        ...narrowedFiles,
        artifactsRoot: options.runId ? join(workspace.artifactsRoot, sanitizeRuntimePathSegment(options.runId)) : workspace.artifactsRoot,
      }
    : undefined;

  return {
    processType: options.processType,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(userRuntime.user ? { user: userRuntime.user } : {}),
    workspace,
    ...(files ? { files } : {}),
    ...selectRuntimeService("artifacts", userRuntime, options),
    ...selectRuntimeService("web", userRuntime, options),
    ...selectRuntimeService("creative", userRuntime, options),
    ...selectRuntimeService("mcp", userRuntime, options),
    ...selectRuntimeService("composio", userRuntime, options),
    ...selectRuntimeService("memory", userRuntime, options),
    ...selectRuntimeService("patterns", userRuntime, options),
    ...selectRuntimeService("myDay", userRuntime, options),
  };
}

function sanitizeRuntimePathSegment(value: string): string {
  const sanitized = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

export function narrowFilesRuntimeAccess(runtime: FilesRuntime, access: RuntimeAccess): FilesRuntime {
  if (runtime.access === access) {
    return runtime;
  }

  if (access === "read" && runtime.storedFiles) {
    const rejectWrite = async (): Promise<never> => {
      throw new Error("Files runtime is read-only.");
    };
    return {
      ...runtime,
      access,
      storedFiles: {
        get: runtime.storedFiles.get,
        getMetadata: runtime.storedFiles.getMetadata,
        list: runtime.storedFiles.list,
        listPage: runtime.storedFiles.listPage,
        store: rejectWrite,
        setUserVisible: rejectWrite,
        moveToFolder: rejectWrite,
        delete: rejectWrite,
        ...(runtime.storedFiles.urlFor ? { urlFor: runtime.storedFiles.urlFor } : {}),
      },
    };
  }

  return {
    ...runtime,
    access,
  };
}

export function createWebRuntimeService(client: WebRuntimeClient): WebRuntimeService {
  return {
    kind: "finn-web-runtime",
    ...(client.provider ? { provider: client.provider } : {}),
    search: (options) => client.search(options),
    fetch: (url, options) => client.getContents(url, options),
  };
}

export function createMcpRuntimeService(client: McpRuntimeClient): McpRuntimeService {
  return {
    kind: "finn-mcp-runtime",
    getConnectedServers: () => client.getConnectedServers(),
    getStatuses: () => client.getStatuses(),
    searchTools: (params) => client.searchTools(params),
    callTool: (params) => client.callTool(params),
    listResources: (params) => client.listResources(params),
    readResource: (params) => client.readResource(params),
  };
}

export function createPatternsRuntimeService(service: Omit<PatternsRuntimeService, "kind">): PatternsRuntimeService {
  return {
    kind: "finn-patterns-runtime",
    ...service,
  };
}

function createUserFilesRuntime(input: UserFilesRuntimeInput, workspaceRoot: string): FilesRuntime {
  if (isFilesRuntime(input)) {
    return input;
  }

  return createFilesRuntime({
    ...input,
    workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  });
}

function isFilesRuntime(input: UserFilesRuntimeInput): input is FilesRuntime {
  return "kind" in input && input.kind === "finn-files-runtime";
}

function shouldIncludeRuntimeSlot(slot: RuntimeServiceSlot, options: ProcessRuntimeServicesOptions): boolean {
  if (slot === "files" && options.filesAccess) {
    return true;
  }

  return Boolean(options.services?.[slot] ?? options.grants?.includes(slot));
}

function selectRuntimeService<Slot extends Exclude<RuntimeServiceSlot, "files" | "workspace">>(
  slot: Slot,
  userRuntime: UserRuntimeServices,
  options: ProcessRuntimeServicesOptions,
): Pick<ProcessRuntimeServices, Slot> | Record<string, never> {
  const service = options.services?.[slot] ?? (shouldIncludeRuntimeSlot(slot, options) ? userRuntime[slot] : undefined);
  return service ? { [slot]: service } as Pick<ProcessRuntimeServices, Slot> : {};
}
