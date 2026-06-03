import { createLogger, generateId, StorageError, type UserContext } from "@finn/core";
import type { Database, NewStoredFile, StoredFile } from "@finn/db";
import { fileFolders, files } from "@finn/db";
import { and, desc, eq, isNull, lt, or, sum, type SQL } from "drizzle-orm";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const logger = createLogger("file-storage");

export interface FileStorageOptions {
  storagePath: string;
  maxFileSizeMb: number;
  db: Database;
  user: UserContext;
}

export interface StoreFileInput {
  filename: string;
  mimeType: string;
  data: Buffer;
  userVisible?: boolean;
  folderId?: string | null;
  origin?: StoredFileOrigin;
}

export interface ListFilesOptions {
  userVisible?: boolean;
  folderId?: string | null;
}

export type StoredFileOrigin =
  | "user_upload"
  | "message_attachment"
  | "assistant_generated"
  | "worker_created"
  | "system";

export interface ListFilesCursor {
  updatedAt: string;
  createdAt: string;
  id: string;
}

export interface StoredFileContextItem {
  id: string;
  tenantId: string;
  userId: string;
  filename: string;
  mimeType: string;
  size: number;
  userVisible: boolean;
  origin: StoredFileOrigin;
  uploadedBy: "user" | "internal";
  folderId: string | null;
  path: string;
  storagePath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFilesPage {
  files: StoredFileContextItem[];
  nextCursor: string | null;
}

function sanitizeStoredFilename(value: string): string {
  const safe = basename(value).replace(/[^\w .@()-]+/g, "_").trim();
  return safe.length > 0 ? safe : `file-${Date.now()}`;
}

function isStoredFileOrigin(value: string): value is StoredFileOrigin {
  return ["user_upload", "message_attachment", "assistant_generated", "worker_created", "system"].includes(value);
}

function normalizeStoredFileOrigin(value: string): StoredFileOrigin {
  return isStoredFileOrigin(value) ? value : "system";
}

function uploadedByForOrigin(origin: StoredFileOrigin): "user" | "internal" {
  return origin === "user_upload" || origin === "message_attachment" ? "user" : "internal";
}

function encodeListFilesCursor(file: StoredFile): string {
  return Buffer.from(JSON.stringify({
    updatedAt: file.updatedAt.toISOString(),
    createdAt: file.createdAt.toISOString(),
    id: file.id,
  } satisfies ListFilesCursor), "utf8").toString("base64url");
}

function decodeListFilesCursor(cursor: string): ListFilesCursor {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ListFilesCursor>;
  if (!parsed.updatedAt || !parsed.createdAt || !parsed.id) {
    throw new StorageError("Invalid file pagination cursor.");
  }
  return {
    updatedAt: parsed.updatedAt,
    createdAt: parsed.createdAt,
    id: parsed.id,
  };
}

function buildFolderPath(folder: { id: string; name: string; parentId: string | null }, foldersById: Map<string, { id: string; name: string; parentId: string | null }>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: typeof folder | undefined = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? foldersById.get(current.parentId) : undefined;
  }
  return parts.join("/");
}

export class FileStorage {
  private readonly storagePath: string;
  private readonly maxFileSizeBytes: number;
  private readonly db: Database;
  private readonly user: UserContext;

  constructor(opts: FileStorageOptions) {
    this.storagePath = opts.storagePath;
    this.maxFileSizeBytes = opts.maxFileSizeMb * 1024 * 1024;
    this.db = opts.db;
    this.user = opts.user;
  }

  async store(input: StoreFileInput): Promise<StoredFile> {
    if (input.data.length > this.maxFileSizeBytes) {
      throw new StorageError(
        `File exceeds max size: ${input.data.length} bytes > ${this.maxFileSizeBytes} bytes`,
      );
    }
    await this.ensureOwnedFolder(input.folderId ?? null);

    const id = generateId("file");
    const owner = this.user;
    const filename = sanitizeStoredFilename(input.filename);
    const dirPath = join(this.storagePath, id);
    const filePath = join(dirPath, filename);

    await mkdir(dirPath, { recursive: true });

    try {
      await Bun.write(filePath, input.data);
    } catch (error) {
      throw new StorageError(
        `Failed to write file to disk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const now = new Date();
    const record: NewStoredFile = {
      id,
      tenantId: owner.tenantId,
      userId: owner.userId,
      filename,
      mimeType: input.mimeType,
      size: input.data.length,
      storagePath: filePath,
      userVisible: input.userVisible ?? false,
      folderId: input.folderId ?? null,
      origin: input.origin ?? "system",
      createdAt: now,
      updatedAt: now,
    };

    const [stored] = await this.db.insert(files).values(record).returning();

    logger.info({ fileId: id, filename, size: input.data.length }, "File stored");

    return stored;
  }

  async get(id: string): Promise<{ file: StoredFile; data: Buffer } | null> {
    const [record] = await this.db.select().from(files).where(this.ownerWhere(id)).limit(1);

    if (!record) return null;

    try {
      const data = await readFile(record.storagePath);
      return { file: record, data: Buffer.from(data) };
    } catch (error) {
      logger.error({ fileId: id, error }, "Failed to read file from disk");
      throw new StorageError(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(id: string): Promise<boolean> {
    const [record] = await this.db.select().from(files).where(this.ownerWhere(id)).limit(1);

    if (!record) return false;

    const dirPath = join(this.storagePath, id);

    try {
      await rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn({ fileId: id, error }, "Failed to remove file from disk");
    }

    await this.db.delete(files).where(this.ownerWhere(id));

    logger.info({ fileId: id }, "File deleted");
    return true;
  }

  async list(limit = 50, offset = 0, options: ListFilesOptions = {}): Promise<StoredFile[]> {
    return this.db
      .select()
      .from(files)
      .where(this.ownerWhere(undefined, options))
      .orderBy(desc(files.updatedAt), desc(files.createdAt), desc(files.id))
      .limit(limit)
      .offset(offset);
  }

  async listPage(limit = 20, cursor?: string, options: ListFilesOptions = {}): Promise<ListFilesPage> {
    const cappedLimit = Math.max(1, Math.min(limit, 100));
    const decodedCursor = cursor ? decodeListFilesCursor(cursor) : null;
    const cursorWhere = decodedCursor
      ? or(
          lt(files.updatedAt, new Date(decodedCursor.updatedAt)),
          and(eq(files.updatedAt, new Date(decodedCursor.updatedAt)), lt(files.createdAt, new Date(decodedCursor.createdAt))),
          and(eq(files.updatedAt, new Date(decodedCursor.updatedAt)), eq(files.createdAt, new Date(decodedCursor.createdAt)), lt(files.id, decodedCursor.id)),
        )
      : undefined;
    const rows = await this.db
      .select()
      .from(files)
      .where(and(this.ownerWhere(undefined, options), cursorWhere))
      .orderBy(desc(files.updatedAt), desc(files.createdAt), desc(files.id))
      .limit(cappedLimit + 1);
    const page = rows.slice(0, cappedLimit);
    const nextCursor = rows.length > cappedLimit && page.length > 0
      ? encodeListFilesCursor(page[page.length - 1]!)
      : null;

    return {
      files: await this.serializeFileContextItems(page),
      nextCursor,
    };
  }

  async setUserVisible(id: string, userVisible: boolean): Promise<StoredFile | null> {
    const [record] = await this.db
      .update(files)
      .set({ userVisible, updatedAt: new Date() })
      .where(this.ownerWhere(id))
      .returning();

    return record ?? null;
  }

  async moveToFolder(id: string, folderId: string | null): Promise<StoredFile | null> {
    await this.ensureOwnedFolder(folderId);

    const [record] = await this.db
      .update(files)
      .set({ folderId, updatedAt: new Date() })
      .where(this.ownerWhere(id))
      .returning();

    return record ?? null;
  }

  private async ensureOwnedFolder(folderId: string | null): Promise<void> {
    if (!folderId) {
      return;
    }

    const [folder] = await this.db
      .select({ id: fileFolders.id })
      .from(fileFolders)
      .where(and(
        eq(fileFolders.id, folderId),
        eq(fileFolders.tenantId, this.user.tenantId),
        eq(fileFolders.userId, this.user.userId),
      ))
      .limit(1);

    if (!folder) {
      throw new StorageError(`Folder not found for current user: ${folderId}`);
    }
  }

  async getMetadata(id: string): Promise<StoredFile | null> {
    const [record] = await this.db.select().from(files).where(this.ownerWhere(id)).limit(1);
    return record ?? null;
  }

  async getStorageStats(): Promise<{ totalFiles: number; totalSizeBytes: number }> {
    const [record] = await this.db
      .select({ totalSizeBytes: sum(files.size) })
      .from(files)
      .where(this.ownerWhere());
    const storedFiles = await this.list(10_000);

    return {
      totalFiles: storedFiles.length,
      totalSizeBytes: Number(record?.totalSizeBytes ?? 0),
    };
  }

  private async serializeFileContextItems(rows: StoredFile[]): Promise<StoredFileContextItem[]> {
    if (rows.length === 0) {
      return [];
    }

    const folders = await this.db
      .select({
        id: fileFolders.id,
        name: fileFolders.name,
        parentId: fileFolders.parentId,
      })
      .from(fileFolders)
      .where(and(
        eq(fileFolders.tenantId, this.user.tenantId),
        eq(fileFolders.userId, this.user.userId),
      ));
    const foldersById = new Map(folders.map((folder) => [folder.id, folder]));

    return rows.map((file) => {
      const origin = normalizeStoredFileOrigin(file.origin);
      const folderPath = file.folderId && foldersById.has(file.folderId)
        ? buildFolderPath(foldersById.get(file.folderId)!, foldersById)
        : "";
      const pathPrefix = file.userVisible ? "Library" : "Internal";
      const path = [pathPrefix, folderPath, file.filename].filter((part) => part.length > 0).join("/");
      return {
        id: file.id,
        tenantId: file.tenantId,
        userId: file.userId,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        userVisible: file.userVisible,
        origin,
        uploadedBy: uploadedByForOrigin(origin),
        folderId: file.folderId,
        path,
        storagePath: file.storagePath,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      };
    });
  }

  private ownerWhere(id?: string, options: ListFilesOptions = {}) {
    const clauses: SQL[] = [
      eq(files.tenantId, this.user.tenantId),
      eq(files.userId, this.user.userId),
    ];

    if (id) {
      clauses.push(eq(files.id, id));
    }
    if (options.userVisible !== undefined) {
      clauses.push(eq(files.userVisible, options.userVisible));
    }
    if (options.folderId !== undefined) {
      clauses.push(options.folderId === null ? isNull(files.folderId) : eq(files.folderId, options.folderId));
    }

    return and(...clauses);
  }
}
