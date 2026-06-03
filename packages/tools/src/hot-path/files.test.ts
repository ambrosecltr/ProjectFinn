import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRuntime, createProcessRuntimeServices, createUserRuntimeServices } from "@finn/runtime";
import type { CodeModeExecutor } from "../code-mode.js";
import { createHotPathTurnTools, type HotPathTurnTools } from "./index.js";

const sender = {
  sendText: async () => undefined,
  sendMedia: async () => undefined,
  sendVoiceMessage: async () => undefined,
  sendReaction: async () => undefined,
  sendTypingIndicator: async () => undefined,
  markRead: async () => undefined,
} as never;

let workspaceRoot: string | null = null;
let turnTools: HotPathTurnTools | null = null;
const legacyCliToolName = "execute" + "_cli";
const legacyLoadToolSkillName = "load" + "_tool_skill";

function createWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-hot-path-files-"));
  return workspaceRoot;
}

afterEach(async () => {
  await turnTools?.cleanup?.();
  turnTools = null;
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});

function createTestCodeModeExecutor(onDispose?: () => void): CodeModeExecutor {
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
    dispose: onDispose,
  };
}

async function runCodeModeApi(tools: HotPathTurnTools["tools"], apiName: string, args: unknown): Promise<unknown> {
  if (!tools.workspace_execute?.execute) {
    throw new Error("workspace_execute is not available.");
  }

  const executed = await tools.workspace_execute.execute({
    code: JSON.stringify({ apiName, args }),
  }, {} as never);
  if (typeof executed !== "object" || executed === null || (executed as { success?: unknown }).success !== true) {
    throw new Error(`workspace_execute returned an unexpected result: ${JSON.stringify(executed)}`);
  }

  return (executed as { result: unknown }).result;
}

async function searchCodeMode(tools: HotPathTurnTools["tools"], query: string): Promise<string> {
  if (!tools.workspace_search?.execute) {
    throw new Error("workspace_search is not available.");
  }
  return String(await tools.workspace_search.execute({ query, limit: 10 }, {} as never));
}

describe("createHotPathTools files", () => {
  it("exposes files through Code Mode without legacy workspace tools", async () => {
    const root = createWorkspace();
    const userRuntime = createUserRuntimeServices({
      workspace: root,
      files: createFilesRuntime({ workspaceRoot: root }),
    });
    const runtime = createProcessRuntimeServices(userRuntime, {
      processType: "hot_path",
      filesAccess: "write",
    });
    let disposeCalls = 0;

    turnTools = await createHotPathTurnTools({
      sender,
      runtime,
      codeModeExecutorFactory: () => createTestCodeModeExecutor(() => {
        disposeCalls += 1;
      }),
    });

    expect(turnTools.tools[legacyLoadToolSkillName]).toBeUndefined();
    expect(turnTools.tools[legacyCliToolName]).toBeUndefined();
    expect(turnTools.tools.workspace_exec).toBeUndefined();
    expect(turnTools.tools.workspace_wait).toBeUndefined();
    expect(turnTools.tools.workspace_stdin).toBeUndefined();
    expect(turnTools.tools.workspace_processes).toBeUndefined();
    expect(turnTools.tools.workspace_search).toBeDefined();
    expect(turnTools.tools.workspace_execute).toBeDefined();
    expect(turnTools.tools.view_image).toBeDefined();

    const docs = await searchCodeMode(turnTools.tools, "finn.files.read write extract image");
    expect(docs).toContain("finn.files.read");
    expect(docs).toContain("finn.files.write");
    expect(docs).not.toContain("finn.files.extract");
    expect(docs).not.toContain("viewImage");

    await turnTools.cleanup?.();
    turnTools = null;

    expect(disposeCalls).toBe(1);
  });

  it("executes hot-path file APIs through Code Mode", async () => {
    const root = createWorkspace();
    writeFileSync(join(root, "note.txt"), "hello");
    const userRuntime = createUserRuntimeServices({
      workspace: root,
      files: createFilesRuntime({
        workspaceRoot: root,
        documentExtraction: true,
      }),
    });
    const runtime = createProcessRuntimeServices(userRuntime, {
      processType: "hot_path",
      filesAccess: "write",
    });
    turnTools = await createHotPathTurnTools({
      sender,
      runtime,
      codeModeExecutorFactory: () => createTestCodeModeExecutor(),
    });

    const readOutput = await runCodeModeApi(turnTools.tools, "finn.files.read", { path: "note.txt" });
    expect(JSON.stringify(readOutput)).toContain("hello");

    const writeOutput = await runCodeModeApi(turnTools.tools, "finn.files.write", {
      path: "hot-path-note.txt",
      content: "ok",
    });
    expect(JSON.stringify(writeOutput)).toContain("hot-path-note.txt");
  });
});
