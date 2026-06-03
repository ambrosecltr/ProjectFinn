export interface StoredFileUrlOwner {
  tenantId: string;
  userId: string;
  id: string;
}

function buildStoredFilePath(file: StoredFileUrlOwner, extension = ""): string {
  return [file.tenantId, file.userId, `${file.id}${extension}`]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function buildStoredFileUrl(publicUrl: string, file: StoredFileUrlOwner): string {
  return `${publicUrl.replace(/\/+$/, "")}/files/${buildStoredFilePath(file)}`;
}

export function buildStoredVoiceFileUrl(publicUrl: string, file: StoredFileUrlOwner): string {
  return `${publicUrl.replace(/\/+$/, "")}/files/${buildStoredFilePath(file, ".caf")}`;
}
