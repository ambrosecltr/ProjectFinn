import type { ToolsetDefinition } from "../../types.js";
import type { FilesRuntime } from "@finn/runtime";
import { createFilesManifest, type FilesManifestOptions } from "./manifest.js";
import { executeFilesCommand } from "./operations.js";

export interface FilesToolsetDefinitionOptions {
  processTypes: FilesManifestOptions["processTypes"];
  runtime: FilesRuntime;
}

export type { FilesManifestOptions } from "./manifest.js";
export {
  downloadFileInputSchema,
  extractFileInputSchema,
  listFilesInputSchema,
  listWorkspaceFilesInputSchema,
  maxPatchFileInputCharacters,
  patchFileInputSchema,
  readFileInputSchema,
  searchFileInputSchema,
  setFileVisibilityInputSchema,
  viewImageInputSchema,
  writeFileInputSchema,
} from "./schemas.js";
export type {
  DownloadFileInput,
  ExtractFileInput,
  ListFilesInput,
  ListWorkspaceFilesInput,
  PatchFileInput,
  ReadFileInput,
  SearchFileInput,
  SetFileVisibilityInput,
  ViewImageInput,
  WriteFileInput,
} from "./schemas.js";
export {
  downloadFileCommand,
  executeFilesCommand,
  extractFileCommand,
  listFilesCommand,
  listWorkspaceFiles,
  patchFileCommand,
  readFileCommand,
  searchFileCommand,
  setFileVisibilityCommand,
  viewImageCommand,
  writeFileCommand,
} from "./operations.js";
export type { ReadFileResult, ViewImageResult } from "./operations.js";

export function createFilesToolsetDefinition(options: FilesToolsetDefinitionOptions): ToolsetDefinition {
  const manifest = createFilesManifest({
    processTypes: options.processTypes,
    documentExtraction: options.runtime.documentExtractionAvailable,
    storedFileVisibility: options.runtime.storedFileVisibilityAvailable,
  });

  return {
    manifest,
    executors: Object.fromEntries(
      manifest.commands.map((command) => [
        command.name,
        (args) => executeFilesCommand(options.runtime, command.name, args),
      ]),
    ),
  };
}
