import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createIsolationWorkbench,
  evaluateIsolationProbeResult,
  isolationProfiles,
  runDefaultIsolationProbeCorpus,
  runCodeMode,
  type IsolationWorkbench,
} from "./workbench.js";
import type { CodeModeExecutor } from "@finn/tools/code-mode";

const workbenches: IsolationWorkbench[] = [];

afterEach(async () => {
  await Promise.allSettled(workbenches.map((workbench) => workbench.cleanup()));
  workbenches.length = 0;
});

function createHostCodeModeExecutor(): CodeModeExecutor {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (finn: unknown) => Promise<unknown>;
  return {
    execute: async ({ code, catalog, dispatch, search }) => {
      const finn = Object.create(null) as Record<string, unknown>;
      const defineApi = (path: readonly string[], apiName: string) => {
        let cursor = finn;
        for (const part of path.slice(0, -1)) {
          cursor[part] ??= Object.create(null);
          cursor = cursor[part] as Record<string, unknown>;
        }
        cursor[path[path.length - 1]!] = (args = {}) => dispatch(apiName, args);
      };
      for (const entry of catalog.entries) {
        defineApi(entry.apiPath, entry.apiName);
      }
      finn.search = search;

      try {
        const result = await new AsyncFunction("finn", code)(finn);
        return { success: true, result: result ?? null, logs: [] };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), logs: [] };
      }
    },
  };
}

async function createTrackedWorkbench(options: Parameters<typeof createIsolationWorkbench>[0] = {}) {
  const workbench = await createIsolationWorkbench({
    ...options,
    executor: options?.executor ?? createHostCodeModeExecutor(),
  });
  workbenches.push(workbench);
  return workbench;
}

describe("Code Mode isolation workbench", () => {
  it("creates a profile-backed workbench with seeded sentinel data and files tools", async () => {
    const workbench = await createTrackedWorkbench({ profile: "worker-write" });

    expect(Object.keys(isolationProfiles)).toEqual([
      "worker-write",
      "hot-path-write",
      "pattern-management-read",
      "my-day-read",
    ]);
    expect(workbench.profile.name).toBe("worker-write");
    expect(workbench.tools.workspace_search).toBeDefined();
    expect(workbench.tools.workspace_execute).toBeDefined();
    expect(workbench.tools.workspace_exec).toBeUndefined();
    expect(workbench.tools.workspace_wait).toBeUndefined();
    expect(workbench.tools.workspace_stdin).toBeUndefined();
    expect(workbench.tools.workspace_processes).toBeUndefined();
    expect(workbench.tools.view_image).toBeDefined();
    expect(workbench.summaries[0]?.slug).toBe("files");

    const fileRead = await runCodeMode(workbench, {
      code: "return await finn.files.read({ path: '/workspace/notes/public.txt' });",
    });

    expect(fileRead.success).toBe(true);
    expect(fileRead.output).toContain("attacker workspace public note");
    expect(fileRead.output).not.toContain(workbench.sentinels.victimSecret);
    expect(fileRead.output).not.toContain(workbench.sentinels.outsideSecret);
  }, 20_000);

  it("runs the default corpus without leaking seeded secrets", async () => {
    const workbench = await createTrackedWorkbench({ profile: "worker-write" });

    const results = await runDefaultIsolationProbeCorpus(workbench);
    const alerts = results.filter((result) => result.alert);

    expect(results.length).toBeGreaterThan(10);
    expect(alerts).toEqual([]);
    expect(readFileSync(workbench.paths.outsideMutationPath, "utf8")).toBe(workbench.sentinels.outsideMutationOriginal);
  }, 60_000);

  it("models read-only process profiles while keeping artifacts writable", async () => {
    const workbench = await createTrackedWorkbench({ profile: "pattern-management-read" });

    const deniedWorkspaceWrite = await runCodeMode(workbench, {
      code: "return await finn.files.write({ path: '/workspace/durable.txt', content: 'changed' });",
    });
    const artifactWrite = await runCodeMode(workbench, {
      code: "return await finn.files.write({ path: '/artifacts/read-profile-note.txt', content: 'artifact-ok' });",
    });

    expect(deniedWorkspaceWrite.success).toBe(false);
    expect(readFileSync(join(workbench.paths.workspaceRoot, "durable.txt"), "utf8")).toBe("durable original\n");
    expect(artifactWrite.success).toBe(true);
    expect(artifactWrite.output).toContain("/artifacts/read-profile-note.txt");
    expect(existsSync(join(workbench.paths.artifactsRunRoot, "read-profile-note.txt"))).toBe(true);
  }, 20_000);

  it("marks a probe result as an alert when sentinel data appears", async () => {
    const workbench = await createTrackedWorkbench({ profile: "worker-write" });

    const evaluated = await evaluateIsolationProbeResult(workbench, {
      id: "synthetic-leak",
      description: "Synthetic leak detector test.",
      expected: "blocked",
      input: { code: "return 'synthetic';" },
    }, {
      success: false,
      logs: [],
      output: `leaked ${workbench.sentinels.victimSecret}`,
    });

    expect(evaluated.alert).toBe(true);
    expect(evaluated.leakedTokens).toEqual(["victimSecret"]);
  });

  it("marks a blocked files probe as an alert when Code Mode reports success", async () => {
    const workbench = await createTrackedWorkbench({ profile: "pattern-management-read" });

    const evaluated = await evaluateIsolationProbeResult(workbench, {
      id: "synthetic-files-success",
      description: "Synthetic files success detector test.",
      expected: "blocked",
      input: { code: "return await finn.files.write({ path: '/workspace/nope.txt', content: 'nope' });" },
    }, {
      success: true,
      result: { path: "/workspace/nope.txt" },
      logs: [],
      output: "{\"path\":\"/workspace/nope.txt\"}\n",
    });

    expect(evaluated.alert).toBe(true);
    expect(evaluated.notes).toContain("Blocked probe completed successfully.");
  });
});
