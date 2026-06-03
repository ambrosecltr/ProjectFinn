import { z } from "zod";
import type { CodeModeCommandSummary, ToolsetRuntime } from "./registry.js";
import type { ToolsetEffect, ToolsetExecuteInput } from "./types.js";

export interface CodeModeCatalogEntry {
  apiName: string;
  apiPath: string[];
  toolset: string;
  command: string;
  description: string;
  effects: ToolsetEffect[];
  inputTypeName: string;
  inputInterface: string;
  signature: string;
  searchText: string;
  executeInput: ToolsetExecuteInput;
}

export interface CodeModeCatalog {
  entries: CodeModeCatalogEntry[];
  typeDefinitions: string;
  search(query: string, options?: { limit?: number }): CodeModeCatalogEntry[];
  resolve(apiName: string): CodeModeCatalogEntry | undefined;
}

export interface CodeModeSearchFormatOptions {
  query: string;
  total: number;
}

export interface CodeModeCatalogOptions {
  excludeCommands?: Partial<Record<string, readonly string[]>>;
}

type ApiTree = Map<string, ApiTree | CodeModeCatalogEntry[]>;

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

function pascalCase(parts: string[], fallback: string): string {
  const value = parts.map((part) => {
    const identifier = sanitizeIdentifier(part, "");
    return identifier ? `${identifier.charAt(0).toUpperCase()}${identifier.slice(1)}` : "";
  }).join("");
  return value || fallback;
}

function apiNamespaceParts(slug: string): string[] {
  return slug
    .split(/[^A-Za-z0-9_$]+/)
    .map((part, index) => sanitizeIdentifier(part, index === 0 ? "toolset" : `group${index}`))
    .filter((part) => part.length > 0);
}

function apiCommandName(command: string): string {
  return sanitizeIdentifier(command, "run");
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const definition = current._def as {
      innerType?: z.ZodType;
      schema?: z.ZodType;
      type?: z.ZodType;
      out?: z.ZodType;
    };
    const next = current instanceof z.ZodEffects
      ? current.innerType()
      : definition.innerType ?? definition.schema ?? definition.type ?? definition.out;
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function unwrapFieldSchema(schema: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let current = schema;
  let optional = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
      optional = true;
    }
    const next = unwrapSchema(current);
    if (next === current) {
      return { schema: current, optional };
    }
    current = next;
  }
  return { schema: current, optional };
}

function schemaDescription(schema: z.ZodType): string | undefined {
  if (schema.description) {
    return schema.description;
  }
  const next = unwrapSchema(schema);
  return next !== schema ? schemaDescription(next) : undefined;
}

function typeForSchema(schema: z.ZodType): string {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodString) {
    return "string";
  }
  if (unwrapped instanceof z.ZodNumber) {
    return "number";
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return "boolean";
  }
  if (unwrapped instanceof z.ZodEnum) {
    return unwrapped.options.map((option: string) => JSON.stringify(String(option))).join(" | ");
  }
  if (unwrapped instanceof z.ZodArray) {
    return `${typeForSchema(unwrapped.element)}[]`;
  }
  if (unwrapped instanceof z.ZodObject) {
    return "{ " + Object.entries(unwrapped.shape).map(([key, value]) => {
      const field = unwrapFieldSchema(value as z.ZodType);
      return `${key}${field.optional ? "?" : ""}: ${typeForSchema(field.schema)}`;
    }).join("; ") + " }";
  }
  if (unwrapped instanceof z.ZodRecord) {
    return "Record<string, unknown>";
  }
  if (unwrapped instanceof z.ZodUnknown || unwrapped instanceof z.ZodAny) {
    return "unknown";
  }
  return "unknown";
}

function renderInputInterface(typeName: string, schema: z.ZodType): string {
  const objectSchema = unwrapSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) {
    return `type ${typeName} = ${typeForSchema(objectSchema)};`;
  }

  const lines = Object.entries(objectSchema.shape).map(([name, value]) => {
    const fieldSchema = value as z.ZodType;
    const field = unwrapFieldSchema(fieldSchema);
    const description = schemaDescription(fieldSchema);
    return [
      description ? `  /** ${description.replace(/\*\//g, "* /")} */` : null,
      `  ${name}${field.optional ? "?" : ""}: ${typeForSchema(field.schema)};`,
    ].filter((line): line is string => line !== null).join("\n");
  });

  return [`interface ${typeName} {`, ...lines, "}"].join("\n");
}

function insertApiTree(tree: ApiTree, path: string[], entry: CodeModeCatalogEntry): void {
  const [head, ...tail] = path;
  if (!head) {
    return;
  }
  if (tail.length === 0) {
    const existing = tree.get(head);
    if (Array.isArray(existing)) {
      existing.push(entry);
    } else {
      tree.set(head, [entry]);
    }
    return;
  }
  const existing = tree.get(head);
  const child = existing instanceof Map ? existing : new Map<string, ApiTree | CodeModeCatalogEntry[]>();
  tree.set(head, child);
  insertApiTree(child, tail, entry);
}

function renderApiTree(tree: ApiTree, indent = "  "): string[] {
  return [...tree.entries()].flatMap(([name, value]) => {
    if (Array.isArray(value)) {
      return value.map((entry) => `${indent}${name}(input: ${entry.inputTypeName}): Promise<unknown>;`);
    }
    return [
      `${indent}${name}: {`,
      ...renderApiTree(value, `${indent}  `),
      `${indent}};`,
    ];
  });
}

function createCatalogEntry(command: CodeModeCommandSummary): CodeModeCatalogEntry {
  const namespace = apiNamespaceParts(command.toolset);
  const commandName = apiCommandName(command.name);
  const apiPath = [...namespace, commandName];
  const apiName = `finn.${apiPath.join(".")}`;
  const inputTypeName = `${pascalCase([...namespace, command.name.split(/[^A-Za-z0-9_$]+/).join(" ")], "Tool")}Input`;
  const inputInterface = renderInputInterface(inputTypeName, command.inputSchema);
  const signature = `${apiName}(input: ${inputTypeName}): Promise<unknown>`;
  const searchText = [
    apiName,
    command.toolset,
    command.name,
    command.description,
    command.effects.join(" "),
    inputInterface,
  ].join("\n").toLowerCase();

  return {
    apiName,
    apiPath,
    toolset: command.toolset,
    command: command.name,
    description: command.description,
    effects: command.effects,
    inputTypeName,
    inputInterface,
    signature,
    searchText,
    executeInput: {
      toolset: command.toolset,
      command: command.name,
      args: {},
    },
  };
}

function scoreEntry(entry: CodeModeCatalogEntry, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return 1;
  }
  return words.reduce((score, word) => score + (entry.searchText.includes(word) ? 1 : 0), 0);
}

export function createCodeModeCatalog(runtime: ToolsetRuntime, options: CodeModeCatalogOptions = {}): CodeModeCatalog {
  const entries = runtime.toCodeModeToolsets().flatMap((toolset) => {
    const excludedCommands = new Set(options.excludeCommands?.[toolset.slug] ?? []);
    return toolset.commands
      .filter((command) => !excludedCommands.has(command.name))
      .map(createCatalogEntry);
  });
  const apiTree: ApiTree = new Map();
  for (const entry of entries) {
    insertApiTree(apiTree, entry.apiPath, entry);
  }
  const typeDefinitions = [
    "declare const finn: FinnRuntimeApi;",
    "",
    "interface FinnRuntimeApi {",
    "  search(query: string, options?: { limit?: number }): Promise<string>;",
    ...renderApiTree(apiTree),
    "}",
    "",
    ...entries.flatMap((entry) => [entry.inputInterface, ""]),
  ].join("\n").trim();
  const entriesByApiName = new Map(entries.map((entry) => [entry.apiName, entry]));

  return {
    entries,
    typeDefinitions,
    search: (query, options = {}) => {
      const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
      return entries
        .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.entry.apiName.localeCompare(b.entry.apiName))
        .slice(0, limit)
        .map(({ entry }) => entry);
    },
    resolve: (apiName) => entriesByApiName.get(apiName),
  };
}

export function formatCodeModeSearchResults(
  matches: CodeModeCatalogEntry[],
  options: CodeModeSearchFormatOptions,
): string {
  if (matches.length === 0) {
    return `No Finn JS workspace APIs matched "${options.query}". ${options.total} API(s) are available in this runtime. Try broader terms such as files, web, mcp, patterns, memory, or the external service name.`;
  }

  return [
    `Found ${matches.length} of ${options.total} Finn JS workspace API(s) for "${options.query}".`,
    "",
    ...matches.map((entry) => [
      `## ${entry.apiName}`,
      entry.description,
      `Signature: ${entry.signature}`,
      `Effects: ${entry.effects.join(", ")}`,
      "Input:",
      "```ts",
      entry.inputInterface,
      "```",
    ].join("\n")),
  ].join("\n\n");
}
