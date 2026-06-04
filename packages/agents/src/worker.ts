import {
  createFinnTelemetry,
  createFinnTelemetryContext,
  createProcessLogger,
  estimateTokens,
  formatUnknownError,
  formatShortTimeZoneName,
  formatUserProfileContext,
  getTracer,
  loadIdentityFile,
  truncate,
  withSpan,
  type UserContext,
  type WorkerRunMessage,
  type WorkerResult,
  type PatternNotifyOutcome,
  type WorkerToolOutputArtifactStore,
} from "@finn/core";
import type { LLMManager, LLMRequestOptions } from "@finn/llm";
import { getAbortErrorMessage } from "@finn/llm";
import { generateText, tool, type ModelMessage, type StopCondition, type ToolResultPart, type ToolSet } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import { wrapToolsWithOutputArtifacts } from "./tool-output-artifacts.js";

const outcomeDetailSchema = z.object({
  summary: z.string().optional(),
  result: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

const patternOutcomeDetailSchema = z.object({
  notify: z.boolean(),
  summary: z.string().min(1),
  reason: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

const setStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("working"),
    detail: z.string().min(1),
  }),
  z.object({
    kind: z.literal("outcome"),
    detail: z.union([patternOutcomeDetailSchema, outcomeDetailSchema]),
  }),
]);

const workerPromptTemplate = loadIdentityFile("worker.xml", "./prompts");
const patternManagementWorkerPromptTemplate = loadIdentityFile("pattern-management-worker.xml", "./prompts");
const patternWorkerPromptTemplate = loadIdentityFile("pattern-worker.xml", "./prompts");
const kidsWorkerPromptTemplate = loadIdentityFile("worker.kids.xml", "./prompts");
const kidsPatternWorkerPromptTemplate = loadIdentityFile("pattern-worker.kids.xml", "./prompts");
const workerContextCompactionPrompt = loadIdentityFile("worker-context-compaction.xml", "./prompts");
const workerFinalizationPrompt = [
  "Finalize this worker run now.",
  "Based only on the completed tool results and current context, call set_status with kind 'outcome'.",
  "Include a concise summary and structured data when useful.",
  "Do not call any tool other than set_status.",
].join("\n");
const maxWorkerPromptTokens = 160_000;
const maxWorkerMessageTokens = 8_000;
const workerContextSummaryPrefix = [
  "[worker context checkpoint - not from the user]",
  "Older worker transcript was compacted to keep this long-running task within context. Treat this as the authoritative work state for the omitted transcript, then continue from the recent verbatim messages that follow.",
].join("\n");
const workerRecentMessageTokens = 24_000;
const maxWorkerSummarySourceTokens = 48_000;
const maxWorkerCompactionSummaryTokens = 1_200;
const maxCheckpointPersistenceRepairAttempts = 2;
const workerPersistenceRepairPrefix = "[worker runtime repair - not from the user]";
function formatRuntimeTimestamp(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${lookup("year")}-${lookup("month")}-${lookup("day")}, ${lookup("hour")}:${lookup("minute")}:${lookup("second")} ${formatShortTimeZoneName(date, timeZone, lookup("timeZoneName"))}`.trim();
}

function normalizeOutcome(detail: z.infer<typeof outcomeDetailSchema>): WorkerResult {
  const summary = detail.summary ?? detail.result ?? detail.error ?? "Worker finished without a summary.";

  return {
    summary,
    data: detail.data,
    error: detail.error,
  };
}

function normalizePatternOutcome(detail: z.infer<typeof patternOutcomeDetailSchema>): WorkerResult {
  return {
    summary: detail.summary,
    data: detail.data,
    error: detail.error,
  };
}

function createMissingPatternNotifyOutcomeResult(): WorkerResult {
  return {
    summary: "Pattern worker failed to report a notify outcome.",
    error: "Pattern workers must report notify, summary, and optional reason/data in their terminal outcome.",
  };
}

export function finalizeFallbackWorkerOutcome(params: {
  source?: "user" | "pattern";
  implicitOutcome: WorkerResult | null;
  text: string;
  maxTurns: number;
}): WorkerResult {
  if (params.source === "pattern") {
    return createMissingPatternNotifyOutcomeResult();
  }

  if (params.implicitOutcome) {
    return params.implicitOutcome;
  }

  const text = params.text.trim();
  if (text.length > 0) {
    return { summary: text };
  }

  return {
    summary: "Worker failed to produce an outcome.",
    error: `No outcome reported after ${params.maxTurns} turns.`,
  };
}

function isPatternOutcomeDetail(detail: z.infer<typeof outcomeDetailSchema> | z.infer<typeof patternOutcomeDetailSchema>): detail is z.infer<typeof patternOutcomeDetailSchema> {
  return "notify" in detail;
}

type ToolResultLike = {
  toolName?: string;
  result?: unknown;
};

type ToolResultOutput = ToolResultPart["output"];
type ToolModelMessage = Extract<ModelMessage, { role: "tool" }>;

function formatJsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(sanitizeBinaryPartsForPrompt(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function sanitizeBinaryPartsForPrompt(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return `[binary buffer: ${value.byteLength} bytes]`;
  }

  if (value instanceof Uint8Array) {
    return `[binary data: ${value.byteLength} bytes]`;
  }

  if (value instanceof ArrayBuffer) {
    return `[binary data: ${value.byteLength} bytes]`;
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeBinaryPartsForPrompt);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record["type"] === "image-data" && typeof record["data"] === "string") {
    return {
      ...record,
      data: `[image data omitted: ${record["data"].length} base64 chars]`,
    };
  }

  if (record["type"] === "image") {
    return {
      ...record,
      image: "[image bytes]",
    };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === "dataBase64" && typeof entry === "string") {
        return [key, `[base64 omitted: ${entry.length} chars]`];
      }
      return [key, sanitizeBinaryPartsForPrompt(entry)];
    }),
  );
}

function compactToolOutput(output: ToolResultOutput, maxChars: number): ToolResultOutput {
  const text = output.type === "text" || output.type === "error-text"
    ? output.value
    : output.type === "content"
      ? formatJsonForPrompt(output.value)
      : "value" in output
        ? formatJsonForPrompt(output.value)
        : formatJsonForPrompt(output);

  if (text.length <= maxChars) {
    return output;
  }

  return {
    type: "text",
    value: truncate(
      `Large tool output omitted from worker history (${text.length} chars). Use targeted follow-up tool calls, or inspect any provided temporary artifact path through workspace_search and workspace_execute with finn.files if needed. Preview: ${text}`,
      maxChars,
    ),
  };
}

function omitImageDataFromToolOutput(output: ToolResultOutput): ToolResultOutput {
  if (output.type === "content" && Array.isArray(output.value)) {
    let omitted = false;
    const value = output.value.map((item) => {
      if (item && typeof item === "object" && (item as Record<string, unknown>)["type"] === "image-data") {
        omitted = true;
        const data = (item as Record<string, unknown>)["data"];
        return {
          type: "text" as const,
          text: `[image data omitted from worker history after it was shown to the model once${typeof data === "string" ? `: ${data.length} base64 chars` : ""}. Use the original file ID or /workspace/... path, or call view_image again only if fresh pixel inspection is required.]`,
        };
      }

      return item;
    });

    return omitted ? { ...output, value } : output;
  }

  if ("value" in output) {
    const sanitized = sanitizeBinaryPartsForPrompt(output.value);
    return sanitized === output.value ? output : { ...output, value: sanitized } as ToolResultOutput;
  }

  return output;
}

function omitConsumedImageToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  let keepImageDataFromIndex = messages.length;
  while (keepImageDataFromIndex > 0 && messages[keepImageDataFromIndex - 1]?.role === "tool") {
    keepImageDataFromIndex -= 1;
  }

  return messages.map((message, index) => {
    if (message.role !== "tool" || index >= keepImageDataFromIndex) {
      return message;
    }

    const toolMessage = message as ToolModelMessage;
    const content = Array.isArray(toolMessage.content)
      ? toolMessage.content.map((part) => {
          if (part.type !== "tool-result") {
            return part;
          }

          const toolResult = part as ToolResultPart;
          return {
            ...toolResult,
            output: omitImageDataFromToolOutput(toolResult.output),
          };
        })
      : toolMessage.content;

    return { ...toolMessage, content } satisfies ToolModelMessage;
  });
}

type WorkerMessageCompactionOptions = {
  maxPromptTokens?: number;
  maxMessageTokens?: number;
};

type WorkerContextCompactionOptions = WorkerMessageCompactionOptions & {
  model: WorkerModel;
  requestOptions?: WorkerRequestOptions;
  abortSignal?: AbortSignal;
  compactionPrompt?: string;
  recentMessageTokens?: number;
  maxSummarySourceTokens?: number;
  summaryCache?: Map<string, string>;
  user?: Pick<UserContext, "tenantId" | "userId" | "phoneNumber" | "displayName">;
  workerId?: string;
  runId?: string;
  processType?: string;
  compactionFunctionId?: string;
};

function estimateMessageTokens(message: ModelMessage): number {
  return estimateTokens(JSON.stringify(sanitizeBinaryPartsForPrompt(message)));
}

function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  return estimateTokens(JSON.stringify(sanitizeBinaryPartsForPrompt(messages)));
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  return truncate(text, Math.max(1, maxTokens) * 4);
}

function compactWorkerToolOutputs(messages: ModelMessage[], maxMessageTokens: number): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }

    const toolMessage = message as ToolModelMessage;
    const content = Array.isArray(toolMessage.content)
      ? toolMessage.content.map((part) => {
          if (part.type !== "tool-result") {
            return part;
          }

          const toolResult = part as ToolResultPart;
          return {
            ...toolResult,
            output: compactToolOutput(toolResult.output, maxMessageTokens * 4),
          };
        })
      : toolMessage.content;

    return { ...toolMessage, content } satisfies ToolModelMessage;
  });
}

function omitWorkerToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message, index) => {
    if (index === 0 || message.role !== "tool") {
      return message;
    }

    const toolMessage = message as ToolModelMessage;
    const content = Array.isArray(toolMessage.content)
      ? toolMessage.content.map((part) => {
          if (part.type !== "tool-result") {
            return part;
          }

          const toolResult = part as ToolResultPart;
          return {
            ...toolResult,
            output: {
              type: "text",
              value: "Tool output omitted from worker history to keep this ephemeral worker within context budget.",
            } satisfies ToolResultOutput,
          };
        })
      : toolMessage.content;

    return { ...toolMessage, content } satisfies ToolModelMessage;
  });
}

export function compactWorkerMessages(
  messages: ModelMessage[],
  options: WorkerMessageCompactionOptions = {},
): ModelMessage[] {
  const maxPromptTokens = options.maxPromptTokens ?? maxWorkerPromptTokens;
  const maxMessageTokens = options.maxMessageTokens ?? maxWorkerMessageTokens;
  const imageCompactedMessages = omitConsumedImageToolOutputs(messages);

  let tokenEstimate = estimateModelMessagesTokens(imageCompactedMessages);
  if (tokenEstimate <= maxPromptTokens) {
    return imageCompactedMessages;
  }

  const compactedMessages = compactWorkerToolOutputs(imageCompactedMessages, maxMessageTokens);

  tokenEstimate = estimateModelMessagesTokens(compactedMessages);
  if (tokenEstimate <= maxPromptTokens) {
    return compactedMessages;
  }

  return omitWorkerToolOutputs(compactedMessages);
}

function appendResponseMessages(baseMessages: ModelMessage[], responseMessages: ModelMessage[]): ModelMessage[] {
  return [...baseMessages, ...responseMessages];
}

export async function buildWorkerResumeCheckpoint(params: {
  baseMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  compactMessages: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
}): Promise<ModelMessage[]> {
  return params.compactMessages(appendResponseMessages(params.baseMessages, params.responseMessages));
}

export async function compactWorkerLoopMessages(params: {
  messages: ModelMessage[];
  fixedMessageCount: number;
  compactMessages: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
}): Promise<ModelMessage[]> {
  const compactedMessages = await params.compactMessages(params.messages);
  if (compactedMessages.length === params.messages.length) {
    return compactedMessages;
  }

  const fixedMessageCount = Math.max(0, Math.min(params.fixedMessageCount, compactedMessages.length));
  const fixedMessages = compactedMessages.slice(0, fixedMessageCount);
  const remainingMessages = compactedMessages.slice(fixedMessageCount);
  const firstCheckpointIndex = remainingMessages.findIndex((message) => {
    return message.role === "user"
      && typeof message.content === "string"
      && message.content.startsWith(workerContextSummaryPrefix);
  });

  if (firstCheckpointIndex === -1) {
    return compactedMessages;
  }

  return [
    ...fixedMessages,
    ...remainingMessages.slice(firstCheckpointIndex),
  ];
}

function includeToolCallForLeadingTool(messages: ModelMessage[], startIndex: number, minimumIndex: number): number {
  let index = startIndex;
  while (index > minimumIndex && messages[index]?.role === "tool") {
    index -= 1;
  }

  return index;
}

function splitWorkerMessagesForCompaction(
  messages: ModelMessage[],
  recentTokenBudget: number,
): { olderMessages: ModelMessage[]; recentMessages: ModelMessage[] } {
  if (messages.length <= 2) {
    return { olderMessages: [], recentMessages: messages.slice(1) };
  }

  let startIndex = messages.length;
  let usedTokens = 0;

  while (startIndex > 1) {
    const message = messages[startIndex - 1];
    if (!message) {
      break;
    }

    const nextTokens = usedTokens + estimateMessageTokens(message);
    if (startIndex < messages.length && nextTokens > recentTokenBudget) {
      break;
    }

    startIndex -= 1;
    usedTokens = nextTokens;
  }

  startIndex = includeToolCallForLeadingTool(messages, startIndex, 1);

  return {
    olderMessages: messages.slice(1, startIndex),
    recentMessages: messages.slice(startIndex),
  };
}

function formatMessageForCompaction(message: ModelMessage, index: number): string {
  return [
    `## message ${index + 1}`,
    `role: ${message.role}`,
    formatJsonForPrompt(message.content),
  ].join("\n");
}

function formatMessagesForCompactionPrompt(messages: ModelMessage[], tokenBudget: number): string {
  const selectedSections: string[] = [];
  let usedTokens = 0;
  let omittedCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    const section = truncateToTokenBudget(formatMessageForCompaction(message, index), 4_000);
    const sectionTokens = estimateTokens(section);

    if (selectedSections.length > 0 && usedTokens + sectionTokens > tokenBudget) {
      omittedCount = index + 1;
      break;
    }

    selectedSections.push(section);
    usedTokens += sectionTokens;
  }

  selectedSections.reverse();

  if (omittedCount > 0) {
    selectedSections.unshift(`[${omittedCount} oldest worker messages omitted from the compaction source because the source exceeded budget]`);
  }

  return selectedSections.join("\n\n");
}

function buildFallbackWorkerSummary(messages: ModelMessage[]): string {
  const tail = messages.slice(-8);
  return [
    "The older worker transcript could not be summarized by the compaction model, so this deterministic checkpoint preserves the latest omitted messages as compressed JSON.",
    formatMessagesForCompactionPrompt(tail, 4_000),
  ].join("\n\n");
}

function fingerprintWorkerMessages(messages: ModelMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex");
}

function cacheWorkerSummary(cache: Map<string, string> | undefined, key: string, summary: string): void {
  if (!cache) {
    return;
  }

  cache.set(key, summary);
  while (cache.size > 4) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    cache.delete(oldestKey);
  }
}

async function summarizeWorkerMessages(
  messages: ModelMessage[],
  options: WorkerContextCompactionOptions,
): Promise<string> {
  const transcript = formatMessagesForCompactionPrompt(
    messages,
    options.maxSummarySourceTokens ?? maxWorkerSummarySourceTokens,
  );

  const result = await generateText({
    model: options.model,
    system: options.compactionPrompt ?? workerContextCompactionPrompt,
    prompt: [
      "Create a checkpoint summary for this older worker transcript segment.",
      "The original task/context and the most recent verbatim messages will remain available separately; summarize only what must survive from this omitted segment.",
      "",
      transcript,
    ].join("\n"),
    maxOutputTokens: maxWorkerCompactionSummaryTokens,
    ...options.requestOptions,
    abortSignal: options.abortSignal,
    experimental_telemetry: createFinnTelemetry({
      functionId: options.compactionFunctionId ?? "worker.context_compact",
      processType: options.processType ?? "worker",
      user: options.user,
      workerId: options.workerId,
      runId: options.runId,
    }),
  });

  const summary = result.text.trim();
  return summary.length > 0 ? summary : buildFallbackWorkerSummary(messages);
}

function buildWorkerContextSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `${workerContextSummaryPrefix}\n\n${truncateToTokenBudget(summary.trim() || "(no summary available)", maxWorkerCompactionSummaryTokens)}`,
  };
}

function trimWorkerHistory(messages: ModelMessage[], maxPromptTokens: number, fixedMessageCount: number): ModelMessage[] {
  if (fixedMessageCount === 0) {
    return [];
  }

  if (estimateModelMessagesTokens(messages) <= maxPromptTokens || messages.length <= fixedMessageCount) {
    return messages;
  }

  const fixedMessages = messages.slice(0, fixedMessageCount);
  const fixedTokens = estimateModelMessagesTokens(fixedMessages);
  const remainingTokens = Math.max(1, maxPromptTokens - fixedTokens);
  let startIndex = messages.length;
  let usedTokens = 0;

  while (startIndex > fixedMessageCount) {
    const message = messages[startIndex - 1];
    if (!message) {
      break;
    }

    const nextTokens = usedTokens + estimateMessageTokens(message);
    if (startIndex < messages.length && nextTokens > remainingTokens) {
      break;
    }

    startIndex -= 1;
    usedTokens = nextTokens;
  }

  startIndex = includeToolCallForLeadingTool(messages, startIndex, fixedMessageCount);
  return [...fixedMessages, ...messages.slice(startIndex)];
}

export async function compactWorkerMessagesWithCheckpoint(
  messages: ModelMessage[],
  options: WorkerContextCompactionOptions,
  onCompactionError: (error: unknown) => void,
): Promise<ModelMessage[]> {
  const imageCompactedMessages = omitConsumedImageToolOutputs(messages);
  const maxPromptTokens = options.maxPromptTokens ?? maxWorkerPromptTokens;
  const toolCompactedMessages = compactWorkerToolOutputs(
    imageCompactedMessages,
    options.maxMessageTokens ?? maxWorkerMessageTokens,
  );

  if (estimateModelMessagesTokens(toolCompactedMessages) <= maxPromptTokens) {
    return toolCompactedMessages;
  }

  const { olderMessages, recentMessages } = splitWorkerMessagesForCompaction(
    toolCompactedMessages,
    options.recentMessageTokens ?? workerRecentMessageTokens,
  );

  if (olderMessages.length === 0) {
    return trimWorkerHistory(compactWorkerMessages(toolCompactedMessages, options), maxPromptTokens, 1);
  }

  const initialMessage = toolCompactedMessages[0];
  if (!initialMessage) {
    return trimWorkerHistory(toolCompactedMessages, maxPromptTokens, 0);
  }

  const summaryCacheKey = fingerprintWorkerMessages(olderMessages);
  let summary = options.summaryCache?.get(summaryCacheKey);

  if (summary === undefined) {
    try {
      summary = await summarizeWorkerMessages(olderMessages, options);
    } catch (error) {
      onCompactionError(error);
      summary = buildFallbackWorkerSummary(olderMessages);
    }

    cacheWorkerSummary(options.summaryCache, summaryCacheKey, summary);
  }

  const compactedHistory = compactWorkerMessages([
    initialMessage,
    buildWorkerContextSummaryMessage(summary),
    ...recentMessages,
  ], options);

  return trimWorkerHistory(compactedHistory, maxPromptTokens, 2);
}

function formatBoundedWorkerSection(label: string, value: string, maxTokens: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const maxChars = Math.max(1, maxTokens) * 4;
  if (trimmed.length <= maxChars) {
    return `${label}:\n${trimmed}`;
  }

  return [
    `${label} (truncated from ${estimateTokens(trimmed)} estimated tokens):`,
    truncate(trimmed, maxChars),
    "[section truncated to keep this worker within its context budget]",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  return formatUnknownError(error);
}

function hasDeliverableResult(result: Record<string, unknown>): boolean {
  const fileIds = result["fileIds"];
  const fileId = result["fileId"];
  const images = result["images"];
  const url = result["url"];

  return (Array.isArray(fileIds) && fileIds.length > 0)
    || (typeof fileId === "string" && fileId.length > 0)
    || (Array.isArray(images) && images.length > 0)
    || (typeof url === "string" && url.length > 0);
}

function getImplicitOutcomeFromWorkspaceResult(result: Record<string, unknown>): WorkerResult | null {
  if (result["success"] !== true || !isRecord(result["result"])) {
    return null;
  }

  const workspaceOutput = result["result"];
  const error = workspaceOutput["error"];
  if (typeof error === "string" && error.length > 0) {
    return null;
  }
  if (!hasDeliverableResult(workspaceOutput)) {
    return null;
  }

  return {
    summary: "Completed via workspace_execute.",
    data: workspaceOutput,
  };
}

export function getImplicitOutcomeFromToolResults(toolResults: unknown[]): WorkerResult | null {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const toolResult = toolResults[index] as ToolResultLike;
    if (!toolResult || toolResult.toolName === "set_status") {
      continue;
    }

    const result = toolResult.result;
    if (!isRecord(result)) {
      continue;
    }

    const error = result["error"];
    if (typeof error === "string" && error.length > 0) {
      continue;
    }

    const workspaceOutcome = getImplicitOutcomeFromWorkspaceResult(result);
    if (workspaceOutcome) {
      return workspaceOutcome;
    }

  }

  return null;
}

function hasFailedStatusReport(toolResults: unknown[]): boolean {
  return toolResults.some((toolResult) => {
    if (!isRecord(toolResult) || toolResult["toolName"] !== "set_status") {
      return false;
    }

    const result = toolResult["result"];
    return isRecord(result) && result["ok"] === false;
  });
}

export function createOutcomeRecorder(
  onOutcome: (outcome: WorkerResult) => Promise<void> | void,
  options: {
    requirePatternOutcome?: boolean;
    onPatternNotifyOutcome?: (outcome: PatternNotifyOutcome) => Promise<void> | void;
  } = {},
): (detail: z.infer<typeof outcomeDetailSchema> | z.infer<typeof patternOutcomeDetailSchema>) => Promise<void> {
  let outcomeReported = false;

  return async (detail) => {
    if (outcomeReported) {
      throw new Error("Worker reported multiple terminal outcomes.");
    }

    if (options.requirePatternOutcome && !isPatternOutcomeDetail(detail)) {
      throw new Error("Pattern workers must report notify, summary, and optional reason/data in their terminal outcome.");
    }

    if (isPatternOutcomeDetail(detail)) {
      const patternNotifyOutcome: PatternNotifyOutcome = {
        notify: detail.notify,
        summary: detail.summary,
        reason: detail.reason,
        data: detail.data,
      };
      await options.onPatternNotifyOutcome?.(patternNotifyOutcome);
      await onOutcome(normalizePatternOutcome(detail));
      outcomeReported = true;
      return;
    }

    await onOutcome(normalizeOutcome(detail));
    outcomeReported = true;
  };
}

export type WorkerModel = ReturnType<LLMManager["getModel"]>;
export type WorkerRequestOptions = LLMRequestOptions;
export type WorkerStatusCallback = (
  kind: "working" | "outcome",
  detail: string | WorkerResult | PatternNotifyOutcome,
) => Promise<void> | void;

export interface WorkerAgentOptions {
  task: string;
  context: string;
  currentTime: Date;
  timeZone: string;
  user: UserContext;
  tools?: ToolSet;
  promptAppendix?: string;
  model: WorkerModel;
  requestOptions?: WorkerRequestOptions;
  compactionModel?: WorkerModel;
  compactionRequestOptions?: WorkerRequestOptions;
  workerId?: string;
  onStatus: WorkerStatusCallback;
  maxTurns: number;
  maxToolCalls: number;
  maxPromptTokens?: number;
  forceToolChoice?: boolean;
  workerType?: string;
  source?: "user" | "pattern";
  abortSignal?: AbortSignal;
  onToolCallCountChange?: (toolCallsUsed: number) => Promise<void> | void;
  initialMessages?: WorkerRunMessage[];
  onMessagesChange?: (messages: WorkerRunMessage[]) => Promise<void> | void;
  toolOutputArtifacts?: WorkerToolOutputArtifactStore;
}

export class WorkerAgent {
  private readonly logger = createProcessLogger("worker");
  private readonly tracer = getTracer("worker");
  private readonly task: string;
  private readonly context: string;
  private readonly currentTime: Date;
  private readonly timeZone: string;
  private readonly user: UserContext;
  private readonly baseTools: ToolSet;
  private readonly promptAppendix: string;
  private readonly model: WorkerModel;
  private readonly requestOptions: WorkerRequestOptions;
  private readonly compactionModel: WorkerModel;
  private readonly compactionRequestOptions: WorkerRequestOptions;
  private readonly workerId?: string;
  private readonly onStatus: WorkerStatusCallback;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly maxPromptTokens: number;
  private readonly forceToolChoice: boolean;
  private readonly workerType?: string;
  private readonly source?: "user" | "pattern";
  private readonly abortSignal?: AbortSignal;
  private readonly onToolCallCountChange?: (toolCallsUsed: number) => Promise<void> | void;
  private readonly initialMessages: WorkerRunMessage[];
  private readonly onMessagesChange?: (messages: WorkerRunMessage[]) => Promise<void> | void;
  private readonly toolOutputArtifacts?: WorkerToolOutputArtifactStore;
  private patternNotifyOutcome: PatternNotifyOutcome | null = null;
  private checkpointPersistenceRepairAttempts = 0;

  constructor(options: WorkerAgentOptions) {
    this.task = options.task;
    this.context = options.context;
    this.currentTime = options.currentTime;
    this.timeZone = options.timeZone;
    this.user = options.user;
    this.baseTools = options.tools ?? {};
    this.promptAppendix = options.promptAppendix?.trim() ?? "";
    this.model = options.model;
    this.requestOptions = options.requestOptions ?? {};
    this.compactionModel = options.compactionModel ?? options.model;
    this.compactionRequestOptions = options.compactionRequestOptions ?? options.requestOptions ?? {};
    this.workerId = options.workerId;
    this.onStatus = options.onStatus;
    this.maxTurns = options.maxTurns;
    this.maxToolCalls = options.maxToolCalls;
    this.maxPromptTokens = options.maxPromptTokens ?? maxWorkerPromptTokens;
    this.forceToolChoice = options.forceToolChoice ?? true;
    this.workerType = options.workerType;
    this.source = options.source;
    this.abortSignal = options.abortSignal;
    this.onToolCallCountChange = options.onToolCallCountChange;
    this.initialMessages = options.initialMessages ?? [];
    this.onMessagesChange = options.onMessagesChange;
    this.toolOutputArtifacts = options.toolOutputArtifacts;
  }

  async run(): Promise<WorkerResult> {
    const telemetryContext = createFinnTelemetryContext({
      functionId: "worker.run",
      processType: "worker",
      user: this.user,
      workerId: this.workerId,
      metadata: {
        workerType: this.workerType ?? "general",
        source: this.source ?? "user",
      },
    });

    return await withSpan(this.tracer, "worker.run", {
      "worker.task": this.task.slice(0, 256),
      "worker.maxTurns": this.maxTurns,
      "worker.hasContext": this.context.trim().length > 0,
      "worker.isFollowUp": this.initialMessages.length > 0,
    }, async (span) => {
      let outcome: WorkerResult | null = null;
      let toolCallsUsed = 0;
      const recordOutcome = createOutcomeRecorder(async (nextOutcome) => {
        outcome = nextOutcome;
        if (this.source === "pattern") {
          return;
        }

        await this.onStatus("outcome", this.patternNotifyOutcome ?? nextOutcome);
      }, {
        requirePatternOutcome: this.source === "pattern",
        onPatternNotifyOutcome: async (nextNotifyOutcome) => {
          this.patternNotifyOutcome = nextNotifyOutcome;
          await this.onStatus("outcome", nextNotifyOutcome);
        },
      });

      const tools: ToolSet = {
        ...this.wrapTools(this.baseTools, async () => {
          toolCallsUsed += 1;
          await this.onToolCallCountChange?.(toolCallsUsed);
          if (toolCallsUsed > this.maxToolCalls) {
            throw new Error(`Worker exceeded tool call limit (${this.maxToolCalls}).`);
          }
        }),
        set_status: tool({
          description: "Report worker progress or final outcome",
          inputSchema: setStatusSchema,
          execute: async (input) => {
            try {
              if (input.kind === "working") {
                await this.onStatus("working", input.detail);
                return { ok: true };
              }

              await recordOutcome(input.detail);
              return { ok: true };
            } catch (error) {
              const message = getErrorMessage(error);
              this.logger.warn({
                error,
                workerId: this.workerId,
                statusKind: input.kind,
              }, "worker status report failed; returning repair instruction");
              return {
                ok: false,
                error: message,
                instruction: input.kind === "outcome"
                  ? "Your terminal outcome was not accepted. Correct the issue and call set_status again with compact JSON-safe notify/summary/data."
                  : "Your status update was not accepted. Continue the task and avoid malformed Unicode or oversized raw output in later status details.",
              };
            }
          },
        }),
      };

      let messages: ModelMessage[] = this.initialMessages.length > 0
        ? [
            ...this.initialMessages as ModelMessage[],
            {
              role: "user",
              content: this.buildFollowUpMessageContent(),
            },
          ]
        : [
            {
              role: "user",
              content: this.buildInitialMessageContent(),
            },
          ];

      const summaryCache = new Map<string, string>();

      const compactMessages = async (stepMessages: ModelMessage[]): Promise<ModelMessage[]> => {
        return compactWorkerMessagesWithCheckpoint(
          stepMessages,
          {
            model: this.compactionModel,
            requestOptions: this.compactionRequestOptions,
            maxPromptTokens: this.maxPromptTokens,
            summaryCache,
            user: this.user,
            workerId: this.workerId,
            abortSignal: this.abortSignal,
          },
          (error) => {
            this.logger.warn({ error }, "worker context compaction model failed; using deterministic checkpoint");
          },
        );
      };

      try {
        const stopAfterOneStep: StopCondition<ToolSet> = ({ steps }) => steps.length >= 1;
        const steps: Array<{ toolResults?: unknown[] }> = [];
        let text = "";

        for (let turnIndex = 0; turnIndex < this.maxTurns; turnIndex += 1) {
          this.throwIfAborted();
          if (toolCallsUsed >= this.maxToolCalls) {
            break;
          }

          messages = await compactWorkerLoopMessages({
            messages,
            fixedMessageCount: 1,
            compactMessages,
          });
          messages = await this.persistWorkerMessages(messages, "before_step");

          const result = await generateText({
            model: this.model,
            system: this.buildSystemPrompt(),
            messages,
            tools,
            ...this.requestOptions,
            stopWhen: stopAfterOneStep,
            abortSignal: this.abortSignal,
            experimental_telemetry: createFinnTelemetry({
              functionId: "worker.generate",
              processType: "worker",
              user: this.user,
              workerId: this.workerId,
              metadata: {
                workerType: this.workerType ?? "general",
                source: this.source ?? "user",
              },
            }),
          });

          steps.push(...result.steps);
          this.throwIfAborted();
          text = result.text.trim() || text;
          messages = await buildWorkerResumeCheckpoint({
            baseMessages: messages,
            responseMessages: result.response.messages,
            compactMessages,
          });
          messages = await this.persistWorkerMessages(messages, "after_step");

          if (outcome) {
            span.setAttribute("worker.outcome", "set_status");
            return outcome;
          }

          if ((result.toolCalls ?? []).length === 0) {
            break;
          }
        }

        this.throwIfAborted();
        const finalizationMessages = await compactWorkerLoopMessages({
          messages,
          fixedMessageCount: 1,
          compactMessages,
        });

        let finalizationResult = await generateText({
          model: this.model,
          system: [this.buildSystemPrompt(), workerFinalizationPrompt].join("\n\n"),
          messages: finalizationMessages,
          tools,
          activeTools: ["set_status"],
          ...(this.forceToolChoice ? { toolChoice: "required" as const } : {}),
          ...this.requestOptions,
          abortSignal: this.abortSignal,
          experimental_telemetry: createFinnTelemetry({
            functionId: "worker.finalize",
            processType: "worker",
            user: this.user,
            workerId: this.workerId,
            metadata: {
              workerType: this.workerType ?? "general",
              source: this.source ?? "user",
            },
          }),
        });
        let finalizationCheckpoint = await buildWorkerResumeCheckpoint({
          baseMessages: finalizationMessages,
          responseMessages: finalizationResult.response.messages,
          compactMessages,
        });
        finalizationCheckpoint = await this.persistWorkerMessages(finalizationCheckpoint, "finalization");

        if (!outcome && hasFailedStatusReport(finalizationResult.steps.flatMap((step) => step.toolResults ?? []))) {
          finalizationResult = await generateText({
            model: this.model,
            system: [this.buildSystemPrompt(), workerFinalizationPrompt].join("\n\n"),
            messages: [
              ...finalizationCheckpoint,
              {
                role: "user",
                content: [
                  workerPersistenceRepairPrefix,
                  "Your previous set_status call was rejected by the worker runtime.",
                  "Correct the reported issue now. Call set_status exactly once with a compact JSON-safe outcome. Do not include raw tool output, malformed Unicode, or decorative emoji.",
                ].join("\n\n"),
              },
            ],
            tools,
            activeTools: ["set_status"],
            ...(this.forceToolChoice ? { toolChoice: "required" as const } : {}),
            ...this.requestOptions,
            abortSignal: this.abortSignal,
            experimental_telemetry: createFinnTelemetry({
              functionId: "worker.finalize.repair",
              processType: "worker",
              user: this.user,
              workerId: this.workerId,
              metadata: {
                workerType: this.workerType ?? "general",
                source: this.source ?? "user",
              },
            }),
          });
          finalizationCheckpoint = await buildWorkerResumeCheckpoint({
            baseMessages: finalizationCheckpoint,
            responseMessages: finalizationResult.response.messages,
            compactMessages,
          });
          await this.persistWorkerMessages(finalizationCheckpoint, "finalization_repair");
        }

        if (outcome) {
          span.setAttribute("worker.outcome", "set_status_finalize");
          return outcome;
        }

        const implicitOutcome = getImplicitOutcomeFromToolResults(
          [...steps, ...finalizationResult.steps].flatMap((step) => step.toolResults ?? []),
        );
        const fallbackOutcome = finalizeFallbackWorkerOutcome({
          source: this.source,
          implicitOutcome,
          text: finalizationResult.text.trim() || text,
          maxTurns: this.maxTurns,
        });

        span.setAttribute("worker.outcome", fallbackOutcome.error
          ? this.source === "pattern" ? "missing_pattern_notify_outcome" : "no_output"
          : implicitOutcome ? "implicit_tool_result" : "text");
        return fallbackOutcome;
      } catch (error) {
        const abortMessage = getAbortErrorMessage(error);
        if (abortMessage) {
          span.setAttribute("worker.outcome", "aborted");
          throw error;
        }

        span.setAttribute("worker.outcome", "error");
        this.logger.error({ error, task: this.task }, "worker execution failed");
        const message = error instanceof Error ? error.message : String(error);

        return {
          summary: "Worker execution failed.",
          error: message,
        };
      }
    }, telemetryContext);
  }

  getPatternNotifyOutcome(): PatternNotifyOutcome | null {
    return this.patternNotifyOutcome;
  }

  private async persistWorkerMessages(messages: ModelMessage[], reason: string): Promise<ModelMessage[]> {
    if (!this.onMessagesChange) {
      return messages;
    }

    try {
      await this.onMessagesChange(messages as WorkerRunMessage[]);
      this.checkpointPersistenceRepairAttempts = 0;
      return messages;
    } catch (error) {
      if (getAbortErrorMessage(error)) {
        throw error;
      }

      this.checkpointPersistenceRepairAttempts += 1;
      if (this.checkpointPersistenceRepairAttempts > maxCheckpointPersistenceRepairAttempts) {
        throw error;
      }

      const message = getErrorMessage(error);
      this.logger.warn({
        error,
        workerId: this.workerId,
        reason,
        attempt: this.checkpointPersistenceRepairAttempts,
      }, "worker checkpoint persistence failed; continuing with repair instruction");

      return [
        ...messages,
        {
          role: "user",
          content: [
            workerPersistenceRepairPrefix,
            `The worker runtime could not persist the latest checkpoint (${reason}): ${message}`,
            "Continue from the available context. Avoid malformed Unicode, oversized raw tool output, and raw JSON blobs in future status/outcome data. If you have enough information, call set_status again with a compact JSON-safe result.",
          ].join("\n\n"),
        },
      ];
    }
  }

  private buildSystemPrompt(): string {
    const basePrompt = this.source === "pattern"
      ? this.user.kidsMode ? kidsPatternWorkerPromptTemplate : patternWorkerPromptTemplate
      : this.workerType === "pattern_worker"
        ? this.user.kidsMode ? kidsPatternWorkerPromptTemplate : patternWorkerPromptTemplate
        : this.workerType === "pattern_management"
          ? patternManagementWorkerPromptTemplate
          : this.user.kidsMode ? kidsWorkerPromptTemplate : workerPromptTemplate;
    return [basePrompt, this.promptAppendix]
      .filter((section) => section.trim().length > 0)
      .join("\n\n");
  }

  private buildInitialMessageContent(): string {
    const initialBudget = Math.max(1_000, Math.floor(this.maxPromptTokens * 0.45));
    const taskBudget = Math.min(16_000, Math.max(500, Math.floor(initialBudget * 0.3)));
    const fixedSections = [
      "[runtime context - not from finn or the user]",
      `current time: ${formatRuntimeTimestamp(this.currentTime, this.timeZone)} (${this.timeZone})`,
      formatUserProfileContext(this.user),
      "",
    ];
    const fixedTokens = estimateTokens(fixedSections.join("\n\n"));
    const contextBudget = Math.max(500, initialBudget - fixedTokens - taskBudget);

    return [
      ...fixedSections,
      formatBoundedWorkerSection("Task", this.task, taskBudget),
      formatBoundedWorkerSection("Context", this.context, contextBudget),
    ]
      .filter((section) => section.length > 0)
      .join("\n\n");
  }

  private buildFollowUpMessageContent(): string {
    const context = this.context.trim();
    return [
      "[runtime context - not from finn or the user]",
      `current time: ${formatRuntimeTimestamp(this.currentTime, this.timeZone)} (${this.timeZone})`,
      "This is a follow-up to the same worker run. Use the previous worker transcript below as context, then address the new follow-up task.",
      "",
      formatBoundedWorkerSection("Follow-up task", this.task, 8_000),
      formatBoundedWorkerSection("Follow-up context", context, 8_000),
    ]
      .filter((section) => section.length > 0)
      .join("\n\n");
  }

  private wrapTools(
    tools: ToolSet,
    beforeExecute: () => Promise<void>,
  ): ToolSet {
    const toolsWithWorkerLifecycle = Object.fromEntries(
      Object.entries(tools).map(([name, toolDefinition]) => {
        const { execute } = toolDefinition;
        if (!execute) {
          return [name, toolDefinition];
        }

        return [
          name,
          {
            ...toolDefinition,
            execute: async (...args: Parameters<typeof execute>) => {
              this.throwIfAborted();
              await beforeExecute();
              this.throwIfAborted();

              try {
                const [input, toolOptions] = args;
                return await this.withAbort(Promise.resolve(execute(input, {
                  ...toolOptions,
                  abortSignal: this.abortSignal ?? toolOptions.abortSignal,
                })));
              } catch (error) {
                if (getAbortErrorMessage(error)) {
                  throw error;
                }

                this.logger.warn({ error, toolName: name }, "worker tool call failed");
                return {
                  error: getErrorMessage(error),
                };
              }
            },
          },
        ];
      }),
    );
    return wrapToolsWithOutputArtifacts(toolsWithWorkerLifecycle, this.toolOutputArtifacts);
  }

  private throwIfAborted(): void {
    if (!this.abortSignal?.aborted) {
      return;
    }

    throw this.createAbortError();
  }

  private createAbortError(): Error {
    const reason = this.abortSignal?.reason;
    if (reason instanceof Error && getAbortErrorMessage(reason)) {
      return reason;
    }

    const message = reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Worker cancelled.";
    const error = new Error(message || "Worker cancelled.");
    error.name = "AbortError";
    return error;
  }

  private async withAbort<T>(operation: Promise<T>): Promise<T> {
    const abortSignal = this.abortSignal;
    if (!abortSignal) {
      return operation;
    }

    this.throwIfAborted();

    const activeAbortSignal = abortSignal;
    const worker = this;
    return new Promise<T>((resolve, reject) => {
      function abort(): void {
        reject(worker.createAbortError());
      }
      function cleanupAbort(): void {
        activeAbortSignal.removeEventListener("abort", abort);
      }

      activeAbortSignal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(cleanupAbort);
    });
  }

}
