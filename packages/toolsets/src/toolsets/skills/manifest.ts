import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import {
  skillsInstallInputSchema,
  skillsListInputSchema,
  skillsLoadInputSchema,
  skillsReadResourceInputSchema,
  skillsRemoveInputSchema,
  skillsSearchInputSchema,
  skillsUpdateInputSchema,
} from "./schemas.js";

export interface SkillsManifestOptions {
  processTypes: ToolsetProcessType[];
}

export function createSkillsManifest(options: SkillsManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [
    {
      name: "list",
      description: "List Finn's installed repo-local worker skills.",
      effects: ["read"],
      inputSchema: skillsListInputSchema,
    },
    {
      name: "search",
      description: "Search skills.sh for installable skills when the user asks for a new capability but does not know the package name.",
      effects: ["read"],
      inputSchema: skillsSearchInputSchema,
    },
    {
      name: "install",
      description: "Install a skill from skills.sh into Finn's shared local skills directory for future worker runs.",
      effects: ["write"],
      inputSchema: skillsInstallInputSchema,
    },
    {
      name: "remove",
      description: "Remove a skill from Finn's repo-local shared skills directory.",
      effects: ["write"],
      inputSchema: skillsRemoveInputSchema,
    },
    {
      name: "update",
      description: "Update one installed repo-local skill, or all installed skills when no name is provided, using Finn's recorded skill sources.",
      effects: ["write"],
      inputSchema: skillsUpdateInputSchema,
    },
    {
      name: "load",
      description: "Load an installed worker skill's instructions and available resource files by skill name.",
      effects: ["read"],
      inputSchema: skillsLoadInputSchema,
    },
    {
      name: "read_resource",
      description: "Read a text resource file from an installed worker skill.",
      effects: ["read"],
      inputSchema: skillsReadResourceInputSchema,
    },
  ];

  return {
    slug: "skills",
    displayName: "Skills",
    description: "Finn JS workspace access to Finn's repo-local worker skill discovery, loading, and skills.sh management.",
    capability: "write",
    effects: ["read", "write"],
    processTypes: options.processTypes,
    commands,
  };
}
