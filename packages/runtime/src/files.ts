import { buildStoredFileUrl, extractDocument, type DocumentOcrMode, type FileStorage } from "@finn/media";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { detectImageMimeType, maxModelImageBytes, prepareImageForModelInput } from "./model-images.js";
export {
  maxModelImageBytes,
  maxViewImageModelBytes,
  prepareImageForModelInput,
  type ModelImageInput,
  type PreparedModelImage,
} from "./model-images.js";

const defaultMaxReadBytes = 256 * 1024;
const defaultListLimit = 200;
const maxDownloadRedirects = 5;
export const maxFileReadBytes = 2 * 1024 * 1024;
export const maxViewImageBytes = 8 * 1024 * 1024;
export const maxFileDownloadBytes = 50 * 1024 * 1024;
export const maxFileListLimit = 1_000;
export const maxDocumentCharacters = 250_000;
export const finnInternalWorkspacePath = ".finn";
export const defaultBlockedWorkspacePaths = [finnInternalWorkspacePath] as const;

export type RuntimeAccess = "read" | "write";

export interface FilesRuntimeOptions {
  workspaceRoot: string;
  artifactsRoot?: string;
  access?: RuntimeAccess;
  blockedWorkspacePaths?: readonly string[];
  fileStorage?: FileStorage;
  publicUrl?: string;
  documentExtraction?: boolean | {
    tempRoot?: string;
  };
  downloadTransport?: FilesDownloadTransport;
}

export type FilesDownloadTransport = (url: URL) => Promise<{ response: Response; finalUrl?: string }>;

export interface FilesRuntime {
  readonly kind: "finn-files-runtime";
  readonly access: RuntimeAccess;
  readonly workspaceRoot: string;
  readonly artifactsRoot?: string;
  readonly blockedWorkspacePaths?: readonly string[];
  readonly storedFiles?: FilesStoredFileService;
  readonly documentExtraction?: FilesDocumentExtractionService;
  readonly downloads?: FilesDownloadService;
  readonly documentExtractionAvailable: boolean;
  readonly storedFileVisibilityAvailable: boolean;
}

export interface FilesStoredFileService {
  get: FileStorage["get"];
  getMetadata: FileStorage["getMetadata"];
  store: FileStorage["store"];
  list: FileStorage["list"];
  listPage: FileStorage["listPage"];
  setUserVisible: FileStorage["setUserVisible"];
  moveToFolder: FileStorage["moveToFolder"];
  delete: FileStorage["delete"];
  urlFor?: (file: StoredFileUrlOwner) => string;
}

interface StoredFileUrlOwner {
  tenantId: string;
  userId: string;
  id: string;
}

export interface FilesDocumentExtractionService {
  tempRoot?: string;
  extract: (input: {
    filename: string;
    mimeType: string;
    data: Buffer;
    maxCharacters?: number;
    offset?: number;
    ocrMode?: DocumentOcrMode;
    tempRoot: string;
  }) => ReturnType<typeof extractDocument>;
}

export interface FilesDownloadService {
  transport?: FilesDownloadTransport;
}

export type FilesRuntimeInput = FilesRuntime | FilesRuntimeOptions;

export interface ListFilesInput {
  scope?: "stored" | "workspace" | "artifacts" | "all";
  cursor?: string;
  limit?: number;
  userVisible?: boolean;
  path?: string;
  includeHidden?: boolean;
}

export interface ListWorkspaceFilesInput {
  path?: string;
  includeHidden?: boolean;
  limit?: number;
}

export interface ReadFileInput {
  path?: string;
  fileId?: string;
  maxBytes?: number;
  offset?: number;
}

export interface SearchFileInput {
  path?: string;
  fileId?: string;
  query: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
}

export interface ExtractFileInput {
  path?: string;
  fileId?: string;
  url?: string;
  maxCharacters?: number;
  offset?: number;
  ocrMode?: DocumentOcrMode;
}

export interface ViewImageInput {
  path?: string;
  fileId?: string;
}

export interface SetFileVisibilityInput {
  fileId: string;
  userVisible: boolean;
}

export interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
  userVisible?: boolean;
  mimeType?: string;
  folderId?: string | null;
}

export interface DownloadFileInput {
  url: string;
  filename?: string;
  path?: string;
  userVisible?: boolean;
  folderId?: string | null;
}

export function createFilesRuntime(options: FilesRuntimeOptions): FilesRuntime {
  return {
    kind: "finn-files-runtime",
    access: options.access ?? "write",
    workspaceRoot: options.workspaceRoot,
    artifactsRoot: options.artifactsRoot,
    blockedWorkspacePaths: options.blockedWorkspacePaths ?? defaultBlockedWorkspacePaths,
    documentExtractionAvailable: Boolean(options.documentExtraction),
    storedFileVisibilityAvailable: Boolean(options.fileStorage),
    ...(options.fileStorage
      ? {
          storedFiles: {
            get: (id) => options.fileStorage!.get(id),
            getMetadata: (id) => options.fileStorage!.getMetadata(id),
            store: (input) => options.fileStorage!.store(input),
            list: (limit, offset, listOptions) => options.fileStorage!.list(limit, offset, listOptions),
            listPage: (limit, cursor, listOptions) => options.fileStorage!.listPage(limit, cursor, listOptions),
            setUserVisible: (id, userVisible) => options.fileStorage!.setUserVisible(id, userVisible),
            moveToFolder: (id, folderId) => options.fileStorage!.moveToFolder(id, folderId),
            delete: (id) => options.fileStorage!.delete(id),
            ...(options.publicUrl
              ? {
                  urlFor: (file: StoredFileUrlOwner) => buildStoredFileUrl(options.publicUrl!, file),
                }
              : {}),
          },
        }
      : {}),
    ...(options.documentExtraction
      ? {
          documentExtraction: {
            ...(typeof options.documentExtraction === "object" && options.documentExtraction.tempRoot
              ? { tempRoot: options.documentExtraction.tempRoot }
              : {}),
            extract: extractDocument,
          },
        }
      : {}),
    ...(options.downloadTransport
      ? { downloads: { transport: options.downloadTransport } }
      : {}),
  };
}

export function toFilesRuntime(input: FilesRuntimeInput): FilesRuntime {
  return isFilesRuntime(input) ? input : createFilesRuntime(input);
}

function isFilesRuntime(input: FilesRuntimeInput): input is FilesRuntime {
  return "kind" in input && input.kind === "finn-files-runtime";
}

function requireStoredFileWriteAccess(runtime: FilesRuntime, command: string): void {
  if (runtime.access !== "write") {
    throw new Error(`${command} changes user-visible stored file metadata and requires write-capable /workspace access; this process has a read-only /workspace mount.`);
  }
}

function getBoundedPositiveInt(value: number | undefined, fallback: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return resolved;
}

function getBoundedNonNegativeInt(value: number | undefined, fallback: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 0 and ${max}.`);
  }
  return resolved;
}

interface LoadedFile {
  displayPath: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  fileId?: string;
  url?: string;
}

interface FileSystemRoot {
  root: string;
  label: "workspace" | "artifacts";
}

const workspaceMountPath = "/workspace";
const artifactsMountPath = "/artifacts";
const tmpMountPath = "/tmp";

export interface ViewImageResult {
  success: true;
  path: string;
  fileId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  originalSizeBytes?: number;
  resizedForModel?: boolean;
  dataBase64: string;
}

export interface ReadFileResult {
  path: string;
  fileId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  offset: number;
  maxBytes: number;
  truncated: boolean;
  nextOffset: number | null;
  content: string;
}

function assertPathInsideRoot(root: string, path: string, label: string): string {
  const relativePath = relative(root, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the filesystem root: ${path}`);
  }
  return path;
}

function visiblePath(rootInfo: FileSystemRoot, path: string): string {
  const relativePath = relative(rootInfo.root, path).replace(/\\/g, "/") || ".";
  if (rootInfo.label === "workspace") {
    return relativePath === "." ? workspaceMountPath : `${workspaceMountPath}/${relativePath}`;
  }
  return relativePath === "." ? artifactsMountPath : `${artifactsMountPath}/${relativePath}`;
}

function workspaceVisiblePath(runtime: FilesRuntime, path: string): string {
  return visiblePath({ root: runtime.workspaceRoot, label: "workspace" }, path);
}

interface RealWorkspacePath {
  realWorkspaceRoot: string;
  realPath: string;
}

function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isMountPath(path: string, mountPath: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

function getFileSystemRoot(runtime: FilesRuntime, path = "."): FileSystemRoot {
  if (isMountPath(path, tmpMountPath)) {
    throw new Error("/tmp is disposable Secure Exec scratch and is not a Finn files API path.");
  }
  if (isMountPath(path, artifactsMountPath) && !runtime.artifactsRoot) {
    throw new Error("/artifacts is not available in this run.");
  }
  if (isMountPath(path, artifactsMountPath) && runtime.artifactsRoot) {
    return { root: runtime.artifactsRoot, label: "artifacts" };
  }

  return { root: runtime.workspaceRoot, label: "workspace" };
}

function normalizeRootRelativePath(path: string, rootInfo: FileSystemRoot): string {
  if (isMountPath(path, tmpMountPath)) {
    throw new Error("/tmp is disposable Secure Exec scratch and is not a Finn files API path.");
  }
  if (rootInfo.label === "artifacts") {
    return path === artifactsMountPath ? "." : path.slice(`${artifactsMountPath}/`.length);
  }
  if (path === workspaceMountPath) {
    return ".";
  }
  if (path.startsWith(`${workspaceMountPath}/`)) {
    return path.slice(`${workspaceMountPath}/`.length);
  }

  return path;
}

function getBlockedWorkspacePaths(runtime: FilesRuntime): string[] {
  return (runtime.blockedWorkspacePaths ?? defaultBlockedWorkspacePaths)
    .map((path) => normalizeWorkspaceRelativePath(path))
    .filter((path) => path.length > 0 && path !== ".");
}

function isBlockedWorkspacePath(runtime: FilesRuntime, workspaceRoot: string, path: string): boolean {
  const relativePath = relative(workspaceRoot, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return false;
  }

  const normalizedRelativePath = normalizeWorkspaceRelativePath(relativePath);
  return getBlockedWorkspacePaths(runtime).some((blockedPath) => normalizedRelativePath === blockedPath
    || normalizedRelativePath.startsWith(`${blockedPath}/`));
}

function assertNotBlockedWorkspacePath(runtime: FilesRuntime, workspaceRoot: string, path: string, label: string): void {
  if (!isBlockedWorkspacePath(runtime, workspaceRoot, path)) {
    return;
  }

  const relativePath = normalizeWorkspaceRelativePath(relative(workspaceRoot, path));
  throw new Error(`${label} points to a Finn-internal path and is not accessible: ${relativePath}`);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function resolveRootPathLexical(rootInfo: FileSystemRoot, path = "."): string {
  const resolved = resolve(rootInfo.root, normalizeRootRelativePath(path, rootInfo));
  return assertPathInsideRoot(rootInfo.root, resolved, "Path");
}

async function assertRealPathInsideWorkspace(workspaceRoot: string, path: string, label: string): Promise<RealWorkspacePath> {
  const [realWorkspaceRoot, realPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(path),
  ]);
  return {
    realWorkspaceRoot,
    realPath: assertPathInsideRoot(realWorkspaceRoot, realPath, label),
  };
}

async function resolveExistingWorkspacePathInfo(runtime: FilesRuntime, path = "."): Promise<RealWorkspacePath> {
  const rootInfo = getFileSystemRoot(runtime, path);
  const resolved = resolveRootPathLexical(rootInfo, path);
  if (rootInfo.label === "workspace") {
    assertNotBlockedWorkspacePath(runtime, runtime.workspaceRoot, resolved, "Path");
  }
  const insidePath = await assertRealPathInsideWorkspace(rootInfo.root, resolved, "Path");
  if (rootInfo.label === "workspace") {
    assertNotBlockedWorkspacePath(runtime, insidePath.realWorkspaceRoot, insidePath.realPath, "Path");
  }
  return insidePath;
}

async function resolveExistingWorkspacePath(runtime: FilesRuntime, path = "."): Promise<string> {
  return (await resolveExistingWorkspacePathInfo(runtime, path)).realPath;
}

async function assertWritableParentPathAllowed(runtime: FilesRuntime, rootInfo: FileSystemRoot, parentPath: string): Promise<void> {
  const parentRelativePath = relative(rootInfo.root, parentPath);
  if (!parentRelativePath) {
    return;
  }

  let currentPath = rootInfo.root;
  for (const part of parentRelativePath.split(/[\\/]+/).filter(Boolean)) {
    currentPath = join(currentPath, part);
    try {
      await lstat(currentPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }

    const insidePath = await assertRealPathInsideWorkspace(rootInfo.root, currentPath, "Path directory");
    if (rootInfo.label === "workspace") {
      assertNotBlockedWorkspacePath(runtime, insidePath.realWorkspaceRoot, insidePath.realPath, "Path directory");
    }
  }
}

function finalSymlinkWriteError(rootInfo: FileSystemRoot, path: string): Error {
  return new Error(`Path points to a symbolic link; refusing to write through final symlink: ${visiblePath(rootInfo, path)}`);
}

async function resolveWritableFileSystemPath(runtime: FilesRuntime, path: string, command: string): Promise<{ rootInfo: FileSystemRoot; absolutePath: string }> {
  const rootInfo = getFileSystemRoot(runtime, path);
  const resolved = resolveRootPathLexical(rootInfo, path);
  if (rootInfo.label === "workspace") {
    if (runtime.access !== "write") {
      throw new Error(`The /workspace mount is read-only for this process; cannot execute ${command} for ${visiblePath(rootInfo, resolved)}. Use /artifacts/... for temporary files.`);
    }
    assertNotBlockedWorkspacePath(runtime, runtime.workspaceRoot, resolved, "Path");
  }
  await assertWritableParentPathAllowed(runtime, rootInfo, dirname(resolved));
  await mkdir(dirname(resolved), { recursive: true });
  const parentPath = await assertRealPathInsideWorkspace(rootInfo.root, dirname(resolved), "Path directory");
  if (rootInfo.label === "workspace") {
    assertNotBlockedWorkspacePath(runtime, parentPath.realWorkspaceRoot, parentPath.realPath, "Path directory");
  }

  try {
    const existingPath = await lstat(resolved);
    if (existingPath.isSymbolicLink()) {
      throw finalSymlinkWriteError(rootInfo, resolved);
    }
    const insidePath = await assertRealPathInsideWorkspace(rootInfo.root, resolved, "Path");
    if (rootInfo.label === "workspace") {
      assertNotBlockedWorkspacePath(runtime, insidePath.realWorkspaceRoot, insidePath.realPath, "Path");
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  return { rootInfo, absolutePath: resolved };
}

function modelImageTempRoot(runtime: FilesRuntime, dataSize: number): string {
  if (runtime.artifactsRoot) {
    return join(runtime.artifactsRoot, "tmp", "model-images");
  }
  if (dataSize > maxModelImageBytes && runtime.access !== "write") {
    throw new Error("view_image needs /artifacts for oversized image preparation when /workspace is read-only.");
  }
  return join(runtime.workspaceRoot, "tmp", "model-images");
}

function sanitizeFilename(value: string): string {
  const safe = basename(value).replace(/[^\w .@()-]+/g, "_").trim();
  return safe.length > 0 ? safe : `download-${Date.now()}`;
}

function mimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".txt" || ext === ".md" || ext === ".log") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function defaultDownloadDestinationPath(runtime: FilesRuntime, filename: string): string {
  const destinationFilename = `${Date.now()}-${randomUUID()}-${filename}`;
  if (runtime.access === "write") {
    return join("tmp", "downloads", destinationFilename);
  }
  if (runtime.artifactsRoot) {
    return `${artifactsMountPath}/downloads/${destinationFilename}`;
  }
  throw new Error("No writable download destination is available: /workspace is read-only for this process and /artifacts is not mounted. Provide a writable /artifacts/... path.");
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const candidate = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (candidate) {
      return decodeURIComponent(candidate);
    }
  } catch {
    // URL inputs are validated before this helper is called.
  }
  return `download-${Date.now()}`;
}

async function loadInputFile(runtime: FilesRuntime, input: { path?: string; fileId?: string }): Promise<LoadedFile> {
  if (input.fileId) {
    if (!runtime.storedFiles) {
      throw new Error("Stored file lookup is not available in this run.");
    }

    const stored = await runtime.storedFiles.get(input.fileId);
    if (!stored) {
      throw new Error(`Stored file not found: ${input.fileId}`);
    }

    return {
      displayPath: workspaceVisiblePath(runtime, stored.file.storagePath),
      filename: stored.file.filename,
      mimeType: stored.file.mimeType,
      data: stored.data,
      fileId: input.fileId,
    };
  }

  if (!input.path) {
    throw new Error("Provide either path or fileId.");
  }

  const rootInfo = getFileSystemRoot(runtime, input.path);
  const pathInfo = await resolveExistingWorkspacePathInfo(runtime, input.path);
  const data = await readFile(pathInfo.realPath);
  return {
    displayPath: visiblePath({ root: pathInfo.realWorkspaceRoot, label: rootInfo.label }, pathInfo.realPath),
    filename: basename(pathInfo.realPath),
    mimeType: mimeTypeFromFilename(pathInfo.realPath),
    data: Buffer.from(data),
  };
}

function requireSingleFileReference(input: { path?: string; fileId?: string }): void {
  if (Boolean(input.path) === Boolean(input.fileId)) {
    throw new Error("Provide exactly one of path or fileId.");
  }
}

function requireSingleDocumentReference(input: { path?: string; fileId?: string; url?: string }): void {
  const referenceCount = [input.path, input.fileId, input.url].filter(Boolean).length;
  if (referenceCount !== 1) {
    throw new Error("Provide exactly one of path, fileId, or url.");
  }
}

async function loadDocumentInput(runtime: FilesRuntime, input: { path?: string; fileId?: string; url?: string }): Promise<LoadedFile> {
  if (input.url) {
    const downloaded = await fetchBytes(input.url, runtime.downloads?.transport);
    return {
      displayPath: input.url,
      filename: sanitizeFilename(downloaded.filename),
      mimeType: downloaded.mimeType,
      data: downloaded.data,
      url: input.url,
    };
  }

  return loadInputFile(runtime, input);
}

async function readDirectoryEntries(runtime: FilesRuntime, path: string, includeHidden: boolean, limit: number) {
  const { realWorkspaceRoot, realPath: absolutePath } = await resolveExistingWorkspacePathInfo(runtime, path);
  const rootInfo = getFileSystemRoot(runtime, path);
  const displayRootInfo = { root: realWorkspaceRoot, label: rootInfo.label } satisfies FileSystemRoot;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const visibleEntries = (includeHidden ? entries : entries.filter((entry) => !entry.name.startsWith(".")))
    .filter((entry) => rootInfo.label === "artifacts" || !isBlockedWorkspacePath(runtime, realWorkspaceRoot, join(absolutePath, entry.name)));
  const selected = visibleEntries.slice(0, limit);

  return Promise.all(selected.map(async (entry) => {
    const entryPath = join(absolutePath, entry.name);
    const info = await stat(entryPath);
    return {
      path: visiblePath(displayRootInfo, entryPath),
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      sizeBytes: entry.isFile() ? info.size : undefined,
      modifiedAt: info.mtime.toISOString(),
    };
  }));
}

export interface RemoteUrlSafetyOptions {
  protocolMessage: string;
  hostMessage: string;
  addressMessage: string;
}

export interface ValidatedRemoteAddress {
  address: string;
  family: 4 | 6;
}

const downloadUrlSafetyMessages: RemoteUrlSafetyOptions = {
  protocolMessage: "Only HTTP(S) URLs can be downloaded.",
  hostMessage: "Downloads from local or internal hosts are not allowed.",
  addressMessage: "Downloads from private or local network addresses are not allowed.",
};

export function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = address.replace(/^\[|\]$/g, "");
  const family = isIP(normalizedAddress);
  if (family === 4) {
    const octets = normalizedAddress.split(".").map((part) => Number(part));
    const [first = 0, second = 0] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) {
    const normalized = normalizedAddress.toLowerCase();
    if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      return true;
    }
  }
  return false;
}

export async function validateRemoteHttpUrl(
  url: URL,
  messages: RemoteUrlSafetyOptions = downloadUrlSafetyMessages,
): Promise<ValidatedRemoteAddress[]> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(messages.protocolMessage);
  }

  const hostname = url.hostname.toLowerCase();
  const lookupHostname = hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error(messages.hostMessage);
  }

  if (isIP(lookupHostname)) {
    if (isBlockedIpAddress(lookupHostname)) {
      throw new Error(messages.addressMessage);
    }
    return [{ address: lookupHostname, family: isIP(lookupHostname) as 4 | 6 }];
  }

  const addresses = await lookup(lookupHostname, { all: true, verbatim: true });
  if (addresses.some((address) => isBlockedIpAddress(address.address))) {
    throw new Error(messages.addressMessage);
  }
  return addresses.map((address) => ({
    address: address.address,
    family: address.family as 4 | 6,
  }));
}

async function assertSafeDownloadUrl(url: URL): Promise<ValidatedRemoteAddress[]> {
  return validateRemoteHttpUrl(url, downloadUrlSafetyMessages);
}

export async function fetchWithValidatedAddresses(url: URL, addresses: ValidatedRemoteAddress[]): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  let addressIndex = 0;

  if (addresses.length === 0) {
    throw new Error("No validated remote addresses are available for download.");
  }

  return new Promise<Response>((resolveResponse, reject) => {
    const req = request(url, {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          const orderedAddresses = addresses.map((_, offset) => addresses[(addressIndex + offset) % addresses.length]);
          addressIndex += 1;
          callback(null, orderedAddresses);
          return;
        }

        const address = addresses[addressIndex % addresses.length];
        addressIndex += 1;
        callback(null, address.address, address.family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxFileDownloadBytes) {
          req.destroy(new Error(`Download exceeds ${maxFileDownloadBytes} byte limit.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolveResponse(new Response(Buffer.concat(chunks), {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: normalizeResponseHeaders(res.headers),
        }));
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function normalizeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
    }
  }
  return normalized;
}

async function fetchBytes(url: string, transport?: FilesDownloadTransport): Promise<{ data: Buffer; mimeType: string; filename: string }> {
  let currentUrl = new URL(url);
  let response: Response | null = null;

  for (let redirectCount = 0; redirectCount <= maxDownloadRedirects; redirectCount += 1) {
    const addresses = await assertSafeDownloadUrl(currentUrl);
    const downloaded = transport
      ? await transport(currentUrl)
      : { response: await fetchWithValidatedAddresses(currentUrl, addresses) };
    response = downloaded.response;
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (downloaded.finalUrl) {
        currentUrl = new URL(downloaded.finalUrl, currentUrl);
        await assertSafeDownloadUrl(currentUrl);
      }
      break;
    }

    const location = response.headers.get("location");
    if (!location) {
      break;
    }
    currentUrl = new URL(location, currentUrl);
  }

  if (!response) {
    throw new Error("Download failed before a request was made.");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(`Download exceeded ${maxDownloadRedirects} redirects.`);
  }
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxFileDownloadBytes) {
    throw new Error(`Download exceeds ${maxFileDownloadBytes} byte limit.`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxFileDownloadBytes) {
    throw new Error(`Download exceeds ${maxFileDownloadBytes} byte limit.`);
  }

  return {
    data,
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    filename: filenameFromUrl(currentUrl.toString()),
  };
}

export async function listWorkspaceFiles(runtimeInput: FilesRuntimeInput, input: ListWorkspaceFilesInput = {}) {
  const runtime = toFilesRuntime(runtimeInput);
  const path = input.path ?? ".";
  const rootInfo = getFileSystemRoot(runtime, path);
  const includeHidden = input.includeHidden ?? false;
  const limit = getBoundedPositiveInt(input.limit, defaultListLimit, maxFileListLimit, "limit");
  const pathInfo = await resolveExistingWorkspacePathInfo(runtime, path);
  const entries = await readDirectoryEntries(runtime, path, includeHidden, limit);
  return {
    path: visiblePath({ root: pathInfo.realWorkspaceRoot, label: rootInfo.label }, pathInfo.realPath),
    entries,
    truncated: entries.length >= limit,
  };
}

export async function readFileCommand(runtimeInput: FilesRuntimeInput, input: ReadFileInput): Promise<ReadFileResult> {
  const runtime = toFilesRuntime(runtimeInput);
  requireSingleFileReference(input);
  const loaded = await loadInputFile(runtime, input);
  const maxBytes = getBoundedPositiveInt(input.maxBytes, defaultMaxReadBytes, maxFileReadBytes, "maxBytes");
  const offset = getBoundedNonNegativeInt(input.offset, 0, loaded.data.length, "offset");
  const endOffset = Math.min(loaded.data.length, offset + maxBytes);
  const slice = loaded.data.subarray(offset, endOffset);
  return {
    path: loaded.displayPath,
    fileId: loaded.fileId,
    filename: loaded.filename,
    mimeType: loaded.mimeType,
    sizeBytes: loaded.data.length,
    offset,
    maxBytes,
    truncated: endOffset < loaded.data.length,
    nextOffset: endOffset < loaded.data.length ? endOffset : null,
    content: slice.toString("utf8"),
  };
}

export async function searchFileCommand(runtimeInput: FilesRuntimeInput, input: SearchFileInput) {
  const runtime = toFilesRuntime(runtimeInput);
  requireSingleFileReference(input);
  const contextLines = getBoundedNonNegativeInt(input.contextLines, 0, 5, "contextLines");
  const maxMatches = getBoundedPositiveInt(input.maxMatches, 50, 200, "maxMatches");
  const loaded = await loadInputFile(runtime, input);
  const content = loaded.data.toString("utf8");
  const lines = content.split(/\r?\n/);
  const query = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches: Array<{
    line: number;
    text: string;
    before?: string[];
    after?: string[];
  }> = [];
  let totalMatches = 0;

  for (const [index, line] of lines.entries()) {
    const haystack = input.caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(query)) {
      continue;
    }

    totalMatches += 1;
    if (matches.length >= maxMatches) {
      continue;
    }

    const before = contextLines > 0
      ? lines.slice(Math.max(0, index - contextLines), index)
      : undefined;
    const after = contextLines > 0
      ? lines.slice(index + 1, Math.min(lines.length, index + 1 + contextLines))
      : undefined;
    matches.push({
      line: index + 1,
      text: line,
      ...(before?.length ? { before } : {}),
      ...(after?.length ? { after } : {}),
    });
  }

  return {
    path: loaded.displayPath,
    fileId: loaded.fileId,
    filename: loaded.filename,
    mimeType: loaded.mimeType,
    sizeBytes: loaded.data.length,
    query: input.query,
    totalMatches,
    truncated: totalMatches > matches.length,
    matches,
  };
}

export async function extractFileCommand(runtimeInput: FilesRuntimeInput, input: ExtractFileInput) {
  const runtime = toFilesRuntime(runtimeInput);
  if (!runtime.documentExtraction) {
    throw new Error("Document extraction is not available in this run.");
  }
  requireSingleDocumentReference(input);
  const maxCharacters = input.maxCharacters === undefined
    ? undefined
    : getBoundedPositiveInt(input.maxCharacters, maxDocumentCharacters, maxDocumentCharacters, "maxCharacters");
  const loaded = await loadDocumentInput(runtime, input);
  const tempRoot = runtime.documentExtraction.tempRoot ?? join(runtime.workspaceRoot, "tmp", "document-extraction");
  return runtime.documentExtraction.extract({
    filename: loaded.filename,
    mimeType: loaded.mimeType,
    data: loaded.data,
    maxCharacters,
    offset: input.offset,
    ocrMode: input.ocrMode,
    tempRoot,
  });
}

export async function writeFileCommand(runtimeInput: FilesRuntimeInput, input: WriteFileInput) {
  const runtime = toFilesRuntime(runtimeInput);
  const requestedRootInfo = getFileSystemRoot(runtime, input.path);
  if (input.userVisible) {
    if (requestedRootInfo.label !== "workspace") {
      throw new Error("finn.files.write can create a user-visible Library copy only for /workspace destinations. /artifacts files are temporary run artifacts and are not visible to the user.");
    }
    if (!runtime.storedFiles) {
      throw new Error("Cannot store a visible Library copy because file storage is unavailable.");
    }
  }
  const { rootInfo, absolutePath } = await resolveWritableFileSystemPath(runtime, input.path, "finn.files.write");
  if (input.append ?? false) {
    await appendFile(absolutePath, input.content);
  } else {
    await writeFile(absolutePath, input.content);
  }
  const finalData = input.userVisible || input.append ? await readFile(absolutePath) : Buffer.from(input.content);

  const result: Record<string, unknown> = {
    success: true,
    path: visiblePath(rootInfo, absolutePath),
    sizeBytes: finalData.length,
    appended: input.append ?? false,
  };

  if (input.userVisible) {
    const stored = await runtime.storedFiles!.store({
      filename: sanitizeFilename(basename(input.path)),
      mimeType: input.mimeType ?? mimeTypeFromFilename(input.path),
      data: finalData,
      userVisible: true,
      folderId: input.folderId ?? null,
      origin: "worker_created",
    });
    result["fileId"] = stored.id;
    result["libraryPath"] = stored.filename;
  }

  return result;
}

export async function downloadFileCommand(runtimeInput: FilesRuntimeInput, input: DownloadFileInput) {
  const runtime = toFilesRuntime(runtimeInput);
  if (input.userVisible && !runtime.storedFiles) {
    throw new Error("Cannot store a visible Library file because file storage is unavailable.");
  }
  const explicitRootInfo = input.path ? getFileSystemRoot(runtime, input.path) : null;
  if (input.userVisible && explicitRootInfo?.label === "artifacts") {
    throw new Error("finn.files.download can mark a file user-visible only when downloading to /workspace. /artifacts files are temporary run artifacts and are not visible to the user.");
  }
  const explicitDestination = input.path
    ? await resolveWritableFileSystemPath(runtime, input.path, "finn.files.download")
    : null;
  if (input.userVisible && !input.path && runtime.access !== "write") {
    throw new Error("finn.files.download can mark a file user-visible only when downloading to /workspace, but /workspace is read-only for this process.");
  }
  if (!input.path && runtime.access !== "write" && !runtime.artifactsRoot) {
    throw new Error("No writable download destination is available: /workspace is read-only for this process and /artifacts is not mounted. Provide a writable /artifacts/... path.");
  }
  const downloaded = await fetchBytes(input.url, runtime.downloads?.transport);
  const selectedFilename = sanitizeFilename(input.filename ?? downloaded.filename);
  const mimeType = downloaded.mimeType === "application/octet-stream"
    ? mimeTypeFromFilename(selectedFilename)
    : downloaded.mimeType;

  const destinationPath = input.path ?? defaultDownloadDestinationPath(runtime, selectedFilename);
  const { rootInfo, absolutePath } = explicitDestination
    ?? await resolveWritableFileSystemPath(runtime, destinationPath, "finn.files.download");
  if (input.userVisible && rootInfo.label !== "workspace") {
    throw new Error("finn.files.download can mark a file user-visible only when downloading to /workspace. /artifacts files are temporary run artifacts and are not visible to the user.");
  }
  await writeFile(absolutePath, downloaded.data);
  const result: Record<string, unknown> = {
    success: true,
    path: visiblePath(rootInfo, absolutePath),
    filename: selectedFilename,
    mimeType,
    sizeBytes: downloaded.data.length,
    userVisible: input.userVisible ?? false,
  };
  if (input.userVisible) {
    const stored = await runtime.storedFiles!.store({
      filename: selectedFilename,
      mimeType,
      data: downloaded.data,
      userVisible: true,
      folderId: input.folderId ?? null,
      origin: "worker_created",
    });
    result["fileId"] = stored.id;
    result["libraryPath"] = stored.filename;
  }
  return result;
}

export async function viewImageCommand(runtimeInput: FilesRuntimeInput, input: ViewImageInput): Promise<ViewImageResult> {
  const runtime = toFilesRuntime(runtimeInput);
  requireSingleFileReference(input);
  const loaded = await loadInputFile(runtime, input);
  if (loaded.data.length > maxViewImageBytes) {
    throw new Error(`Image exceeds ${maxViewImageBytes} byte view limit.`);
  }

  const mimeType = detectImageMimeType(loaded.data, loaded.mimeType);
  if (!mimeType) {
    throw new Error(`File is not a supported image: ${loaded.mimeType}`);
  }
  const prepared = await prepareImageForModelInput({
    data: loaded.data,
    filename: loaded.filename,
    mimeType,
    tempRoot: modelImageTempRoot(runtime, loaded.data.length),
  });

  return {
    success: true,
    path: loaded.displayPath,
    fileId: loaded.fileId,
    filename: loaded.filename,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.data.length,
    ...(prepared.data.length !== loaded.data.length ? { originalSizeBytes: loaded.data.length } : {}),
    ...(prepared.resizedForModel ? { resizedForModel: true } : {}),
    dataBase64: prepared.data.toString("base64"),
  };
}

export async function setFileVisibilityCommand(runtimeInput: FilesRuntimeInput, input: SetFileVisibilityInput) {
  const runtime = toFilesRuntime(runtimeInput);
  requireStoredFileWriteAccess(runtime, "finn.files.setVisibility");
  if (!runtime.storedFiles) {
    throw new Error("Stored file visibility is not available in this run.");
  }
  const file = await runtime.storedFiles.setUserVisible(input.fileId, input.userVisible);
  if (!file) {
    return { updated: false, fileId: input.fileId, error: `Stored file not found for current user: ${input.fileId}` };
  }
  return {
    updated: true,
    file: {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      origin: file.origin,
      userVisible: file.userVisible,
      folderId: file.folderId,
      createdAt: file.createdAt.toISOString(),
      modifiedAt: file.updatedAt.toISOString(),
    },
  };
}

export async function listFilesCommand(runtimeInput: FilesRuntimeInput, input: ListFilesInput) {
  const runtime = toFilesRuntime(runtimeInput);
  const scope = input.scope ?? "all";
  const limit = getBoundedPositiveInt(input.limit, 20, maxFileListLimit, "limit");
  const result: Record<string, unknown> = { scope };

  if ((scope === "stored" || scope === "all") && runtime.storedFiles) {
    const page = await runtime.storedFiles.listPage(limit, input.cursor, { userVisible: input.userVisible });
    result["stored"] = {
      files: page.files.map((file) => ({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        origin: file.origin,
        uploadedBy: file.uploadedBy,
        userVisible: file.userVisible,
        folderId: file.folderId,
        libraryPath: file.path,
        createdAt: file.createdAt.toISOString(),
        modifiedAt: file.updatedAt.toISOString(),
        ...(runtime.storedFiles?.urlFor ? { url: runtime.storedFiles.urlFor(file) } : {}),
      })),
      count: page.files.length,
      nextCursor: page.nextCursor,
    };
  }

  if (scope === "workspace" || scope === "all") {
    result["workspace"] = await listWorkspaceFiles(runtime, {
      path: input.path,
      includeHidden: input.includeHidden,
      limit,
    });
  }

  if ((scope === "artifacts" || scope === "all") && runtime.artifactsRoot) {
    result["artifacts"] = await listWorkspaceFiles(runtime, {
      path: input.path ?? artifactsMountPath,
      includeHidden: input.includeHidden ?? true,
      limit,
    });
  }

  return result;
}
