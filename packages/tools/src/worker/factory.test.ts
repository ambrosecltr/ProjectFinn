import { afterEach, describe, expect, it, mock } from "bun:test";

import type { PatternRunRecord } from "@finn/core";
import { ComposioClient, ExaClient, FalClient, XaiImagineClient, type McpBroker, type MemoryClient } from "@finn/integrations";
import { createCreativeRuntimeService, createFilesRuntime, createMemoryRuntimeService, createPatternsRuntimeService, createUserRuntimeServices, createWebRuntimeService, type CreativeRuntimeClient, type UserRuntimeServices } from "@finn/runtime";
import type { ToolsetExecuteInput } from "@finn/toolsets";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { CodeModeExecutor } from "../code-mode.js";
import { createAllWorkerTools, createWorkerRuntimeConfig as createWorkerRuntimeConfigBase, type WorkerRuntimeConfig, type WorkerToolsDeps } from "./factory.js";

const testWorkspaceRoot = "/tmp/finn-test-workspace";
const legacyCliToolName = "execute" + "_cli";
const legacyWorkspaceExecPhrase = "workspace" + " exec";
const legacyWorkspaceStdinPhrase = "workspace" + " stdin";

function expectNoNativeWorkspaceTools(tools: ToolSet): void {
  expect(tools.workspace_exec).toBeUndefined();
  expect(tools.workspace_wait).toBeUndefined();
  expect(tools.workspace_stdin).toBeUndefined();
  expect(tools.workspace_processes).toBeUndefined();
}

const baseDeps = {
  integrations: {},
  user: {
    tenantId: "tenant_test",
    userId: "usr_test",
    phoneNumber: "+15555555555",
    displayName: "Test User",
    timezone: "UTC",
    timezoneSource: "server" as const,
    location: null,
    kidsMode: false,
  },
  composioUserId: "tenant_test_usr_test",
  runtime: createUserRuntimeServices({
    workspace: testWorkspaceRoot,
    files: createFilesRuntime({
      workspaceRoot: testWorkspaceRoot,
      documentExtraction: true,
    }),
  }),
} satisfies WorkerToolsDeps;

const createdWorkerRuntimes: WorkerRuntimeConfig[] = [];

afterEach(async () => {
  await Promise.allSettled(createdWorkerRuntimes.map((runtime) => runtime.cleanup?.()));
  createdWorkerRuntimes.length = 0;
});

function createTestCodeModeExecutor(): CodeModeExecutor {
  return {
    execute: async ({ code, dispatch, search }) => {
      const request = JSON.parse(code) as { apiName?: string; args?: unknown; search?: string; limit?: number };
      if (request.search) {
        return {
          success: true,
          result: search(request.search, { limit: request.limit }),
          logs: [],
        };
      }
      if (!request.apiName) {
        throw new Error("Test Code Mode request requires apiName or search.");
      }
      return {
        success: true,
        result: await dispatch(request.apiName, request.args ?? {}),
        logs: [],
      };
    },
  };
}

async function createWorkerRuntimeConfig(
  deps: WorkerToolsDeps,
  options?: Parameters<typeof createWorkerRuntimeConfigBase>[1],
): Promise<WorkerRuntimeConfig> {
  const runtime = await createWorkerRuntimeConfigBase({
    ...deps,
    codeModeExecutorFactory: deps.codeModeExecutorFactory ?? createTestCodeModeExecutor,
  }, options);
  createdWorkerRuntimes.push(runtime);
  return runtime;
}

function createTestRuntime(exa?: ExaClient, creative?: CreativeRuntimeClient) {
  const files = createFilesRuntime({
    workspaceRoot: testWorkspaceRoot,
    documentExtraction: true,
  });
  return createUserRuntimeServices({
    workspace: testWorkspaceRoot,
    files,
    ...(exa ? { web: createWebRuntimeService(exa) } : {}),
    ...(creative ? { creative: createCreativeRuntimeService({ client: creative, files }) } : {}),
  });
}

function withMemoryRuntime(memory: MemoryClient): UserRuntimeServices {
  return createUserRuntimeServices({
    ...baseDeps.runtime,
    memory: createMemoryRuntimeService({ client: memory, user: baseDeps.user }),
  });
}

function createPatternRuntime() {
  return createPatternsRuntimeService({
    user: { timezone: "UTC" },
    create: mock(async () => ({}) as never),
    list: mock(async () => []),
    update: mock(async () => null),
    remove: mock(async () => null),
  });
}

function createExaClient(): ExaClient {
  const client = new ExaClient({ apiKey: "test" });
  client.search = mock(async () => ({ provider: "exa" as const, results: [] }));
  client.getContents = mock(async () => ({ provider: "exa" as const, contents: [] }));
  return client;
}

function createMemoryClient(): MemoryClient {
  return {
    provider: "test",
    addDocument: mock(async () => ({ id: "doc_123", status: "queued" })),
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
    buildHotPathTurnCustomId: (messageId) => `hot-path-turn_${messageId}`,
    buildPatternRunCustomId: (patternRunId) => `pattern-run_${patternRunId}`,
  };
}

function createReflectMemoryClient(): MemoryClient {
  return {
    ...createMemoryClient(),
    reflectMemory: mock(async () => ({ ok: true as const, answer: "remembered answer", evidence: null })),
  };
}

function createFalClient(): FalClient {
  const client = new FalClient({ apiKey: "test" });
  client.generateImage = mock(async () => []);
  client.editImage = mock(async () => []);
  client.generateVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  client.imageToVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  client.editVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  return client;
}

function createXaiImagineClient(): XaiImagineClient {
  const client = new XaiImagineClient({ apiKey: "test" });
  client.generateImage = mock(async () => []);
  client.editImage = mock(async () => []);
  client.generateVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  client.imageToVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  client.editVideo = mock(async () => ({ url: "https://example.com/video.mp4", contentType: "video/mp4" }));
  return client;
}

function createMcpBroker(): McpBroker {
  return {
    getConnectedServers: () => ["docs"],
    getStatuses: () => [{ server: "docs", transport: "http", connected: true, toolCount: 1, resourceCount: 0, alwaysOn: true }],
    searchTools: mock(async () => []),
    callTool: mock(async () => ({ server: "docs", tool: "search", isError: false, content: "ok" })),
    listResources: mock(async () => []),
    readResource: mock(async () => ({ server: "docs", uri: "docs://intro", contents: [] })),
  };
}

function createComposioClient(tools: ToolSet, allowedToolkits?: string[]): ComposioClient {
  const client = new ComposioClient({ apiKey: "test" });
  client.getTools = mock(async () => tools);
  client.getAllowedToolkits = () => allowedToolkits;
  return client;
}

async function searchCodeMode(runtime: WorkerRuntimeConfig, query: string, limit = 10): Promise<string> {
  if (!runtime.tools.workspace_search?.execute) {
    throw new Error("workspace_search is not available in this runtime.");
  }

  return String(await runtime.tools.workspace_search.execute({ query, limit }, {} as never));
}

async function runCodeModeApi(runtime: WorkerRuntimeConfig, apiName: string, args: unknown): Promise<unknown> {
  if (!runtime.tools.workspace_execute?.execute) {
    throw new Error("workspace_execute is not available in this runtime.");
  }

  const executed = await runtime.tools.workspace_execute.execute({
    code: JSON.stringify({ apiName, args }),
  }, {} as never);
  if (typeof executed !== "object" || executed === null || (executed as { success?: unknown }).success !== true) {
    throw new Error(`workspace_execute returned an unexpected result: ${JSON.stringify(executed)}`);
  }

  return (executed as { result: unknown }).result;
}

const composioSearchTool = tool({
  description: "Search Composio tools.",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

const composioExecuteTool = tool({
  description: "Execute Composio tools.",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

const composioManageConnectionsTool = tool({
  description: "Manage Composio connections.",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

describe("createAllWorkerTools", () => {
  it("omits integration-backed tools when integrations are not configured", () => {
    const tools = createAllWorkerTools(baseDeps, { source: "user" });

    expect(tools.web_search).toBeUndefined();
    expect(tools.get_page_contents).toBeUndefined();
    expect(tools.create_or_edit_image).toBeUndefined();
    expect(tools.create_or_edit_video).toBeUndefined();
    expect(tools[legacyCliToolName]).toBeUndefined();
    expect(tools.create_pattern).toBeUndefined();
  });

  it("keeps Pattern management out of the native worker tool set", () => {
    const generalTools = createAllWorkerTools(baseDeps, { source: "user", workerType: "general" });
    const patternTools = createAllWorkerTools(baseDeps, { source: "user", workerType: "pattern_management" });

    expect(generalTools.create_pattern).toBeUndefined();
    expect(generalTools.list_patterns).toBeUndefined();
    expect(patternTools.create_pattern).toBeUndefined();
    expect(patternTools.list_patterns).toBeUndefined();
    expect(patternTools.inspect_pattern).toBeUndefined();
    expect(patternTools.edit_pattern).toBeUndefined();
    expect(patternTools.delete_pattern).toBeUndefined();
  });

  it("exposes Pattern management through Code Mode only to pattern_management workers", async () => {
    const patterns = createPatternRuntime();
    const runtimeDeps = {
      ...baseDeps,
      runtime: createUserRuntimeServices({
        workspace: testWorkspaceRoot,
        files: createFilesRuntime({ workspaceRoot: testWorkspaceRoot }),
        patterns,
      }),
    };
    const generalRuntime = await createWorkerRuntimeConfig(runtimeDeps, { source: "user", workerType: "general" });
    const patternRuntime = await createWorkerRuntimeConfig(runtimeDeps, { source: "user", workerType: "pattern_management" });

    expect(generalRuntime.promptAppendix).not.toContain("finn.patterns.list");
    expect(patternRuntime.tools.create_pattern).toBeUndefined();
    expect(patternRuntime.tools[legacyCliToolName]).toBeUndefined();
    expect(patternRuntime.tools.workspace_search).toBeDefined();
    expect(patternRuntime.tools.workspace_execute).toBeDefined();
    expect(patternRuntime.promptAppendix).toContain("patterns (read/write)");
    expect(patternRuntime.promptAppendix).toContain("Finn JS workspace");
    expect(patternRuntime.promptAppendix).not.toContain("finn.patterns.list");
    expect(patternRuntime.promptAppendix).not.toContain("finn.patterns.pause");
    expect(patternRuntime.promptAppendix).not.toContain("finn.patterns.resume");
    expect(patternRuntime.promptAppendix).not.toContain("toggle_pattern");

    await runCodeModeApi(patternRuntime, "finn.patterns.list", {});

    expect(patterns.list).toHaveBeenCalled();
  });

  it("exposes Files Finn JS workspace APIs to worker runtimes with pattern management read-only", async () => {
    const generalRuntime = await createWorkerRuntimeConfig(baseDeps, { source: "user", workerType: "general" });
    const patternRuntime = await createWorkerRuntimeConfig(baseDeps, {
      source: "pattern",
      workerType: "pattern_worker",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const patternManagementRuntime = await createWorkerRuntimeConfig(baseDeps, { source: "user", workerType: "pattern_management" });

    expect(generalRuntime.tools[legacyCliToolName]).toBeUndefined();
    expect(patternRuntime.tools[legacyCliToolName]).toBeUndefined();
    expect(patternManagementRuntime.tools[legacyCliToolName]).toBeUndefined();
    expect(generalRuntime.tools.workspace_execute).toBeDefined();
    expect(patternRuntime.tools.workspace_execute).toBeDefined();
    expect(patternManagementRuntime.tools.workspace_execute).toBeDefined();
    expect(generalRuntime.tools.view_image).toBeDefined();
    expect(generalRuntime.tools.files_extract).toBeUndefined();
    expect(patternManagementRuntime.tools.files_extract).toBeUndefined();
    expect(generalRuntime.promptAppendix).toContain("files (read/write)");
    expect(await searchCodeMode(generalRuntime, "finn.files.extract")).toContain("finn.files.extract");
    expect(patternManagementRuntime.promptAppendix).toContain("files (read/write)");
    expect(patternManagementRuntime.promptAppendix).toContain("Only the Finn API toolsets listed here are enabled for this process");
    const patternManagementFileDocs = await searchCodeMode(patternManagementRuntime, "finn.files.write patch download", 10);
    expect(patternManagementFileDocs).toContain("finn.files.write");
    expect(patternManagementFileDocs).toContain("finn.files.download");
    expect(patternManagementFileDocs).toContain("finn.files.patch");

    await expect(runCodeModeApi(patternManagementRuntime, "finn.files.write", {
      path: "/workspace/pattern-management.txt",
      content: "nope",
    })).rejects.toThrow("/workspace mount is read-only");
    const artifactWrite = await runCodeModeApi(patternManagementRuntime, "finn.files.write", {
      path: "/artifacts/pattern-management.txt",
      content: "ok",
    });
    expect(JSON.stringify(artifactWrite)).toContain("/artifacts/pattern-management.txt");
  });

  it("exposes Web Finn JS workspace APIs to general and pattern workers only when a web provider and runtime web are available", async () => {
    const exa = createExaClient();
    const deps = {
      ...baseDeps,
      integrations: { exa, web: exa },
      runtime: createTestRuntime(exa),
    };
    const generalRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "general" });
    const patternRuntime = await createWorkerRuntimeConfig(deps, {
      source: "pattern",
      workerType: "pattern_worker",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const patternManagementRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "pattern_management" });

    expect(generalRuntime.tools.web_search).toBeUndefined();
    expect(generalRuntime.tools.get_page_contents).toBeUndefined();
    expect(generalRuntime.promptAppendix).toContain("web (read)");
    expect(generalRuntime.promptAppendix).not.toContain("finn.web.search");
    expect(generalRuntime.promptAppendix).not.toContain("finn.web.fetch");
    expect(patternRuntime.promptAppendix).toContain("web (read)");
    expect(patternManagementRuntime.promptAppendix).not.toContain("finn.web.search");

    await runCodeModeApi(generalRuntime, "finn.web.search", { query: "atlas" });

    expect(exa.search).toHaveBeenCalledWith({
      query: "atlas",
      objective: undefined,
      searchQueries: undefined,
      numResults: 5,
      maxAgeHours: undefined,
      vertical: undefined,
      mode: undefined,
      maxCharsTotal: undefined,
      sessionId: undefined,
      sourcePolicy: undefined,
      fetchPolicy: undefined,
      maxCharsPerResult: undefined,
      location: undefined,
    });
  });

  it("gates individual Web Finn JS workspace APIs with worker capability flags", async () => {
    const exa = createExaClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { exa, web: exa },
      runtime: createTestRuntime(exa),
      capabilities: {
        web_search: true,
        get_page_contents: false,
        create_or_edit_image: false,
        create_or_edit_video: false,
        mcp: false,
        patterns: true,
        composio: false,
        memory: false,
        memory_reflect: false,
        skills: true,
      },
    }, { source: "user", workerType: "general" });

    const docs = await searchCodeMode(runtime, "finn.web.search fetch", 10);

    expect(docs).toContain("finn.web.search");
    expect(docs).not.toContain("finn.web.fetch");
  });

  it("exposes Creative Finn JS workspace APIs to general and pattern workers only when Fal and runtime creative are available", async () => {
    const fal = createFalClient();
    const deps = {
      ...baseDeps,
      integrations: { fal, creative: fal },
      runtime: createTestRuntime(undefined, fal),
    };
    const generalRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "general" });
    const patternRuntime = await createWorkerRuntimeConfig(deps, {
      source: "pattern",
      workerType: "pattern_worker",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const patternManagementRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "pattern_management" });

    expect(generalRuntime.tools.create_or_edit_image).toBeUndefined();
    expect(generalRuntime.tools.create_or_edit_video).toBeUndefined();
    expect(generalRuntime.promptAppendix).toContain("creative (write)");
    expect(generalRuntime.promptAppendix).not.toContain("finn.creative.image");
    expect(generalRuntime.promptAppendix).not.toContain("finn.creative.video");
    expect(patternRuntime.promptAppendix).toContain("creative (write)");
    expect(patternManagementRuntime.promptAppendix).not.toContain("finn.creative.image");

    await runCodeModeApi(generalRuntime, "finn.creative.video", { prompt: "make a short clip" });

    expect(fal.generateVideo).toHaveBeenCalledWith({
      prompt: "make a short clip",
      resolution: undefined,
      duration: undefined,
      aspectRatio: undefined,
      generateAudio: undefined,
    });
  });

  it("exposes Creative Finn JS workspace APIs when xAI is the configured creative provider", async () => {
    const xaiImagine = createXaiImagineClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { xaiImagine, creative: xaiImagine },
      runtime: createTestRuntime(undefined, xaiImagine),
    }, { source: "user", workerType: "general" });

    expect(runtime.promptAppendix).toContain("creative (write)");

    const docs = await searchCodeMode(runtime, "finn.creative.video", 10);
    expect(docs).toContain("finn.creative.video");

    await runCodeModeApi(runtime, "finn.creative.video", { prompt: "make a short clip" });

    expect(xaiImagine.generateVideo).toHaveBeenCalledWith({
      prompt: "make a short clip",
      resolution: undefined,
      duration: undefined,
      aspectRatio: undefined,
      generateAudio: undefined,
    });
  });

  it("gates individual Creative Finn JS workspace APIs with worker capability flags", async () => {
    const fal = createFalClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { fal, creative: fal },
      runtime: createTestRuntime(undefined, fal),
      capabilities: {
        web_search: false,
        get_page_contents: false,
        create_or_edit_image: false,
        create_or_edit_video: true,
        mcp: false,
        patterns: true,
        composio: false,
        memory: false,
        memory_reflect: false,
        skills: true,
      },
    }, { source: "user", workerType: "general" });

    const docs = await searchCodeMode(runtime, "finn.creative.video", 10);

    expect(docs).toContain("finn.creative.video");
    expect(docs).not.toContain("## finn.creative.image");
  });

  it("exposes Finn JS workspace tools to general, pattern, and pattern management workers", async () => {
    const generalRuntime = await createWorkerRuntimeConfig(baseDeps, { source: "user", workerType: "general" });
    const patternRuntime = await createWorkerRuntimeConfig(baseDeps, {
      source: "pattern",
      workerType: "pattern_worker",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const patternManagementRuntime = await createWorkerRuntimeConfig(baseDeps, { source: "user", workerType: "pattern_management" });

    expect(generalRuntime.tools.exec_command).toBeUndefined();
    expect(generalRuntime.tools.write_stdin).toBeUndefined();
    expect(generalRuntime.tools.apply_patch).toBeUndefined();
    expectNoNativeWorkspaceTools(generalRuntime.tools);
    expect(generalRuntime.tools.workspace_search).toBeDefined();
    expect(generalRuntime.tools.workspace_execute).toBeDefined();
    expect(generalRuntime.promptAppendix).toContain("Finn JS workspace APIs enabled in this run");
    expect(generalRuntime.promptAppendix).toContain("Only the Finn API toolsets listed here are enabled for this process");
    expect(generalRuntime.promptAppendix).not.toContain("Secure Exec");
    expect(generalRuntime.promptAppendix).not.toContain("not a shell");
    expect(generalRuntime.promptAppendix).not.toContain(legacyWorkspaceExecPhrase);
    expect(generalRuntime.promptAppendix).not.toContain(legacyWorkspaceStdinPhrase);
    expect(generalRuntime.promptAppendix).not.toContain("workspace patch");
    expect(generalRuntime.promptAppendix).not.toContain("short toolkit aliases");
    expect(patternRuntime.tools.workspace_execute).toBeDefined();
    expectNoNativeWorkspaceTools(patternRuntime.tools);
    expect(patternRuntime.promptAppendix).toContain("Only the Finn API toolsets listed here are enabled for this process");
    expect(patternManagementRuntime.tools.workspace_execute).toBeDefined();
    expectNoNativeWorkspaceTools(patternManagementRuntime.tools);
    expect(patternManagementRuntime.promptAppendix).not.toContain(legacyWorkspaceExecPhrase);
  });

  it("keeps structured patching inside the files Finn JS workspace APIs for write-capable workers", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      capabilities: {
        web_search: false,
        get_page_contents: false,
        create_or_edit_image: false,
        create_or_edit_video: false,
        mcp: false,
        patterns: true,
        composio: false,
        memory: false,
        memory_reflect: false,
        skills: true,
      },
    }, { source: "user", workerType: "general" });

    const docs = await searchCodeMode(runtime, "finn.files.patch image", 10);

    expect(docs).toContain("finn.files.patch");
    expect(docs).not.toContain("viewImage");
    expect(runtime.tools.workspace_execute).toBeDefined();
    expect(runtime.tools.view_image).toBeDefined();
  });

  it("keeps migrated integration toolkits out of the native worker tool set", () => {
    const tools = createAllWorkerTools({
      ...baseDeps,
      integrations: {
        web: createExaClient(),
        exa: createExaClient(),
        fal: createFalClient(),
      },
      mcp: createMcpBroker(),
    });

    expect(tools.web_search).toBeUndefined();
    expect(tools.get_page_contents).toBeUndefined();
    expect(tools.create_or_edit_image).toBeUndefined();
    expect(tools.create_or_edit_video).toBeUndefined();
    expect(tools[legacyCliToolName]).toBeUndefined();
  });

  it("respects capability flags when dependencies exist", () => {
    const tools = createAllWorkerTools({
      ...baseDeps,
      integrations: {
        web: createExaClient(),
        exa: createExaClient(),
        fal: createFalClient(),
      },
      capabilities: {
        web_search: true,
        get_page_contents: false,
        create_or_edit_image: true,
        create_or_edit_video: false,
        mcp: false,
        patterns: true,
        composio: true,
        memory: true,
        memory_reflect: true,
        skills: true,
      },
      mcp: createMcpBroker(),
    });

    expect(tools.web_search).toBeUndefined();
    expect(tools.get_page_contents).toBeUndefined();
    expect(tools.create_or_edit_image).toBeUndefined();
    expect(tools.create_or_edit_video).toBeUndefined();
    expect(tools[legacyCliToolName]).toBeUndefined();
  });

  it("removes only pattern management tools for pattern-triggered workers", () => {
    const tools = createAllWorkerTools(baseDeps, { source: "pattern" });

    expect(tools.create_pattern).toBeUndefined();
    expect(tools.list_patterns).toBeUndefined();
    expect(tools.edit_pattern).toBeUndefined();
    expect(tools.delete_pattern).toBeUndefined();
  });

  it("does not filter normal Finn JS workspace APIs for pattern-triggered workers", async () => {
    const fal = createFalClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { fal, creative: fal },
      runtime: createTestRuntime(undefined, fal),
    }, {
      source: "pattern",
      workerType: "pattern_worker",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    expect(runtime.tools.create_or_edit_image).toBeUndefined();
    expect(runtime.tools.create_or_edit_video).toBeUndefined();
    expect(runtime.promptAppendix).toContain("creative (write)");
    expect(runtime.promptAppendix).not.toContain("finn.creative.image");
    expect(runtime.promptAppendix).not.toContain("finn.creative.video");
  });

  it("exposes Pattern and user memory tools for scoped pattern-triggered workers", async () => {
    const memory = createMemoryClient();
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(memory),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        runId: "ptrun_current",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    await tools.search_memory.execute?.({ scope: "pattern", query: "last outcome", limit: 2 }, {} as never);
    await tools.search_memory.execute?.({ query: "already told", limit: 3 }, {} as never);

    expect(tools.search_memory).toBeDefined();
    expect(tools.search_pattern_memory).toBeUndefined();
    expect(tools.search_user_memory).toBeUndefined();
    expect(memory.searchDocuments).toHaveBeenNthCalledWith(1, {
      user: { tenantId: baseDeps.user.tenantId, userId: baseDeps.user.userId, timezone: baseDeps.user.timezone },
      query: "last outcome",
      limit: 2,
      metadata: { kind: "pattern_run_outcome", source: "pattern_worker", patternId: "ptn_123" },
      observability: { operation: "search_memory", patternId: "ptn_123", patternRunId: "ptrun_current" },
    });
    expect(memory.searchDocuments).toHaveBeenNthCalledWith(2, {
      user: { tenantId: baseDeps.user.tenantId, userId: baseDeps.user.userId, timezone: baseDeps.user.timezone },
      query: "already told",
      limit: 3,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" },
    });
  });

  it("exposes reflect memory tools only when the provider supports reflection", async () => {
    const searchOnlyTools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(createMemoryClient()),
    }, { source: "user", workerType: "general" });
    const memory = createReflectMemoryClient();
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(memory),
    }, { source: "user", workerType: "general" });

    await tools.reflect_memory.execute?.({ question: "what motivates the user?", budget: "high" }, {} as never);

    expect(searchOnlyTools.search_memory).toBeDefined();
    expect(searchOnlyTools.reflect_memory).toBeUndefined();
    expect(tools.reflect_memory).toBeDefined();
    expect(memory.reflectMemory).toHaveBeenCalledWith({
      user: { tenantId: baseDeps.user.tenantId, userId: baseDeps.user.userId, timezone: baseDeps.user.timezone },
      query: "what motivates the user?",
      budget: "high",
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "reflect_memory" },
    });
  });

  it("exposes Pattern reflect memory only when scoped for pattern-triggered workers", async () => {
    const memory = createReflectMemoryClient();
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(memory),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        runId: "ptrun_current",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    await tools.reflect_memory.execute?.({ scope: "pattern", question: "what changed across runs?" }, {} as never);

    expect(tools.reflect_memory).toBeDefined();
    expect(tools.search_memory).toBeDefined();
    expect(tools.reflect_pattern_memory).toBeUndefined();
    expect(memory.reflectMemory).toHaveBeenCalledWith({
      user: { tenantId: baseDeps.user.tenantId, userId: baseDeps.user.userId, timezone: baseDeps.user.timezone },
      query: "what changed across runs?",
      budget: undefined,
      metadata: { kind: "pattern_run_outcome", source: "pattern_worker", patternId: "ptn_123" },
      observability: { operation: "reflect_memory", patternId: "ptn_123", patternRunId: "ptrun_current" },
    });
  });

  it("exposes user memory to delegated workers without Pattern memory", async () => {
    const memory = createMemoryClient();
    const deps = { ...baseDeps, runtime: withMemoryRuntime(memory) };
    const generalTools = createAllWorkerTools(deps, { source: "user", workerType: "general" });
    const patternManagementTools = createAllWorkerTools(deps, { source: "user", workerType: "pattern_management" });

    await generalTools.search_memory.execute?.({ query: "user preference", limit: 4 }, {} as never);

    expect(generalTools.search_memory).toBeDefined();
    expect(generalTools.search_pattern_memory).toBeUndefined();
    expect(patternManagementTools.search_memory).toBeDefined();
    expect(patternManagementTools.search_pattern_memory).toBeUndefined();
    expect(memory.searchDocuments).toHaveBeenCalledWith({
      user: { tenantId: baseDeps.user.tenantId, userId: baseDeps.user.userId, timezone: baseDeps.user.timezone },
      query: "user preference",
      limit: 4,
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" },
    });
  });

  it("does not expose model-controlled memory write tools", () => {
    const forbiddenToolNames = new Set(["add_memory", "write_memory", "remember", "delete_memory", "edit_memory"]);
    const memory = createMemoryClient();
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(memory),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    for (const toolName of Object.keys(tools)) {
      expect(forbiddenToolNames.has(toolName)).toBe(false);
    }
    expect(Object.keys(tools).filter((toolName) => toolName.includes("memory"))).toEqual(["search_memory"]);
  });

  it("omits worker memory tools when memory is disabled by capability", () => {
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(createMemoryClient()),
      capabilities: {
        web_search: true,
        get_page_contents: true,
        create_or_edit_image: true,
        create_or_edit_video: true,
        mcp: true,
        patterns: true,
        composio: true,
        memory: false,
        memory_reflect: false,
        skills: true,
      },
    }, { source: "user", workerType: "general" });

    expect(tools.search_memory).toBeUndefined();
    expect(tools.reflect_memory).toBeUndefined();
  });

  it("exposes Pattern run history through Pattern Finn JS workspace APIs only to pattern-triggered workers", async () => {
    const previousRun: PatternRunRecord = {
      id: "ptrun_old",
      tenantId: "tenant_test",
      userId: "usr_test",
      patternId: "ptn_123",
      triggeredBy: "schedule",
      triggerPayload: { subject: "Launch" },
      workerId: "wrk_old",
      state: "done",
      result: { summary: "OpenAI launched model X.", data: { sourceCount: 2 } },
      error: null,
      skipReason: null,
      notifyOutcome: { notify: true, summary: "OpenAI launched model X.", reason: "New release found." },
      surfacedAt: new Date("2026-04-27T09:02:00.000Z"),
      toolScope: null,
      createdAt: new Date("2026-04-27T09:00:00.000Z"),
      startedAt: new Date("2026-04-27T09:00:01.000Z"),
      completedAt: new Date("2026-04-27T09:01:00.000Z"),
    };
    const listRuns = mock(async (): Promise<PatternRunRecord[]> => [previousRun]);
    const getRun = mock(async () => previousRun);
    const patterns = createPatternsRuntimeService({
      user: { timezone: "UTC" },
      create: mock(async () => ({}) as never),
      list: mock(async () => []),
      update: mock(async () => null),
      remove: mock(async () => null),
      listRuns,
      getRun,
    });
    const deps = {
      ...baseDeps,
      runtime: createUserRuntimeServices({
        workspace: testWorkspaceRoot,
        files: createFilesRuntime({ workspaceRoot: testWorkspaceRoot }),
        patterns,
      }),
    };
    const runtime = await createWorkerRuntimeConfig(deps, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const generalRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "general" });
    const patternManagementRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "pattern_management" });

    await runCodeModeApi(runtime, "finn.pattern.runs", { limit: 1 });
    await runCodeModeApi(runtime, "finn.pattern.run", { runId: "ptrun_old" });

    expect(runtime.tools.list_pattern_runs).toBeUndefined();
    expect(runtime.tools.get_pattern_run).toBeUndefined();
    expect(runtime.tools[legacyCliToolName]).toBeUndefined();
    expect(runtime.tools.workspace_execute).toBeDefined();
    expect(runtime.promptAppendix).toContain("pattern (read)");
    expect(runtime.promptAppendix).not.toContain("finn.pattern.runs");
    expect(runtime.promptAppendix).not.toContain("finn.pattern.run");
    expect(generalRuntime.promptAppendix).not.toContain("finn.pattern.runs");
    expect(patternManagementRuntime.promptAppendix).not.toContain("finn.pattern.runs");
    expect(listRuns).toHaveBeenCalledWith({ patternId: "ptn_123", limit: 1, beforeRunId: undefined });
    expect(getRun).toHaveBeenCalledWith("ptn_123", "ptrun_old");
  });

  it("omits the MCP toolkit for pattern-triggered workers with no scoped MCP servers", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      mcp: createMcpBroker(),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    const docs = await searchCodeMode(runtime, "mcp", 10);

    expect(docs).not.toContain("finn.mcp");
  });

  it("scopes the MCP toolkit for pattern-triggered workers to selected servers", async () => {
    const broker = createMcpBroker();
    broker.getConnectedServers = () => ["docs", "private"];
    broker.getStatuses = () => [
      { server: "docs", transport: "http", connected: true, toolCount: 1, resourceCount: 0, alwaysOn: true },
      { server: "private", transport: "http", connected: true, toolCount: 1, resourceCount: 0, alwaysOn: true },
    ];
    broker.searchTools = mock(async () => [
      { server: "docs", name: "search", inputSchema: { type: "object" as const } },
      { server: "private", name: "search", inputSchema: { type: "object" as const } },
    ]);

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      mcp: broker,
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: ["docs"] },
      },
    });

    const serversOutput = await runCodeModeApi(runtime, "finn.mcp.servers", {});
    await runCodeModeApi(runtime, "finn.mcp.search", { query: "docs" });
    await runCodeModeApi(runtime, "finn.mcp.call", { server: "private", tool: "search" });

    expect(JSON.stringify(serversOutput)).toContain("docs");
    expect(JSON.stringify(serversOutput)).not.toContain("private");
    expect(broker.searchTools).toHaveBeenCalledWith({ query: "docs", limit: undefined, server: undefined });
    expect(broker.callTool).not.toHaveBeenCalled();
  });

  it("exposes the MCP toolkit read-only to pattern-management workers", async () => {
    const broker = createMcpBroker();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      mcp: broker,
    }, { source: "user", workerType: "pattern_management" });

    const docs = await searchCodeMode(runtime, "finn.mcp.search readResource call", 10);
    const denied = await runtime.tools.workspace_execute?.execute?.({
      code: JSON.stringify({ apiName: "finn.mcp.call", args: { server: "docs", tool: "search" } }),
    }, {} as never);

    expect(broker.callTool).not.toHaveBeenCalled();
    expect(docs).toContain("finn.mcp.search");
    expect(docs).toContain("finn.mcp.readResource");
    expect(docs).not.toContain("finn.mcp.call");
    expect(denied).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("finn.mcp.call"),
    }));
  });
});

describe("createWorkerRuntimeConfig", () => {
  it("runs cleanup callbacks when Code Mode setup fails", async () => {
    const cleanup = mock(async () => undefined);

    await expect(createWorkerRuntimeConfigBase({
      ...baseDeps,
      puterToolsets: ["puter.notes"],
      puterContext: {
        executeCommand: mock(async () => ({})),
        cleanup,
      },
      codeModeExecutorFactory: () => {
        throw new Error("workspace setup failure");
      },
    }, { workerId: "workspace_startup_failure" })).rejects.toThrow("workspace setup failure");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("omits the Composio prompt appendix when no Composio tools are loaded", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: {
        composio: createComposioClient({}),
      },
    });

    expect(runtime.promptAppendix).not.toContain("### Composio");
  });

  it("omits unavailable integration tool families from the prompt appendix", async () => {
    const runtime = await createWorkerRuntimeConfig(baseDeps);

    expect(runtime.promptAppendix).not.toContain("research & browsing");
    expect(runtime.promptAppendix).not.toContain("creative");
    expect(runtime.promptAppendix).not.toContain("composio tools");
    expect(runtime.promptAppendix).not.toContain("memory tools");
    expect(runtime.promptAppendix).toContain("runtime tools");
    expect(runtime.promptAppendix).not.toContain("create_pattern");
  });

  it("always returns tool output artifact handling with the baseline files toolkit", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      capabilities: {
        web_search: false,
        get_page_contents: false,
        create_or_edit_image: false,
        create_or_edit_video: false,
        mcp: false,
        patterns: false,
        composio: false,
        memory: false,
        memory_reflect: false,
        skills: false,
      },
    });

    expect(runtime.toolOutputArtifacts).toBeDefined();
    expect(runtime.tools.workspace_execute).toBeDefined();
    expect(runtime.tools.view_image).toBeDefined();
    expect(runtime.promptAppendix).toContain("files (read/write)");
    expect(runtime.promptAppendix).toContain("The files APIs enabled for this run can inspect `/artifacts/...` paths returned by tool outputs");
    expect(await searchCodeMode(runtime, "finn.files.search artifacts", 10)).toContain("finn.files.search");
    expect(runtime.promptAppendix).not.toContain(legacyWorkspaceExecPhrase);
  });

  it("keeps artifact handling and files access alongside other Finn JS workspace APIs", async () => {
    const exa = createExaClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { exa, web: exa },
      runtime: createTestRuntime(exa),
      capabilities: {
        web_search: true,
        get_page_contents: true,
        create_or_edit_image: false,
        create_or_edit_video: false,
        mcp: false,
        patterns: false,
        composio: false,
        memory: false,
        memory_reflect: false,
        skills: false,
      },
    });

    expect(runtime.tools[legacyCliToolName]).toBeUndefined();
    expect(runtime.tools.workspace_execute).toBeDefined();
    expect(runtime.tools.view_image).toBeDefined();
    expect(runtime.promptAppendix).toContain("web (read)");
    expect(runtime.promptAppendix).toContain("files (read/write)");
    expect(runtime.toolOutputArtifacts).toBeDefined();
  });

  it("includes user memory guidance when the tool is loaded", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      runtime: withMemoryRuntime(createMemoryClient()),
    }, { source: "user", workerType: "general" });

    expect(runtime.promptAppendix).toContain("### Memory");
    expect(runtime.promptAppendix).toContain("search_memory");
    expect(runtime.promptAppendix).toContain("prior user context");
    expect(runtime.promptAppendix).toContain("what Finn knows about the user");
    expect(runtime.promptAppendix).not.toContain("Pattern memory is not proof");
  });

  it("uses kid-safe user memory guidance in kids-mode worker appendices", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      user: { ...baseDeps.user, kidsMode: true },
      runtime: withMemoryRuntime(createMemoryClient()),
    }, { source: "user", workerType: "general" });

    expect(runtime.promptAppendix).toContain("search safe context Finn knows about the user");
    expect(runtime.promptAppendix).not.toContain("search what Finn knows about the user");
  });

  it("includes Pattern memory guidance when Pattern memory tools are loaded", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      runtime: withMemoryRuntime(createMemoryClient()),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    expect(runtime.promptAppendix).toContain("### Memory");
    expect(runtime.promptAppendix).toContain("scope: \"pattern\"");
    expect(runtime.promptAppendix).toContain("Pattern memory is not proof the user was notified");
  });

  it("formats sanitized worker memory results without provider provenance", async () => {
    const memory = createMemoryClient();
    memory.searchDocuments = mock(async () => ({
      ok: true as const,
      results: [{
        documentId: "pattern-run_ptrun_123",
        title: null,
        summary: null,
        content: "Pattern already saw Launch A.",
        score: null,
        createdAt: "2026-05-07T09:01:00.000Z",
        updatedAt: null,
        metadata: {
          kind: "pattern_run_outcome",
          patternRunId: "ptrun_123",
          notified: true,
          surfaced: false,
          memoryId: "mem_123",
          memoryType: "experience",
          memoryContext: "Finn Pattern worker run outcome",
          memoryTags: ["scope:pattern"],
          memoryEntities: ["Launch A"],
        },
        chunks: [{ content: "Pattern already saw Launch A.", score: null, isRelevant: true }],
      }],
    }));
    const tools = createAllWorkerTools({
      ...baseDeps,
      runtime: withMemoryRuntime(memory),
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });

    const result = await tools.search_memory.execute?.({ scope: "pattern", query: "launch" }, {} as never);

    expect(result).toEqual({
      results: [{
        content: "Pattern already saw Launch A.",
        score: null,
        createdAt: "2026-05-07T09:01:00.000Z",
        updatedAt: null,
        metadata: {
          kind: "pattern_run_outcome",
          messageId: null,
          conversationId: null,
          patternRunId: "ptrun_123",
          day: null,
          notified: true,
          surfaced: false,
        },
      }],
    });
  });

  it("includes the Composio prompt appendix when Composio tools are loaded", async () => {
    const composio = createComposioClient({
      COMPOSIO_SEARCH_TOOLS: composioSearchTool,
      COMPOSIO_MULTI_EXECUTE_TOOL: composioExecuteTool,
    }, ["gmail", "outlook"]);
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioCallbackUrl: "https://finn.example.com",
      composioToolkits: async () => [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "all" }],
    });

    expect(composio.getTools).toHaveBeenCalledWith(expect.objectContaining({
      sessionConfig: expect.objectContaining({
        manageConnections: { callbackUrl: "https://finn.example.com" },
      }),
    }));
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeDefined();
    expect(runtime.promptAppendix).toContain("### Composio");
    expect(runtime.promptAppendix).toContain("Search with `COMPOSIO_SEARCH_TOOLS` when you need tool names or schemas, then execute with `COMPOSIO_MULTI_EXECUTE_TOOL`.");
    expect(runtime.promptAppendix).toContain("Toolkits available for connection: gmail, outlook.");
    expect(runtime.promptAppendix).toContain("Connected Composio toolkits: gmail account=acct_123.");
    expect(runtime.promptAppendix).toContain("never use Composio, `COMPOSIO_MULTI_EXECUTE_TOOL`, or remote workbench tools");
    expect(runtime.promptAppendix).toContain("Connection requests are allowed in this run.");
    expect(runtime.promptAppendix).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
    expect(runtime.promptAppendix).not.toContain("Connection management: unavailable");
    expect(runtime.promptAppendix).not.toContain("Do not create or request new Composio connections");
  });

  it("loads Composio tools only for scoped pattern connector accounts", async () => {
    const composio = createComposioClient({ COMPOSIO_SEARCH_TOOLS: composioSearchTool });

    await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioToolkits: async () => [
        { slug: "gmail", connectedAccountId: "acct_123", permissionMode: "all" },
        { slug: "slack", connectedAccountId: "acct_456", permissionMode: "all" },
      ],
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123", allowedTools: ["GMAIL_FETCH_EMAILS"] }], mcpServerIds: [] },
      },
    });

    expect(composio.getTools).toHaveBeenCalledTimes(1);
    expect(composio.getTools).toHaveBeenCalledWith(expect.objectContaining({
      sessionConfig: expect.objectContaining({
        manageConnections: false,
        workbench: { enable: false },
        toolkits: { enable: ["gmail"] },
        connectedAccounts: { gmail: ["acct_123"] },
        tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } },
      }),
    }));
  });

  it("does not let pattern allowed tools override a read-only connector scope", async () => {
    const composio = createComposioClient({ COMPOSIO_SEARCH_TOOLS: composioSearchTool });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioToolkits: async () => [
        { slug: "gmail", connectedAccountId: "acct_123", permissionMode: "read_only" },
      ],
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123", allowedTools: ["GMAIL_SEND_EMAIL"] }], mcpServerIds: [] },
      },
    });

    expect(composio.getTools).toHaveBeenCalledTimes(1);
    expect(composio.getTools).toHaveBeenCalledWith(expect.objectContaining({
      sessionConfig: expect.objectContaining({
        manageConnections: false,
        workbench: { enable: false },
        toolkits: { enable: ["gmail"] },
        connectedAccounts: { gmail: ["acct_123"] },
        tools: { gmail: { tags: ["readOnlyHint"] } },
      }),
    }));
    expect(runtime.promptAppendix).toContain("Connected Composio toolkits: gmail account=acct_123.");
    expect(runtime.promptAppendix).not.toContain("GMAIL_SEND_EMAIL");
  });

  it("describes scoped Composio toolkits in pattern worker appendices", async () => {
    const composio = createComposioClient({
      COMPOSIO_SEARCH_TOOLS: composioSearchTool,
      COMPOSIO_MANAGE_CONNECTIONS: composioManageConnectionsTool,
    });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioToolkits: async () => [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "all" }],
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123", allowedTools: ["GMAIL_FETCH_EMAILS"] }], mcpServerIds: [] },
      },
    });

    expect(runtime.promptAppendix).toContain("Connected Composio toolkits: gmail account=acct_123 tools=GMAIL_FETCH_EMAILS.");
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeDefined();
    expect(runtime.tools.COMPOSIO_MANAGE_CONNECTIONS).toBeUndefined();
    expect(runtime.promptAppendix).not.toContain("Connection management: unavailable");
    expect(runtime.promptAppendix).not.toContain("Do not create or request new Composio connections");
    expect(runtime.promptAppendix).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
    expect(runtime.promptAppendix).not.toContain("create the connection link");
  });

  it("does not load Composio tools for disallowed pattern connector accounts", async () => {
    const composio = createComposioClient({ COMPOSIO_SEARCH_TOOLS: composioSearchTool });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioToolkits: async () => [{ slug: "gmail", connectedAccountId: "acct_other", permissionMode: "all" }],
    }, {
      source: "pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "acct_123" }], mcpServerIds: [] },
      },
    });

    expect(composio.getTools).not.toHaveBeenCalled();
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeUndefined();
  });

  it("loads read-only Puter Finn JS workspace APIs only for general workers with live context", async () => {
    const calls: Array<ToolsetExecuteInput & { workerId?: string }> = [];
    const cleanup = mock(() => {});
    const deps = {
      ...baseDeps,
      puterToolsets: async () => ["puter.imessage", "puter.notes"],
      puterContext: async ({ workerId }: { workerId?: string }) => ({
        connectedAccountId: "puter:mac",
        windowStart: new Date(0),
        windowEnd: new Date("2026-05-18T00:00:00.000Z"),
        executeCommand: async (input: ToolsetExecuteInput) => {
          calls.push({ ...input, workerId });
          return { ok: true };
        },
        cleanup,
      }),
    };
    const generalRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "general", workerId: "wrk_123" });
    const patternRuntime = await createWorkerRuntimeConfig(deps, {
      source: "pattern",
      workerType: "pattern_worker",
      workerId: "wrk_pattern",
      pattern: {
        patternId: "ptn_123",
        connectorScope: { composio: [], mcpServerIds: [] },
      },
    });
    const patternManagementRuntime = await createWorkerRuntimeConfig(deps, { source: "user", workerType: "pattern_management", workerId: "wrk_management" });

    await runCodeModeApi(generalRuntime, "finn.puter.notes.listNotes", { limit: 1 });
    await generalRuntime.cleanup?.();

    expect(generalRuntime.promptAppendix).toContain("puter.notes (read)");
    expect(generalRuntime.promptAppendix).toContain("puter.imessage");
    expect(patternRuntime.promptAppendix).not.toContain("puter.notes");
    expect(patternManagementRuntime.promptAppendix).not.toContain("puter.notes");
    expect(calls).toEqual([{
      toolset: "puter.notes",
      command: "list_notes",
      args: { limit: 1 },
      workerId: "wrk_123",
    }]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("omits Puter Finn JS workspace APIs when no live context is available", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      puterToolsets: async () => ["puter.notes"],
      puterContext: async () => undefined,
    }, { source: "user", workerType: "general" });

    expect(runtime.tools[legacyCliToolName]).toBeUndefined();
    expect(runtime.tools.workspace_execute).toBeDefined();
    expect(runtime.promptAppendix).not.toContain("puter.notes");
  });

  it("loads Composio native tools when no user toolkits are connected", async () => {
    const composio = createComposioClient({ COMPOSIO_SEARCH_TOOLS: composioSearchTool });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioToolkits: async () => [],
    });

    expect(composio.getTools).toHaveBeenCalledTimes(1);
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeDefined();
    expect(runtime.promptAppendix).toContain("### Composio");
  });

  it("loads Composio connection tools for pattern management workers without connected toolkits", async () => {
    const composio = createComposioClient({
      COMPOSIO_SEARCH_TOOLS: composioSearchTool,
      COMPOSIO_MANAGE_CONNECTIONS: composioManageConnectionsTool,
    });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      composioCallbackUrl: "https://finn.example.com/composio/callback",
      composioToolkits: async () => [],
    }, {
      source: "user",
      workerType: "pattern_management",
    });

    expect(composio.getTools).toHaveBeenCalledTimes(1);
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeDefined();
    expect(runtime.tools.COMPOSIO_MANAGE_CONNECTIONS).toBeDefined();
    expect(runtime.promptAppendix).toContain("Use `COMPOSIO_MANAGE_CONNECTIONS` directly only when the task requires a new connection.");
    expect(runtime.promptAppendix).not.toContain("Connection management: unavailable");
  });

  it("does not load a broad Composio session for kids mode when no toolkits are connected", async () => {
    const composio = createComposioClient({ COMPOSIO_SEARCH_TOOLS: composioSearchTool });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      allowComposioConnectionRequests: false,
      composioToolkits: async () => [],
    });

    expect(composio.getTools).not.toHaveBeenCalled();
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeUndefined();
    expect(runtime.promptAppendix).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });

  it("removes Composio connection management for kids mode when connected tools load", async () => {
    const composio = createComposioClient({
      COMPOSIO_SEARCH_TOOLS: composioSearchTool,
      COMPOSIO_MANAGE_CONNECTIONS: composioManageConnectionsTool,
    });

    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: { composio },
      allowComposioConnectionRequests: false,
      composioToolkits: async () => [{ slug: "gmail", connectedAccountId: "acct_123", permissionMode: "all" }],
    });

    expect(composio.getTools).toHaveBeenCalledTimes(1);
    expect(runtime.tools.COMPOSIO_SEARCH_TOOLS).toBeDefined();
    expect(runtime.tools.COMPOSIO_MANAGE_CONNECTIONS).toBeUndefined();
    expect(runtime.promptAppendix).not.toContain("guardian setup in the web app");
    expect(runtime.promptAppendix).not.toContain("Do not create or request new Composio connections");
    expect(runtime.promptAppendix).not.toContain("manage auth with `COMPOSIO_MANAGE_CONNECTIONS`");
    expect(runtime.promptAppendix).not.toContain("create the connection link");
  });

  it("includes configured integration tool families in the prompt appendix", async () => {
    const exa = createExaClient();
    const fal = createFalClient();
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      integrations: {
        web: exa,
        exa,
        fal,
        creative: fal,
      },
      runtime: createTestRuntime(exa, fal),
      mcp: createMcpBroker(),
    });

    expect(runtime.promptAppendix).toContain("web (read)");
    expect(runtime.promptAppendix).not.toContain("finn.web.search");
    expect(runtime.promptAppendix).not.toContain("web_search");
    expect(runtime.promptAppendix).toContain("creative (write)");
    expect(runtime.promptAppendix).not.toContain("finn.creative.image");
    expect(runtime.promptAppendix).not.toContain("create_or_edit_image");
    expect(runtime.promptAppendix).toContain("mcp (read/write)");
    expect(runtime.promptAppendix).not.toContain("load the mcp skill");
    expect(runtime.promptAppendix).toContain("mcp runtime: read/write");
    expect(runtime.promptAppendix).toContain("MCP servers visible in this run: docs");
    expect(runtime.promptAppendix).not.toContain("search_mcp_tools");
    expect(runtime.promptAppendix).not.toContain("load the mcp skill");
  });

  it("describes read-only MCP availability without call guidance", async () => {
    const runtime = await createWorkerRuntimeConfig({
      ...baseDeps,
      mcp: createMcpBroker(),
    }, { source: "user", workerType: "pattern_management" });

    expect(runtime.promptAppendix).toContain("mcp (read)");
    expect(runtime.promptAppendix).toContain("mcp runtime: read-only; remote tool calls are not available in this run");
    expect(runtime.promptAppendix).not.toContain("read/write, with remote tool calls treated as write/unknown-effect");
  });

  it("does not expose legacy native workspace tools in Code Mode runtimes", async () => {
    const runtime = await createWorkerRuntimeConfig(baseDeps);

    expect(runtime.tools.exec_command).toBeUndefined();
    expect(runtime.tools[legacyCliToolName]).toBeUndefined();
    expectNoNativeWorkspaceTools(runtime.tools);
    expect(runtime.tools.workspace_execute).toBeDefined();
  });

  it("does not grant skills toolkit or native skill tools initially", async () => {
    const runtime = await createWorkerRuntimeConfig(baseDeps);

    expect(runtime.tools.list_installed_skills).toBeUndefined();
    expect(runtime.tools.search_skills_sh).toBeUndefined();
    expect(runtime.tools.load_skill).toBeUndefined();
    expect(runtime.promptAppendix).not.toContain("### skills");
    expect(runtime.promptAppendix).not.toContain("local skills");
    expect(runtime.promptAppendix).not.toContain("skills (");
  });
});
