import type { WorkerToolOutputArtifactStore } from "@finn/core";
import type { ToolSet } from "ai";

export interface WrapToolsWithOutputArtifactsOptions {
  excludeToolNames?: Iterable<string>;
}

export function canWrapToolOutputWithArtifact(
  toolName: string,
  toolDefinition: ToolSet[string],
  options: WrapToolsWithOutputArtifactsOptions = {},
): boolean {
  if (new Set(options.excludeToolNames ?? []).has(toolName)) {
    return false;
  }

  return !("toModelOutput" in toolDefinition && typeof toolDefinition.toModelOutput === "function");
}

export function wrapToolsWithOutputArtifacts(
  tools: ToolSet,
  artifacts: WorkerToolOutputArtifactStore | undefined,
  options: WrapToolsWithOutputArtifactsOptions = {},
): ToolSet {
  if (!artifacts) {
    return tools;
  }

  return Object.fromEntries(
    Object.entries(tools).map(([name, toolDefinition]) => {
      if (!toolDefinition.execute || !canWrapToolOutputWithArtifact(name, toolDefinition, options)) {
        return [name, toolDefinition];
      }

      return [
        name,
        {
          ...toolDefinition,
          execute: async (...args: Parameters<NonNullable<typeof toolDefinition.execute>>) => {
            const result = await toolDefinition.execute!(...args);
            return artifacts.replaceIfOversized(name, result);
          },
        },
      ];
    }),
  );
}
