import { createLogger, WorkerToolOutputArtifactStore } from "@finn/core";
import type { AppConfig, SpawnWorkerOpts, UserContext } from "@finn/core";
import { createComposioSessionConfig, type ComposioConfiguredToolkit, type IntegrationClients } from "@finn/integrations";
import { createMcpRuntimeService, createProcessRuntimeServices, type McpRuntimeService, type RuntimeProcessType, type RuntimeServiceSlot, type ToolRuntimeServices, type UserRuntimeServices } from "@finn/runtime";
import { createCreativeToolsetDefinition, createFilesToolsetDefinition, createMcpToolsetDefinition, createPatternToolsetDefinition, createPatternsToolsetDefinition, createToolsetRuntime, createWebToolsetDefinition, type CodeModeToolsetSummary, type ToolsetDefinition, type ToolsetExecutionContext, type ToolsetGrantMap, type ToolsetProcessType } from "@finn/toolsets";
import type { ToolSet } from "ai";

import { createCodeModeTools, SecureExecCodeModeExecutor, type CodeModeExecutor } from "../code-mode.js";
import { createViewImageTools } from "../view-image.js";
import { createWorkerMemoryTools } from "./memory.js";

const logger = createLogger("worker-tools");

type ToolsetCommandNameSummary = {
  slug: string;
  commands: readonly { name: string }[];
};

export interface WorkerToolsDeps {
  integrations: IntegrationClients;
  user?: UserContext;
  capabilities?: AppConfig["capabilities"]["tools"]["worker"];
  runtime: UserRuntimeServices;
  composioUserId: string;
  composioCallbackUrl?: string;
  allowComposioConnectionRequests?: boolean;
  composioToolkits?: ComposioConfiguredToolkit[] | (() => Promise<ComposioConfiguredToolkit[]>);
  puterToolsets?: Iterable<string> | (() => Promise<Iterable<string>>);
  puterContext?: ToolsetExecutionContext | ((options: { workerId?: string }) => Promise<ToolsetExecutionContext | undefined>);
  mcp?: IntegrationClients["mcp"];
  codeModeExecutorFactory?: () => CodeModeExecutor;
}

export interface WorkerRuntimeConfig {
  tools: ToolSet;
  promptAppendix: string;
  toolOutputArtifacts?: WorkerToolOutputArtifactStore;
  cleanup?: (options?: WorkerRuntimeCleanupOptions) => void | Promise<void>;
}

export interface WorkerRuntimeOptions {
  source?: "user" | "pattern";
  workerType?: string;
  pattern?: SpawnWorkerOpts["pattern"];
  workerId?: string;
}

export interface WorkerRuntimeCleanupOptions {
  preserveTemporaryWorkspace?: boolean;
}

function isMcpServerAllowed(server: string, allowedServers?: Set<string>): boolean {
  return !allowedServers || allowedServers.has(server);
}

function scopeMcpBroker(mcp: NonNullable<IntegrationClients["mcp"]>, serverIds: string[]): NonNullable<IntegrationClients["mcp"]> | undefined {
  if (serverIds.length === 0) {
    return undefined;
  }

  const allowedServers = new Set(serverIds);
  return {
    getConnectedServers: () => mcp.getConnectedServers().filter((server) => isMcpServerAllowed(server, allowedServers)),
    getStatuses: () => mcp.getStatuses().filter((status) => isMcpServerAllowed(status.server, allowedServers)),
    searchTools: (params) => {
      if (!isMcpServerAllowed(params.server ?? "", params.server ? allowedServers : undefined)) {
        return Promise.resolve([]);
      }
      return mcp.searchTools(params.server ? params : { ...params }).then((tools) => tools.filter((tool) => isMcpServerAllowed(tool.server, allowedServers)));
    },
    callTool: (params) => {
      if (!isMcpServerAllowed(params.server, allowedServers)) {
        throw new Error(`MCP server is not in this Pattern scope: ${params.server}`);
      }
      return mcp.callTool(params);
    },
    listResources: (params) => {
      if (params?.server && !isMcpServerAllowed(params.server, allowedServers)) {
        return Promise.resolve([]);
      }
      return mcp.listResources(params).then((resources) => resources.filter((resource) => isMcpServerAllowed(resource.server, allowedServers)));
    },
    readResource: (params) => {
      if (!isMcpServerAllowed(params.server, allowedServers)) {
        throw new Error(`MCP server is not in this Pattern scope: ${params.server}`);
      }
      return mcp.readResource(params);
    },
  };
}

function hasTool(tools: ToolSet, name: string): boolean {
  return Boolean(tools[name]);
}

function hasAnyTool(tools: ToolSet, names: string[]): boolean {
  return names.some((name) => hasTool(tools, name));
}

function getWorkerToolsetProcessType(options: WorkerRuntimeOptions): ToolsetProcessType {
  if (options.source === "pattern") {
    return "pattern_worker";
  }
  if (options.workerType === "pattern_management") {
    return "pattern_management";
  }
  return "worker";
}

function getWorkerRuntimeProcessType(options: WorkerRuntimeOptions): RuntimeProcessType {
  if (options.source === "pattern") {
    return "pattern_worker";
  }
  if (options.workerType === "pattern_management") {
    return "pattern_management";
  }
  return "worker";
}

function commandNamesForToolset(summaries: readonly ToolsetCommandNameSummary[], slug: string): string[] {
  return summaries.find((summary) => summary.slug === slug)?.commands.map((command) => command.name) ?? [];
}

function renderMcpRuntimeGuidance(summaries: readonly ToolsetCommandNameSummary[], mcp?: McpRuntimeService): string[] {
  const commands = commandNamesForToolset(summaries, "mcp");
  if (commands.length === 0) {
    return [];
  }

  const statuses = mcp?.getStatuses() ?? [];
  const serverNames = statuses.map((status) => status.server).filter((server) => server.length > 0);
  const hasCall = commands.includes("call");

  return [
    `- mcp runtime: ${hasCall ? "read/write, with remote tool calls treated as write/unknown-effect" : "read-only; remote tool calls are not available in this run"}.`,
    serverNames.length > 0 ? `- MCP servers visible in this run: ${serverNames.join(", ")}.` : "- MCP servers can be discovered with the available `finn.mcp.*` APIs; none were prelisted in the runtime appendix.",
    "- inspect MCP API guidance with `workspace_search` before using discovery, resource, or remote-call APIs.",
  ].filter((line) => line.length > 0);
}

function renderCodeModeToolsetInstructions(summaries: readonly CodeModeToolsetSummary[], options: { mcp?: McpRuntimeService } = {}): string {
  if (summaries.length === 0) {
    return "";
  }

  const fileCommands = commandNamesForToolset(summaries, "files");
  const hasFiles = fileCommands.length > 0;
  const patchGuidance = fileCommands.includes("patch")
    ? "The `finn.files.patch` API is enabled; prefer `finn.files.patch(...)` for structured file edits when modifying workspace files."
    : "";
  const artifactGuidance = hasFiles
    ? "The files APIs enabled for this run can inspect `/artifacts/...` paths returned by tool outputs."
    : "";

  const guidanceLines = [
    "### Finn JS workspace APIs enabled in this run",
    "Only the Finn API toolsets listed here are enabled for this process.",
  ];
  if (patchGuidance) {
    guidanceLines.push(patchGuidance);
  }
  if (artifactGuidance) {
    guidanceLines.push(artifactGuidance);
  }

  return [
    ...guidanceLines,
    "",
    "Enabled Finn API toolsets:",
    ...summaries.map((summary) => {
      const effects = summary.effects.join("/");
      return `- ${summary.slug} (${effects}): ${summary.description} ${summary.commands.length} API(s).`;
    }),
    ...renderMcpRuntimeGuidance(summaries, options.mcp),
  ].join("\n");
}

function formatConnectedComposioToolkits(toolkits: ComposioConfiguredToolkit[] | undefined): string {
  if (!toolkits?.length) {
    return "none";
  }

  return toolkits
    .map((toolkit) => {
      const account = toolkit.connectedAccountId ? ` account=${toolkit.connectedAccountId}` : "";
      const allowedTools = toolkit.permissionMode !== "read_only" && toolkit.allowedTools?.length ? ` tools=${toolkit.allowedTools.join(",")}` : "";
      return `${toolkit.slug}${account}${allowedTools}`;
    })
    .join("; ");
}

function formatConnectableComposioToolkits(toolkits: readonly string[] | undefined): string {
  if (!toolkits) {
    return "any toolkit allowed by this Finn deployment";
  }
  if (toolkits.length === 0) {
    return "none";
  }
  return toolkits.join(", ");
}

function applyPatternComposioAllowedTools(
  configured: ComposioConfiguredToolkit,
  allowedTools: string[] | undefined,
): ComposioConfiguredToolkit {
  if (configured.permissionMode === "read_only") {
    const { allowedTools: _ignoredAllowedTools, ...readOnlyConfigured } = configured;
    return readOnlyConfigured;
  }

  return {
    ...configured,
    ...(allowedTools?.length ? { allowedTools } : {}),
  };
}

function renderAvailableWorkerToolInstructions(tools: ToolSet, options: { kidsMode: boolean; connectionRequestsAllowed: boolean; patternMemoryAvailable?: boolean; composioToolkits?: ComposioConfiguredToolkit[]; composioAllowedToolkits?: readonly string[]; filesToolsetAvailable?: boolean }): string {
  const sections = [
    "## runtime tools",
    "",
    "Only use tools that are present in this run. If a tool family is absent, do not claim you can use it.",
  ];

  if (hasAnyTool(tools, ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"])) {
    const hasConnectionManagement = hasTool(tools, "COMPOSIO_MANAGE_CONNECTIONS");
    const hasSearch = hasTool(tools, "COMPOSIO_SEARCH_TOOLS");
    const hasExecute = hasTool(tools, "COMPOSIO_MULTI_EXECUTE_TOOL");
    const usageInstruction = hasSearch && hasExecute
      ? "Search with `COMPOSIO_SEARCH_TOOLS` when you need tool names or schemas, then execute with `COMPOSIO_MULTI_EXECUTE_TOOL`."
      : hasSearch
        ? "Search with `COMPOSIO_SEARCH_TOOLS` when you need connected tool names or schemas."
        : "Execute connected Composio tools with `COMPOSIO_MULTI_EXECUTE_TOOL`.";
    const authInstructions = hasConnectionManagement
      ? [
          "Use `COMPOSIO_MANAGE_CONNECTIONS` directly only when the task requires a new connection.",
          "If Composio returns a connect link or auth URL, include it clearly in the final outcome data so Finn can ask the user to complete auth.",
        ]
      : options.connectionRequestsAllowed
        ? [
            "Connection requests are allowed in this run. If a needed toolkit is not connected, use the available Composio meta tools to find the connection/auth action and include any connect link or auth URL in the final outcome data.",
          ]
        : [];
    sections.push(
      "",
      "### Composio",
      "Use Composio for connected external services and account actions.",
      usageInstruction,
      `Connected Composio toolkits: ${formatConnectedComposioToolkits(options.composioToolkits)}.`,
      `Toolkits available for connection: ${formatConnectableComposioToolkits(options.composioAllowedToolkits)}.`,
      ...authInstructions,
      options.filesToolsetAvailable
        ? "If any tool result includes `full_output_path`, `tool_output_artifact.path`, or a `/artifacts/...` path, treat it as a Finn run artifact and inspect it through `finn.files.*` workspace APIs; never use Composio, `COMPOSIO_MULTI_EXECUTE_TOOL`, or remote workbench tools for these paths."
        : "If any tool result includes `full_output_path`, `tool_output_artifact.path`, or a `/artifacts/...` path, treat it as a Finn run artifact, not an external-service file or user workspace file. Never use Composio, `COMPOSIO_MULTI_EXECUTE_TOOL`, or remote workbench tools for these paths.",
    );
  }

  if (hasAnyTool(tools, ["reflect_memory", "search_memory"])) {
    const userMemoryDescription = options.kidsMode
      ? "search safe context Finn knows about the user, including preferences, personal facts, communication style, prior context, and what Finn may already have told them."
      : "search what Finn knows about the user, including preferences, personal facts, communication style, prior context, and what Finn may already have told them.";
    const hasPatternScope = options.patternMemoryAvailable ?? false;
    sections.push(
      "",
      "### Memory",
      "Use memory only when prior user context, previous Finn answers, cross-run continuity, or notification novelty materially changes the task.",
      hasTool(tools, "search_memory") ? `\`search_memory\` user scope: ${userMemoryDescription}` : "",
      hasTool(tools, "reflect_memory") ? "`reflect_memory` asks Finn's memory layer to synthesize an answer when raw matching facts are not enough. Its budget is a work budget, not a quality slider: low for simple/specific facts, mid for synthesis across a few related memories, and high only for broad, ambiguous, sensitive, or high-consequence synthesis." : "",
      hasPatternScope ? "Pattern workers may pass `scope: \"pattern\"` to inspect previous terminal outcomes for this same Pattern." : "",
      hasPatternScope ? "Pattern memory is not proof the user was notified; use user memory when user-visible novelty matters." : "",
      "Do not announce memory searches or mention memory mechanics in outcomes.",
    );
  }

  return sections.filter((line) => line.length > 0).join("\n");
}

export function createAllWorkerTools(deps: WorkerToolsDeps, options: WorkerRuntimeOptions = {}): ToolSet {
  const capabilities = deps.capabilities;
  const tools: ToolSet = {};

  if ((capabilities?.memory ?? true) && deps.runtime.memory && deps.user) {
    Object.assign(tools, createWorkerMemoryTools({
      memory: deps.runtime.memory,
      reflect: capabilities?.memory_reflect ?? true,
      patternId: options.source === "pattern" ? options.pattern?.patternId : undefined,
      patternRunId: options.pattern?.runId,
    }));
  }

  return tools;
}

export async function createWorkerRuntimeConfig(deps: WorkerToolsDeps, options: WorkerRuntimeOptions = {}): Promise<WorkerRuntimeConfig> {
  const tools = createAllWorkerTools(deps, options);
  const workspaceRoot = deps.runtime.workspace.workspaceRoot;
  const toolOutputArtifacts = new WorkerToolOutputArtifactStore({
    workspaceRoot,
    artifactsRoot: deps.runtime.workspace.artifactsRoot,
    runId: options.workerId,
  });
  const toolsetDefinitions: ToolsetDefinition[] = [];
  const enabledToolsets = new Set<string>();
  const toolsetGrants: ToolsetGrantMap = {};
  const cleanupCallbacks: Array<() => void | Promise<void>> = [];
  const processType = getWorkerToolsetProcessType(options);
  const webSearchEnabled = deps.capabilities?.web_search ?? true;
  const webFetchEnabled = deps.capabilities?.get_page_contents ?? true;
  const shouldExposeWebToolset = Boolean(deps.integrations.web)
    && (processType === "worker" || processType === "pattern_worker")
    && (webSearchEnabled || webFetchEnabled);
  const creativeImageEnabled = deps.capabilities?.create_or_edit_image ?? true;
  const creativeVideoEnabled = deps.capabilities?.create_or_edit_video ?? true;
  const shouldExposeCreativeToolset = Boolean(deps.integrations.fal)
    && (processType === "worker" || processType === "pattern_worker")
    && (creativeImageEnabled || creativeVideoEnabled);
  const scopedMcp = options.source === "pattern" && deps.mcp
    ? scopeMcpBroker(deps.mcp, options.pattern?.connectorScope.mcpServerIds ?? [])
    : deps.mcp;
  const shouldExposeMcpToolset = (deps.capabilities?.mcp ?? true)
    && Boolean(scopedMcp)
    && (processType === "worker" || processType === "pattern_management" || processType === "pattern_worker");
  const shouldGrantPatternsRuntime = (deps.capabilities?.patterns ?? true)
    && Boolean(deps.runtime?.patterns)
    && processType === "pattern_management";
  const shouldGrantPatternRuntime = (deps.capabilities?.patterns ?? true)
    && Boolean(deps.runtime?.patterns?.listRuns && deps.runtime.patterns.getRun && options.pattern?.patternId)
    && processType === "pattern_worker";
  const processGrants: RuntimeServiceSlot[] = [
    ...(shouldExposeWebToolset ? ["web" as const] : []),
    ...(shouldExposeCreativeToolset ? ["creative" as const] : []),
    "artifacts",
    ...(shouldExposeMcpToolset ? ["mcp" as const] : []),
    ...(shouldGrantPatternsRuntime ? ["patterns" as const] : []),
    ...(shouldGrantPatternRuntime ? ["patterns" as const] : []),
  ];
  const services: ToolRuntimeServices = {
    artifacts: toolOutputArtifacts,
    ...(shouldExposeMcpToolset && scopedMcp ? { mcp: createMcpRuntimeService(scopedMcp) } : {}),
  };
  const processRuntime = createProcessRuntimeServices(deps.runtime, {
    processType: getWorkerRuntimeProcessType(options),
    runId: options.workerId,
    grants: processGrants,
    filesAccess: processType === "pattern_management" ? "read" : "write",
    services,
  });

  if (processRuntime?.files) {
    toolsetDefinitions.push(createFilesToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.files,
    }));
    enabledToolsets.add("files");
  }

  if (shouldExposeWebToolset && processRuntime?.web) {
    toolsetDefinitions.push(createWebToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.web,
      search: webSearchEnabled,
      fetch: webFetchEnabled,
    }));
    enabledToolsets.add("web");
    toolsetGrants["web"] = "read";
  }

  if (shouldExposeCreativeToolset && processRuntime?.creative) {
    toolsetDefinitions.push(createCreativeToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.creative,
      image: creativeImageEnabled,
      video: creativeVideoEnabled,
    }));
    enabledToolsets.add("creative");
    toolsetGrants["creative"] = "write";
  }

  if (shouldExposeMcpToolset && processRuntime?.mcp) {
    toolsetDefinitions.push(createMcpToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.mcp,
    }));
    enabledToolsets.add("mcp");
    toolsetGrants["mcp"] = processType === "pattern_management" ? "read" : "write";
  }

  if (processType === "pattern_management" && processRuntime?.patterns) {
    toolsetDefinitions.push(createPatternsToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.patterns,
    }));
    enabledToolsets.add("patterns");
    toolsetGrants["patterns"] = "write";
  }

  if (processType === "pattern_worker" && processRuntime?.patterns && options.pattern?.patternId) {
    toolsetDefinitions.push(createPatternToolsetDefinition({
      processTypes: [processType],
      runtime: processRuntime.patterns,
      patternId: options.pattern.patternId,
    }));
    enabledToolsets.add("pattern");
    toolsetGrants["pattern"] = "read";
  }

  let puterContext: ToolsetExecutionContext | undefined;
  if (processType === "worker") {
    const configuredPuterToolsets = typeof deps.puterToolsets === "function"
      ? await deps.puterToolsets()
      : deps.puterToolsets;
    const puterToolsets = [...configuredPuterToolsets ?? []].filter((toolset) => toolset === "puter.imessage" || toolset === "puter.notes");
    if (puterToolsets.length > 0) {
      puterContext = typeof deps.puterContext === "function"
        ? await deps.puterContext({ workerId: options.workerId })
        : deps.puterContext;
      if (puterContext?.executeCommand) {
        for (const toolset of puterToolsets) {
          enabledToolsets.add(toolset);
          toolsetGrants[toolset] = "read";
        }
        if (puterContext.cleanup) {
          cleanupCallbacks.push(puterContext.cleanup);
        }
      }
    }
  }

  let loadedComposioToolkits: ComposioConfiguredToolkit[] | undefined;
  let connectableComposioToolkits: string[] | undefined;
  if ((deps.capabilities?.composio ?? true) && deps.integrations.composio) {
    try {
      const allowComposioConnectionRequests = deps.allowComposioConnectionRequests ?? true;
      const allowComposioConnectionManagement = options.source === "pattern" ? false : allowComposioConnectionRequests;
      const composioToolkits = typeof deps.composioToolkits === "function"
        ? await deps.composioToolkits()
        : deps.composioToolkits;
      const scopedComposioToolkits = options.source === "pattern"
        ? options.pattern?.connectorScope.composio.map((scope) => {
            const configured = composioToolkits?.find((toolkit) => toolkit.slug === scope.toolkitSlug && (!scope.connectedAccountId || toolkit.connectedAccountId === scope.connectedAccountId));
            return configured ? applyPatternComposioAllowedTools(configured, scope.allowedTools) : null;
          }).filter((toolkit): toolkit is NonNullable<typeof toolkit> => Boolean(toolkit)) ?? []
        : composioToolkits;
      const shouldLoadComposio = options.source === "pattern"
        ? Boolean(scopedComposioToolkits?.length)
        : allowComposioConnectionRequests || Boolean(scopedComposioToolkits?.length);
      if (shouldLoadComposio) {
        loadedComposioToolkits = scopedComposioToolkits;
        connectableComposioToolkits = deps.integrations.composio.getAllowedToolkits();
        const composioTools = await deps.integrations.composio.getTools({
          userId: deps.composioUserId,
          sessionConfig: createComposioSessionConfig({
            callbackUrl: deps.composioCallbackUrl,
            allowConnectionRequests: allowComposioConnectionManagement,
            allowedToolkits: connectableComposioToolkits,
            configuredToolkits: scopedComposioToolkits,
          }),
        });
        if (!allowComposioConnectionManagement) {
          delete composioTools.COMPOSIO_MANAGE_CONNECTIONS;
        }
        Object.assign(tools, composioTools);
      }
    } catch (error) {
      logger.error({ error, userId: deps.composioUserId }, "Failed to load Composio tools for worker runtime");
    }
  }

  const toolsetRuntime = toolsetDefinitions.length > 0 || puterContext
    ? createToolsetRuntime({
        processType,
        enabledTools: enabledToolsets,
        definitions: toolsetDefinitions,
        includeBuiltInToolsets: puterContext !== undefined,
        toolsetGrants,
        context: {
          ...(processRuntime ? { runtime: { ...processRuntime, artifacts: toolOutputArtifacts } } : {}),
          ...puterContext,
        },
      })
    : null;

  let runtimeClosed = false;
  let temporaryWorkspaceCleaned = false;
  async function cleanupTemporaryWorkspace(): Promise<void> {
    if (temporaryWorkspaceCleaned) {
      return;
    }
    temporaryWorkspaceCleaned = true;
    await toolOutputArtifacts.cleanup();
  }

  const codeModeToolsetSummaries = toolsetRuntime?.toCodeModeToolsets() ?? [];
  if (toolsetRuntime) {
    try {
      const codeModeExecutor = deps.codeModeExecutorFactory?.() ?? new SecureExecCodeModeExecutor();
      cleanupCallbacks.push(() => codeModeExecutor.dispose?.());
      Object.assign(tools, createCodeModeTools(toolsetRuntime, {
        executor: codeModeExecutor,
        artifacts: toolOutputArtifacts,
        catalog: { excludeCommands: { files: ["view_image"] } },
      }));
    } catch (error) {
      await Promise.allSettled([
        ...cleanupCallbacks.map((callback) => callback()),
        toolOutputArtifacts.cleanup(),
      ]);
      throw error;
    }
  }
  Object.assign(tools, createViewImageTools(processRuntime));

  if (codeModeToolsetSummaries.length > 0) {
    logger.debug({
      processType,
      runId: options.workerId,
      toolsets: codeModeToolsetSummaries.map((summary) => summary.slug),
    }, "Registered Finn JS workspace APIs for worker runtime");
  }

  return {
    tools,
    toolOutputArtifacts,
    cleanup: async (cleanupOptions = {}) => {
      if (!runtimeClosed) {
        runtimeClosed = true;
        await Promise.allSettled(cleanupCallbacks.map((callback) => callback()));
      }
      if (cleanupOptions.preserveTemporaryWorkspace !== true) {
        await cleanupTemporaryWorkspace();
      }
    },
    promptAppendix: [
      renderAvailableWorkerToolInstructions(tools, {
        kidsMode: deps.user?.kidsMode ?? false,
        connectionRequestsAllowed: (deps.allowComposioConnectionRequests ?? true) && options.source !== "pattern",
        patternMemoryAvailable: options.source === "pattern" && Boolean(options.pattern?.patternId),
        composioToolkits: loadedComposioToolkits,
        composioAllowedToolkits: connectableComposioToolkits,
        filesToolsetAvailable: commandNamesForToolset(codeModeToolsetSummaries, "files").length > 0,
      }),
      renderCodeModeToolsetInstructions(codeModeToolsetSummaries, { mcp: processRuntime?.mcp }),
    ]
      .filter((section) => section.trim().length > 0)
      .join("\n\n"),
  };
}

export function createGetWorkerTools(deps: WorkerToolsDeps): (type: string, options?: WorkerRuntimeOptions) => Promise<WorkerRuntimeConfig> {
  return (type, options) => createWorkerRuntimeConfig(deps, { ...options, workerType: type });
}
