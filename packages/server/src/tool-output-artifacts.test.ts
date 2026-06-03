import { afterEach, describe, expect, it } from "bun:test";
import { WorkerToolOutputArtifactStore } from "@finn/core";
import { createFilesRuntime, createProcessRuntimeServices, createUserRuntimeServices, type ProcessRuntimeServices, type UserRuntimeServices } from "@finn/runtime";
import type { CodeModeExecutor } from "@finn/tools/code-mode";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserFilesCodeModeTools,
  createUserFilesProcessRuntime,
  createUserToolOutputArtifactStore,
} from "./tool-output-artifacts.js";

let workspacesRoot: string | null = null;
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

function createWorkspacesRoot(): string {
  workspacesRoot = mkdtempSync(join(tmpdir(), "finn-server-tool-output-"));
  return workspacesRoot;
}

function createRuntime(root = createWorkspacesRoot()): { userRuntime: UserRuntimeServices; processRuntime: ProcessRuntimeServices & { files: NonNullable<ProcessRuntimeServices["files"]> }; workspaceRoot: string; artifactsRoot: string } {
  const userRoot = join(root, "tenant_test", "usr_test");
  const workspaceRoot = join(userRoot, "workspace");
  const artifactsRoot = join(userRoot, "artifacts");
  const userRuntime = createUserRuntimeServices({
    user: { tenantId: "tenant_test", userId: "usr_test" },
    workspace: { workspaceRoot, artifactsRoot },
    files: createFilesRuntime({
      workspaceRoot,
      artifactsRoot,
      documentExtraction: true,
    }),
  });
  const processRuntime = createProcessRuntimeServices(userRuntime, {
    processType: "my_day",
    filesAccess: "read",
  });
  if (!processRuntime.files) {
    throw new Error("test files runtime missing");
  }
  return { userRuntime, processRuntime: processRuntime as typeof processRuntime & { files: NonNullable<typeof processRuntime.files> }, workspaceRoot, artifactsRoot };
}

afterEach(async () => {
  await Promise.allSettled(cleanupCallbacks.map((cleanup) => cleanup()));
  cleanupCallbacks.length = 0;
  if (workspacesRoot) {
    rmSync(workspacesRoot, { recursive: true, force: true });
    workspacesRoot = null;
  }
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

function createFileCodeModeAccess(
  processRuntime: ProcessRuntimeServices & { files: NonNullable<ProcessRuntimeServices["files"]> },
  options: { artifacts?: WorkerToolOutputArtifactStore } = {},
): ReturnType<typeof createUserFilesCodeModeTools> {
  const access = createUserFilesCodeModeTools(processRuntime, {
    access: "read",
    processType: "my_day",
    executor: createTestCodeModeExecutor(),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  });
  cleanupCallbacks.push(access.cleanup);
  return access;
}

async function runCodeModeApi(tools: ReturnType<typeof createUserFilesCodeModeTools>["tools"], apiName: string, args: unknown) {
  if (!tools.workspace_execute?.execute) {
    throw new Error("workspace_execute is not available.");
  }
  const executed = await tools.workspace_execute.execute({
    code: JSON.stringify({ apiName, args }),
  }, { toolCallId: "call_code", messages: [] } as never);
  if (typeof executed !== "object" || executed === null) {
    throw new Error("workspace_execute returned an unexpected result shape.");
  }
  return executed;
}

describe("createUserFilesCodeModeTools", () => {
  it("exposes read-only artifact access through files Finn JS workspace APIs", async () => {
    const root = createWorkspacesRoot();
    const { processRuntime, workspaceRoot } = createRuntime(root);
    await mkdir(join(workspaceRoot, "tmp"), { recursive: true });
    await writeFile(join(workspaceRoot, "tmp/tool-output.txt"), "artifact needle");

    const { tools, summaries } = createFileCodeModeAccess(processRuntime);

    expect(summaries[0]?.commands.map((command) => command.name)).toEqual([
      "list",
      "read",
      "search",
      "extract",
      "write",
      "patch",
      "download",
    ]);
    expect(tools["execute" + "_cli"]).toBeUndefined();
    expect(tools.workspace_exec).toBeUndefined();
    expect(tools.workspace_wait).toBeUndefined();
    expect(tools.workspace_stdin).toBeUndefined();
    expect(tools.workspace_processes).toBeUndefined();
    expect(tools.view_image).toBeDefined();

    const searchOutput = await runCodeModeApi(tools, "finn.files.search", {
      path: "/workspace/tmp/tool-output.txt",
      query: "needle",
    });
    expect(JSON.stringify(searchOutput)).toContain("\"totalMatches\":1");

    const deniedWorkspaceWrite = await runCodeModeApi(tools, "finn.files.write", {
      path: "/workspace/tmp/nope.txt",
      content: "nope",
    });
    expect(deniedWorkspaceWrite).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("/workspace mount is read-only"),
    }));

    const artifactWrite = await runCodeModeApi(tools, "finn.files.write", {
      path: "/artifacts/my-day-note.txt",
      content: "ok",
    });
    expect(JSON.stringify(artifactWrite)).toContain("/artifacts/my-day-note.txt");
  });

  it("creates readable run-scoped artifacts outside the user's workspace", async () => {
    const { userRuntime, processRuntime, workspaceRoot, artifactsRoot } = createRuntime();
    const store = createUserToolOutputArtifactStore(userRuntime, "arun_test");
    const { tools } = createFileCodeModeAccess(processRuntime, { artifacts: store });

    const artifact = await store.writeText("connector", "large connector output", { extension: "txt" });
    const read = await runCodeModeApi(tools, "finn.files.read", { path: artifact.path, maxBytes: 100 });

    expect(artifact.path).toStartWith("/artifacts/");
    expect(JSON.stringify(read)).toContain("large connector output");
    expect(existsSync(join(workspaceRoot, artifact.path))).toBe(false);
    expect(existsSync(join(artifactsRoot, "arun_test", artifact.path.replace(/^\/artifacts\//, "")))).toBe(true);

    await store.cleanup();
    expect(existsSync(join(artifactsRoot, "arun_test"))).toBe(false);
  });

  it("keeps artifact reader paths scoped to the user workspace", async () => {
    const { processRuntime, workspaceRoot } = createRuntime();
    const { tools } = createFileCodeModeAccess(processRuntime);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "..", "outside.txt"), "secret");

    const result = await runCodeModeApi(tools, "finn.files.read", { path: "../outside.txt" });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("escapes the filesystem root"),
    }));
  });

  it("exposes compact artifact search and keeps oversized reads out of model context when wrapped", async () => {
    const root = createWorkspacesRoot();
    const { processRuntime, workspaceRoot, artifactsRoot } = createRuntime(root);
    await mkdir(join(workspaceRoot, "tmp"), { recursive: true });
    await writeFile(join(workspaceRoot, "tmp/tool-output.txt"), `${"x".repeat(500)}\nneedle line`);
    const artifacts = new WorkerToolOutputArtifactStore({
      workspaceRoot,
      artifactsRoot,
      runId: "arun_test",
      maxInlineChars: 450,
    });
    const { tools } = createFileCodeModeAccess(processRuntime, { artifacts });

    const searchResult = await runCodeModeApi(tools, "finn.files.search", {
      path: "/workspace/tmp/tool-output.txt",
      query: "needle",
    });
    const readResult = await runCodeModeApi(tools, "finn.files.read", {
      path: "/workspace/tmp/tool-output.txt",
    });

    expect(JSON.stringify(searchResult)).toContain("needle line");
    expect(readResult).toEqual(expect.objectContaining({
      full_output_path: expect.stringMatching(/^\/artifacts\//),
    }));
    expect(existsSync(join(artifactsRoot, "arun_test", (readResult as { full_output_path: string }).full_output_path.replace(/^\/artifacts\//, "")))).toBe(true);
  });

  it("creates process runtimes with file access", () => {
    const { userRuntime } = createRuntime();
    const runtime = createUserFilesProcessRuntime(userRuntime, {
      processType: "my_day",
      filesAccess: "read",
    });

    expect(runtime.files.access).toBe("read");
  });
});
