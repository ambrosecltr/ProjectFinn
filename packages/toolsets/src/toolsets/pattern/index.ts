import type { PatternsRuntimeService } from "@finn/runtime";
import type { ToolsetDefinition } from "../../types.js";
import { createPatternManifest, type PatternManifestOptions } from "./manifest.js";
import { executePatternCommand } from "./operations.js";

export interface PatternToolsetDefinitionOptions {
  processTypes: PatternManifestOptions["processTypes"];
  runtime: PatternsRuntimeService;
  patternId: string;
}

export type { PatternManifestOptions } from "./manifest.js";
export { createPatternManifest } from "./manifest.js";
export {
  executePatternCommand,
  patternRunCommand,
  patternRunsCommand,
} from "./operations.js";
export {
  patternRunInputSchema,
  patternRunsInputSchema,
} from "./schemas.js";
export type {
  PatternRunInput,
  PatternRunsInput,
} from "./schemas.js";

export function createPatternToolsetDefinition(options: PatternToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createPatternManifest({
    processTypes: options.processTypes,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executePatternCommand({ patterns: options.runtime, patternId: options.patternId }, command.name, args),
      ]),
    ),
  };
}
