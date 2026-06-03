import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerToolOutputArtifactStore } from "./worker-tool-output-artifacts.js";

let workspaceRoot: string | null = null;

function createWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-tool-output-artifacts-"));
  return workspaceRoot;
}

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});

describe("WorkerToolOutputArtifactStore", () => {
  it("leaves small tool outputs inline", async () => {
    const store = new WorkerToolOutputArtifactStore({
      workspaceRoot: createWorkspace(),
      runId: "wrk_small",
      maxInlineChars: 100,
    });

    const result = { ok: true, content: "small" };

    expect(await store.replaceIfOversized("read_tool", result)).toBe(result);
  });

  it("writes oversized tool outputs to temporary readable artifacts", async () => {
    const root = createWorkspace();
    const store = new WorkerToolOutputArtifactStore({
      workspaceRoot: root,
      runId: "wrk_large",
      maxInlineChars: 100,
      previewChars: 20,
    });

    const result = await store.replaceIfOversized("COMPOSIO_MULTI_EXECUTE_TOOL", {
      success: true,
      fileId: "file_123",
      records: ["x".repeat(500)],
    });

    expect(result).toEqual({
      success: true,
      fileId: "file_123",
      full_output_path: expect.stringMatching(/^\/artifacts\//),
      tool_output_artifact: expect.objectContaining({
        type: "temporary_worker_tool_output",
        toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
        path: expect.stringMatching(/^\/artifacts\//),
        preview: expect.stringContaining("{"),
        instructions: expect.stringContaining("workspace_execute with finn.files"),
      }),
    });
    expect((result as { tool_output_artifact: { instructions: string } }).tool_output_artifact.instructions).toContain("Finn run artifact");
    expect((result as { tool_output_artifact: { instructions: string } }).tool_output_artifact.instructions).toContain("Do not use Composio");

    const artifactPath = join(root, "tmp", "tool-outputs", "wrk_large", (result as { full_output_path: string }).full_output_path.replace(/^\/artifacts\//, ""));
    expect(readFileSync(artifactPath, "utf8")).toContain("records");

    await store.cleanup();
    expect(existsSync(artifactPath)).toBe(false);
  });

  it("does not rewrap outputs that already point to full output", async () => {
    const store = new WorkerToolOutputArtifactStore({
      workspaceRoot: createWorkspace(),
      runId: "wrk_existing",
      maxInlineChars: 10,
    });
    const result = {
      output: "x".repeat(500),
      full_output_path: "/artifacts/output.log",
    };

    expect(await store.replaceIfOversized("exec_command", result)).toBe(result);
  });

});
