import { WorkerToolOutputArtifactStore } from "@finn/core/worker-tool-output-artifacts";
import { createCodeModeTools, SecureExecCodeModeExecutor, type CodeModeExecutor } from "@finn/tools/code-mode";
import { createViewImageTools } from "@finn/tools/view-image";
import { createFilesToolsetDefinition } from "@finn/toolsets/toolsets/files/index";
import { createToolsetRuntime, type CodeModeToolsetSummary, type ToolsetRuntime } from "@finn/toolsets/registry";
import type { ToolsetDefinition, ToolsetProcessType } from "@finn/toolsets/types";
import { createProcessRuntimeServices, type FilesRuntime, type ProcessRuntimeServices, type UserRuntimeServices } from "@finn/runtime";
import type { ToolSet } from "ai";

type FilesProcessRuntime = ProcessRuntimeServices & { files: FilesRuntime };

export function createUserToolOutputArtifactStore(
  runtime: Pick<UserRuntimeServices, "workspace">,
  runId: string,
): WorkerToolOutputArtifactStore {
  return new WorkerToolOutputArtifactStore({
    workspaceRoot: runtime.workspace.workspaceRoot,
    artifactsRoot: runtime.workspace.artifactsRoot,
    runId,
  });
}

export function createUserFilesToolsetDefinition(
  processRuntime: FilesProcessRuntime,
  options: {
    access: "read" | "write";
    processTypes: ToolsetProcessType[];
  },
): ToolsetDefinition {
  return createFilesToolsetDefinition({
    processTypes: options.processTypes,
    runtime: processRuntime.files,
  });
}

export function createCodeModeToolsForToolsetRuntime(
  processRuntime: ProcessRuntimeServices,
  runtime: ToolsetRuntime | null,
  options: {
    artifacts?: WorkerToolOutputArtifactStore;
    executor?: CodeModeExecutor;
  } = {},
): { tools: ToolSet; summaries: CodeModeToolsetSummary[]; cleanup: () => Promise<void> } {
  const executor = options.executor ?? new SecureExecCodeModeExecutor();
  const tools = runtime
    ? createCodeModeTools(runtime, {
        executor,
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
        catalog: { excludeCommands: { files: ["view_image"] } },
      })
    : {};
  const summaries = runtime?.toCodeModeToolsets() ?? [];

  return {
    tools: {
      ...tools,
      ...createViewImageTools(processRuntime),
    },
    summaries,
    cleanup: async () => {
      await executor.dispose?.();
    },
  };
}

export function createUserFilesCodeModeTools(
  processRuntime: FilesProcessRuntime,
  options: {
    access: "read" | "write";
    processType: ToolsetProcessType;
    artifacts?: WorkerToolOutputArtifactStore;
    executor?: CodeModeExecutor;
  },
): { tools: ToolSet; summaries: CodeModeToolsetSummary[]; cleanup: () => Promise<void> } {
  const filesRuntime = options.artifacts
    ? { ...processRuntime.files, artifactsRoot: options.artifacts.runDirectory }
    : processRuntime.files;
  const scopedProcessRuntime: FilesProcessRuntime = filesRuntime === processRuntime.files
    ? processRuntime
    : { ...processRuntime, files: filesRuntime };
  const runtimeContext = options.artifacts
    ? { ...scopedProcessRuntime, artifacts: options.artifacts }
    : scopedProcessRuntime;
  const runtime = createToolsetRuntime({
    processType: options.processType,
    enabledTools: ["files"],
    includeBuiltInToolsets: false,
    definitions: [createFilesToolsetDefinition({
      processTypes: [options.processType],
      runtime: filesRuntime,
    })],
    context: { runtime: runtimeContext },
  });

  return createCodeModeToolsForToolsetRuntime(scopedProcessRuntime, runtime, {
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  });
}

export function createUserFilesProcessRuntime(
  userRuntime: UserRuntimeServices,
  options: { processType: ToolsetProcessType; filesAccess: "read" | "write" },
): FilesProcessRuntime {
  const processRuntime = createProcessRuntimeServices(userRuntime, {
    processType: options.processType,
    filesAccess: options.filesAccess,
  });
  if (!processRuntime.files) {
    throw new Error("Files runtime is not available for Finn JS workspace tools.");
  }

  return processRuntime as FilesProcessRuntime;
}
