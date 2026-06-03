import type { CreativeRuntimeService } from "@finn/runtime";
import type { ToolsetDefinition } from "../../types.js";
import { createCreativeManifest, type CreativeManifestOptions } from "./manifest.js";
import { executeCreativeCommand } from "./operations.js";

export interface CreativeToolsetDefinitionOptions {
  processTypes: CreativeManifestOptions["processTypes"];
  runtime: CreativeRuntimeService;
  image?: boolean;
  video?: boolean;
}

export type { CreativeManifestOptions } from "./manifest.js";
export { createCreativeManifest } from "./manifest.js";
export { creativeImageInputSchema, creativeVideoInputSchema } from "./schemas.js";
export type { CreativeImageInput, CreativeVideoInput } from "./schemas.js";
export { creativeImageCommand, creativeVideoCommand, executeCreativeCommand } from "./operations.js";

export function createCreativeToolsetDefinition(options: CreativeToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createCreativeManifest({
    processTypes: options.processTypes,
    image: options.image,
    video: options.video,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executeCreativeCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
