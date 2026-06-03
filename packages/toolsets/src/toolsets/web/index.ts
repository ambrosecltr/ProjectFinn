import type { WebRuntimeService } from "@finn/runtime";
import type { ToolsetDefinition } from "../../types.js";
import { createWebManifest, type WebManifestOptions } from "./manifest.js";
import { executeWebCommand } from "./operations.js";

export interface WebToolsetDefinitionOptions {
  processTypes: WebManifestOptions["processTypes"];
  runtime: WebRuntimeService;
  search?: boolean;
  fetch?: boolean;
}

export type { WebManifestOptions } from "./manifest.js";
export { createWebManifest } from "./manifest.js";
export { webFetchInputSchema, webSearchInputSchema } from "./schemas.js";
export type { WebFetchInput, WebFetchMode, WebSearchInput } from "./schemas.js";
export { executeWebCommand, webFetchCommand, webSearchCommand } from "./operations.js";

export function createWebToolsetDefinition(options: WebToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createWebManifest({
    processTypes: options.processTypes,
    search: options.search,
    fetch: options.fetch,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executeWebCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
