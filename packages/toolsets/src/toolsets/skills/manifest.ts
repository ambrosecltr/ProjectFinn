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
      examples: [
        { purpose: "List installed skills", code: "await finn.skills.list({})" },
      ],
      outputGuidance: [
        "Use returned skill names exactly with finn.skills.load or finn.skills.readResource.",
      ],
    },
    {
      name: "search",
      description: "Search skills.sh for installable skills when the user asks for a new capability but does not know the package name.",
      effects: ["read"],
      inputSchema: skillsSearchInputSchema,
      argumentGuidance: [
        "query should describe the capability or package the user asked for, such as spreadsheet parsing or calendar planning.",
      ],
      examples: [
        { purpose: "Search installable skills", code: "await finn.skills.search({ query: \"spreadsheet analysis\" })" },
      ],
      outputGuidance: [
        "Inspect search results before installing; do not guess package names.",
      ],
    },
    {
      name: "install",
      description: "Install a skill from skills.sh into Finn's shared local skills directory for future worker runs.",
      effects: ["write"],
      inputSchema: skillsInstallInputSchema,
      argumentGuidance: [
        "package is the skills.sh package/source shown by search results or provided by the user.",
        "skill is optional and should be used only when the package contains multiple skills and one specific skill is intended.",
      ],
      examples: [
        { purpose: "Install a package from search results", code: "await finn.skills.install({ package: \"owner/repo\" })" },
        { purpose: "Install one skill from a multi-skill package", code: "await finn.skills.install({ package: \"owner/repo\", skill: \"spreadsheet-analysis\" })" },
      ],
      outputGuidance: [
        "Use the returned installed skill name/path as the source of truth.",
        "If installation returns an error, report the error and do not claim the skill is available.",
      ],
    },
    {
      name: "remove",
      description: "Remove a skill from Finn's repo-local shared skills directory.",
      effects: ["write"],
      inputSchema: skillsRemoveInputSchema,
      argumentGuidance: [
        "name must be an installed skill name from finn.skills.list.",
      ],
      examples: [
        { purpose: "Remove an installed skill", code: "await finn.skills.remove({ name: \"spreadsheet-analysis\" })" },
      ],
      outputGuidance: [
        "Only report removal when the returned result confirms the named skill was removed.",
      ],
    },
    {
      name: "update",
      description: "Update one installed repo-local skill, or all installed skills when no name is provided, using Finn's recorded skill sources.",
      effects: ["write"],
      inputSchema: skillsUpdateInputSchema,
      argumentGuidance: [
        "Omit name only when updating all installed repo-local skills is explicitly intended.",
        "Use name to update one specific installed skill from finn.skills.list.",
      ],
      examples: [
        { purpose: "Update one installed skill", code: "await finn.skills.update({ name: \"spreadsheet-analysis\" })" },
        { purpose: "Update all installed skills", code: "await finn.skills.update({})" },
      ],
      outputGuidance: [
        "Report any returned errors or skipped skills; do not assume every skill updated successfully.",
      ],
    },
    {
      name: "load",
      description: "Load an installed worker skill's instructions and available resource files by skill name.",
      effects: ["read"],
      inputSchema: skillsLoadInputSchema,
      argumentGuidance: [
        "name must be an installed skill name from finn.skills.list or a known skill already present in context.",
      ],
      examples: [
        { purpose: "Load a skill's instructions", code: "await finn.skills.load({ name: \"spreadsheet-analysis\" })" },
      ],
      outputGuidance: [
        "Follow the returned instructions only when they are relevant to the current task.",
        "Use returned resource paths with finn.skills.readResource when the instructions say a resource is needed.",
      ],
    },
    {
      name: "read_resource",
      description: "Read a text resource file from an installed worker skill.",
      effects: ["read"],
      inputSchema: skillsReadResourceInputSchema,
      argumentGuidance: [
        "skill is the installed skill name. path must be a resource path returned by finn.skills.load.",
      ],
      examples: [
        { purpose: "Read a skill resource", code: "await finn.skills.readResource({ skill: \"spreadsheet-analysis\", path: \"references/formulas.md\" })" },
      ],
      outputGuidance: [
        "If truncated is true, read narrower resources or use the most relevant returned slice.",
      ],
    },
  ];

  return {
    slug: "skills",
    displayName: "Skills",
    description: "Finn JS workspace access to Finn's repo-local worker skill discovery, loading, and skills.sh management.",
    capability: "write",
    effects: ["read", "write"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset for installed worker skill discovery, loading, and skills.sh management.",
        "Load a skill before relying on its specialized workflow.",
      ],
      syntaxRules: [
        "Pass skill names exactly as returned by finn.skills.list, search, install, or load.",
        "Use camelCase Finn JS API names, such as finn.skills.readResource.",
      ],
      safetyRules: [
        "Install, remove, and update mutate Finn's shared skill directory. Use them only when the user asked for skill management or a needed capability is clearly missing.",
        "Do not claim a skill is available unless list/install/load confirms it.",
      ],
    },
    commands,
  };
}
