import { afterEach, describe, expect, it } from "bun:test";
import { createFilesRuntime } from "@finn/runtime";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchFileCommand } from "./operations.js";

let workspaceRoot: string | null = null;

function createWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-files-toolset-"));
  return workspaceRoot;
}

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});

describe("files operations", () => {
  it("enforces read-only /workspace while allowing patches to /artifacts", async () => {
    const workspace = createWorkspace();
    const artifactsRoot = join(workspace, "artifacts", "patch-readonly");
    mkdirSync(artifactsRoot, { recursive: true });
    const runtime = createFilesRuntime({
      workspaceRoot: workspace,
      artifactsRoot,
      access: "read",
    });

    await expect(patchFileCommand(runtime, {
      input: [
        "*** Begin Patch",
        "*** Add File: /workspace/nope.txt",
        "+nope",
        "*** End Patch",
        "",
      ].join("\n"),
    })).rejects.toThrow("/workspace mount is read-only");

    await expect(patchFileCommand(runtime, {
      input: [
        "*** Begin Patch",
        "*** Add File: /artifacts/result.txt",
        "+ok",
        "*** End Patch",
        "",
      ].join("\n"),
    })).resolves.toMatchObject({
      success: true,
      changedFiles: [expect.objectContaining({ path: "/artifacts/result.txt" })],
    });
    expect(readFileSync(join(artifactsRoot, "result.txt"), "utf8")).toBe("ok\n");
  });

  it("rejects /tmp and mixed-mount patches", async () => {
    const workspace = createWorkspace();
    const artifactsRoot = join(workspace, "artifacts", "patch-invalid");
    mkdirSync(artifactsRoot, { recursive: true });
    const runtime = createFilesRuntime({
      workspaceRoot: workspace,
      artifactsRoot,
      access: "write",
    });

    await expect(patchFileCommand(runtime, {
      input: [
        "*** Begin Patch",
        "*** Add File: /tmp/nope.txt",
        "+nope",
        "*** End Patch",
        "",
      ].join("\n"),
    })).rejects.toThrow("/tmp is disposable workspace scratch");

    await expect(patchFileCommand(runtime, {
      input: [
        "*** Begin Patch",
        "*** Add File: /workspace/one.txt",
        "+one",
        "*** Add File: /artifacts/two.txt",
        "+two",
        "*** End Patch",
        "",
      ].join("\n"),
    })).rejects.toThrow("cannot mix /workspace and /artifacts");
  });
});
