import type { PatternsRuntimeService } from "@finn/runtime";
import type { ToolsetDefinition } from "../../types.js";
import { createPatternsManifest, type PatternsManifestOptions } from "./manifest.js";
import { executePatternsCommand } from "./operations.js";

export interface PatternsToolsetDefinitionOptions {
  processTypes: PatternsManifestOptions["processTypes"];
  runtime: PatternsRuntimeService;
}

export type { PatternsManifestOptions } from "./manifest.js";
export { createPatternsManifest } from "./manifest.js";
export {
  patternsCreateInputSchema,
  patternsDeleteInputSchema,
  patternsEditInputSchema,
  patternsInspectInputSchema,
  patternsListInputSchema,
  patternsSetActiveInputSchema,
  patternsTriggerTypeInputSchema,
  patternsTriggerTypesInputSchema,
} from "./schemas.js";
export type {
  PatternsCreateInput,
  PatternsDeleteInput,
  PatternsEditInput,
  PatternsInspectInput,
  PatternsListInput,
  PatternsSetActiveInput,
  PatternsTriggerTypeInput,
  PatternsTriggerTypesInput,
} from "./schemas.js";
export {
  executePatternsCommand,
  patternsCreateCommand,
  patternsDeleteCommand,
  patternsEditCommand,
  patternsInspectCommand,
  patternsListCommand,
  patternsPauseCommand,
  patternsResumeCommand,
  patternsTriggerTypeCommand,
  patternsTriggerTypesCommand,
} from "./operations.js";

export function createPatternsToolsetDefinition(options: PatternsToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createPatternsManifest({
    processTypes: options.processTypes,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executePatternsCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
