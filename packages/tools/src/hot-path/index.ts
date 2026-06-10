import { WorkerToolOutputArtifactStore } from "@finn/core";
import type { MessageSender } from "@finn/messaging";
import type { TextToSpeechClient } from "@finn/media";
import type { FilesRuntime, MemoryRuntimeService, ProcessRuntimeServices } from "@finn/runtime";
import { createFilesToolsetDefinition, createToolsetRuntime } from "@finn/toolsets";
import type { ToolSet } from "ai";

import { createCodeModeTools, SecureExecCodeModeExecutor, type CodeModeExecutor } from "../code-mode";
import { createViewImageTools } from "../view-image";
import { createDisplayDraftTool } from "./display-draft";
import { finish_turn } from "./finish-turn";
import { createListActivePatternsTool, createReminderTools, type PatternOps } from "./patterns";
import { createReactTool } from "./react";
import { createSendMediaTool, createSendMessageTool } from "./send-message";
import { createHotPathMemoryTools } from "./memory";
import { createMyDayTools, type MyDayToolsDeps } from "./my-day";
import { createUpdateUserProfileTool, type UpdateUserProfileToolDeps } from "./profile";
import { wait } from "./wait";

type HotPathFilesRuntime = Omit<FilesRuntime, "documentExtraction" | "documentExtractionAvailable"> & {
  documentExtractionAvailable: false;
};

export interface HotPathToolsDeps {
  sender: MessageSender;
  runtime: ProcessRuntimeServices;
  voice?: {
    tts: TextToSpeechClient;
    tempRoot: string;
  };
  memory?: MemoryRuntimeService;
  reflectMemory?: boolean;
  patterns?: Pick<PatternOps, "list">;
  reminders?: PatternOps;
  myDay?: MyDayToolsDeps;
  profile?: UpdateUserProfileToolDeps;
}

export interface HotPathTurnToolsDeps extends HotPathToolsDeps {
  codeModeExecutorFactory?: () => CodeModeExecutor;
}

export interface HotPathTurnTools {
  tools: ToolSet;
  cleanup?: () => void | Promise<void>;
}

function createHotPathFilesToolsetRuntime(runtime: FilesRuntime): HotPathFilesRuntime {
  const { documentExtraction: _documentExtraction, documentExtractionAvailable: _documentExtractionAvailable, ...filesRuntime } = runtime;
  return {
    ...filesRuntime,
    documentExtractionAvailable: false,
  };
}

export function createHotPathTools(deps: HotPathToolsDeps): ToolSet {
  if (!deps.runtime.files) {
    throw new Error("Hot-path tools require a files runtime.");
  }

  const tools: ToolSet = {
    send_message: createSendMessageTool({
      sender: deps.sender,
      voice: deps.voice ? { ...deps.voice, files: deps.runtime.files } : undefined,
    }),
    send_media: createSendMediaTool(deps.sender, deps.runtime.files),
    react: createReactTool(deps.sender),
    wait,
    finish_turn,
    display_draft: createDisplayDraftTool(deps.sender),
    ...(deps.memory ? createHotPathMemoryTools({ memory: deps.memory, reflect: deps.reflectMemory }) : {}),
    ...(deps.profile ? { update_user_profile: createUpdateUserProfileTool(deps.profile) } : {}),
    ...(deps.patterns ? { list_active_patterns: createListActivePatternsTool(deps.patterns) } : {}),
    ...(deps.reminders ? createReminderTools(deps.reminders) : {}),
    ...(deps.myDay ? createMyDayTools(deps.myDay) : {}),
  };

  return tools;
}

export async function createHotPathTurnTools(deps: HotPathTurnToolsDeps): Promise<HotPathTurnTools> {
  const tools = createHotPathTools(deps);
  if (!deps.runtime.files) {
    throw new Error("Hot-path Finn JS workspace tools require a files runtime.");
  }
  const filesRuntime = deps.runtime.files;

  const toolsetRuntime = createToolsetRuntime({
    processType: "hot_path",
    enabledTools: ["files"],
    includeBuiltInToolsets: false,
    definitions: [createFilesToolsetDefinition({
      processTypes: ["hot_path"],
      runtime: createHotPathFilesToolsetRuntime(filesRuntime),
    })],
    context: { runtime: deps.runtime },
  });
  const toolOutputArtifacts = filesRuntime.artifactsRoot
    ? new WorkerToolOutputArtifactStore({
        workspaceRoot: deps.runtime.workspace.workspaceRoot,
        artifactsRoot: deps.runtime.workspace.artifactsRoot,
        runId: deps.runtime.runId,
      })
    : undefined;
  const codeModeExecutor = deps.codeModeExecutorFactory?.() ?? new SecureExecCodeModeExecutor();
  Object.assign(tools, createCodeModeTools(toolsetRuntime, {
    executor: codeModeExecutor,
    ...(toolOutputArtifacts ? { artifacts: toolOutputArtifacts } : {}),
    catalog: { excludeCommands: { files: ["view_image"] } },
  }));
  Object.assign(tools, createViewImageTools(deps.runtime));

  return {
    tools,
    cleanup: () => codeModeExecutor.dispose?.(),
  };
}

export { createListActivePatternsTool, createReminderTools } from "./patterns";
export type { PatternOps } from "./patterns";
export { createDisplayDraftTool, formatDraftForDisplay } from "./display-draft";
export { finish_turn } from "./finish-turn";
export { createHotPathMemoryTool, createHotPathMemoryTools, createHotPathReflectMemoryTool } from "./memory";
export { createMyDayTools } from "./my-day";
export type { MyDayToolsDeps, MyDayToolStore } from "./my-day";
export { createUpdateUserProfileTool } from "./profile";
export type { UpdateUserProfileToolDeps, UserProfileUpdate } from "./profile";
export { createReactTool } from "./react";
export { createSendMediaTool } from "./send-message";
export { createSendMessageTool } from "./send-message";
export { wait } from "./wait";
