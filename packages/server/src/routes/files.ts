import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { createHash } from "node:crypto";
import { createLogger } from "@finn/core";
import type { UserRuntimeRegistry } from "../user-runtime.js";

const logger = createLogger("file-routes");

interface FileRoutesDeps {
  runtimes: Pick<UserRuntimeRegistry, "getFilesRuntime">;
}

function contentDispositionFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, "_");
}

async function serveStoredFile(deps: FileRoutesDeps, user: { tenantId: string; userId: string }, id: string, c: Context) {
  let filesRuntime: Awaited<ReturnType<FileRoutesDeps["runtimes"]["getFilesRuntime"]>>;
  try {
    filesRuntime = await deps.runtimes.getFilesRuntime(user);
  } catch (error) {
    if (isMissingScopedFileOwner(error)) {
      return c.json({ error: "File not found" }, 404);
    }
    logger.error({ error, tenantId: user.tenantId, userId: user.userId, fileId: id }, "Failed to resolve files runtime");
    return c.json({ error: "Internal server error" }, 500);
  }
  if (!filesRuntime) {
    return c.json({ error: "File not found" }, 404);
  }
  const result = await filesRuntime.storedFiles?.get(id);

  if (!result) {
    return c.json({ error: "File not found" }, 404);
  }

  c.header("Content-Type", result.file.mimeType);
  c.header("Content-Length", result.file.size.toString());
  c.header("Content-Disposition", `inline; filename="${contentDispositionFilename(result.file.filename)}"`);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "sandbox");
  c.header("ETag", `"${createHash("sha256").update(result.data).digest("base64url")}"`);

  return stream(c, async (s) => {
    await s.write(result.data);
  });
}

function isMissingScopedFileOwner(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith("User not found:") || error.message.startsWith("Runtime tenant mismatch"));
}

export function createFileRoutes(deps: FileRoutesDeps) {
  const app = new Hono();

  app.get("/:tenantId/:userId/:voiceFile{.+\\.caf}", async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");
    const voiceFile = c.req.param("voiceFile");
    if (!tenantId || !userId || !voiceFile) {
      return c.json({ error: "File not found" }, 404);
    }
    const id = voiceFile.slice(0, -4);
    return serveStoredFile(deps, { tenantId, userId }, id, c);
  });

  app.get("/:tenantId/:userId/:id", async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");
    const id = c.req.param("id");
    if (!tenantId || !userId || !id) {
      return c.json({ error: "File not found" }, 404);
    }
    return serveStoredFile(deps, { tenantId, userId }, id, c);
  });

  return app;
}
