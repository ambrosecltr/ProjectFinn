import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const workspaceMountPath = "/workspace";
const artifactsMountPath = "/artifacts";
const tmpMountPath = "/tmp";

export interface WorkspacePatchInput {
  input: string;
}

export interface WorkspacePatchOptions {
  blockedWorkspacePaths?: readonly string[];
  mountPath?: typeof workspaceMountPath | typeof artifactsMountPath;
}

interface AppliedPatchFile {
  path: string;
  operation: "add" | "delete" | "update" | "move";
  addedLines?: number;
  removedLines?: number;
}

export interface WorkspacePatchResult {
  success: true;
  changedFiles: AppliedPatchFile[];
}

type PatchOperation =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

interface PatchHunk {
  header?: string;
  lines: Array<{ kind: "context" | "remove" | "add"; text: string }>;
  endOfFile?: boolean;
}

class PatchParseError extends Error {}

function pathIsInside(rootDir: string, path: string): boolean {
  const relativePath = relative(rootDir, path);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function normalizeWorkspacePath(
  path: string,
  mountPath: typeof workspaceMountPath | typeof artifactsMountPath = workspaceMountPath,
): string {
  if (path === tmpMountPath || path.startsWith(`${tmpMountPath}/`)) {
    throw new Error("/tmp is disposable Secure Exec scratch and cannot be used as a Finn workspace path.");
  }
  if (path === mountPath) {
    return ".";
  }
  if (path.startsWith(`${mountPath}/`)) {
    return path.slice(`${mountPath}/`.length);
  }
  return path;
}

function visibleWorkspacePath(
  path: string,
  mountPath: typeof workspaceMountPath | typeof artifactsMountPath = workspaceMountPath,
): string {
  const normalized = normalizeWorkspacePath(path, mountPath).replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.length === 0 || normalized === "." ? mountPath : `${mountPath}/${normalized}`;
}

function assertWorkspacePathInside(rootDir: string, path: string, label: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(path);
  if (!pathIsInside(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} escapes the worker workspace: ${path}`);
  }

  return resolvedPath;
}

function normalizePatch(input: string): string[] {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function requireRelativePath(path: string, options: WorkspacePatchOptions = {}): void {
  const normalizedPath = normalizeWorkspacePath(path, options.mountPath);
  if (isAbsolute(normalizedPath) || normalizedPath.split(/[\\/]+/).some((part) => part === "..")) {
    throw new PatchParseError(`Patch paths must be relative and stay inside the workspace: ${path}`);
  }
  if (normalizedPath.split(/[\\/]+/).includes(".finn")) {
    throw new PatchParseError(`Patch paths cannot target Finn internal files: ${path}`);
  }
}

function assertPatchPathAllowed(
  rootDir: string,
  resolvedPath: string,
  blockedWorkspacePaths: readonly string[] | undefined,
  label: string,
): void {
  for (const blockedPath of blockedWorkspacePaths ?? []) {
    const resolvedBlockedPath = resolve(rootDir, blockedPath);
    if (pathIsInside(resolvedBlockedPath, resolvedPath)) {
      throw new PatchParseError(`${label} cannot target blocked workspace path: ${blockedPath}`);
    }
  }
}

function resolvePatchPath(rootDir: string, path: string, options: WorkspacePatchOptions = {}, label = "Patch path"): string {
  requireRelativePath(path, options);
  const resolved = assertWorkspacePathInside(rootDir, resolve(rootDir, normalizeWorkspacePath(path, options.mountPath)), label);
  assertPatchPathAllowed(rootDir, resolved, options.blockedWorkspacePaths, label);
  return resolved;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensurePatchParentInside(rootDir: string, path: string, options: WorkspacePatchOptions = {}): Promise<void> {
  const parentPath = dirname(path);
  const realRoot = await realpath(rootDir);
  const parentRelativePath = relative(rootDir, parentPath);
  if (!parentRelativePath) {
    return;
  }

  let currentPath = rootDir;
  for (const part of parentRelativePath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, part);
    let fileInfo;
    try {
      fileInfo = await lstat(currentPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      await mkdir(currentPath);
      fileInfo = await lstat(currentPath);
    }

    if (fileInfo.isSymbolicLink()) {
      throw new PatchParseError(`Patch path directory cannot traverse a symlink: ${relative(rootDir, currentPath)}`);
    }
    if (!fileInfo.isDirectory()) {
      throw new PatchParseError(`Patch path directory must be a directory: ${relative(rootDir, currentPath)}`);
    }
    const realCurrentPath = assertWorkspacePathInside(realRoot, await realpath(currentPath), "Patch path directory");
    assertPatchPathAllowed(rootDir, realCurrentPath, options.blockedWorkspacePaths, "Patch path directory");
  }
}

async function resolveExistingPatchTarget(
  rootDir: string,
  path: string,
  label: string,
  options: WorkspacePatchOptions = {},
): Promise<string> {
  const resolved = resolvePatchPath(rootDir, path, options, label);
  const fileInfo = await lstat(resolved);
  if (fileInfo.isSymbolicLink()) {
    throw new PatchParseError(`${label} cannot target a symlink: ${path}`);
  }
  if (!fileInfo.isFile()) {
    throw new PatchParseError(`${label} must target a file: ${path}`);
  }

  const [realRoot, realTarget] = await Promise.all([
    realpath(rootDir),
    realpath(resolved),
  ]);
  const safeTarget = assertWorkspacePathInside(realRoot, realTarget, label);
  assertPatchPathAllowed(rootDir, safeTarget, options.blockedWorkspacePaths, label);
  return safeTarget;
}

async function resolveNewPatchTarget(
  rootDir: string,
  path: string,
  label: string,
  options: WorkspacePatchOptions = {},
): Promise<string> {
  const resolved = resolvePatchPath(rootDir, path, options, label);
  await ensurePatchParentInside(rootDir, resolved, options);
  try {
    const fileInfo = await lstat(resolved);
    if (fileInfo.isSymbolicLink()) {
      throw new PatchParseError(`${label} cannot target a symlink: ${path}`);
    }
    if (fileInfo.isFile()) {
      const [realRoot, realTarget] = await Promise.all([
        realpath(rootDir),
        realpath(resolved),
      ]);
      const safeTarget = assertWorkspacePathInside(realRoot, realTarget, label);
      assertPatchPathAllowed(rootDir, safeTarget, options.blockedWorkspacePaths, label);
      return safeTarget;
    }
    throw new PatchParseError(`${label} must target a file path: ${path}`);
  } catch (error) {
    if (error instanceof PatchParseError) {
      throw error;
    }
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return resolved;
}

function isOperationHeader(line: string): boolean {
  return line.startsWith("*** Add File: ")
    || line.startsWith("*** Delete File: ")
    || line.startsWith("*** Update File: ")
    || line === "*** End Patch";
}

function parsePatch(input: string, options: WorkspacePatchOptions = {}): PatchOperation[] {
  const lines = normalizePatch(input);
  let index = 0;

  if (lines[index] !== "*** Begin Patch") {
    throw new PatchParseError("Patch must start with *** Begin Patch.");
  }
  index += 1;

  const operations: PatchOperation[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      requireRelativePath(path, options);
      index += 1;
      const addLines: string[] = [];
      while (index < lines.length && !isOperationHeader(lines[index] ?? "")) {
        const addLine = lines[index] ?? "";
        if (!addLine.startsWith("+")) {
          throw new PatchParseError(`Add file lines must start with '+': ${addLine}`);
        }
        addLines.push(addLine.slice(1));
        index += 1;
      }
      if (addLines.length === 0) {
        throw new PatchParseError(`Add file operation has no content: ${path}`);
      }
      operations.push({ type: "add", path, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      requireRelativePath(path, options);
      operations.push({ type: "delete", path });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      requireRelativePath(path, options);
      index += 1;
      let moveTo: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        moveTo = (lines[index] ?? "").slice("*** Move to: ".length).trim();
        requireRelativePath(moveTo, options);
        index += 1;
      }

      const hunks: PatchHunk[] = [];
      while (index < lines.length && !isOperationHeader(lines[index] ?? "")) {
        const headerLine = lines[index] ?? "";
        if (!headerLine.startsWith("@@")) {
          throw new PatchParseError(`Update hunks must start with '@@': ${headerLine}`);
        }
        const header = headerLine === "@@" ? undefined : headerLine.slice(3).trim();
        index += 1;
        const hunkLines: PatchHunk["lines"] = [];
        let endOfFile = false;
        while (index < lines.length && !isOperationHeader(lines[index] ?? "") && !(lines[index] ?? "").startsWith("@@")) {
          const hunkLine = lines[index] ?? "";
          if (hunkLine === "*** End of File") {
            endOfFile = true;
            index += 1;
            continue;
          }
          const prefix = hunkLine[0];
          if (prefix !== " " && prefix !== "-" && prefix !== "+") {
            throw new PatchParseError(`Hunk lines must start with space, '-', or '+': ${hunkLine}`);
          }
          hunkLines.push({
            kind: prefix === " " ? "context" : prefix === "-" ? "remove" : "add",
            text: hunkLine.slice(1),
          });
          index += 1;
        }
        hunks.push({ header, lines: hunkLines, endOfFile });
      }

      if (!moveTo && hunks.length === 0) {
        throw new PatchParseError(`Update operation has no hunks: ${path}`);
      }
      operations.push({ type: "update", path, moveTo, hunks });
      continue;
    }

    if (line.length === 0 && index === lines.length - 1) {
      break;
    }

    throw new PatchParseError(`Unsupported patch line: ${line}`);
  }

  throw new PatchParseError("Patch must end with *** End Patch.");
}

function splitFileLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith("\n");
  const lines = trailingNewline ? content.slice(0, -1).split("\n") : content.split("\n");
  return {
    lines: lines.length === 1 && lines[0] === "" ? [] : lines,
    trailingNewline,
  };
}

function joinFileLines(lines: string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function findSequence(content: string[], expected: string[], startIndex: number): number {
  if (expected.length === 0) {
    return startIndex;
  }

  for (let index = startIndex; index <= content.length - expected.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (content[index + offset] !== expected[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }

  return -1;
}

function findHeader(content: string[], header: string | undefined, startIndex: number): number {
  if (!header) {
    return startIndex;
  }

  const index = content.findIndex((line, lineIndex) => lineIndex >= startIndex && line.includes(header));
  if (index === -1) {
    throw new PatchParseError(`Could not find hunk header context: ${header}`);
  }
  return index;
}

function applyHunks(content: string, hunks: PatchHunk[]): { content: string; addedLines: number; removedLines: number } {
  const parsed = splitFileLines(content);
  let lines = [...parsed.lines];
  let cursor = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of hunks) {
    cursor = findHeader(lines, hunk.header, cursor);
    if (hunk.lines.length === 0) {
      cursor = Math.min(lines.length, cursor + 1);
      continue;
    }

    const expected = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const replacement = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const foundIndex = hunk.endOfFile
      ? findSequence(lines, expected, Math.max(0, lines.length - expected.length))
      : findSequence(lines, expected, cursor);

    if (foundIndex === -1) {
      throw new PatchParseError(`Could not apply hunk${hunk.header ? ` near ${hunk.header}` : ""}; context did not match.`);
    }

    lines = [
      ...lines.slice(0, foundIndex),
      ...replacement,
      ...lines.slice(foundIndex + expected.length),
    ];
    addedLines += hunk.lines.filter((line) => line.kind === "add").length;
    removedLines += hunk.lines.filter((line) => line.kind === "remove").length;
    cursor = foundIndex + replacement.length;
  }

  return {
    content: joinFileLines(lines, parsed.trailingNewline),
    addedLines,
    removedLines,
  };
}

async function applyOperation(rootDir: string, operation: PatchOperation, options: WorkspacePatchOptions = {}): Promise<AppliedPatchFile> {
  if (operation.type === "add") {
    const path = await resolveNewPatchTarget(rootDir, operation.path, "Patch add target", options);
    const content = `${operation.lines.join("\n")}\n`;
    await writeFile(path, content, { flag: "wx" });
    return {
      path: visibleWorkspacePath(operation.path, options.mountPath),
      operation: "add",
      addedLines: operation.lines.length,
      removedLines: 0,
    };
  }

  if (operation.type === "delete") {
    const path = await resolveExistingPatchTarget(rootDir, operation.path, "Patch delete target", options);
    await rm(path);
    return {
      path: visibleWorkspacePath(operation.path, options.mountPath),
      operation: "delete",
    };
  }

  const sourcePath = await resolveExistingPatchTarget(rootDir, operation.path, "Patch update target", options);
  const original = await readFile(sourcePath, "utf8");
  const result = applyHunks(original, operation.hunks);
  const targetPath = operation.moveTo
    ? await resolveNewPatchTarget(rootDir, operation.moveTo, "Patch move target", options)
    : sourcePath;
  await writeFile(sourcePath, result.content);
  if (operation.moveTo) {
    await rename(sourcePath, targetPath);
  }

  return {
    path: visibleWorkspacePath(operation.moveTo ?? operation.path, options.mountPath),
    operation: operation.moveTo ? "move" : "update",
    addedLines: result.addedLines,
    removedLines: result.removedLines,
  };
}

export async function applyWorkspacePatch(
  rootDir: string,
  input: WorkspacePatchInput,
  options: WorkspacePatchOptions = {},
): Promise<WorkspacePatchResult> {
  const operations = parsePatch(input.input, options);
  const changedFiles: AppliedPatchFile[] = [];
  for (const operation of operations) {
    changedFiles.push(await applyOperation(rootDir, operation, options));
  }
  return {
    success: true,
    changedFiles,
  };
}
