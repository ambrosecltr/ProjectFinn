import { describe, expect, it } from "bun:test";
import type { Attachment } from "@finn/core";

import {
  getAttachmentWorkspacePath,
  sanitizeModelVisibleWorkspacePaths,
  workspacePathFromStoragePath,
} from "./workspace-paths.js";

describe("workspacePathFromStoragePath", () => {
  it("preserves nested workspace path segments after the workspace root", () => {
    expect(workspacePathFromStoragePath(
      "/data/workspaces/tenant_test/usr_test/workspace/files/file_image/workspace/IMG_3853.jpg",
    )).toBe("files/file_image/workspace/IMG_3853.jpg");
  });

  it("anchors to the stored files mount when the runtime root contains workspace", () => {
    expect(workspacePathFromStoragePath(
      "/srv/workspace/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
    )).toBe("files/file_image/IMG_3853.jpg");
  });
});

describe("getAttachmentWorkspacePath", () => {
  const attachment: Attachment = {
    id: "att_123",
    url: "file://attachment",
    mimeType: "image/jpeg",
    filename: "IMG_3853.jpg",
    fileId: "file_image",
  };

  it("returns null instead of inventing a path when storage is not workspace-backed", () => {
    expect(getAttachmentWorkspacePath(attachment)).toBeNull();
    expect(getAttachmentWorkspacePath({
      ...attachment,
      storagePath: "/tmp/finn-attachments/file_image/IMG_3853.jpg",
    })).toBeNull();
  });

  it("returns the workspace-relative path when storage is workspace-backed", () => {
    expect(getAttachmentWorkspacePath({
      ...attachment,
      storagePath: "/data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
    })).toBe("files/file_image/IMG_3853.jpg");
  });
});

describe("sanitizeModelVisibleWorkspacePaths", () => {
  it("keeps sanitizing XML attachment contexts across blank lines", () => {
    const sanitized = sanitizeModelVisibleWorkspacePaths([
      '<attachment_context handle="msg_123">',
      "filename: IMG_3853.jpg",
      "",
      "local path: /data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
      "</attachment_context>",
    ].join("\n"));

    expect(sanitized).not.toContain("/data/workspaces");
    expect(sanitized).not.toContain("local path:");
    expect(sanitized).toContain("workspace path: /workspace/files/file_image/IMG_3853.jpg");
    expect(sanitized.match(/workspace path:/g)).toHaveLength(1);
  });

  it("still ends inline attachment sanitization on a blank line", () => {
    const text = [
      "[attachment | handle:msg_123]",
      "local path: /data/workspaces/tenant_test/usr_test/workspace/files/file_image/IMG_3853.jpg",
      "",
      "my local path: /Users/test/Documents/note.txt",
    ].join("\n");

    const sanitized = sanitizeModelVisibleWorkspacePaths(text);

    expect(sanitized).toContain("workspace path: /workspace/files/file_image/IMG_3853.jpg");
    expect(sanitized).toContain("my local path: /Users/test/Documents/note.txt");
  });
});
