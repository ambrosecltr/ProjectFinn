import { describe, expect, it, mock } from "bun:test";

import { createFileRoutes } from "./files.js";

describe("file routes", () => {
  it("serves stored files from scoped bare and .caf voice-note URLs", async () => {
    const filesRuntime = {
      storedFiles: {
        get: mock(async () => ({
          file: {
            id: "file_voice",
            tenantId: "tenant_test",
            userId: "usr_test",
            filename: "voice-response.caf",
            mimeType: "audio/x-caf",
            size: 4,
          },
          data: Buffer.from("test"),
        })),
      },
    };
    const getFilesRuntime = mock(async () => filesRuntime);

    const app = createFileRoutes({ runtimes: { getFilesRuntime } } as never);

    const bareResponse = await app.request("http://localhost/tenant_test/usr_test/file_voice");
    expect(bareResponse.status).toBe(200);
    expect(bareResponse.headers.get("Content-Type")).toBe("audio/x-caf");
    expect(bareResponse.headers.get("Content-Disposition")).toBe('inline; filename="voice-response.caf"');
    expect(bareResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(bareResponse.headers.get("Content-Security-Policy")).toBe("sandbox");

    const cafResponse = await app.request("http://localhost/tenant_test/usr_test/file_voice.caf");
    expect(cafResponse.status).toBe(200);
    expect(cafResponse.headers.get("Content-Type")).toBe("audio/x-caf");
    expect(cafResponse.headers.get("Content-Disposition")).toBe('inline; filename="voice-response.caf"');

    expect(getFilesRuntime).toHaveBeenCalledWith({
      tenantId: "tenant_test",
      userId: "usr_test",
    });
    expect(filesRuntime.storedFiles.get).toHaveBeenCalledTimes(2);
  });

  it("escapes stored filenames before writing response headers", async () => {
    const filesRuntime = {
      storedFiles: {
        get: mock(async () => ({
          file: {
            id: "file_bad",
            tenantId: "tenant_test",
            userId: "usr_test",
            filename: "bad\"\r\nX-Evil: yes.txt",
            mimeType: "text/plain",
            size: 4,
          },
          data: Buffer.from("test"),
        })),
      },
    };
    const app = createFileRoutes({ runtimes: { getFilesRuntime: async () => filesRuntime } } as never);

    const response = await app.request("http://localhost/tenant_test/usr_test/file_bad");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="bad___X-Evil: yes.txt"');
    expect(response.headers.get("X-Evil")).toBeNull();
  });

  it("does not serve legacy unscoped file URLs", async () => {
    const filesRuntime = {
      storedFiles: {
        get: mock(async () => null),
      },
    };

    const app = createFileRoutes({ runtimes: { getFilesRuntime: async () => filesRuntime } } as never);
    const response = await app.request("http://localhost/file_voice");

    expect(response.status).toBe(404);
    expect(filesRuntime.storedFiles.get).not.toHaveBeenCalled();
  });

  it("returns not found when scoped user runtime lookup fails", async () => {
    const getFilesRuntime = mock(async () => {
      throw new Error("User not found: usr_missing");
    });
    const app = createFileRoutes({ runtimes: { getFilesRuntime } } as never);

    const response = await app.request("http://localhost/tenant_test/usr_missing/file_voice");

    expect(response.status).toBe(404);
  });

  it("returns internal server error when files runtime resolution fails unexpectedly", async () => {
    const getFilesRuntime = mock(async () => {
      throw new Error("database unavailable");
    });
    const app = createFileRoutes({ runtimes: { getFilesRuntime } } as never);

    const response = await app.request("http://localhost/tenant_test/usr_test/file_voice");

    expect(response.status).toBe(500);
  });
});
