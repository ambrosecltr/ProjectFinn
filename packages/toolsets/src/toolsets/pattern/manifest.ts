import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import { patternRunInputSchema, patternRunsInputSchema } from "./schemas.js";

export interface PatternManifestOptions {
  processTypes: ToolsetProcessType[];
}

export function createPatternManifest(options: PatternManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [
    {
      name: "runs",
      description: "List previous runs for the current Pattern only, five summaries at a time.",
      effects: ["read"],
      inputSchema: patternRunsInputSchema,
      argumentGuidance: [
        "limit is 1-5 and defaults to the runtime limit.",
        "beforeRunId pages older than a run ID returned by a previous runs response.",
      ],
      examples: [
        { purpose: "List recent runs for the current Pattern", code: "await finn.pattern.runs({ limit: 5 })" },
        { purpose: "Page older Pattern runs", code: "await finn.pattern.runs({ limit: 5, beforeRunId: \"ptrun_123\" })" },
      ],
      outputGuidance: [
        "Use returned run IDs with finn.pattern.run when you need full details.",
      ],
    },
    {
      name: "run",
      description: "Get full details for one previous run of the current Pattern by run ID.",
      effects: ["read"],
      inputSchema: patternRunInputSchema,
      argumentGuidance: [
        "runId must be a run ID returned by finn.pattern.runs or present in current Pattern context.",
      ],
      examples: [
        { purpose: "Inspect a previous Pattern run", code: "await finn.pattern.run({ runId: \"ptrun_123\" })" },
      ],
      outputGuidance: [
        "Use previous run details for dedupe, novelty checks, skipped reasons, and outcome continuity. Do not treat this as proof the user was notified.",
      ],
    },
  ];

  return {
    slug: "pattern",
    displayName: "Pattern",
    description: "Read-only Finn JS workspace access to persisted run history for the current Pattern.",
    capability: "read",
    effects: ["read"],
    runtimeRequirements: ["patterns"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this read-only toolset inside a Pattern worker to inspect persisted run history for the current Pattern only.",
        "Use it when novelty, dedupe, prior failures, prior skips, or recurring outcome continuity could change the current run.",
      ],
      referenceFormats: [
        "Pattern run IDs look like ptrun_123 and come from finn.pattern.runs or current runtime context.",
      ],
      syntaxRules: [
        "This toolset is already scoped to the current Pattern. Do not pass Pattern IDs.",
      ],
      safetyRules: [
        "Pattern run history is not proof the user was notified. Use user memory or current scheduler context when user-visible novelty matters.",
      ],
    },
    defaultLimit: 5,
    maxLimit: 5,
    commands,
  };
}
