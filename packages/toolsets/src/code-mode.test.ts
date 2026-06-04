import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createCodeModeCatalog, formatCodeModeSearchResults } from "./code-mode.js";
import { createToolsetRuntime } from "./registry.js";
import type { ToolsetDefinition } from "./types.js";

const codeModeTestToolset: ToolsetDefinition = {
  manifest: {
    slug: "files",
    displayName: "Files",
    description: "Read and write user workspace files.",
    capability: "write",
    processTypes: ["worker"],
    commands: [
      {
        name: "read",
        description: "Read a workspace file.",
        effects: ["read"],
        inputSchema: z.object({
          path: z.string().describe("Workspace or artifact path to read."),
          limit: z.number().int().positive().optional().describe("Maximum characters to return."),
        }),
      },
      {
        name: "write",
        description: "Write text to a workspace file.",
        effects: ["write"],
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
        }),
      },
      {
        name: "create-pattern",
        description: "Create a scheduled Pattern.",
        effects: ["write"],
        inputSchema: z.object({
          schedule: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("once"), localDateTime: z.string() }),
            z.object({ kind: z.literal("daily"), time: z.string() }),
            z.object({
              kind: z.literal("weekly"),
              daysOfWeek: z.array(z.enum(["monday", "tuesday"])),
              time: z.string(),
            }),
          ]),
          triggerFilters: z.array(z.object({
            path: z.string(),
            operator: z.enum(["equals", "exists"]),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
          })).optional(),
          connectorScope: z.object({
            composio: z.array(z.object({
              toolkitSlug: z.string(),
              connectedAccountId: z.string().optional(),
            })).optional(),
            mcpServerIds: z.array(z.string()).optional(),
          }).optional(),
          notifyCondition: z.union([
            z.object({ type: z.literal("always") }),
            z.object({ type: z.literal("worker_decision"), instruction: z.string() }),
          ]).optional(),
        }),
        argumentGuidance: [
          "Daily schedules use { kind: \"daily\", time: \"08:00\" }.",
          "notifyCondition must be an object such as { type: \"always\" }, not a bare string.",
        ],
        examples: [
          {
            purpose: "Create a daily Pattern",
            code: "await finn.files.createPattern({ schedule: { kind: \"daily\", time: \"08:00\" }, notifyCondition: { type: \"always\" } })",
          },
        ],
        outputGuidance: [
          "Use the returned nextRun; do not invent one.",
        ],
      },
    ],
  },
  executors: {
    read: () => "file contents",
    write: () => ({ ok: true }),
    "create-pattern": () => ({ id: "ptn_123" }),
  },
};

const dottedToolset: ToolsetDefinition = {
  manifest: {
    slug: "puter.imessage",
    displayName: "Puter iMessage",
    description: "Read paired Mac iMessage records.",
    capability: "read",
    processTypes: ["worker"],
    commands: [
      {
        name: "search-records",
        description: "Search iMessage records.",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().optional(),
        }),
      },
    ],
  },
  executors: {
    "search-records": () => [],
  },
};

describe("Code Mode catalog", () => {
  it("generates a typed Finn API path for enabled toolset commands", () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["files", "puter.imessage"],
      includeBuiltInToolsets: false,
      definitions: [codeModeTestToolset, dottedToolset],
      context: {},
    });

    const catalog = createCodeModeCatalog(runtime);

    expect(catalog.entries.map((entry) => entry.apiName)).toEqual([
      "finn.files.read",
      "finn.files.write",
      "finn.files.createPattern",
      "finn.puter.imessage.searchRecords",
    ]);
    expect(catalog.typeDefinitions).toContain("declare const finn: FinnRuntimeApi;");
    expect(catalog.typeDefinitions).toContain("read(input: FilesReadInput): Promise<unknown>;");
    expect(catalog.typeDefinitions).toContain("path: string;");
    expect(catalog.typeDefinitions).toContain("limit?: number;");
    expect(catalog.typeDefinitions).toContain("createPattern(input: FilesCreatePatternInput): Promise<unknown>;");
    expect(catalog.typeDefinitions).toContain("schedule: { kind: \"once\"; localDateTime: string } | { kind: \"daily\"; time: string } | { kind: \"weekly\"; daysOfWeek: (\"monday\" | \"tuesday\")[]; time: string };");
    expect(catalog.typeDefinitions).toContain("triggerFilters?: { path: string; operator: \"equals\" | \"exists\"; value?: string | number | boolean | null }[];");
    expect(catalog.typeDefinitions).toContain("connectorScope?: { composio?: { toolkitSlug: string; connectedAccountId?: string }[]; mcpServerIds?: string[] };");
    expect(catalog.typeDefinitions).toContain("notifyCondition?: { type: \"always\" } | { type: \"worker_decision\"; instruction: string };");
  });

  it("returns targeted docs instead of the whole catalog", () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["files", "puter.imessage"],
      includeBuiltInToolsets: false,
      definitions: [codeModeTestToolset, dottedToolset],
      context: {},
    });
    const catalog = createCodeModeCatalog(runtime);

    const matches = catalog.search("read file", { limit: 1 });
    const formatted = formatCodeModeSearchResults(matches, {
      query: "read file",
      total: catalog.entries.length,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.apiName).toBe("finn.files.read");
    expect(formatted).toContain("finn.files.read(input: FilesReadInput): Promise<unknown>");
    expect(formatted).toContain("Workspace or artifact path to read.");
    expect(formatted).not.toContain("finn.files.write");
    expect(formatted).not.toContain("finn.puter.imessage.searchRecords");
  });

  it("includes command guidance and examples in search results", () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["files"],
      includeBuiltInToolsets: false,
      definitions: [codeModeTestToolset],
      context: {},
    });
    const catalog = createCodeModeCatalog(runtime);

    const formatted = formatCodeModeSearchResults(catalog.search("daily schedule pattern", { limit: 1 }), {
      query: "daily schedule pattern",
      total: catalog.entries.length,
    });

    expect(formatted).toContain("finn.files.createPattern");
    expect(formatted).toContain("Daily schedules use { kind: \"daily\", time: \"08:00\" }.");
    expect(formatted).toContain("notifyCondition must be an object");
    expect(formatted).toContain("Create a daily Pattern");
    expect(formatted).toContain("Use the returned nextRun; do not invent one.");
  });
});
