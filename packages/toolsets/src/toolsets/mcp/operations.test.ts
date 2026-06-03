import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerToolOutputArtifactStore } from "@finn/core";
import type { McpRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createMcpToolsetDefinition } from "./index.js";

let workspaceRoot: string | null = null;

function createMcpRuntime(): McpRuntimeService {
  return {
    kind: "finn-mcp-runtime",
    getConnectedServers: () => ["docs"],
    getStatuses: () => [{
      server: "docs",
      transport: "http",
      connected: true,
      toolCount: 1,
      resourceCount: 2,
      alwaysOn: true,
    }],
    searchTools: mock(async () => [{
      server: "docs",
      name: "search_docs",
      description: "Search the docs.",
      inputSchema: { type: "object" },
    }]),
    callTool: mock(async () => ({
      server: "docs",
      tool: "search_docs",
      isError: false,
      content: "result".repeat(200),
    })),
    listResources: mock(async () => [
      { server: "docs", uri: "docs://intro", name: "Intro" },
      { server: "docs", uri: "docs://setup", name: "Setup" },
    ]),
    readResource: mock(async () => ({
      server: "docs",
      uri: "docs://intro",
      contents: [{ uri: "docs://intro", text: "hello" }],
    })),
  };
}

function createRuntime(options: { grant?: "read" | "write"; artifacts?: boolean } = {}) {
  const mcp = createMcpRuntime();
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-mcp-toolset-"));
  const artifacts = options.artifacts
    ? new WorkerToolOutputArtifactStore({ workspaceRoot, runId: "wrk_mcp", maxInlineChars: 500 })
    : undefined;
  return {
    mcp,
    artifacts,
    root: workspaceRoot,
    runtime: createToolsetRuntime({
      processType: "worker",
      enabledTools: ["mcp"],
      includeBuiltInToolsets: false,
      toolsetGrants: { mcp: options.grant ?? "write" },
      definitions: [createMcpToolsetDefinition({
        processTypes: ["worker", "pattern_management", "pattern_worker"],
        runtime: mcp,
      })],
      context: artifacts ? { runtime: { processType: "worker", workspace: { workspaceRoot, artifactsRoot: join(workspaceRoot, "tmp", "tool-outputs") }, artifacts } } : {},
    }),
  };
}

describe("mcp toolset", () => {
  it("routes discovery and resource commands through the MCP runtime", async () => {
    const { mcp, runtime } = createRuntime();

    const servers = await runtime.execute({ toolset: "mcp", command: "servers", args: {} });
    const search = await runtime.execute({
      toolset: "mcp",
      command: "search",
      args: { query: "docs", limit: 3 },
    });
    const resources = await runtime.execute({
      toolset: "mcp",
      command: "resources",
      args: { limit: 1 },
    });
    const resource = await runtime.execute({
      toolset: "mcp",
      command: "read_resource",
      args: { server: "docs", uri: "docs://intro" },
    });

    expect(servers).toMatchObject({
      command: "servers",
      result: { servers: [expect.objectContaining({ server: "docs" })] },
    });
    expect(search).toMatchObject({
      command: "search",
      result: { tools: [expect.objectContaining({ name: "search_docs" })] },
    });
    expect(resources).toMatchObject({
      command: "resources",
      result: {
        resources: [{ server: "docs", uri: "docs://intro", name: "Intro" }],
        total: 2,
        truncated: true,
      },
    });
    expect(resource).toMatchObject({
      command: "read_resource",
      result: { contents: [{ uri: "docs://intro", text: "hello" }] },
    });
    expect(mcp.searchTools).toHaveBeenCalledWith({ query: "docs", limit: 3, server: undefined });
    expect(mcp.listResources).toHaveBeenCalledWith({ server: undefined });
    expect(mcp.readResource).toHaveBeenCalledWith({ server: "docs", uri: "docs://intro" });
  });

  it("treats remote MCP calls as write commands and parses JSON arguments", async () => {
    const { mcp, runtime } = createRuntime();

    const result = await runtime.execute({
      toolset: "mcp",
      command: "call",
      args: { server: "docs", tool: "search_docs", arguments: { query: "intro" } },
    });

    expect(result).toMatchObject({
      command: "call",
      result: { content: expect.stringContaining("result") },
    });
    expect(mcp.callTool).toHaveBeenCalledWith({
      server: "docs",
      tool: "search_docs",
      arguments: { query: "intro" },
    });
  });

  it("removes call from read-only grants", async () => {
    const { runtime } = createRuntime({ grant: "read" });

    const loaded = await runtime.load("mcp");

    expect(loaded.instructions).toContain("API: finn.mcp.search(input)");
    expect(loaded.instructions).not.toContain("API: finn.mcp.call(input)");
    await expect(runtime.execute({
      toolset: "mcp",
      command: "call",
      args: { server: "docs", tool: "search_docs" },
    })).rejects.toThrow("Toolset command is not allowed");
  });

  it("rejects oversized MCP call arguments before remote execution", async () => {
    const { mcp, runtime } = createRuntime();
    const argumentsJson = JSON.stringify({ query: "x".repeat(20_001) });

    await expect(runtime.execute({
      toolset: "mcp",
      command: "call",
      args: { server: "docs", tool: "search_docs", arguments: argumentsJson },
    })).rejects.toThrow("arguments must be at most");

    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it("writes oversized MCP outputs to shared artifacts", async () => {
    const { artifacts, root, runtime } = createRuntime({ artifacts: true });

    const executed = await runtime.execute({
      toolset: "mcp",
      command: "call",
      args: { server: "docs", tool: "search_docs" },
    });
    const output = await artifacts!.replaceIfOversized("workspace_execute", executed.result) as Record<string, unknown>;

    expect(output).toMatchObject({
      tool_output_artifact: expect.objectContaining({
        type: "temporary_worker_tool_output",
        path: expect.stringContaining("/artifacts/"),
      }),
    });
    expect(typeof output.full_output_path).toBe("string");
    expect(existsSync(join(root, "tmp", "tool-outputs", "wrk_mcp", String(output.full_output_path).replace(/^\/artifacts\//, "")))).toBe(true);

    await artifacts?.cleanup();
  });
});

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});
