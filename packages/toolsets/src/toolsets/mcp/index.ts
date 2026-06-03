import type { McpRuntimeService } from "@finn/runtime";
import type { ToolsetDefinition } from "../../types.js";
import { createMcpManifest, type McpManifestOptions } from "./manifest.js";
import { executeMcpCommand } from "./operations.js";

export interface McpToolsetDefinitionOptions {
  processTypes: McpManifestOptions["processTypes"];
  runtime: McpRuntimeService;
}

export type { McpManifestOptions } from "./manifest.js";
export { createMcpManifest } from "./manifest.js";
export {
  mcpCallInputSchema,
  mcpReadResourceInputSchema,
  mcpResourcesInputSchema,
  mcpSearchInputSchema,
  mcpServersInputSchema,
} from "./schemas.js";
export type {
  McpCallInput,
  McpReadResourceInput,
  McpResourcesInput,
  McpSearchInput,
  McpServersInput,
} from "./schemas.js";
export {
  executeMcpCommand,
  mcpCallCommand,
  mcpReadResourceCommand,
  mcpResourcesCommand,
  mcpSearchCommand,
  mcpServersCommand,
} from "./operations.js";

export function createMcpToolsetDefinition(options: McpToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createMcpManifest({
    processTypes: options.processTypes,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executeMcpCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
