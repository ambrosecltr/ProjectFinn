import { describe, expect, it, mock } from "bun:test";
import type { PatternRunRecord } from "@finn/core";
import { createPatternsRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createPatternToolsetDefinition } from "./index.js";

const baseRun = {
  id: "ptrun_old",
  tenantId: "tenant_test",
  userId: "usr_test",
  patternId: "ptn_current",
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
} satisfies PatternRunRecord;

function createRuntime(overrides: { runs?: PatternRunRecord[]; run?: PatternRunRecord | null } = {}) {
  const listRuns = mock(async () => overrides.runs ?? [baseRun]);
  const getRun = mock(async () => overrides.run ?? baseRun);
  const patterns = createPatternsRuntimeService({
    create: mock(async () => ({}) as never),
    list: mock(async () => []),
    update: mock(async () => null),
    remove: mock(async () => null),
    listRuns,
    getRun,
  });
  const runtime = createToolsetRuntime({
    processType: "pattern_worker",
    enabledTools: ["pattern"],
    includeBuiltInToolsets: false,
    toolsetGrants: { pattern: "read" },
    definitions: [createPatternToolsetDefinition({
      processTypes: ["pattern_worker"],
      runtime: patterns,
      patternId: "ptn_current",
    })],
    context: {},
  });

  return { runtime, listRuns, getRun };
}

describe("pattern toolset", () => {
  it("lists summaries for only the current Pattern", async () => {
    const { runtime, listRuns } = createRuntime({ runs: [baseRun] });

    const result = await runtime.execute({
      toolset: "pattern",
      command: "runs",
      args: { limit: 1, beforeRunId: "ptrun_cursor" },
    });

    expect(listRuns).toHaveBeenCalledWith({
      patternId: "ptn_current",
      limit: 1,
      beforeRunId: "ptrun_cursor",
    });
    expect(result).toMatchObject({
      command: "runs",
      result: {
        runs: [{
          id: "ptrun_old",
          createdAt: "2026-04-27T09:00:00.000Z",
          triggeredBy: "schedule",
          state: "done",
          notify: true,
          summary: "OpenAI launched model X.",
          completedAt: "2026-04-27T09:01:00.000Z",
        }],
        nextBeforeRunId: "ptrun_old",
      },
    });
  });

  it("uses the current Pattern ID for detailed run lookup", async () => {
    const { runtime, getRun } = createRuntime({ run: baseRun });

    const result = await runtime.execute({
      toolset: "pattern",
      command: "run",
      args: { runId: "ptrun_old" },
    });

    expect(getRun).toHaveBeenCalledWith("ptn_current", "ptrun_old");
    expect(result).toMatchObject({
      command: "run",
      result: {
        run: {
          id: "ptrun_old",
          reason: "New release found.",
          data: { sourceCount: 2 },
          triggerPayload: { subject: "Launch" },
        },
      },
    });
  });

  it("summarizes oversized run details", async () => {
    const oversizedRun = {
      ...baseRun,
      triggerPayload: { text: "x".repeat(4_200) },
      notifyOutcome: { notify: true, summary: "Large payload", data: { text: "y".repeat(4_200) } },
    } satisfies PatternRunRecord;
    const { runtime } = createRuntime({ run: oversizedRun });

    const result = await runtime.execute({
      toolset: "pattern",
      command: "run",
      args: { runId: "ptrun_old" },
    });

    expect(result).toMatchObject({
      result: {
        run: {
          data: { summary: expect.stringContaining("Value omitted") },
          triggerPayload: { summary: expect.stringContaining("Value omitted") },
        },
      },
    });
  });
});
