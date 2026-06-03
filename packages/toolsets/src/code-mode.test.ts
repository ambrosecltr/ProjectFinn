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
    ],
  },
  executors: {
    read: () => "file contents",
    write: () => ({ ok: true }),
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
      "finn.puter.imessage.searchRecords",
    ]);
    expect(catalog.typeDefinitions).toContain("declare const finn: FinnRuntimeApi;");
    expect(catalog.typeDefinitions).toContain("read(input: FilesReadInput): Promise<unknown>;");
    expect(catalog.typeDefinitions).toContain("path: string;");
    expect(catalog.typeDefinitions).toContain("limit?: number;");
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
});
