import { z } from "zod";
import { puterImessageToolset } from "./toolsets/puter-imessage/index.js";
import { puterNotesToolset } from "./toolsets/puter-notes/index.js";
import type {
  ToolsetCommandDefinition,
  ToolsetDefinition,
  ToolsetEffect,
  ToolsetExecuteInput,
  ToolsetExecuteResult,
  ToolsetExecutionContext,
  ToolsetExecutionOptions,
  ToolsetGrant,
  ToolsetGrantMap,
  ToolsetProcessType,
  ToolsetSkill,
  ToolsetSummary,
} from "./types.js";

const allToolsets = [
  puterImessageToolset,
  puterNotesToolset,
] satisfies ToolsetDefinition[];

export interface ToolsetRuntimeOptions {
  processType: ToolsetProcessType;
  enabledTools: Iterable<string>;
  context: ToolsetExecutionContext;
  toolsetGrants?: ToolsetGrantMap;
  definitions?: Iterable<ToolsetDefinition>;
  includeBuiltInToolsets?: boolean;
}

export type ToolsetInputFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "unknown"
  | "string[]"
  | "number[]"
  | "object[]"
  | "unknown[]"
  | { enum: string[] };

export interface ToolsetInputFieldSummary {
  name: string;
  type: ToolsetInputFieldType;
  required: boolean;
  description?: string;
}

export interface CodeModeCommandSummary {
  toolset: string;
  name: string;
  description: string;
  effects: ToolsetEffect[];
  inputSchema: z.ZodType;
  argumentGuidance: string[];
  examples: ToolsetCommandDefinition["examples"];
  outputGuidance: string[];
}

export interface CodeModeToolsetSummary {
  slug: string;
  displayName: string;
  description: string;
  effects: ToolsetEffect[];
  commands: CodeModeCommandSummary[];
}

interface AvailableToolset {
  definition: ToolsetDefinition;
  commands: ToolsetCommandDefinition[];
  usesGeneratedInstructions: boolean;
}

function isAbortReason(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === "AbortError";
}

function getAbortReasonMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) {
    return reason.message || fallback;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return fallback;
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (isAbortReason(reason)) {
    return reason;
  }

  const error = new Error(getAbortReasonMessage(reason, "Toolset command cancelled."));
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value
    .replace(/^[^A-Za-z$]+/, "")
    .replace(/[^A-Za-z0-9$]+/g, " ")
    .trim();
  if (!cleaned) {
    return fallback;
  }

  const [first = "", ...rest] = cleaned.split(/\s+/);
  const identifier = `${first.toLowerCase()}${rest.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("")}`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier) ? identifier : fallback;
}

function apiCommandName(command: string): string {
  return sanitizeIdentifier(command, "run");
}

export class ToolsetRuntime {
  private readonly availableToolsets: Map<string, AvailableToolset>;
  private readonly context: ToolsetExecutionContext;

  constructor(options: ToolsetRuntimeOptions) {
    const enabledTools = new Set(options.enabledTools);
    this.context = options.context;
    const definitions = [
      ...(options.includeBuiltInToolsets === false ? [] : allToolsets),
      ...(options.definitions ?? []),
    ];
    this.availableToolsets = new Map(
      definitions
        .filter((definition) => definition.manifest.processTypes.includes(options.processType))
        .filter((definition) => isToolsetEnabled(definition, enabledTools))
        .map((definition) => createAvailableToolset(definition, options.toolsetGrants?.[definition.manifest.slug]))
        .filter((toolset): toolset is AvailableToolset => toolset !== null)
        .map((toolset) => [toolset.definition.manifest.slug, toolset]),
    );
  }

  list(query?: string): ToolsetSummary[] {
    const normalizedQuery = query?.trim().toLowerCase();
    return [...this.availableToolsets.values()]
      .map((toolset) =>
        summarizeToolset(toolset.definition, toolset.commands, {
          useEffectiveDescription: toolset.usesGeneratedInstructions,
        }))
      .filter((summary) => {
        if (!normalizedQuery) {
          return true;
        }
        return [
          summary.slug,
          summary.displayName,
          summary.description,
          summary.commands.map((command) => `${command.name} ${command.description}`).join(" "),
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      });
  }

  async load(slug: string): Promise<ToolsetSkill> {
    const toolset = this.requireToolset(slug);
    return {
      toolset: summarizeToolset(toolset.definition, toolset.commands, {
        useEffectiveDescription: toolset.usesGeneratedInstructions,
      }),
      instructions: await this.loadInstructions(toolset),
    };
  }

  toCodeModeToolsets(): CodeModeToolsetSummary[] {
    return [...this.availableToolsets.values()].map((availableToolset) => ({
      slug: availableToolset.definition.manifest.slug,
      displayName: availableToolset.definition.manifest.displayName,
      description: availableToolset.definition.manifest.description,
      effects: summarizeEffects(availableToolset.definition, availableToolset.commands),
      commands: availableToolset.commands.map((command) => ({
        toolset: availableToolset.definition.manifest.slug,
        name: command.name,
        description: command.description,
        effects: commandEffects(availableToolset.definition, command),
        inputSchema: command.inputSchema,
        argumentGuidance: command.argumentGuidance ?? [],
        examples: command.examples ?? [],
        outputGuidance: command.outputGuidance ?? [],
      })),
    })).filter((toolset) => toolset.commands.length > 0);
  }

  async execute(input: ToolsetExecuteInput, options: ToolsetExecutionOptions = {}): Promise<ToolsetExecuteResult> {
    const abortSignal = options.abortSignal ?? this.context.abortSignal;
    throwIfAborted(abortSignal);

    const toolset = this.requireToolset(input.toolset);
    const command = toolset.commands.find((candidate) => candidate.name === input.command);
    if (!command) {
      throw new Error(`Toolset command is not allowed: ${input.toolset}/${input.command}`);
    }

    const executor = toolset.definition.executors[input.command];
    if (!executor) {
      throw new Error(`Toolset command is not implemented: ${input.toolset}/${input.command}`);
    }

    const args = command.inputSchema.parse(input.args);
    throwIfAborted(abortSignal);
    return {
      toolset: input.toolset,
      command: input.command,
      result: await executor(args, { ...this.context, ...(abortSignal ? { abortSignal } : {}) }),
    };
  }

  private requireToolset(slug: string): AvailableToolset {
    const toolset = this.availableToolsets.get(slug);
    if (!toolset) {
      throw new Error(`Toolset is not available in this run: ${slug}`);
    }
    return toolset;
  }

  private async loadInstructions(toolset: AvailableToolset): Promise<string> {
    if (!toolset.usesGeneratedInstructions && toolset.definition.loadInstructions) {
      return toolset.definition.loadInstructions();
    }
    return renderToolsetInstructions(toolset.definition, toolset.commands);
  }
}

export function summarizeToolset(
  definition: ToolsetDefinition,
  commands = definition.manifest.commands,
  options: { useEffectiveDescription?: boolean } = {},
): ToolsetSummary {
  const effects = summarizeEffects(definition, commands);
  return {
    slug: definition.manifest.slug,
    displayName: definition.manifest.displayName,
    description: options.useEffectiveDescription
      ? `Available ${definition.manifest.displayName} Finn JS workspace APIs for this run.`
      : definition.manifest.description,
    capability: effects.includes("write") ? "write" : "read",
    effects,
    commands: commands.map((command) => ({
      name: command.name,
      description: command.description,
      effects: commandEffects(definition, command),
      flags: extractFlagSummaries(command.inputSchema).map((flag) => flag.name),
    })),
  };
}

export function createToolsetRuntime(options: ToolsetRuntimeOptions): ToolsetRuntime {
  return new ToolsetRuntime(options);
}

function isToolsetEnabled(definition: ToolsetDefinition, enabledTools: Set<string>): boolean {
  if (enabledTools.has(definition.manifest.slug)) {
    return true;
  }
  const gate = definition.manifest.connectorGate;
  return gate ? enabledTools.has(gate.enabledTool) : false;
}

function createAvailableToolset(
  definition: ToolsetDefinition,
  grant: ToolsetGrant | undefined,
): AvailableToolset | null {
  const allowedEffects = grant === undefined || definition.manifest.slug === "files" ? null : effectsForGrant(grant);
  const commands = allowedEffects
    ? definition.manifest.commands.filter((command) =>
        commandEffects(definition, command).every((effect) => allowedEffects.has(effect)))
    : definition.manifest.commands;

  if (commands.length === 0) {
    return null;
  }

  return {
    definition,
    commands,
    usesGeneratedInstructions: grant !== undefined || !definition.loadInstructions,
  };
}

function effectsForGrant(grant: ToolsetGrant): Set<ToolsetEffect> {
  if (typeof grant !== "string") {
    return new Set<ToolsetEffect>(grant);
  }

  if (grant === "all") {
    return new Set(["read", "write", "control"]);
  }
  if (grant === "write") {
    return new Set(["read", "write"]);
  }

  return new Set([grant]);
}

function commandEffects(definition: ToolsetDefinition, command: ToolsetCommandDefinition): ToolsetEffect[] {
  return command.effects ?? definition.manifest.effects ?? [definition.manifest.capability];
}

function summarizeEffects(definition: ToolsetDefinition, commands: ToolsetCommandDefinition[]): ToolsetEffect[] {
  const effects = new Set<ToolsetEffect>();
  for (const command of commands) {
    for (const effect of commandEffects(definition, command)) {
      effects.add(effect);
    }
  }
  return [...effects];
}

function renderToolsetInstructions(definition: ToolsetDefinition, commands: ToolsetCommandDefinition[]): string {
  const summary = summarizeToolset(definition, commands, { useEffectiveDescription: true });
  const commandSections = commands.map((command) => {
    const inputFields = extractFlagSummaries(command.inputSchema);
    const fieldList = inputFields.length > 0 ? inputFields.map(formatInputFieldSummary).join(", ") : "none";
    const apiName = `finn.${definition.manifest.slug}.${apiCommandName(command.name)}`;

    return [
      `## ${apiName}`,
      command.description,
      `API: ${apiName}(input)`,
      `Effects: ${commandEffects(definition, command).join(", ")}`,
      `Input fields: ${fieldList}`,
      ...renderBulletSection("Argument guidance", command.argumentGuidance, "###"),
      ...renderExampleSection(command.examples),
      ...renderBulletSection("Output guidance", command.outputGuidance, "###"),
    ].filter((line) => line.length > 0).join("\n");
  });
  const guidance = definition.manifest.instructions;

  return [
    `# ${definition.manifest.displayName}`,
    summary.description,
    "",
    `Toolset: ${definition.manifest.slug}`,
    `Available effects: ${summary.effects.join(", ")}`,
    "",
    "Use these operations through the typed Finn JS workspace APIs exposed for this run.",
    "Input fields use the schema shown by workspace_search. Quote JSON/string values only when you are composing JavaScript source.",
    ...renderBulletSection("When to use", guidance?.overview),
    ...renderBulletSection("Reference formats", guidance?.referenceFormats),
    ...renderBulletSection("Syntax rules", guidance?.syntaxRules),
    ...renderBulletSection("Common workflows", guidance?.workflows),
    ...renderBulletSection("Safety rules", guidance?.safetyRules),
    ...renderBulletSection("Output guidance", guidance?.outputGuidance),
    "",
    ...commandSections,
  ].join("\n");
}

function renderBulletSection(title: string, lines: string[] | undefined, heading = "##"): string[] {
  if (!lines?.length) {
    return [];
  }

  return [
    "",
    `${heading} ${title}`,
    ...lines.map((line) => `- ${line}`),
  ];
}

function renderExampleSection(examples: ToolsetCommandDefinition["examples"]): string[] {
  if (!examples?.length) {
    return [];
  }

  return [
    "### Code examples",
    ...examples.map((example) => `- ${example.purpose}: \`${example.code}\``),
  ];
}

function formatInputFieldSummary(field: ToolsetInputFieldSummary): string {
  const type = typeof field.type === "string" ? field.type : field.type.enum.map((value) => JSON.stringify(value)).join(" | ");
  return `${field.name}${field.required ? "" : "?"}: ${type}`;
}

function extractFlagSummaries(schema: z.ZodType): ToolsetInputFieldSummary[] {
  const objectSchema = unwrapSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) {
    return [];
  }

  return Object.entries(objectSchema.shape).map(([name, fieldSchema]) => {
    const field = unwrapFieldSchema(fieldSchema as z.ZodType);
    return {
      name,
      type: schemaFlagType(field.schema),
      required: !field.optional,
      ...(schemaDescription(fieldSchema as z.ZodType) ? { description: schemaDescription(fieldSchema as z.ZodType) } : {}),
    };
  });
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;

  for (let depth = 0; depth < 8; depth += 1) {
    const next = getWrappedSchema(current);
    if (!next || next === current) {
      return current;
    }
    current = next;
  }

  return current;
}

function getWrappedSchema(schema: z.ZodType): z.ZodType | null {
  if (schema instanceof z.ZodEffects) {
    return schema.innerType();
  }

  const definition = schema._def as {
    innerType?: z.ZodType;
    schema?: z.ZodType;
    out?: z.ZodType;
  };

  return definition.innerType ?? definition.schema ?? definition.out ?? null;
}

function unwrapFieldSchema(schema: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let current = schema;
  let optional = false;

  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      optional = true;
    }
    if (current instanceof z.ZodNullable) {
      optional = true;
    }

    const next = getWrappedSchema(current);
    if (!next || next === current) {
      return { schema: current, optional };
    }
    current = next;
  }

  return { schema: current, optional };
}

function schemaFlagType(schema: z.ZodType): ToolsetInputFieldType {
  if (schema instanceof z.ZodNumber) {
    return "number";
  }
  if (schema instanceof z.ZodBoolean) {
    return "boolean";
  }
  if (schema instanceof z.ZodEnum) {
    return { enum: schema.options.map(String) };
  }
  if (schema instanceof z.ZodArray) {
    const item = unwrapFieldSchema(schema.element).schema;
    if (item instanceof z.ZodNumber) {
      return "number[]";
    }
    if (item instanceof z.ZodObject) {
      return "object[]";
    }
    if (item instanceof z.ZodString || item instanceof z.ZodEnum || item instanceof z.ZodLiteral) {
      return "string[]";
    }
    return "unknown[]";
  }
  if (schema instanceof z.ZodObject || schema instanceof z.ZodRecord || schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return "object";
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return "unknown";
  }
  return "string";
}

function schemaDescription(schema: z.ZodType): string | undefined {
  if (schema.description) {
    return schema.description;
  }
  const next = getWrappedSchema(schema);
  return next && next !== schema ? schemaDescription(next) : undefined;
}
