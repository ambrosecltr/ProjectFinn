import {
  applyWorkspacePatch,
  downloadFileCommand as downloadFileRuntimeCommand,
  extractFileCommand as extractFileRuntimeCommand,
  listFilesCommand as listFilesRuntimeCommand,
  listWorkspaceFiles as listWorkspaceFilesRuntimeCommand,
  readFileCommand as readFileRuntimeCommand,
  searchFileCommand as searchFileRuntimeCommand,
  setFileVisibilityCommand as setFileVisibilityRuntimeCommand,
  viewImageCommand as viewImageRuntimeCommand,
  writeFileCommand as writeFileRuntimeCommand,
  type FilesRuntime,
  type ReadFileResult,
  type ViewImageResult,
  type WorkspacePatchResult,
} from "@finn/runtime";
import {
  downloadFileInputSchema,
  extractFileInputSchema,
  listFilesInputSchema,
  listWorkspaceFilesInputSchema,
  patchFileInputSchema,
  readFileInputSchema,
  searchFileInputSchema,
  setFileVisibilityInputSchema,
  viewImageInputSchema,
  writeFileInputSchema,
} from "./schemas.js";

export type { ReadFileResult, ViewImageResult } from "@finn/runtime";

export function listWorkspaceFiles(runtime: FilesRuntime, input = {}) {
  return listWorkspaceFilesRuntimeCommand(runtime, listWorkspaceFilesInputSchema.parse(input));
}

export function readFileCommand(runtime: FilesRuntime, input: unknown): Promise<ReadFileResult> {
  return readFileRuntimeCommand(runtime, readFileInputSchema.parse(input));
}

export function searchFileCommand(runtime: FilesRuntime, input: unknown) {
  return searchFileRuntimeCommand(runtime, searchFileInputSchema.parse(input));
}

export function extractFileCommand(runtime: FilesRuntime, input: unknown) {
  return extractFileRuntimeCommand(runtime, extractFileInputSchema.parse(input));
}

export function writeFileCommand(runtime: FilesRuntime, input: unknown) {
  return writeFileRuntimeCommand(runtime, writeFileInputSchema.parse(input));
}

const artifactsMountPath = "/artifacts";
const tmpMountPath = "/tmp";
const patchHeaderPrefix = "*** ";

function isMountPath(path: string, mountPath: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

function patchTargetMount(path: string): "workspace" | "artifacts" {
  if (isMountPath(path, tmpMountPath)) {
    throw new Error("/tmp is disposable workspace scratch and is not a Finn files API path.");
  }
  return isMountPath(path, artifactsMountPath) ? "artifacts" : "workspace";
}

function inferPatchMount(input: string): "workspace" | "artifacts" {
  const mounts = new Set<"workspace" | "artifacts">();
  const addPrefix = `${patchHeaderPrefix}Add File: `;
  const deletePrefix = `${patchHeaderPrefix}Delete File: `;
  const updatePrefix = `${patchHeaderPrefix}Update File: `;
  const movePrefix = `${patchHeaderPrefix}Move to: `;
  for (const line of input.split(/\r?\n/)) {
    const target = line.startsWith(addPrefix)
      ? line.slice(addPrefix.length).trim()
      : line.startsWith(deletePrefix)
        ? line.slice(deletePrefix.length).trim()
        : line.startsWith(updatePrefix)
          ? line.slice(updatePrefix.length).trim()
          : line.startsWith(movePrefix)
            ? line.slice(movePrefix.length).trim()
            : null;
    if (target) {
      mounts.add(patchTargetMount(target));
    }
  }
  if (mounts.has("workspace") && mounts.has("artifacts")) {
    throw new Error("finn.files.patch cannot mix /workspace and /artifacts paths in one patch. Apply separate patches per mount.");
  }
  return mounts.has("artifacts") ? "artifacts" : "workspace";
}

export async function patchFileCommand(runtime: FilesRuntime, input: unknown): Promise<WorkspacePatchResult> {
  const parsed = patchFileInputSchema.parse(input);
  const mount = inferPatchMount(parsed.input);
  if (mount === "artifacts") {
    if (!runtime.artifactsRoot) {
      throw new Error("/artifacts is not available in this run.");
    }
    return applyWorkspacePatch(runtime.artifactsRoot, parsed, {
      mountPath: artifactsMountPath,
    });
  }
  if (runtime.access !== "write") {
    throw new Error("The /workspace mount is read-only for this process; cannot execute finn.files.patch for /workspace paths. Use /artifacts/... for temporary files.");
  }

  return applyWorkspacePatch(runtime.workspaceRoot, parsed, {
    blockedWorkspacePaths: runtime.blockedWorkspacePaths,
  });
}

export function downloadFileCommand(runtime: FilesRuntime, input: unknown) {
  return downloadFileRuntimeCommand(runtime, downloadFileInputSchema.parse(input));
}

export function viewImageCommand(runtime: FilesRuntime, input: unknown): Promise<ViewImageResult> {
  return viewImageRuntimeCommand(runtime, viewImageInputSchema.parse(input));
}

export function setFileVisibilityCommand(runtime: FilesRuntime, input: unknown) {
  return setFileVisibilityRuntimeCommand(runtime, setFileVisibilityInputSchema.parse(input));
}

export async function listFilesCommand(runtime: FilesRuntime, input: unknown) {
  return listFilesRuntimeCommand(runtime, listFilesInputSchema.parse(input));
}

export async function executeFilesCommand(runtime: FilesRuntime, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "list":
      return listFilesCommand(runtime, args);
    case "read":
      return readFileCommand(runtime, args);
    case "search":
      return searchFileCommand(runtime, args);
    case "extract":
      return extractFileCommand(runtime, args);
    case "view_image":
      return viewImageCommand(runtime, args);
    case "set_visibility":
      return setFileVisibilityCommand(runtime, args);
    case "write":
      return writeFileCommand(runtime, args);
    case "patch":
      return patchFileCommand(runtime, args);
    case "download":
      return downloadFileCommand(runtime, args);
    default:
      throw new Error(`Unsupported files command: ${command}`);
  }
}
