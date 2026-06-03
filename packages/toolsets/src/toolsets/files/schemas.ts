import {
  maxDocumentCharacters,
  maxFileDownloadBytes,
  maxFileListLimit,
  maxFileReadBytes,
  maxViewImageBytes,
} from "@finn/runtime";
import { z } from "zod";

export {
  maxDocumentCharacters,
  maxFileDownloadBytes,
  maxFileListLimit,
  maxFileReadBytes,
  maxViewImageBytes,
} from "@finn/runtime";

const booleanFlagSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());
export const maxPatchFileInputCharacters = 200_000;

const fileReferenceFields = {
  path: z.string().trim().min(1).optional().describe("Workspace-relative, /workspace/..., or /artifacts/... path. Do not use /tmp; it is VM-only scratch."),
  fileId: z.string().trim().min(1).optional().describe("Stored Finn file ID."),
};

export const listFilesInputSchema = z.object({
  scope: z.enum(["stored", "workspace", "artifacts", "all"]).optional().default("all"),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(maxFileListLimit).optional(),
  userVisible: booleanFlagSchema.optional(),
  path: z.string().trim().min(1).optional().describe("Workspace-relative, /workspace/..., or /artifacts/... path for listing."),
  includeHidden: booleanFlagSchema.optional(),
}).strict();

export const listWorkspaceFilesInputSchema = z.object({
  path: z.string().trim().min(1).optional().describe("Workspace-relative or /workspace/... destination. Do not use /tmp."),
  includeHidden: booleanFlagSchema.optional(),
  limit: z.coerce.number().int().positive().max(maxFileListLimit).optional(),
}).strict();

export const readFileInputSchema = z.object({
  ...fileReferenceFields,
  maxBytes: z.coerce.number().int().positive().max(maxFileReadBytes).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict().refine((input) => Boolean(input.path) !== Boolean(input.fileId), {
  message: "Provide exactly one of path or fileId.",
});

export const searchFileInputSchema = z.object({
  ...fileReferenceFields,
  query: z.string().trim().min(1).max(500),
  caseSensitive: booleanFlagSchema.optional().default(false),
  contextLines: z.coerce.number().int().min(0).max(5).optional().default(0),
  maxMatches: z.coerce.number().int().positive().max(200).optional().default(50),
}).strict().refine((input) => Boolean(input.path) !== Boolean(input.fileId), {
  message: "Provide exactly one of path or fileId.",
});

export const extractFileInputSchema = z.object({
  ...fileReferenceFields,
  url: z.string().url().optional(),
  maxCharacters: z.coerce.number().int().positive().max(maxDocumentCharacters).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  ocrMode: z.enum(["auto", "always", "never"]).optional(),
}).strict().refine((input) => [input.path, input.fileId, input.url].filter(Boolean).length === 1, {
  message: "Provide exactly one of path, fileId, or url.",
});

export const viewImageInputSchema = z.object(fileReferenceFields).strict().refine(
  (input) => Boolean(input.path) !== Boolean(input.fileId),
  { message: "Provide exactly one of path or fileId." },
);

export const setFileVisibilityInputSchema = z.object({
  fileId: z.string().trim().min(1),
  userVisible: booleanFlagSchema,
}).strict();

export const writeFileInputSchema = z.object({
  path: z.string().trim().min(1).describe("Workspace-relative, /workspace/..., or /artifacts/... destination. Do not use /tmp; it is VM-only scratch."),
  content: z.string(),
  append: booleanFlagSchema.optional(),
  userVisible: booleanFlagSchema.optional(),
  mimeType: z.string().trim().min(1).optional(),
  folderId: z.string().trim().min(1).nullable().optional(),
}).strict();

export const patchFileInputSchema = z.object({
  input: z.string().trim().min(1).max(maxPatchFileInputCharacters),
}).strict();

export const downloadFileInputSchema = z.object({
  url: z.string().url(),
  filename: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional().describe("Workspace-relative, /workspace/..., or /artifacts/... destination. Do not use /tmp; it is VM-only scratch."),
  userVisible: booleanFlagSchema.optional(),
  folderId: z.string().trim().min(1).nullable().optional(),
}).strict();

export type ListFilesInput = z.infer<typeof listFilesInputSchema>;
export type ListWorkspaceFilesInput = z.infer<typeof listWorkspaceFilesInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type SearchFileInput = z.infer<typeof searchFileInputSchema>;
export type ExtractFileInput = z.infer<typeof extractFileInputSchema>;
export type ViewImageInput = z.infer<typeof viewImageInputSchema>;
export type SetFileVisibilityInput = z.infer<typeof setFileVisibilityInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type PatchFileInput = z.infer<typeof patchFileInputSchema>;
export type DownloadFileInput = z.infer<typeof downloadFileInputSchema>;
