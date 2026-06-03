import { publicPatternScheduleSchema } from "@finn/core";
import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.unknown());

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed;
  } catch {
    return value;
  }
}

function parseJsonArray(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseNullableString(value: unknown): unknown {
  return value === "null" ? null : value;
}

const booleanFlagSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

const triggerFilterSchema = z.object({
  path: z.string().trim().min(1),
  operator: z.enum(["equals", "not_equals", "contains", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).strict();

const notifyConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }).strict(),
  z.object({ type: z.literal("never") }).strict(),
  z.object({
    type: z.literal("worker_decision"),
    instruction: z.string().trim().min(1),
  }).strict(),
]);

const connectorScopeSchema = z.object({
  composio: z.array(z.object({
    toolkitSlug: z.string().trim().min(1),
    connectedAccountId: z.string().trim().min(1).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
  }).strict()).optional(),
  mcpServerIds: z.array(z.string().trim().min(1)).optional(),
}).strict();

const composioTriggerSchema = z.object({
  toolkitSlug: z.string().trim().min(1),
  triggerSlug: z.string().trim().min(1),
  connectedAccountId: z.string().trim().min(1),
  triggerConfig: jsonObjectSchema.optional(),
}).strict();

const editContextSchema = z.object({
  reason: z.string().trim().min(1),
}).strict();

export const patternsListInputSchema = z.object({
  cursor: z.string().trim().min(1).optional(),
}).strict();

export const patternsInspectInputSchema = z.object({
  id: z.string().trim().min(1),
}).strict();

export const patternsCreateInputSchema = z.object({
  name: z.string().trim().min(1),
  userDescription: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  schedule: z.preprocess(parseJsonObject, publicPatternScheduleSchema).optional(),
  connectorScope: z.preprocess(parseJsonObject, connectorScopeSchema).optional(),
  triggerFilters: z.preprocess(parseJsonArray, z.array(triggerFilterSchema)).optional(),
  notifyCondition: z.preprocess(parseJsonObject, notifyConditionSchema).optional(),
  composio: z.preprocess(parseJsonObject, composioTriggerSchema).optional(),
}).strict();

export const patternsEditInputSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  userDescription: z.preprocess(parseNullableString, z.string().trim().min(1).nullable()).optional(),
  userDescriptionEdit: z.preprocess(parseJsonObject, editContextSchema).optional(),
  prompt: z.string().trim().min(1).optional(),
  promptEdit: z.preprocess(parseJsonObject, editContextSchema).optional(),
  active: booleanFlagSchema.optional(),
  schedule: z.preprocess(parseJsonObject, publicPatternScheduleSchema).optional(),
  connectorScope: z.preprocess(parseJsonObject, connectorScopeSchema).optional(),
  triggerFilters: z.preprocess(parseJsonArray, z.array(triggerFilterSchema)).optional(),
  notifyCondition: z.preprocess(parseJsonObject, notifyConditionSchema).optional(),
  composio: z.preprocess(parseJsonObject, composioTriggerSchema).optional(),
}).strict();

export const patternsSetActiveInputSchema = z.object({
  id: z.string().trim().min(1),
}).strict();

export const patternsDeleteInputSchema = z.object({
  id: z.string().trim().min(1),
}).strict();

export const patternsTriggerTypesInputSchema = z.object({
  toolkitSlug: z.string().trim().min(1).optional(),
}).strict();

export const patternsTriggerTypeInputSchema = z.object({
  triggerSlug: z.string().trim().min(1),
}).strict();

export type PatternsListInput = z.infer<typeof patternsListInputSchema>;
export type PatternsInspectInput = z.infer<typeof patternsInspectInputSchema>;
export type PatternsCreateInput = z.infer<typeof patternsCreateInputSchema>;
export type PatternsEditInput = z.infer<typeof patternsEditInputSchema>;
export type PatternsSetActiveInput = z.infer<typeof patternsSetActiveInputSchema>;
export type PatternsDeleteInput = z.infer<typeof patternsDeleteInputSchema>;
export type PatternsTriggerTypesInput = z.infer<typeof patternsTriggerTypesInputSchema>;
export type PatternsTriggerTypeInput = z.infer<typeof patternsTriggerTypeInputSchema>;
