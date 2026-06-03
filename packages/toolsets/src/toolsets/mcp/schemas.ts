import { z } from "zod";

const maxMcpArgumentsJsonChars = 20_000;
const maxMcpArgumentsDepth = 8;

export const mcpServersInputSchema = z.object({}).strict();

export const mcpSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  server: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional(),
}).strict();

export const mcpResourcesInputSchema = z.object({
  server: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const mcpReadResourceInputSchema = z.object({
  server: z.string().trim().min(1),
  uri: z.string().trim().min(1),
}).strict();

function getJsonDepth(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }
  if (seen.has(value)) {
    return maxMcpArgumentsDepth + 1;
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce((maxDepth, child) => Math.max(maxDepth, getJsonDepth(child, seen)), 0);
}

function validateMcpArguments(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "arguments must be JSON-serializable",
    });
    return;
  }

  if (serialized.length > maxMcpArgumentsJsonChars) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `arguments must be at most ${maxMcpArgumentsJsonChars} serialized characters`,
    });
  }
  if (getJsonDepth(value) > maxMcpArgumentsDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `arguments nesting must be at most ${maxMcpArgumentsDepth} levels`,
    });
  }
}

const mcpArgumentsSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.string().trim().min(1).superRefine((value, ctx) => {
    if (value.length > maxMcpArgumentsJsonChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `arguments must be at most ${maxMcpArgumentsJsonChars} serialized characters`,
      });
    }
  }).transform((value, ctx) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to a schema issue below.
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "arguments must be a JSON object",
    });
    return z.NEVER;
  }),
]).superRefine(validateMcpArguments);

export const mcpCallInputSchema = z.object({
  server: z.string().trim().min(1),
  tool: z.string().trim().min(1),
  arguments: mcpArgumentsSchema.optional(),
}).strict();

export type McpServersInput = z.infer<typeof mcpServersInputSchema>;
export type McpSearchInput = z.infer<typeof mcpSearchInputSchema>;
export type McpResourcesInput = z.infer<typeof mcpResourcesInputSchema>;
export type McpReadResourceInput = z.infer<typeof mcpReadResourceInputSchema>;
export type McpCallInput = z.infer<typeof mcpCallInputSchema>;
