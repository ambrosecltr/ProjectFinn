import type { PatternRunRecord } from "@finn/core";
import type { PatternsRuntimeService } from "@finn/runtime";
import { patternRunInputSchema, patternRunsInputSchema } from "./schemas.js";

export interface PatternCommandRuntime {
  patterns: PatternsRuntimeService;
  patternId: string;
}

function serializeRunSummary(run: PatternRunRecord) {
  return {
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    triggeredBy: run.triggeredBy,
    state: run.state,
    notify: run.notifyOutcome?.notify ?? null,
    summary: run.notifyOutcome?.summary ?? run.result?.summary ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function summarizeLargeValue(value: unknown, maxLength: number): unknown {
  if (value === undefined || value === null) return null;

  const text = JSON.stringify(value);
  if (text.length <= maxLength) return value;

  return { summary: `Value omitted because it is ${text.length} characters. Use the run summary as the canonical context.` };
}

function serializeRunDetails(run: PatternRunRecord) {
  const data = run.notifyOutcome?.data ?? run.result?.data ?? null;

  return {
    ...serializeRunSummary(run),
    workerId: run.workerId,
    reason: run.notifyOutcome?.reason ?? null,
    data: summarizeLargeValue(data, 4_000),
    error: run.error ?? run.result?.error ?? null,
    skipReason: run.skipReason,
    triggerPayload: summarizeLargeValue(run.triggerPayload, 4_000),
    startedAt: run.startedAt?.toISOString() ?? null,
    surfacedAt: run.surfacedAt?.toISOString() ?? null,
  };
}

function getNextBeforeRunId(runs: PatternRunRecord[], limit: number): string | null {
  return runs.length === limit ? runs.at(-1)?.id ?? null : null;
}

export async function patternRunsCommand(runtime: PatternCommandRuntime, input: unknown) {
  const parsed = patternRunsInputSchema.parse(input);
  const limit = parsed.limit ?? 5;
  if (!runtime.patterns.listRuns) {
    return { error: "Pattern run history is not configured." };
  }

  const runs = await runtime.patterns.listRuns({
    patternId: runtime.patternId,
    limit,
    beforeRunId: parsed.beforeRunId,
  });
  return {
    runs: runs.map(serializeRunSummary),
    nextBeforeRunId: getNextBeforeRunId(runs, limit),
  };
}

export async function patternRunCommand(runtime: PatternCommandRuntime, input: unknown) {
  const parsed = patternRunInputSchema.parse(input);
  if (!runtime.patterns.getRun) {
    return { error: "Pattern run history is not configured." };
  }

  const run = await runtime.patterns.getRun(runtime.patternId, parsed.runId);
  return run ? { run: serializeRunDetails(run) } : { error: "Pattern run not found." };
}

export async function executePatternCommand(runtime: PatternCommandRuntime, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "runs":
      return patternRunsCommand(runtime, args);
    case "run":
      return patternRunCommand(runtime, args);
    default:
      throw new Error(`Unsupported Pattern command: ${command}`);
  }
}
