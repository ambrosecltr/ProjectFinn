import { loadIdentityFile, type AppConfig, type EventBus, type MyDayRecord, type MyDayTodoRecord, type PatternRecord, type UserContext, type UserMessage } from "@finn/core";
import type { Database } from "@finn/db";
import type { LLMManager } from "@finn/llm";

import type { Compactor } from "./compactor.js";
import { HotPathAgent, type DelegateToolContext, type HotPathMemoryClient, type HotPathTurnRecorder, type HotPathTurnToolFactory, type MessageSender, type PrepareHotPathImageForModelInput, type ToolSet } from "./hot-path.js";
import type { WorkerManager } from "./worker-manager.js";
import { buildHotPathFinnPrompt } from "./prompt-factory.js";

interface CreateHotPathAgentDeps {
  db: Database;
  config: AppConfig;
  user: UserContext;
  llmManager: LLMManager;
  messageSender: MessageSender;
  eventBus: EventBus;
  workerManager?: WorkerManager;
  memory?: HotPathMemoryClient;
  getActivePatternCount?: () => Promise<number>;
  listActivePatterns?: () => Promise<PatternRecord[]>;
  getMyDay?: () => Promise<{ day: MyDayRecord; todos: MyDayTodoRecord[] }>;
  getDelegateToolContext?: (message: UserMessage) => DelegateToolContext | undefined;
  attachmentStorageRoot?: string;
  prepareImageForModelInput?: PrepareHotPathImageForModelInput;
  maxInlineVisionImages?: number;
  tools?: ToolSet;
  createTurnTools?: HotPathTurnToolFactory;
  compactor?: Compactor;
  hotPathTurnRecorder?: HotPathTurnRecorder;
}

export type { CreateHotPathAgentDeps };

export function buildHotPathIdentityFiles(deps: Pick<CreateHotPathAgentDeps, "config" | "user">) {
  const finnIdentityFile = deps.user.kidsMode ? "FINN.kids.xml" : "FINN.xml";
  const hotPathPromptFile = deps.user.kidsMode ? "hot-path.kids.xml" : "hot-path.xml";

  return {
    finn: buildHotPathFinnPrompt({
      finnIdentity: loadIdentityFile(finnIdentityFile),
      hotPathPrompt: loadIdentityFile(hotPathPromptFile, "./prompts"),
      capabilities: deps.config.capabilities,
    }),
  };
}

export function createHotPathAgent(deps: CreateHotPathAgentDeps): HotPathAgent {
  const agent = new HotPathAgent({
    db: deps.db,
    llmManager: deps.llmManager,
    sender: deps.messageSender,
    config: deps.config,
    user: deps.user,
    eventBus: deps.eventBus,
    workerManager: deps.workerManager,
    memory: deps.memory,
    getActivePatternCount: deps.getActivePatternCount,
    listActivePatterns: deps.listActivePatterns,
    getMyDay: deps.getMyDay,
    getDelegateToolContext: deps.getDelegateToolContext,
    attachmentStorageRoot: deps.attachmentStorageRoot,
    prepareImageForModelInput: deps.prepareImageForModelInput,
    maxInlineVisionImages: deps.maxInlineVisionImages,
    createTurnTools: deps.createTurnTools,
    compactor: deps.compactor,
    hotPathTurnRecorder: deps.hotPathTurnRecorder,
  });

  agent.setIdentityFiles(buildHotPathIdentityFiles(deps));

  if (deps.tools) {
    agent.setTools(deps.tools);
  }

  return agent;
}
