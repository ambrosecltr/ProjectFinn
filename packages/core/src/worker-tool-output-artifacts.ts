import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { estimateTokens, truncate } from "./utils.js";

const defaultMaxInlineChars = 32_000;
const defaultPreviewChars = 4_000;
const maxRetainedFieldChars = 8_000;
const retainedToolResultKeys = [
  "success",
  "ok",
  "error",
  "fileId",
  "fileIds",
  "url",
  "urls",
  "images",
  "imageUrl",
  "imageUrls",
  "videoUrl",
  "videoUrls",
  "path",
  "paths",
  "filename",
  "mimeType",
  "sizeBytes",
  "truncated",
  "original_token_count",
] as const;

export interface WorkerToolOutputArtifact {
  path: string;
  absolutePath: string;
  toolName: string;
  sizeBytes: number;
  originalChars: number;
  estimatedTokens: number;
  preview: string;
}

export interface WorkerToolOutputArtifactStoreOptions {
  workspaceRoot: string;
  artifactsRoot?: string;
  runId?: string;
  maxInlineChars?: number;
  previewChars?: number;
}

export interface WriteWorkerToolOutputArtifactOptions {
  extension?: string;
}

type SerializedToolOutput = {
  text: string;
  extension: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "tool-output";
}

function normalizeExtension(extension: string | undefined): string {
  const sanitized = (extension ?? "txt").replace(/[^\w]+/g, "").toLowerCase();
  return sanitized.length > 0 ? sanitized : "txt";
}

function serializeToolOutput(value: unknown): SerializedToolOutput {
  if (typeof value === "string") {
    return { text: value, extension: "txt" };
  }

  try {
    return {
      text: JSON.stringify(value, null, 2) ?? String(value),
      extension: "json",
    };
  } catch {
    return {
      text: String(value),
      extension: "txt",
    };
  }
}

function serializedLength(value: unknown): number {
  return serializeToolOutput(value).text.length;
}

function pickRetainedFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const retained: Record<string, unknown> = {};
  for (const key of retainedToolResultKeys) {
    if (!(key in value)) {
      continue;
    }

    const field = value[key];
    if (serializedLength(field) <= maxRetainedFieldChars) {
      retained[key] = field;
    }
  }

  return retained;
}

function hasExistingFullOutputPath(value: unknown): boolean {
  return isRecord(value)
    && typeof value["full_output_path"] === "string"
    && value["full_output_path"].length > 0;
}

export class WorkerToolOutputArtifactStore {
  private readonly artifactsRoot: string;
  readonly runDirectory: string;
  private readonly maxInlineChars: number;
  private readonly previewChars: number;

  constructor(options: WorkerToolOutputArtifactStoreOptions) {
    const runId = sanitizePathSegment(options.runId ?? randomUUID());
    this.artifactsRoot = options.artifactsRoot ?? join(options.workspaceRoot, "tmp", "tool-outputs");
    this.runDirectory = join(this.artifactsRoot, runId);
    this.maxInlineChars = options.maxInlineChars ?? defaultMaxInlineChars;
    this.previewChars = options.previewChars ?? defaultPreviewChars;
  }

  async writeText(
    toolName: string,
    content: string,
    options: WriteWorkerToolOutputArtifactOptions = {},
  ): Promise<WorkerToolOutputArtifact> {
    const extension = normalizeExtension(options.extension);
    const safeToolName = sanitizePathSegment(toolName);
    const absolutePath = join(this.runDirectory, `${Date.now()}-${safeToolName}-${randomUUID()}.${extension}`);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);

    return {
      path: `/artifacts/${relative(this.runDirectory, absolutePath).replace(/\\/g, "/")}`,
      absolutePath,
      toolName,
      sizeBytes: Buffer.byteLength(content),
      originalChars: content.length,
      estimatedTokens: estimateTokens(content),
      preview: truncate(content, this.previewChars),
    };
  }

  async replaceIfOversized(toolName: string, value: unknown): Promise<unknown> {
    if (hasExistingFullOutputPath(value)) {
      return value;
    }

    const serialized = serializeToolOutput(value);
    if (serialized.text.length <= this.maxInlineChars) {
      return value;
    }

    const artifact = await this.writeText(toolName, serialized.text, { extension: serialized.extension });
    return {
      ...pickRetainedFields(value),
      full_output_path: artifact.path,
      tool_output_artifact: {
        type: "temporary_worker_tool_output",
        toolName,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        originalChars: artifact.originalChars,
        estimatedTokens: artifact.estimatedTokens,
        preview: artifact.preview,
        instructions: `Full ${toolName} output was written to ${artifact.path}. This is a Finn run artifact, not an external-service file or user workspace file. Use workspace_search to find the files API and workspace_execute with finn.files on this /artifacts path while the worker is running or resumable if you need details. Do not use Composio, remote workbench tools, MCP, or web browsing to open /artifacts paths. This temporary artifact is removed when the worker can no longer resume, so extract any needed facts before finishing the run.`,
      },
    };
  }

  async cleanup(): Promise<void> {
    await rm(this.runDirectory, { recursive: true, force: true });
  }
}
