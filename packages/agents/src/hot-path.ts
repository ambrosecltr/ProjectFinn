import {
  createFinnTelemetry,
  createFinnTelemetryContext,
  createProcessLogger,
  estimateTokens,
  formatShortTimeZoneName,
  formatInternalMessage,
  getTracer,
  activeToolNamesForCategories,
  normalizeOutgoingAssistantText,
  truncate,
  withSpan,
  type Attachment,
  type AppConfig,
  type EventBus,
  type InboundMessage,
  type MyDayRecord,
  type MyDayTodoRecord,
  type PatternRecord,
  type StatusBlock,
  type UserContext,
  type UserMessage,
  type UserMessagePart,
  type WorkerMessage,
  type WorkerOriginSource,
  type ToolCategory,
} from "@finn/core";
import type { MemoryRuntimeService } from "@finn/runtime";
import type { Database } from "@finn/db";
import type { LLMManager } from "@finn/llm";
import { stepCountIs, streamText, tool, type ModelMessage, type StopCondition, type SystemModelMessage, type ToolSet, type UserModelMessage } from "ai";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";

import {
  HotPathConversationStore,
  formatWorkerDeliveryContent,
} from "./conversation-store.js";
import type { Compactor } from "./compactor.js";
import { escapePromptContentValue, formatPromptEnvelope, startsWithPromptEnvelope } from "./prompt-envelopes.js";
import { buildStatusBlock, formatStatusBlock, StatusCache } from "./status.js";
import { getAttachmentWorkspacePath, toWorkspaceApiPath } from "./workspace-paths.js";
import type { WorkerManager } from "./worker-manager.js";
import { hotPathWorkerCancellationReasons, WorkerFollowUpUnavailableError, type HotPathWorkerCancellationReason } from "./worker-manager.js";

export interface HotPathTurnRecorder {
  recordHotPathTurn(input: {
    message: UserMessage;
    conversationId: string;
    deliveredAssistantText: string;
  }): Promise<void>;
  recordVisibleAssistantMessage?(input: {
    source: "worker" | "trigger";
    sourceMessageId: string;
    conversationId: string;
    deliveredAssistantText: string;
    timestamp: Date;
  }): Promise<void>;
}

export interface HotPathMemoryContextResult {
  text: string;
  type?: string | null;
  occurredAt?: string | null;
}

export interface HotPathMemoryProfileContext {
  static: string[];
  dynamic: string[];
}

export interface HotPathAutoMemoryStatus {
  enabled: boolean;
  clientAvailable: boolean;
  queried: boolean;
  injectedCount: number;
  reason: string;
}

interface HotPathMemorySearchResult {
  summary: string | null;
  content: string | null;
  createdAt: string | null;
  chunks: Array<{
    content: string;
    isRelevant: boolean | null;
  }>;
}

type HotPathMemoryContextResponse =
  | { ok: true; results: HotPathMemoryContextResult[] }
  | { ok: false; results: []; error: string };

export interface HotPathMemoryClient {
  searchDocuments: MemoryRuntimeService["searchDocuments"];
  buildContext?: MemoryRuntimeService["buildContext"];
  buildProfileContext?: MemoryRuntimeService["buildProfileContext"];
}

interface HotPathMemorySearchCompatClient {
  searchDocuments(input: Parameters<MemoryRuntimeService["searchDocuments"]>[0]): Promise<
    | { ok: true; results: HotPathMemorySearchResult[] }
    | { ok: false; results: []; error: string }
  >;
}

type PromptIdentity = {
  finn: string;
};

type ContextParts = {
  identity: PromptIdentity & { user?: string };
  chapterSummary?: string | null;
  memoryProfile?: HotPathMemoryProfileContext | null;
};

type CurrentTurnUserContent = string | Array<
  { type: "text"; text: string }
  | { type: "image"; image: URL | string | Buffer | Uint8Array | ArrayBuffer; mediaType?: string }
>;

type CurrentTurnPart =
  { type: "text"; text: string }
  | { type: "image"; image: URL | string | Buffer | Uint8Array | ArrayBuffer; mediaType?: string };

export type HotPathImagePreparationInput = {
  data: Buffer;
  filename: string;
  mimeType: string;
};

export type PreparedHotPathImage = {
  data: Buffer;
  mimeType: string;
  resizedForModel: boolean;
};

export type PrepareHotPathImageForModelInput = (input: HotPathImagePreparationInput) => Promise<PreparedHotPathImage>;

type CurrentTurnContentOptions = {
  attachmentStorageRoot?: string;
  maxInlineVisionImages?: number;
  prepareImageForModelInput?: PrepareHotPathImageForModelInput;
};

type PromptBudgetParts = {
  systemPrompt: string;
  messages: ModelMessage[];
  fixedTailCount: number;
};

type RuntimeContextParts = {
  currentTime: Date;
  statusBlock: StatusBlock;
  inboundMessage: InboundMessage;
  user: UserContext;
  memoryContext?: HotPathMemoryContextResult[];
};

const emptyAutoMemoryStatus: HotPathAutoMemoryStatus = {
  enabled: false,
  clientAvailable: false,
  queried: false,
  injectedCount: 0,
  reason: "not_started",
};

const maxAutoMemoryResults = 8;
const maxAutoMemoryProfileItems = 8;
const autoMemoryContextTokenBudget = 1000;
const autoMemoryProfileTokenBudget = 600;
export const maxCurrentTurnInlineVisionImages = 3;

export function buildOverlapAckGuidance(parts: Pick<RuntimeContextParts, "statusBlock" | "inboundMessage">): string | null {
  if (parts.inboundMessage.source !== "user" || parts.statusBlock.activeWorkers.length === 0) {
    return null;
  }

  const activeTasks = parts.statusBlock.activeWorkers
    .map((worker) => worker.task.replace(/\s+/g, " ").trim())
    .filter((task, index, tasks) => task.length > 0 && tasks.indexOf(task) === index)
    .slice(0, 3);

  if (activeTasks.length === 0) {
    return null;
  }

  return [
    "There is already user-requested work in flight.",
    ...activeTasks.map((task) => `- active task: ${task}`),
    "",
    "If you acknowledge this new user turn, keep it short. Add only 2-4 words of scope when a plain ack would be ambiguous between overlapping live requests.",
    "A scoped ack is only the message copy. If the new request needs worker help, call delegate in the same tool pass before finish_turn.",
    'Good: send_message("two secs on the weather") + delegate(weather task) + finish_turn while xAI is still running.',
    'Bad: send_message("two secs on the weather") + finish_turn with no delegate.',
    'Bad: repeating the whole request or adding extra scope when a plain "on it" is already clear.',
  ].join("\n");
}

function formatPatternSetupNextRun(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatRuntimeTimestamp(date, timeZone);
}

export function buildPatternSetupConfirmationGuidance(result: WorkerMessage["result"], timeZone: string): string | null {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return null;
  }

  const data = result.data as Record<string, unknown>;
  if (data["type"] !== "pattern_setup") {
    return null;
  }

  const nextRun = formatPatternSetupNextRun(data["nextRun"], timeZone);
  const patternName = typeof data["patternName"] === "string" && data["patternName"].trim().length > 0
    ? data["patternName"].trim()
    : null;
  const triggerType = typeof data["triggerType"] === "string" && data["triggerType"].trim().length > 0
    ? data["triggerType"].trim()
    : null;
  const nextRunGuidance = nextRun
    ? `Persisted next run: ${nextRun} (${timeZone})`
    : triggerType === "composio"
      ? "This is toolkit/event-triggered; do not claim a scheduled next run time. Say it will run when the trigger fires."
      : "No persisted next run is available; do not claim a next run time.";

  return [
    "Use the worker's persisted Pattern details for any schedule claim.",
    patternName ? `Pattern name: ${patternName}` : null,
    triggerType ? `Trigger type: ${triggerType}` : null,
    nextRunGuidance,
    "Do not recalculate or infer the next run from schedule details.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildHotPathUserProfileContext(user: UserContext): string {
  const sections: string[] = [];

  if (user.displayName?.trim()) {
    sections.push(`name: ${user.displayName.trim()}`);
  }

  if (user.timezone.trim()) {
    sections.push(`timezone: ${user.timezone.trim()}`);
  }

  if (user.location?.trim()) {
    sections.push(`location: ${user.location.trim()}`);
  }

  if (user.phoneNumber.trim()) {
    sections.push(`mobile: ${user.phoneNumber.trim()}`);
  }

  return sections.join("\n");
}

export function buildNaturalOnboardingContext(user: UserContext): string {
  if (user.displayName?.trim()) {
    return "";
  }

  return [
    "The user's name is not set yet. If it fits naturally, learn what they want to be called without making this feel like onboarding or a questionnaire.",
    "Keep helping with the user's actual request first. Ask at most one light contextual question, and do not repeatedly ask if they ignore or decline it.",
    "If the user explicitly states their name, call update_user_profile silently before or alongside the normal reply.",
  ].join("\n");
}

export function assembleSystemPrompt(parts: ContextParts): string {
  return parts.identity.finn.trim();
}

export function assembleDynamicPromptContext(parts: ContextParts): string {
  const sections: string[] = [];

  if (parts.identity.user?.trim()) {
    sections.push(formatPromptEnvelope("user_profile", {}, parts.identity.user, { escapeContent: true }));
  }

  if (parts.memoryProfile && (parts.memoryProfile.static.length > 0 || parts.memoryProfile.dynamic.length > 0)) {
    sections.push(formatMemoryProfileContextBlock(parts.memoryProfile));
  }

  if (parts.chapterSummary && parts.chapterSummary.trim().length > 0) {
    sections.push(formatPromptEnvelope(
      "chapter_summary",
      {},
      parts.chapterSummary,
      { escapeContent: true },
    ));
  }

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

export function formatMemoryProfileContextBlock(profile: HotPathMemoryProfileContext): string {
  const lines = [
    "Provider-maintained user profile:",
    "These profile facts are automatically extracted from prior user interactions and connected source context. They may be incomplete or stale; use only when relevant and do not mention memory mechanics.",
  ];

  const staticFacts = profile.static.slice(0, maxAutoMemoryProfileItems);
  if (staticFacts.length > 0) {
    lines.push("", "Static facts:");
    for (const fact of staticFacts) {
      lines.push(`- ${fact}`);
    }
  }

  const dynamicFacts = profile.dynamic.slice(0, maxAutoMemoryProfileItems);
  if (dynamicFacts.length > 0) {
    lines.push("", "Current context:");
    for (const fact of dynamicFacts) {
      lines.push(`- ${fact}`);
    }
  }

  return formatPromptEnvelope(
    "memory_profile",
    {},
    truncateTextToTokens(lines.join("\n"), autoMemoryProfileTokenBudget),
    { escapeContent: true },
  );
}

export function buildRuntimeContextMessage(
  parts: RuntimeContextParts,
  timeZone: string,
): string {
  const runtimeLines = [
    `current time: ${formatRuntimeTimestamp(parts.currentTime, timeZone)} (${timeZone})`,
  ];
  const sections: string[] = [];

  if (parts.inboundMessage.source === "user") {
    const onboardingContext = buildNaturalOnboardingContext(parts.user);
    if (onboardingContext) {
      sections.push(formatPromptEnvelope(
        "turn_guidance",
        { kind: "natural_profile_completion" },
        onboardingContext,
        { escapeContent: true },
      ));
    }
  }

  if (parts.inboundMessage.source === "worker") {
    runtimeLines.push(`worker id: ${parts.inboundMessage.workerId}`);
    if (parts.inboundMessage.originSource) {
      runtimeLines.push(`worker origin: ${parts.inboundMessage.originSource}`);
    }
    if (parts.inboundMessage.originMessageId) {
      runtimeLines.push(`origin message: ${parts.inboundMessage.originMessageId}`);
    }
    const patternSetupGuidance = buildPatternSetupConfirmationGuidance(parts.inboundMessage.result, timeZone);
    if (patternSetupGuidance) {
      sections.push(formatPromptEnvelope(
        "turn_guidance",
        { kind: "pattern_setup_confirmation" },
        patternSetupGuidance,
        { escapeContent: true },
      ));
    }
  }

  sections.unshift(formatPromptEnvelope(
    "runtime_context",
    { source: parts.inboundMessage.source },
    runtimeLines.join("\n"),
    { escapeContent: true },
  ));

  if (parts.memoryContext && parts.memoryContext.length > 0) {
    sections.push(formatMemoryContextBlock(parts.memoryContext));
  }

  if (
    parts.statusBlock.activeWorkers.length > 0
    || parts.statusBlock.followUpWorkers.length > 0
    || parts.statusBlock.activePatterns > 0
  ) {
    sections.push(formatPromptEnvelope("runtime_status", {}, formatStatusBlock(parts.statusBlock), { escapeContent: false }));
  }

  const overlapGuidance = buildOverlapAckGuidance(parts);
  if (overlapGuidance) {
    sections.push(formatPromptEnvelope("turn_guidance", { kind: "overlap" }, overlapGuidance, { escapeContent: true }));
  }

  sections.push(buildTrailingTurnRules());

  return sections.join("\n\n");
}

export function formatMemoryContextBlock(results: HotPathMemoryContextResult[]): string {
  const lines = [
    "Auto-injected semantic memory:",
    "These semantic recall results for the current turn may be incomplete, noisy, or irrelevant. Use only facts that are directly relevant and supported here.",
    "If a core user fact is needed but absent or uncertain, use the memory tool when available; otherwise avoid the specific claim. Do not mention memory mechanics.",
  ];

  for (const result of results.slice(0, maxAutoMemoryResults)) {
    const label = [result.type, result.occurredAt].filter((value): value is string => Boolean(value)).join(" | ");
    lines.push(label ? `- ${result.text} (${label})` : `- ${result.text}`);
  }

  return formatPromptEnvelope(
    "semantic_memory",
    {},
    truncateTextToTokens(lines.join("\n"), autoMemoryContextTokenBudget),
    { escapeContent: true },
  );
}

export function buildTrailingTurnRules(): string {
  return formatPromptEnvelope("turn_rules", {}, [
    "Only human_message envelopes are user-authored. Runtime context, status, memory, worker results, triggers, and tool results are internal context, not new user messages.",
    "User-visible output must use send_message, send_media, display_draft, or react. Finish with finish_turn after all needed tools are called.",
    "Multiple user-visible delivery calls are allowed when they belong to the same response. Tool results from delivery calls are outbound receipts, not new user messages.",
    "For specific personal facts that are not explicit in the current human message, user profile, or current conversation, use memory tools when available; otherwise avoid the claim.",
    "Temporal awareness: weigh the current time, message timestamps, and elapsed time when reasoning. Information checked hours ago is not current — don't present stale data as fresh. If your last check on something was this morning and it's now evening, re-check or acknowledge you haven't looked recently. A friend doesn't say 'nothing new' based on old data.",
  ].join("\n"));
}

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

export interface MessageSender {
  sendText(text: string, options?: { replyToMessageHandle?: string }): Promise<unknown> | unknown;
  sendMedia(fileId: string, caption?: string): Promise<void> | void;
  sendVoiceMessage(fileId: string, options?: { replyToMessageHandle?: string }): Promise<unknown> | unknown;
  sendReaction(handle: string, type: string): Promise<void> | void;
  sendTypingIndicator(): Promise<void> | void;
  startTyping?(): Promise<void> | void;
  stopTyping?(): Promise<void> | void;
  markRead(): Promise<void> | void;
}

export type { ToolSet };

type SendMessageSummary = {
  text: string;
  replyToMessageHandle?: string;
  messageIds: string[];
};

function formatAttachmentDetails(messageId: string, attachments?: UserMessage["attachments"]): string[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  return attachments.map((attachment) => formatAttachmentElement(attachment, { sourceMessageHandle: messageId }));
}

function getMessageModality(part: Pick<UserMessagePart, "content" | "attachments">): string {
  const modalities = new Set<string>();

  if (part.content.trim().length > 0) {
    modalities.add("text");
  }

  for (const attachment of part.attachments ?? []) {
    if (attachment.mimeType.startsWith("audio/")) {
      if (attachment.contextText && !attachment.contextText.trim().startsWith("[")) {
        modalities.add(attachment.audioKind === "voice_note" ? "transcribed_voice" : "transcribed_audio");
      } else {
        modalities.add(attachment.audioKind === "voice_note" ? "voice_message" : "audio");
      }
    } else if (attachment.mimeType.startsWith("image/")) {
      modalities.add("image");
    } else if (attachment.mimeType.startsWith("video/")) {
      modalities.add("video");
    } else {
      modalities.add("file");
    }
  }

  return modalities.size > 0 ? [...modalities].join(",") : "empty";
}

function formatXmlTextElement(tag: string, value: string): string {
  return `<${tag}>${escapePromptContentValue(value)}</${tag}>`;
}

function formatXmlBlockElement(tag: string, value: string): string {
  return `<${tag}>\n${escapePromptContentValue(value)}\n</${tag}>`;
}

function formatAttachmentElement(attachment: Attachment, options: { sourceMessageHandle?: string } = {}): string {
  const workspacePath = getAttachmentWorkspacePath(attachment);
  const workspaceApiPath = workspacePath ? toWorkspaceApiPath(workspacePath) : null;
  const lines = [
    attachment.contextText ? formatXmlBlockElement("context", attachment.contextText) : null,
    workspaceApiPath ? formatXmlTextElement("workspace_path", workspaceApiPath) : null,
  ];

  return formatPromptEnvelope(
    "attachment",
    {
      source_message_handle: options.sourceMessageHandle,
      filename: attachment.filename,
      mime_type: attachment.mimeType,
      audio_kind: attachment.audioKind,
      file_id: attachment.fileId,
    },
    lines.filter((line): line is string => Boolean(line)).join("\n"),
  );
}

function formatHumanMessagePart(
  part: Pick<UserMessagePart, "content" | "messageId" | "replyToMessageId" | "timestamp" | "attachments">,
  timeZone: string,
): string {
  const hasAttachments = Boolean(part.attachments?.length);
  const content = [
    part.content.trim().length > 0 ? formatPromptEnvelope("text", {}, part.content, { escapeContent: true }) : null,
    ...(part.attachments ?? []).map((attachment) => formatAttachmentElement(attachment)),
    hasAttachments
      ? formatPromptEnvelope(
          "attachment_usage",
          {},
          "Use file ids and `/workspace/...` paths when delegating work on the user's media.",
          { escapeContent: true },
        )
      : null,
  ].filter((line): line is string => Boolean(line)).join("\n");

  return formatPromptEnvelope(
    "message",
    {
      handle: part.messageId,
      timestamp: formatRuntimeTimestamp(part.timestamp, timeZone),
      reply_to: part.replyToMessageId,
      modality: getMessageModality(part),
    },
    content,
  );
}

function formatHumanMessageEnvelope(
  parts: Array<Pick<UserMessagePart, "content" | "messageId" | "replyToMessageId" | "timestamp" | "attachments">>,
  timeZone: string,
): string {
  return formatPromptEnvelope(
    "human_message",
    { source: "user" },
    parts.map((part) => formatHumanMessagePart(part, timeZone)).join("\n"),
  );
}

export async function toCurrentTurnMessageContent(message: UserMessage, timeZone: string, options: CurrentTurnContentOptions = {}): Promise<CurrentTurnUserContent> {
  const parts = message.parts ?? [{
    content: message.content,
    attachments: message.attachments,
    messageId: message.messageId,
    replyToMessageId: message.replyToMessageId,
    timestamp: message.timestamp,
  }];

  const content: CurrentTurnPart[] = [];
  const maxInlineVisionImages = Math.max(
    0,
    Math.floor(options.maxInlineVisionImages ?? maxCurrentTurnInlineVisionImages),
  );
  let inlineVisionImages = 0;

  const humanMessageEnvelope = formatHumanMessageEnvelope(parts, timeZone);
  if (humanMessageEnvelope.length > 0) {
    content.push({ type: "text", text: humanMessageEnvelope });
  }

  for (const part of parts) {
    for (const attachment of part.attachments ?? []) {
      const mediaPart = await toMediaPart(attachment, part.messageId, options, {
        canInlineImage: inlineVisionImages < maxInlineVisionImages,
        inlineImageLimit: maxInlineVisionImages,
      });
      if (mediaPart) {
        content.push(mediaPart);
        if (mediaPart.type === "image") {
          inlineVisionImages += 1;
        }
      }
    }
  }

  return content.length > 0 ? content : message.content;
}

async function resolveAllowedAttachmentStoragePath(storagePath: string, storageRoot?: string): Promise<string | null> {
  if (!storageRoot || !storagePath || !isAbsolute(storagePath)) {
    return null;
  }

  try {
    const [realRoot, realPath] = await Promise.all([
      realpath(storageRoot),
      realpath(storagePath),
    ]);
    const relativePath = relative(realRoot, realPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return null;
    }
    return realPath;
  } catch {
    return null;
  }
}

async function loadAttachmentImageBytes(attachment: Attachment, options: CurrentTurnContentOptions): Promise<Buffer | null> {
  if (attachment.data) {
    return Buffer.from(attachment.data);
  }

  if (attachment.storagePath) {
    const safePath = await resolveAllowedAttachmentStoragePath(attachment.storagePath, options.attachmentStorageRoot);
    if (!safePath) {
      return null;
    }

    try {
      return Buffer.from(await readFile(safePath));
    } catch {
      return null;
    }
  }

  return null;
}

function formatImageAttachmentContext(
  attachment: Attachment,
  messageId: string,
  reason: string,
): { type: "text"; text: string } {
  return {
    type: "text",
    text: formatPromptEnvelope(
      "attachment_context",
      { message_handle: messageId, kind: "image" },
      [
        formatAttachmentElement(attachment, { sourceMessageHandle: messageId }),
        formatXmlBlockElement("reason", reason),
      ].filter((line): line is string => Boolean(line)).join("\n"),
    ),
  };
}

async function toMediaPart(
  attachment: Attachment,
  messageId: string,
  options: CurrentTurnContentOptions,
  limits: { canInlineImage: boolean; inlineImageLimit: number },
): Promise<{ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType: string } | null> {
  if (attachment.mimeType.startsWith("image/")) {
    if (!limits.canInlineImage) {
      return formatImageAttachmentContext(
        attachment,
        messageId,
        `image omitted from inline vision input because this turn already included ${limits.inlineImageLimit} image${limits.inlineImageLimit === 1 ? "" : "s"}. Use the file id/path directly or delegate if this image needs inspection.`,
      );
    }

    const image = await loadAttachmentImageBytes(attachment, options);
    if (!image) {
      return formatImageAttachmentContext(
        attachment,
        messageId,
        "image bytes could not be loaded for inline vision input.",
      );
    }

    try {
      const prepared = options.prepareImageForModelInput
        ? await options.prepareImageForModelInput({
            data: image,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })
        : { data: image, mimeType: attachment.mimeType, resizedForModel: false };
      return { type: "image", image: prepared.data, mediaType: prepared.mimeType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatImageAttachmentContext(
        attachment,
        messageId,
        `image bytes could not be prepared for inline vision input: ${message}`,
      );
    }
  }

  if (attachment.mimeType.startsWith("video/")) {
    return null;
  }

  return null;
}

function sanitizeBinaryPartsForTokenEstimate(value: unknown): unknown {
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
    return value.map(sanitizeBinaryPartsForTokenEstimate);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "image") {
    return {
      ...record,
      image: "[image bytes]",
    };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, sanitizeBinaryPartsForTokenEstimate(entry)]),
  );
}

function estimatePromptTokens(parts: PromptBudgetParts): number {
  return estimateTokens(JSON.stringify({
    system: parts.systemPrompt,
    messages: sanitizeBinaryPartsForTokenEstimate(parts.messages),
  }));
}

function truncateTextToTokens(text: string, tokenBudget: number): string {
  const maxChars = Math.max(1, tokenBudget) * 4;
  if (text.length <= maxChars) {
    return text;
  }

  return truncate(`${text}\n[content truncated to fit hot-path prompt budget]`, maxChars);
}

function compactCurrentTurnContent(content: CurrentTurnUserContent, tokenBudget: number): CurrentTurnUserContent {
  if (typeof content === "string") {
    return truncateTextToTokens(content, tokenBudget);
  }

  let usedTokens = 0;
  const compacted: CurrentTurnPart[] = [];

  for (const part of content) {
    if (part.type === "image") {
      compacted.push(part);
      continue;
    }

    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens <= 0) {
      break;
    }

    const text = truncateTextToTokens(part.text, remainingTokens);
    compacted.push({ ...part, text });
    usedTokens += estimateTokens(text);
  }

  return compacted.length > 0 ? compacted : "[current turn omitted because it exceeded hot-path prompt budget]";
}

function isProtectedRuntimeContextPart(text: string): boolean {
  return [
    "runtime_context",
    "runtime_status",
    "semantic_memory",
    "turn_guidance",
    "turn_rules",
  ].some((tag) => startsWithPromptEnvelope(text, tag));
}

function compactModelUserContent(content: UserModelMessage["content"], tokenBudget: number): UserModelMessage["content"] {
  if (typeof content === "string") {
    return truncateTextToTokens(content, tokenBudget);
  }

  if (!Array.isArray(content)) {
    return content;
  }

  let remainingTokens = tokenBudget;
  const compacted: typeof content = [];

  for (const part of content) {
    if (part.type !== "text") {
      compacted.push(part);
      continue;
    }

    if (isProtectedRuntimeContextPart(part.text)) {
      compacted.push(part);
      continue;
    }

    if (remainingTokens <= 0) {
      continue;
    }

    const text = truncateTextToTokens(part.text, remainingTokens);
    compacted.push({ ...part, text });
    remainingTokens -= estimateTokens(text);
  }

  return compacted;
}


function wasSent(output: unknown, key: "sent" | "displayed"): boolean {
  return Boolean(output && typeof output === "object" && key in output && (output as Record<string, unknown>)[key] === true);
}

function summarizeSentMedia(stepToolResults: Array<{ toolName: string; input: unknown; output?: unknown }>): string | null {
  const sentMedia = stepToolResults
    .filter((toolResult) => toolResult.toolName === "send_media" && wasSent(toolResult.output, "sent"))
    .map((toolResult) => {
      const input = toolResult.input;
      if (!input || typeof input !== "object") {
        return null;
      }

      const fileId = "fileId" in input && typeof input.fileId === "string" ? input.fileId : null;
      const caption = "caption" in input && typeof input.caption === "string" ? input.caption.trim() : "";
      if (!fileId) {
        return null;
      }

      return caption.length > 0
        ? `[sent media ${fileId}] ${caption}`
        : `[sent media ${fileId}]`;
    })
    .filter((value): value is string => Boolean(value));

  return sentMedia.length > 0 ? sentMedia.join("\n") : null;
}

function getStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getSendMessageIds(output: unknown): string[] {
  if (!output || typeof output !== "object") {
    return [];
  }

  if ("outboundMessageHandles" in output && Array.isArray(output.outboundMessageHandles)) {
    return output.outboundMessageHandles.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  }

  const sendResult = "sendResult" in output ? output.sendResult : output;
  if (!sendResult || typeof sendResult !== "object" || !("messageIds" in sendResult) || !Array.isArray(sendResult.messageIds)) {
    return [];
  }

  return sendResult.messageIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function summarizeSendMessages(stepToolResults: Array<{ toolName: string; input: unknown; output?: unknown }>): SendMessageSummary[] {
  return stepToolResults
    .filter((toolResult) => toolResult.toolName === "send_message")
    .map<SendMessageSummary | null>((toolResult) => {
      const input = toolResult.input;
      if (!input || typeof input !== "object") {
        return null;
      }

      const text = getStringField(input as Record<string, unknown>, "text");
      if (!text) {
        return null;
      }

      const replyToMessageHandle = getStringField(input as Record<string, unknown>, "replyToMessageHandle");
      return {
        text,
        ...(replyToMessageHandle ? { replyToMessageHandle } : {}),
        messageIds: getSendMessageIds(toolResult.output),
      };
    })
    .filter((summary): summary is SendMessageSummary => summary !== null);
}

function formatSendMessageSummaries(messages: SendMessageSummary[]): string {
  return messages
    .map((message) => [
      message.messageIds.length > 0 ? `[handle:${message.messageIds.join(",")}]` : null,
      message.replyToMessageHandle ? `[reply to handle:${message.replyToMessageHandle}]` : null,
      message.text,
    ].filter((line): line is string => Boolean(line)).join("\n"))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function summarizeDisplayDrafts(stepToolResults: Array<{ toolName: string; input: unknown; output?: unknown }>): string {
  return stepToolResults
    .filter((toolResult) => toolResult.toolName === "display_draft" && wasSent(toolResult.output, "displayed"))
    .map((toolResult) => {
      const input = toolResult.input;
      if (!input || typeof input !== "object") {
        return "";
      }

      const body = "body" in input ? input.body : null;
      return typeof body === "string" ? body.trim() : "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

type ReactionSummary = { reaction: string; messageHandle?: string };

function summarizeReactions(stepToolResults: Array<{ toolName: string; input: unknown; output?: unknown }>): ReactionSummary[] {
  return stepToolResults
    .filter((toolResult) => toolResult.toolName === "react" && wasSent(toolResult.output, "sent"))
    .map<ReactionSummary | null>((toolResult) => {
      const input = toolResult.input;
      if (!input || typeof input !== "object") {
        return null;
      }

      const reaction = "reaction" in input && typeof input.reaction === "string" ? input.reaction : null;
      const messageHandle = "messageHandle" in input && typeof input.messageHandle === "string" ? input.messageHandle : undefined;
      if (!reaction) {
        return null;
      }

      return messageHandle ? { reaction, messageHandle } : { reaction };
    })
    .filter((value): value is ReactionSummary => value !== null);
}

function formatReactionSummary(reaction: ReactionSummary): string {
  return reaction.messageHandle
    ? `[tapback: ${reaction.reaction} | target_handle: ${reaction.messageHandle}]`
    : `[tapback: ${reaction.reaction}]`;
}

export function buildVisibleAssistantMemoryTranscript(input: {
  deliveredAssistantText: string;
  sentMediaText: string | null;
  reactions: Array<{ reaction: string; messageHandle?: string }>;
}): string {
  return [
    input.deliveredAssistantText.trim(),
    input.sentMediaText?.trim() ?? "",
    ...input.reactions.map(formatReactionSummary),
  ].filter((text) => text.length > 0).join("\n\n");
}

const userTurnDeliveryToolNames = new Set(["send_message", "send_media", "react", "wait", "display_draft"]);
const finishTurnToolName = "finish_turn";
const silentToolNames = new Set(["reflect_memory", "search_memory", "update_user_profile", "wait", "react"]);

export function userTurnNeedsDeliveryAfterDelegation(stepToolCalls: Array<{ toolName: string }>): boolean {
  return stepToolCalls.some((toolCall) => toolCall.toolName === "delegate")
    && !stepToolCalls.some((toolCall) => userTurnDeliveryToolNames.has(toolCall.toolName));
}

export function finishTurnCanStop(source: InboundMessage["source"], stepToolCalls: Array<{ toolName: string }>): boolean {
  if (!stepToolCalls.some((toolCall) => toolCall.toolName === finishTurnToolName)) {
    return false;
  }

  return source !== "user" || !userTurnNeedsDeliveryAfterDelegation(stepToolCalls);
}

export function finishTurnStopCondition(source: InboundMessage["source"]): StopCondition<ToolSet> {
  return ({ steps }) => finishTurnCanStop(source, steps.at(-1)?.toolCalls ?? []);
}

function hasSilentToolOutcome(toolsUsed: Set<string>): boolean {
  const toolsExcludingFinish = [...toolsUsed].filter((toolName) => toolName !== finishTurnToolName);
  return toolsExcludingFinish.length > 0 && toolsExcludingFinish.every((toolName) => silentToolNames.has(toolName));
}

const delegateParameters = z.object({
  task: z.string().describe("What the worker should do"),
  context: z.string().optional().describe("Additional context for the worker."),
  worker_id: z.string().optional().describe("Existing follow-up enabled worker ID to resume. Only use IDs listed under Follow-up enabled workers in runtime status."),
  worker_type: z.enum(["general", "pattern_management"]).optional().describe("Use pattern_management only for Pattern create/list/update/delete/pause/resume/inspect tasks. Pattern runs use pattern_worker internally and should not be delegated from hot path. Use general for all other delegated work."),
});

const cancelWorkerReasonValues = [...hotPathWorkerCancellationReasons] as [
  HotPathWorkerCancellationReason,
  ...HotPathWorkerCancellationReason[],
];

const cancelWorkerParameters = z.object({
  worker_id: z.string().describe("Active general worker ID from the Active workers runtime status block."),
  reason: z.enum(cancelWorkerReasonValues).describe("Why this active worker is no longer needed."),
});

const allOriginHotPathCategories = [
  "hotpath_delivery",
  "hotpath_turn_control",
  "hotpath_delegate",
  "hotpath_memory",
  "hotpath_file_context",
  "hotpath_pattern_context",
  "hotpath_reminder_read",
  "hotpath_my_day_read",
] as const satisfies readonly ToolCategory[];

const userOnlyHotPathCategories = [
  "hotpath_reactions",
  "hotpath_profile",
  "hotpath_worker_control",
  "hotpath_reminder_write",
  "hotpath_my_day_write",
] as const satisfies readonly ToolCategory[];

const userWorkerCompletionCategories = [
  "hotpath_my_day_completion",
] as const satisfies readonly ToolCategory[];

export function getActiveHotPathToolNames(input: {
  source: InboundMessage["source"];
  scopedTools: ToolSet;
  stepNumber: number;
  forceToolChoice?: boolean;
  previousStepToolCalls?: Array<{ toolName: string }>;
  workerOriginSource?: WorkerMessage["originSource"];
}): string[] | null {
  if (input.forceToolChoice === false) {
    return null;
  }

  if (input.stepNumber > 0 && input.source === "user" && userTurnNeedsDeliveryAfterDelegation(input.previousStepToolCalls ?? [])) {
    return activeToolNamesForCategories(input.scopedTools, ["hotpath_delegation_ack"]);
  }

  if (input.source === "user") {
    return activeToolNamesForCategories(input.scopedTools, [
      ...allOriginHotPathCategories,
      ...userOnlyHotPathCategories,
    ]);
  }

  if (input.source === "worker" || input.source === "trigger") {
    return activeToolNamesForCategories(input.scopedTools, [
      ...allOriginHotPathCategories,
      ...(input.source === "worker" && input.workerOriginSource === "user" ? userWorkerCompletionCategories : []),
    ]);
  }

  return null;
}

export function getActiveHotPathToolNamesForStep(input: {
  source: InboundMessage["source"];
  scopedTools: ToolSet;
  stepNumber: number;
  steps: Array<{ toolCalls?: Array<{ toolName: string }> }>;
  forceToolChoice?: boolean;
  workerOriginSource?: WorkerMessage["originSource"];
}): string[] | null {
  return getActiveHotPathToolNames({
    source: input.source,
    scopedTools: input.scopedTools,
    stepNumber: input.stepNumber,
    forceToolChoice: input.forceToolChoice,
    previousStepToolCalls: input.steps.at(-1)?.toolCalls,
    workerOriginSource: input.workerOriginSource,
  });
}

export type DelegateToolContext = {
  originMessageId?: string;
  originSource?: WorkerOriginSource;
  attachmentContext?: string;
  onDelegated?: (workerId: string) => Promise<void> | void;
};

export interface HotPathTurnTools {
  tools: ToolSet;
  cleanup?: () => void | Promise<void>;
}

export type HotPathTurnToolFactory = (input: {
  message: InboundMessage;
}) => HotPathTurnTools | Promise<HotPathTurnTools>;

export function buildDelegateToolContext(input: {
  message: UserMessage;
  attachmentContext?: string;
  extra?: DelegateToolContext;
}): DelegateToolContext {
  return {
    originMessageId: input.message.messageId,
    originSource: "user",
    attachmentContext: input.attachmentContext,
    ...input.extra,
  };
}

export class HotPathAgent {
  private readonly logger = createProcessLogger("hot-path");
  private readonly tracer = getTracer("hot-path");
  private readonly statusCache?: StatusCache;
  private readonly conversationStore: HotPathConversationStore;
  private processingQueue: Promise<void> = Promise.resolve();
  private tools: ToolSet = {};
  private identityFiles: PromptIdentity = {
    finn: "",
  };

  constructor(
    private readonly deps: {
      llmManager: LLMManager;
      sender: MessageSender;
      db: Database;
      config: AppConfig;
      user: UserContext;
      eventBus: EventBus;
      workerManager?: WorkerManager;
      memory?: HotPathMemoryClient;
      getActivePatternCount?: () => Promise<number>;
      listActivePatterns?: () => Promise<PatternRecord[]>;
      getMyDay?: () => Promise<{ day: MyDayRecord; todos: MyDayTodoRecord[] }>;
      getDelegateToolContext?: (message: UserMessage) => DelegateToolContext | undefined;
      attachmentStorageRoot?: string;
      prepareImageForModelInput?: CurrentTurnContentOptions["prepareImageForModelInput"];
      maxInlineVisionImages?: number;
      createTurnTools?: HotPathTurnToolFactory;
      compactor?: Compactor;
      hotPathTurnRecorder?: HotPathTurnRecorder;
    },
    ) {
    this.conversationStore = new HotPathConversationStore(
      deps.db,
      { userTimezone: deps.config.userTimezone, context: deps.config.context },
      deps.llmManager.getModel("compactor"),
      deps.user,
      (conversationId) => deps.llmManager.getRequestOptions("compactor", conversationId),
    );

    if (deps.workerManager) {
      this.statusCache = new StatusCache(deps.eventBus, deps.user);
    }
  }

  setIdentityFiles(identityFiles: PromptIdentity): void {
    this.identityFiles = identityFiles;
  }

  setTools(tools: ToolSet): void {
    this.tools = tools;
  }

  async handleMessage(message: InboundMessage): Promise<string | null> {
    const telemetryContext = createFinnTelemetryContext({
      functionId: "hot-path.handleMessage",
      processType: "hot-path",
      user: this.deps.user,
      metadata: {
        source: message.source,
        messageId: this.getSourceMessageId(message),
      },
    });
    const run = () => withSpan(this.tracer, "hot-path.handleMessage", {
      "message.source": message.source,
      "message.id": this.getSourceMessageId(message),
    }, async (span) => {
      const source = message.source;
      if (source === "user") {
        void this.markRead();
      }
      await this.startTyping();

      const historyState = await this.conversationStore.hydrateActiveConversation();
      const content = this.toConversationContent(message);
      await this.conversationStore.appendInbound(message, content);

      const statusBlock = await buildStatusBlock({
        workerManager: this.deps.workerManager,
        statusCache: this.statusCache,
        getActivePatternCount: this.deps.getActivePatternCount,
        listActivePatterns: this.deps.listActivePatterns,
        getMyDay: this.deps.getMyDay,
      });
      const [autoMemory, memoryProfile] = await Promise.all([
        this.buildAutoMemoryContext(message),
        this.buildAutoMemoryProfileContext(),
      ]);
      span.setAttribute("memory.auto.enabled", autoMemory.status.enabled);
      span.setAttribute("memory.auto.clientAvailable", autoMemory.status.clientAvailable);
      span.setAttribute("memory.auto.queried", autoMemory.status.queried);
      span.setAttribute("memory.auto.injectedCount", autoMemory.status.injectedCount);
      span.setAttribute("memory.auto.reason", autoMemory.status.reason);
      const { systemPrompt, dynamicContext, runtimeContext } = await this.buildPromptContext(
        statusBlock,
        historyState.chapterSummary,
        message,
        autoMemory.results,
        memoryProfile,
      );
      const currentTurnContent = message.source === "user"
        ? compactCurrentTurnContent(
            await toCurrentTurnMessageContent(message, this.userTimeZone, {
              attachmentStorageRoot: this.deps.attachmentStorageRoot,
              prepareImageForModelInput: this.deps.prepareImageForModelInput,
              maxInlineVisionImages: this.deps.maxInlineVisionImages,
            }),
            this.deps.config.context.currentTurnTokenBudget,
          )
        : truncateTextToTokens(content, this.deps.config.context.currentTurnTokenBudget);
      const conversationHistory = this.fitPromptToBudget({
        systemPrompt,
        messages: [
          ...historyState.messages,
          {
            role: "user",
            content: this.appendRuntimeContextToCurrentTurn(currentTurnContent, runtimeContext),
          },
        ],
        fixedTailCount: 1,
      });
      const attachmentContext = source === "user"
        ? this.toAttachmentContext(message)
        : undefined;
      const baseDelegateContext = source === "user"
        ? buildDelegateToolContext({
            message,
            attachmentContext,
            extra: this.deps.getDelegateToolContext?.(message),
          })
        : undefined;
      const turnTools = this.deps.createTurnTools ? await this.deps.createTurnTools({ message }) : { tools: this.tools };
      try {
        const scopedTools = this.getScopedTools(message, baseDelegateContext, turnTools.tools);
        const stopWhen = [
          finishTurnStopCondition(source),
          stepCountIs(this.deps.config.maxTurns.hotPath),
        ];

        this.logger.info({ source: message.source }, "handling hot-path message");

        const turnStartedAt = Date.now();
        let firstStepStartedAt: number | null = null;
        let firstToolStartedAt: number | null = null;
        let firstSendMessageCompletedAt: number | null = null;

        const result = streamText({
          model: this.deps.llmManager.getModel("hot-path"),
          system: this.buildSystemPrompt(systemPrompt, dynamicContext),
          messages: conversationHistory,
          tools: scopedTools,
          ...this.deps.llmManager.getRequestOptions("hot-path", historyState.conversation.rootConversationId),
          prepareStep: ({ stepNumber, steps }) => {
            const activeToolNames = getActiveHotPathToolNamesForStep({
              source,
              scopedTools,
              stepNumber,
              steps,
              forceToolChoice: this.deps.config.llm.forceToolChoice,
              workerOriginSource: message.source === "worker" ? message.originSource : undefined,
            });
            if (activeToolNames) {
              return {
                toolChoice: "required",
                activeTools: activeToolNames,
              };
            }

            return undefined;
          },
          stopWhen,
          experimental_onStart: () => {
            span.addEvent("hot_path.stream_start", { elapsed_ms: Date.now() - turnStartedAt });
          },
          experimental_onStepStart: ({ stepNumber, activeTools }) => {
            const now = Date.now();
            firstStepStartedAt ??= now;
            span.addEvent("hot_path.step_start", {
              step_number: stepNumber,
              elapsed_ms: now - turnStartedAt,
              active_tools: activeTools?.map(String).join(",") ?? "",
            });
          },
          experimental_onToolCallStart: ({ toolCall, stepNumber }) => {
            const now = Date.now();
            firstToolStartedAt ??= now;
            span.addEvent("hot_path.tool_start", {
              tool_name: toolCall.toolName,
              tool_call_id: toolCall.toolCallId,
              step_number: stepNumber ?? -1,
              elapsed_ms: now - turnStartedAt,
            });
          },
          experimental_onToolCallFinish: ({ toolCall, durationMs, success, error, stepNumber }) => {
            const now = Date.now();
            if (toolCall.toolName === "send_message" && success) {
              firstSendMessageCompletedAt ??= now;
            }
            span.addEvent("hot_path.tool_finish", {
              tool_name: toolCall.toolName,
              tool_call_id: toolCall.toolCallId,
              step_number: stepNumber ?? -1,
              elapsed_ms: now - turnStartedAt,
              duration_ms: durationMs,
              success,
              error: error instanceof Error ? error.message : error ? String(error) : "",
            });
          },
          onStepFinish: ({ stepNumber, finishReason, toolCalls, usage }) => {
            span.addEvent("hot_path.step_finish", {
              step_number: stepNumber,
              elapsed_ms: Date.now() - turnStartedAt,
              finish_reason: finishReason,
              tool_count: toolCalls.length,
              total_tokens: usage.totalTokens ?? 0,
            });
          },
          onFinish: ({ steps, finishReason, totalUsage }) => {
            span.addEvent("hot_path.stream_finish", {
              elapsed_ms: Date.now() - turnStartedAt,
              step_count: steps.length,
              finish_reason: finishReason,
              total_tokens: totalUsage.totalTokens ?? 0,
            });
          },
          onError: ({ error }) => {
            span.addEvent("hot_path.stream_error", {
              elapsed_ms: Date.now() - turnStartedAt,
              error: error instanceof Error ? error.message : String(error),
            });
          },
          experimental_telemetry: createFinnTelemetry({
            functionId: "hot-path.stream",
            processType: "hot-path",
            user: this.deps.user,
            conversationId: historyState.conversation.rootConversationId,
            metadata: {
              source,
              messageId: this.getSourceMessageId(message),
              autoMemoryEnabled: autoMemory.status.enabled,
              autoMemoryClientAvailable: autoMemory.status.clientAvailable,
              autoMemoryQueried: autoMemory.status.queried,
              autoMemoryInjectedCount: autoMemory.status.injectedCount,
              autoMemoryReason: autoMemory.status.reason,
            },
          }),
        });

      await result.consumeStream({
        onError: (error) => {
          this.logger.error({ error, source }, "Hot-path stream error");
        },
      });

      const steps = await result.steps;
      const assistantText = (await result.text).trim();

      const toolsUsed = new Set(
        steps.flatMap((step) => step.toolCalls.map((tc) => tc.toolName)),
      );
      const sendMessageCalled = toolsUsed.has("send_message");
      const sendMediaCalled = toolsUsed.has("send_media");
      const displayDraftCalled = toolsUsed.has("display_draft");
      const stepToolResults = steps.flatMap((step) => step.toolResults);
      const reactionCalls = summarizeReactions(stepToolResults);
      const deliveredText = [
        formatSendMessageSummaries(summarizeSendMessages(stepToolResults)),
        summarizeDisplayDrafts(stepToolResults),
      ].filter((text) => text.trim().length > 0).join("\n\n");
      const normalizedDeliveredText = normalizeOutgoingAssistantText(deliveredText);
      const sentMediaText = summarizeSentMedia(stepToolResults);

      const onlySilentTools = hasSilentToolOutcome(toolsUsed);

      span.setAttribute("response.length", assistantText.length);
      span.setAttribute("response.empty", assistantText.trim().length === 0);
      span.setAttribute("response.sendMessageToolUsed", sendMessageCalled);
      span.setAttribute("response.sendMediaToolUsed", sendMediaCalled);
      span.setAttribute("response.displayDraftToolUsed", displayDraftCalled);
      span.setAttribute("response.toolsUsed", [...toolsUsed].join(","));
      span.setAttribute("response.finishTurnToolUsed", toolsUsed.has(finishTurnToolName));
      span.setAttribute("response.stepCount", steps.length);
      span.setAttribute("timing.totalMs", Date.now() - turnStartedAt);
      if (firstStepStartedAt !== null) {
        span.setAttribute("timing.firstStepStartMs", firstStepStartedAt - turnStartedAt);
      }
      if (firstToolStartedAt !== null) {
        span.setAttribute("timing.firstToolStartMs", firstToolStartedAt - turnStartedAt);
      }
      if (firstSendMessageCompletedAt !== null) {
        span.setAttribute("timing.firstSendMessageCompleteMs", firstSendMessageCompletedAt - turnStartedAt);
      }

      const deliveredAssistantText = normalizedDeliveredText;
      const visibleAssistantMemoryTranscript = buildVisibleAssistantMemoryTranscript({
        deliveredAssistantText,
        sentMediaText,
        reactions: reactionCalls,
      });

      if (!sendMessageCalled && !sendMediaCalled && !displayDraftCalled && !onlySilentTools && assistantText.length > 0) {
        span.setAttribute("response.delivery_failed", true);
        this.logger.warn({ source, toolsUsed: [...toolsUsed] }, "hot-path turn produced text without a delivery tool");
      }

      if (deliveredAssistantText.length > 0) {
        await this.conversationStore.appendAssistant(deliveredAssistantText);
      } else if (sendMediaCalled && sentMediaText) {
        await this.conversationStore.appendAssistant(sentMediaText);
      }

      if (reactionCalls.length > 0) {
        for (const reactionCall of reactionCalls) {
          await this.conversationStore.appendAssistantReaction(reactionCall.reaction, reactionCall.messageHandle);
        }
      }

      if (message.source === "user") {
        void this.deps.hotPathTurnRecorder?.recordHotPathTurn({
          message,
          conversationId: historyState.conversation.id,
          deliveredAssistantText: visibleAssistantMemoryTranscript,
        }).catch((error: unknown) => {
          this.logger.error({
            error,
            operation: "retain_hot_path_turn",
            tenantId: message.tenantId,
            userId: message.userId,
            messageId: message.messageId,
            conversationId: historyState.conversation.id,
          }, "Hot-path memory recording failed");
        });
      } else if (visibleAssistantMemoryTranscript.length > 0) {
        void this.deps.hotPathTurnRecorder?.recordVisibleAssistantMessage?.({
          source: message.source,
          sourceMessageId: this.getSourceMessageId(message),
          conversationId: historyState.conversation.id,
          deliveredAssistantText: visibleAssistantMemoryTranscript,
          timestamp: new Date(),
        }).catch((error: unknown) => {
          this.logger.error({
            error,
            operation: "retain_hot_path_turn",
            tenantId: message.tenantId,
            userId: message.userId,
            messageId: this.getSourceMessageId(message),
            conversationId: historyState.conversation.id,
          }, "Hot-path memory recording failed");
        });
      }

      if (message.source === "worker" && (sendMessageCalled || sendMediaCalled || onlySilentTools)) {
        await this.deps.workerManager?.markCompletionDelivered(message.workerId);
      }

      await this.deps.eventBus.emit({
        type: "hot_path_turn",
        tenantId: this.deps.user.tenantId,
        userId: this.deps.user.userId,
        source: message.source,
        messageId: this.getSourceMessageId(message),
      });

      if (this.deps.compactor) {
        const activeConversationId = historyState.conversation.id;
        this.deps.compactor.checkAndCompact(activeConversationId).catch((error: unknown) => {
          this.logger.error({ error }, "Compactor check failed");
        });
      }

        return deliveredAssistantText.length > 0 ? deliveredAssistantText : null;
      } finally {
        try {
          await turnTools.cleanup?.();
        } catch (error) {
          this.logger.warn({ error }, "Hot-path turn cleanup failed");
        }
      }
    }, telemetryContext).finally(async () => {
      await this.stopTyping();
    });

    const result = this.processingQueue.catch(() => undefined).then(run);
    this.processingQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async buildPromptContext(
    statusBlock: StatusBlock,
    chapterSummary: string | null,
    inboundMessage: InboundMessage,
    memoryContext: HotPathMemoryContextResult[] = [],
    memoryProfile: HotPathMemoryProfileContext | null = null,
  ): Promise<{ systemPrompt: string; dynamicContext: string; runtimeContext: string }> {
    const contextParts = {
      identity: {
        finn: this.identityFiles.finn,
        user: buildHotPathUserProfileContext(this.deps.user),
      },
      chapterSummary,
      memoryProfile,
    };

    return {
      systemPrompt: assembleSystemPrompt(contextParts),
      dynamicContext: assembleDynamicPromptContext(contextParts),
      runtimeContext: this.buildRuntimeContextMessage({
        currentTime: new Date(),
        statusBlock,
        inboundMessage,
        user: this.deps.user,
        memoryContext,
      }),
    };
  }

  private async buildAutoMemoryContext(inboundMessage: InboundMessage): Promise<{
    results: HotPathMemoryContextResult[];
    status: HotPathAutoMemoryStatus;
  }> {
    if (this.deps.config.memory.mode === "tools" || !this.deps.config.capabilities.integrations.memory) {
      return {
        results: [],
        status: {
          ...emptyAutoMemoryStatus,
          enabled: false,
          clientAvailable: Boolean(this.deps.memory),
          reason: this.deps.config.memory.mode === "tools" ? "memory_mode_tools" : "memory_capability_disabled",
        },
      };
    }

    const memory = this.deps.memory;
    if (!memory) {
      return {
        results: [],
        status: {
          ...emptyAutoMemoryStatus,
          enabled: true,
          reason: "memory_client_missing",
        },
      };
    }

    const query = this.buildMemoryContextQuery(inboundMessage);
    if (!query) {
      return {
        results: [],
        status: {
          ...emptyAutoMemoryStatus,
          enabled: true,
          clientAvailable: true,
          reason: "empty_query",
        },
      };
    }

    const input = {
      query: truncateTextToTokens(query, 500),
      limit: this.getAutoMemoryMaxResults(),
      queryTimestamp: this.getMemoryQueryTimestamp(inboundMessage),
      metadata: { kind: "hot_path_turn", source: "hot_path" },
      observability: { operation: "search_memory" as const, messageId: this.getSourceMessageId(inboundMessage) },
    };

    const response = await this.withAutoMemoryTimeout(
      memory.buildContext
        ? memory.buildContext(input)
        : this.buildDefaultMemoryContext(memory, input),
      "semantic recall",
    );

    if (!response) {
      return {
        results: [],
        status: {
          enabled: true,
          clientAvailable: true,
          queried: true,
          injectedCount: 0,
          reason: "timeout_or_exception",
        },
      };
    }

    if (!response.ok) {
      return {
        results: [],
        status: {
          enabled: true,
          clientAvailable: true,
          queried: true,
          injectedCount: 0,
          reason: "provider_error",
        },
      };
    }

    const results = this.compactMemoryContextResults(response.results);
    return {
      results,
      status: {
        enabled: true,
        clientAvailable: true,
        queried: true,
        injectedCount: results.length,
        reason: results.length > 0 ? "injected" : "empty_results",
      },
    };
  }

  private async buildAutoMemoryProfileContext(): Promise<HotPathMemoryProfileContext | null> {
    if (this.deps.config.memory.mode === "tools" || !this.deps.config.capabilities.integrations.memory) {
      return null;
    }

    const memory = this.deps.memory;
    if (!memory?.buildProfileContext) {
      return null;
    }

    const response = await this.withAutoMemoryTimeout(
      memory.buildProfileContext({
        observability: { operation: "build_profile_context" },
      }),
      "profile context",
    );

    if (!response?.ok) {
      return null;
    }

    return this.compactMemoryProfileContext(response.profile);
  }

  private async buildDefaultMemoryContext(
    memory: HotPathMemorySearchCompatClient,
    input: Parameters<MemoryRuntimeService["searchDocuments"]>[0],
  ) {
    const response = await memory.searchDocuments(input);
    if (!response.ok) {
      return response;
    }

    return {
      ok: true as const,
      results: response.results.flatMap((result) => {
        const bestChunk = result.chunks.find((chunk) => chunk.isRelevant !== false) ?? result.chunks[0];
        const text = (bestChunk?.content ?? result.summary ?? result.content)?.trim();
        return text ? [{ text, occurredAt: result.createdAt }] : [];
      }),
    };
  }

  private async withAutoMemoryTimeout<T>(
    response: Promise<T>,
    label: string,
  ): Promise<T | null> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedResponse = await Promise.race<T | null>([
        response,
        new Promise<null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), this.deps.config.memory.autoRecallTimeoutMs);
        }),
      ]);

      if (!timedResponse) {
        this.logger.warn({ timeoutMs: this.deps.config.memory.autoRecallTimeoutMs, label }, "Auto memory context timed out");
      }

      return timedResponse;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ failureReason, label }, "Auto memory context failed");
      return null;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private getAutoMemoryMaxResults(): number {
    return Math.max(1, Math.min(this.deps.config.memory.autoRecallMaxResults, maxAutoMemoryResults));
  }

  private compactMemoryContextResults(results: HotPathMemoryContextResult[]): HotPathMemoryContextResult[] {
    const compacted: HotPathMemoryContextResult[] = [];
    const seen = new Set<string>();
    const maxResults = this.getAutoMemoryMaxResults();

    for (const result of results) {
      const text = result.text.replace(/\s+/g, " ").trim();
      if (!text || seen.has(text.toLowerCase())) {
        continue;
      }

      seen.add(text.toLowerCase());
      compacted.push({
        text: truncateTextToTokens(text, 120),
        ...(result.type ? { type: result.type } : {}),
        ...(result.occurredAt ? { occurredAt: result.occurredAt } : {}),
      });

      if (compacted.length >= maxResults) {
        break;
      }
    }

    return compacted;
  }

  private compactMemoryProfileContext(profile: HotPathMemoryProfileContext): HotPathMemoryProfileContext | null {
    const compacted = {
      static: this.compactMemoryProfileLines(profile.static),
      dynamic: this.compactMemoryProfileLines(profile.dynamic),
    };

    return compacted.static.length > 0 || compacted.dynamic.length > 0 ? compacted : null;
  }

  private compactMemoryProfileLines(lines: string[]): string[] {
    const compacted: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!text || seen.has(text.toLowerCase())) {
        continue;
      }

      seen.add(text.toLowerCase());
      compacted.push(truncateTextToTokens(text, 80));

      if (compacted.length >= maxAutoMemoryProfileItems) {
        break;
      }
    }

    return compacted;
  }

  private buildMemoryContextQuery(inboundMessage: InboundMessage): string | null {
    switch (inboundMessage.source) {
      case "user":
        return this.toUserMemoryContextQuery(inboundMessage);
      case "worker":
        return [inboundMessage.task, inboundMessage.result.summary].filter((value) => value.trim().length > 0).join("\n");
      case "trigger":
        return [inboundMessage.triggerType, JSON.stringify(inboundMessage.details)].join("\n");
    }
  }

  private getMemoryQueryTimestamp(inboundMessage: InboundMessage): string | undefined {
    return inboundMessage.source === "user" ? inboundMessage.timestamp.toISOString() : new Date().toISOString();
  }

  private toUserMemoryContextQuery(message: UserMessage): string {
    const parts = message.parts ?? [{
      content: message.content,
      attachments: message.attachments,
      messageId: message.messageId,
      timestamp: message.timestamp,
    }];

    return parts
      .map((part) => [
        part.content,
        ...formatAttachmentDetails(part.messageId, part.attachments),
      ].filter((line) => line.trim().length > 0).join("\n"))
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  }

  private buildSystemPrompt(systemPrompt: string, dynamicContext: string): string | SystemModelMessage[] {
    if (dynamicContext.trim().length > 0) {
      return [
        { role: "system", content: systemPrompt },
        { role: "system", content: dynamicContext },
      ];
    }

    return systemPrompt;
  }

  private appendRuntimeContextToCurrentTurn(content: CurrentTurnUserContent, runtimeContext: string): CurrentTurnUserContent {
    if (typeof content === "string") {
      return [content, runtimeContext].filter((section) => section.trim().length > 0).join("\n\n");
    }

    return [...content, { type: "text", text: runtimeContext }];
  }

  private toConversationContent(message: InboundMessage): string {
    switch (message.source) {
      case "user": {
        const parts = message.parts ?? [{
          messageId: message.messageId,
          replyToMessageId: message.replyToMessageId,
          content: message.content,
          attachments: message.attachments,
          timestamp: message.timestamp,
        }];

        return formatHumanMessageEnvelope(parts, this.userTimeZone);
      }
      case "worker":
        return formatPromptEnvelope(
          "worker_result",
          { worker_id: message.workerId, origin: message.originSource },
          formatWorkerDeliveryContent(message),
          { escapeContent: true },
        );
      case "trigger":
        return formatPromptEnvelope(
          "trigger_event",
          { trigger_id: message.triggerId, trigger_type: message.triggerType },
          formatInternalMessage("trigger", {
            triggerType: message.triggerType,
            details: message.details,
          }),
          { escapeContent: true },
        );
    }
  }

  private async markRead(): Promise<void> {
    try {
      await this.deps.sender.markRead();
    } catch (error) {
      this.logger.warn({ error }, "Failed to mark inbound message as read");
    }
  }

  private async sendTypingIndicator(): Promise<void> {
    await this.startTyping();
  }

  private async startTyping(): Promise<void> {
    try {
      if (this.deps.sender.startTyping) {
        await this.deps.sender.startTyping();
        return;
      }

      await this.deps.sender.sendTypingIndicator();
    } catch (error) {
      this.logger.warn({ error }, "Failed to start typing indicator");
    }
  }

  private async stopTyping(): Promise<void> {
    try {
      await this.deps.sender.stopTyping?.();
    } catch (error) {
      this.logger.warn({ error }, "Failed to stop typing indicator");
    }
  }

  private getSourceMessageId(message: InboundMessage): string {
    if (message.source === "user") {
      return message.messageId;
    }

    switch (message.source) {
      case "worker":
        return message.workerId;
      case "trigger":
        return message.triggerId;
    }
  }

  private getScopedTools(message: InboundMessage, delegateContext?: DelegateToolContext, tools: ToolSet = this.tools): ToolSet {
    if (!this.deps.workerManager) {
      return tools;
    }

    const scopedTools: ToolSet = {
      ...tools,
      delegate: this.createUserScopedDelegateTool(message.source === "user"
        ? delegateContext
        : {
            originMessageId: this.getSourceMessageId(message),
            originSource: message.source === "worker" ? message.originSource ?? "trigger" : "trigger",
          }),
    };

    if (message.source === "user") {
      scopedTools.cancel_worker = this.createCancelWorkerTool();
    }

    return scopedTools;
  }

  private fitPromptToBudget(parts: PromptBudgetParts): ModelMessage[] {
    const maxPromptTokens = Math.max(1, this.deps.config.context.maxTokens - this.deps.config.context.compactionBufferTokens);
    let messages = parts.messages;
    const fixedTailCount = Math.max(1, Math.min(parts.fixedTailCount, messages.length));

    while (messages.length > fixedTailCount && estimatePromptTokens({ ...parts, messages }) > maxPromptTokens) {
      messages = messages.slice(1);
    }

    if (estimatePromptTokens({ ...parts, messages }) <= maxPromptTokens || messages.length < fixedTailCount) {
      return messages;
    }

    const currentTurnIndex = messages.length - fixedTailCount;
    const currentTurnMessage = messages[currentTurnIndex];
    if (!currentTurnMessage || currentTurnMessage.role !== "user") {
      return messages;
    }

    return messages.map((message, index) => index === currentTurnIndex
      ? {
          ...currentTurnMessage,
          content: compactModelUserContent(currentTurnMessage.content, this.deps.config.context.currentTurnTokenBudget),
        }
      : message);
  }

  private createUserScopedDelegateTool(delegateContext?: DelegateToolContext): ToolSet[string] {
    return tool({
      description:
        "Delegate background work for this user turn. Use this for explicit requests that need work after a short ack, or for quick conversational fact checks before you reply. If you tell the user you are checking or working on something, call this before finish_turn.",
      inputSchema: delegateParameters,
      execute: async ({ task, context, worker_id, worker_type }, options) => {
        void options;

        if (!this.deps.workerManager) {
          throw new Error("Worker manager is not configured.");
        }

        const parentConversationId = await this.conversationStore.getActiveConversationId();
        const workerContext = [
          context?.trim(),
          delegateContext?.attachmentContext,
        ]
          .filter((value): value is string => Boolean(value && value.length > 0))
          .join("\n\n");

        try {
          const workerId = await this.deps.workerManager.spawn({
            tenantId: this.deps.user.tenantId,
            userId: this.deps.user.userId,
            task,
            workerId: worker_id,
            type: worker_type ?? "general",
            context: workerContext.length > 0 ? workerContext : undefined,
            parentConversationId,
            source: "user",
            originSource: delegateContext?.originSource ?? "user",
            originMessageId: delegateContext?.originMessageId,
          });
          await delegateContext?.onDelegated?.(workerId);

          return {
            delegated: true,
            resumed: Boolean(worker_id),
            workerId,
            task,
          };
        } catch (error) {
          if (error instanceof WorkerFollowUpUnavailableError) {
            return {
              delegated: false,
              workerId: worker_id,
              error: error.message,
              instruction: "That worker is no longer available. Call delegate again without worker_id to start a fresh worker.",
            };
          }

          throw error;
        }
      },
    });
  }

  private createCancelWorkerTool(): ToolSet[string] {
    return tool({
      description:
        "Cancel an active general background worker for this user. Use only when the user explicitly cancelled, corrected, or superseded that worker's task, or when your prior delegation clearly used the wrong directive. Never use this for Pattern management, Pattern runs, Personal Intelligence, My Day refreshes, or unrelated overlapping work. If replacing the task, call delegate with the corrected task in the same pass before finish_turn.",
      inputSchema: cancelWorkerParameters,
      execute: async ({ worker_id, reason }, options) => {
        void options;

        if (!this.deps.workerManager) {
          throw new Error("Worker manager is not configured.");
        }

        return this.deps.workerManager.cancelHotPathWorker(worker_id, reason);
      },
    });
  }

  private toAttachmentContext(message: UserMessage): string | undefined {
    const parts = message.parts ?? [{
      content: message.content,
      attachments: message.attachments,
      messageId: message.messageId,
      timestamp: message.timestamp,
    }];

    const attachmentBlocks = parts.flatMap((part) => formatAttachmentDetails(part.messageId, part.attachments));
    if (attachmentBlocks.length === 0) {
      return undefined;
    }

    return formatPromptEnvelope(
      "current_turn_attachments",
      {},
      [
        ...attachmentBlocks,
        formatPromptEnvelope(
          "attachment_usage",
          {},
          "Use these file ids directly for media editing tools when the task refers to the user's attached media.",
          { escapeContent: true },
        ),
      ].join("\n"),
    );
  }

  private buildRuntimeContextMessage(parts: RuntimeContextParts): string {
    return buildRuntimeContextMessage(parts, this.userTimeZone);
  }

  private get userTimeZone(): string {
    return this.deps.user.timezone || this.deps.config.userTimezone;
  }
}
