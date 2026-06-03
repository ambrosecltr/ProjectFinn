import type { ProcessRuntimeServices, ToolRuntimeRequirement } from "@finn/runtime";
import type { z } from "zod";

export type ToolsetProcessType =
  | "hot_path"
  | "worker"
  | "pattern_management"
  | "pattern_worker"
  | "personal_intelligence"
  | "my_day";
export type ToolsetEffect = "read" | "write" | "control";
export type ToolsetCapability = "read" | "write";
export type ToolsetGrant = ToolsetEffect | "all" | readonly ToolsetEffect[];
export type ToolsetGrantMap = Record<string, ToolsetGrant>;

export interface ToolsetConnectorGate {
  toolkitSlug: string;
  enabledTool: string;
}

export interface ToolsetExample {
  code: string;
  purpose: string;
}

export interface ToolsetInstructionGuidance {
  overview?: string[];
  referenceFormats?: string[];
  syntaxRules?: string[];
  workflows?: string[];
  safetyRules?: string[];
  outputGuidance?: string[];
}

export interface ToolsetCommandDefinition {
  name: string;
  description: string;
  effects?: ToolsetEffect[];
  inputSchema: z.ZodType;
  argumentGuidance?: string[];
  examples?: ToolsetExample[];
  outputGuidance?: string[];
}

export interface ToolsetManifest {
  slug: string;
  displayName: string;
  description: string;
  capability: ToolsetCapability;
  effects?: ToolsetEffect[];
  runtimeRequirements?: ToolRuntimeRequirement[];
  processTypes: ToolsetProcessType[];
  connectorGate?: ToolsetConnectorGate;
  instructions?: ToolsetInstructionGuidance;
  commands: ToolsetCommandDefinition[];
  defaultLimit?: number;
  maxLimit?: number;
}

export interface ToolsetSummary {
  slug: string;
  displayName: string;
  description: string;
  capability: ToolsetCapability;
  effects: ToolsetEffect[];
  commands: ToolsetCommandSummary[];
}

export interface ToolsetCommandSummary {
  name: string;
  description: string;
  effects: ToolsetEffect[];
  flags: string[];
}

export interface ToolsetSkill {
  toolset: ToolsetSummary;
  instructions: string;
}

export interface PuterToolsetRecord {
  sourceType: "imessage" | "notes";
  sourceId: string;
  messageId?: string;
  threadId?: string;
  direction?: "sent_by_user" | "received";
  sender?: string;
  senderContact?: PuterContactIdentity;
  recipients: string[];
  recipientContacts?: PuterContactIdentity[];
  title: string;
  timestamp: string;
  content: string;
  attachments?: PuterAttachmentMetadata[];
  sourceUrl?: string;
  metadata: Record<string, unknown>;
}

export interface PuterContactIdentity {
  handle: string;
  displayName: string;
}

export interface PuterAttachmentMetadata {
  attachmentId: number;
  guid?: string;
  filename?: string;
  transferName?: string;
  uti?: string;
  mimeType?: string;
  totalBytes?: number;
  path?: string;
  missing: boolean;
}

export interface ToolsetExecutionContext {
  runtime?: ProcessRuntimeServices;
  connectedAccountId?: string;
  windowStart?: Date;
  windowEnd?: Date;
  excludedHandles?: string[];
  records?: PuterToolsetRecord[];
  abortSignal?: AbortSignal;
  executeCommand?: (input: ToolsetExecuteInput, options?: ToolsetExecutionOptions) => Promise<unknown>;
  cleanup?: () => void | Promise<void>;
}

export interface ToolsetExecutionOptions {
  abortSignal?: AbortSignal;
}

export interface ToolsetExecuteInput {
  toolset: string;
  command: string;
  args: unknown;
}

export interface ToolsetExecuteResult {
  toolset: string;
  command: string;
  result: unknown;
}

export type ToolsetExecutor = (
  args: unknown,
  context: ToolsetExecutionContext,
) => Promise<unknown> | unknown;

export interface ToolsetDefinition {
  manifest: ToolsetManifest;
  loadInstructions?: () => Promise<string>;
  executors: Record<string, ToolsetExecutor>;
}
