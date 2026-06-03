import type { Attachment } from "@finn/core";

const localPathPrefix = "local path:";
export const workspaceApiPathPrefix = "/workspace/";
const storedFilesWorkspacePrefix = `${workspaceApiPathPrefix}files/`;

export function normalizeWorkspaceRelativePath(path: string): string | null {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0] === ".finn" || parts.some((part) => part === "." || part === "..")) {
    return null;
  }

  return parts.join("/");
}

export function workspacePathFromStoragePath(storagePath?: string): string | null {
  if (!storagePath) {
    return null;
  }

  const normalizedPath = storagePath.replace(/\\/g, "/");
  const markerIndex = normalizedPath.lastIndexOf(storedFilesWorkspacePrefix);
  if (markerIndex === -1) {
    return null;
  }

  return normalizeWorkspaceRelativePath(normalizedPath.slice(markerIndex + workspaceApiPathPrefix.length));
}

export function toWorkspaceApiPath(workspacePath: string): string {
  return `${workspaceApiPathPrefix}${workspacePath}`;
}

export function getAttachmentWorkspacePath(attachment: Attachment): string | null {
  return workspacePathFromStoragePath(attachment.storagePath);
}

export function formatAttachmentWorkspacePathLines(attachment: Attachment): string[] {
  const workspacePath = getAttachmentWorkspacePath(attachment);
  if (!workspacePath) {
    return [];
  }

  return [`workspace path: ${toWorkspaceApiPath(workspacePath)}`];
}

function sanitizeModelVisibleWorkspacePathLine(line: string): string[] {
  const localPathIndex = line.indexOf(localPathPrefix);
  if (localPathIndex === -1) {
    return [line];
  }

  const storagePath = line.slice(localPathIndex + localPathPrefix.length).trim();
  const workspacePath = workspacePathFromStoragePath(storagePath);
  if (!workspacePath) {
    return [];
  }

  const prefix = line.slice(0, localPathIndex);
  return [`${prefix}workspace path: ${toWorkspaceApiPath(workspacePath)}`];
}

export function sanitizeModelVisibleWorkspacePaths(text: string): string {
  const sanitizedLines: string[] = [];
  let blockMode: "none" | "xml_attachment_context" | "inline_attachment_block" = "none";

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("<attachment_context")) {
      blockMode = "xml_attachment_context";
    } else if (trimmedLine.startsWith("[attachment |")) {
      blockMode = "inline_attachment_block";
    }

    sanitizedLines.push(...(blockMode !== "none" ? sanitizeModelVisibleWorkspacePathLine(line) : [line]));

    if (blockMode === "xml_attachment_context" && trimmedLine.startsWith("</attachment_context>")) {
      blockMode = "none";
    } else if (blockMode === "inline_attachment_block" && trimmedLine.length === 0) {
      blockMode = "none";
    }
  }

  return sanitizedLines.join("\n");
}
