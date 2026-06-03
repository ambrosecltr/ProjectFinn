import type { ToolsetDefinition } from "../../types.js";
import { createSkillsManifest, type SkillsManifestOptions } from "./manifest.js";
import { executeSkillsCommand, type SkillsToolsetRuntime } from "./operations.js";

export interface SkillsToolsetDefinitionOptions {
  processTypes: SkillsManifestOptions["processTypes"];
  runtime: SkillsToolsetRuntime;
}

export type { SkillsManifestOptions } from "./manifest.js";
export { createSkillsManifest } from "./manifest.js";
export {
  skillsInstallInputSchema,
  skillsListInputSchema,
  skillsLoadInputSchema,
  skillsReadResourceInputSchema,
  skillsRemoveInputSchema,
  skillsSearchInputSchema,
  skillsUpdateInputSchema,
} from "./schemas.js";
export type {
  SkillsInstallInput,
  SkillsListInput,
  SkillsLoadInput,
  SkillsReadResourceInput,
  SkillsRemoveInput,
  SkillsSearchInput,
  SkillsUpdateInput,
} from "./schemas.js";
export {
  discoverWorkerSkills,
  executeSkillsCommand,
  skillsInstallCommand,
  skillsListCommand,
  skillsLoadCommand,
  skillsReadResourceCommand,
  skillsRemoveCommand,
  skillsSearchCommand,
  skillsUpdateCommand,
} from "./operations.js";
export type { SkillCommandRunner, SkillsToolsetRuntime, WorkerSkill } from "./operations.js";

export function createSkillsToolsetDefinition(options: SkillsToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createSkillsManifest({ processTypes: options.processTypes });
  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executeSkillsCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
