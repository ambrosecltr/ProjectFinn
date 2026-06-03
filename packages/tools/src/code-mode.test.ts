import { describe, expect, it, mock } from "bun:test";

import { createToolsetRuntime, type ToolsetDefinition } from "@finn/toolsets";
import { z } from "zod";
import type { CodeModeExecutor } from "./code-mode.js";
import { createCodeModeTools } from "./code-mode.js";

const filesToolset = {
  manifest: {
    slug: "files",
    displayName: "Files",
    description: "Read and write Finn workspace files.",
    capability: "write",
    processTypes: ["worker"],
    commands: [
      {
        name: "read",
        description: "Read a file from the workspace.",
        effects: ["read"],
        inputSchema: z.object({
          path: z.string().describe("Workspace path."),
        }),
      },
      {
        name: "write",
        description: "Write a file to the workspace.",
        effects: ["write"],
        inputSchema: z.object({
          path: z.string().describe("Workspace path."),
          contents: z.string().describe("File contents."),
        }),
      },
    ],
  },
  executors: {
    read: mock(async (input: unknown) => {
      const parsed = z.object({ path: z.string() }).parse(input);
      return { path: parsed.path, contents: "hello" };
    }),
    write: mock(async (input: unknown) => {
      const parsed = z.object({ path: z.string(), contents: z.string() }).parse(input);
      return { path: parsed.path, bytes: parsed.contents.length };
    }),
  },
} satisfies ToolsetDefinition;

function createRuntime() {
  return createToolsetRuntime({
    processType: "worker",
    enabledTools: ["files"],
    includeBuiltInToolsets: false,
    definitions: [filesToolset],
    context: {},
  });
}

describe("Finn JS workspace tools", () => {
  it("exposes searchable typed Finn APIs without dumping the whole catalog", async () => {
    const runtime = createRuntime();
    const executor: CodeModeExecutor = {
      execute: async ({ code, dispatch, search }) => {
        expect(code).toContain("finn.files.read");
        expect(search("read file", { limit: 1 })).toContain("finn.files.read");
        expect(search("read file", { limit: 1 })).not.toContain("finn.files.write");
        return {
          success: true,
          result: await dispatch("finn.files.read", { path: "/workspace/note.txt" }),
          logs: [],
        };
      },
    };
    const tools = createCodeModeTools(runtime, { executor });

    const searchResult = await tools.workspace_search?.execute?.({ query: "read file", limit: 1 }, {} as never);
    const executeResult = await tools.workspace_execute?.execute?.({
      code: "return await finn.files.read({ path: '/workspace/note.txt' });",
    }, {} as never);

    expect(String(searchResult)).toContain("finn.files.read(input: FilesReadInput)");
    expect(String(searchResult)).not.toContain("finn.files.write");
    expect(executeResult).toEqual({
      success: true,
      result: {
        path: "/workspace/note.txt",
        contents: "hello",
      },
      logs: [],
    });
  });

  it("returns a structured execution error for unavailable APIs", async () => {
    const runtime = createRuntime();
    const executor: CodeModeExecutor = {
      execute: async ({ dispatch }) => ({
        success: true,
        result: await dispatch("finn.files.delete", { path: "/workspace/note.txt" }),
        logs: [],
      }),
    };
    const tools = createCodeModeTools(runtime, { executor });

    const result = await tools.workspace_execute?.execute?.({
      code: "return await finn.files.delete({ path: '/workspace/note.txt' });",
    }, {} as never);

    expect(result).toEqual({
      success: false,
      error: "Finn JS workspace API is not available in this runtime: finn.files.delete",
      logs: [],
    });
  });
});
