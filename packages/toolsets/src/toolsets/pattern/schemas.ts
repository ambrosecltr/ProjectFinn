import { z } from "zod";

function parseOptionalNumber(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

export const patternRunsInputSchema = z.object({
  limit: z.preprocess(parseOptionalNumber, z.number().int().min(1).max(5)).optional(),
  beforeRunId: z.string().trim().min(1).optional(),
}).strict();

export const patternRunInputSchema = z.object({
  runId: z.string().trim().min(1),
}).strict();

export type PatternRunsInput = z.infer<typeof patternRunsInputSchema>;
export type PatternRunInput = z.infer<typeof patternRunInputSchema>;
