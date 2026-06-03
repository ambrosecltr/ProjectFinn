import { afterEach, describe, expect, it } from "bun:test";
import { WorkerToolOutputArtifactStore } from "@finn/core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapToolsWithOutputArtifacts } from "./tool-output-artifacts.js";

let workspaceRoot: string | null = null;

function createWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-agent-tool-output-"));
  return workspaceRoot;
}

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});

describe("wrapToolsWithOutputArtifacts", () => {
  it("returns artifact references for oversized tool results", async () => {
    const root = createWorkspace();
    const artifacts = new WorkerToolOutputArtifactStore({
      workspaceRoot: root,
      runId: "wrk_wrap",
      maxInlineChars: 100,
    });
    const tools = wrapToolsWithOutputArtifacts({
      large_tool: {
        execute: async () => ({
          ok: true,
          payload: "x".repeat(500),
        }),
      } as never,
    }, artifacts);

    const result = await tools.large_tool.execute?.({}, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      full_output_path: expect.stringMatching(/^\/artifacts\//),
      tool_output_artifact: expect.objectContaining({
        instructions: expect.stringContaining("workspace_execute with finn.files"),
      }),
    }));
    expect(existsSync(join(root, "tmp", "tool-outputs", "wrk_wrap", (result as { full_output_path: string }).full_output_path.replace(/^\/artifacts\//, "")))).toBe(true);
  });

  it("does not wrap tools that provide custom model output", async () => {
    const artifacts = new WorkerToolOutputArtifactStore({
      workspaceRoot: createWorkspace(),
      runId: "wrk_model_output",
      maxInlineChars: 100,
    });
    const tools = wrapToolsWithOutputArtifacts({
      view_image: {
        execute: async () => ({
          success: true,
          dataBase64: "x".repeat(500),
        }),
        toModelOutput: async ({ output }: { output: { dataBase64: string } }) => ({
          type: "content",
          value: [{ type: "image-data", data: output.dataBase64, mediaType: "image/png" }],
        }),
      } as never,
    }, artifacts);

    const result = await tools.view_image.execute?.({}, { toolCallId: "call_1", messages: [] } as never);

    expect(result).toEqual({
      success: true,
      dataBase64: "x".repeat(500),
    });
  });

});
