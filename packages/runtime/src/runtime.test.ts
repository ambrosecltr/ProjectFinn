import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesRuntime,
  createCreativeRuntimeService,
  downloadFileCommand,
  fetchWithValidatedAddresses,
  listFilesCommand,
  createProcessRuntimeServices,
  createUserRuntimeServices,
  createWebRuntimeService,
  listWorkspaceFiles,
  readFileCommand,
  viewImageCommand,
  writeFileCommand,
  maxViewImageModelBytes,
  type CreativeRuntimeClient,
  type FilesRuntime,
  type MemoryRuntimeService,
  type WorkspaceRuntimeService,
} from "./index.js";

let workspaceRoot: string | null = null;

function createWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), "finn-runtime-"));
  return workspaceRoot;
}

type RuntimeStoredFile = Awaited<ReturnType<NonNullable<FilesRuntime["storedFiles"]>["store"]>>;

function createStoredFile(id: string, filename: string, mimeType: string, size = 4): RuntimeStoredFile {
  return {
    id,
    tenantId: "tenant_test",
    userId: "usr_test",
    filename,
    mimeType,
    size,
    storagePath: join(workspaceRoot ?? createWorkspace(), "files", id, filename),
    userVisible: true,
    folderId: null,
    origin: "assistant_generated",
    createdAt: new Date("2026-05-18T00:00:00.000Z"),
    updatedAt: new Date("2026-05-18T00:00:00.000Z"),
  };
}

function createStoredFilesRuntime(options: { listStoredFiles?: boolean } = {}): { runtime: FilesRuntime; storedInputs: Array<{ filename: string; mimeType: string; data: Buffer; userVisible?: boolean; origin?: string }> } {
  const storedInputs: Array<{ filename: string; mimeType: string; data: Buffer; userVisible?: boolean; origin?: string }> = [];
  const workspace = createWorkspace();
  const listedFile = {
    ...createStoredFile("file_listed", "listed.txt", "text/plain", 6),
    path: "Library/listed.txt",
    uploadedBy: "internal" as const,
    origin: "assistant_generated" as const,
  };
  return {
    storedInputs,
    runtime: {
      kind: "finn-files-runtime",
      access: "write",
      workspaceRoot: workspace,
      documentExtractionAvailable: false,
      storedFileVisibilityAvailable: true,
      storedFiles: {
        get: async (id) => ({ file: createStoredFile(id, "source.png", "image/png"), data: Buffer.from("source") }),
        getMetadata: async (id) => createStoredFile(id, "source.png", "image/png"),
        store: async (input) => {
          storedInputs.push({
            filename: input.filename,
            mimeType: input.mimeType,
            data: Buffer.from(input.data),
            userVisible: input.userVisible,
            origin: input.origin,
          });
          return createStoredFile(`file_generated_${storedInputs.length}`, input.filename, input.mimeType, input.data.length);
        },
        list: async () => [],
        listPage: async () => ({ files: options.listStoredFiles ? [listedFile] : [], nextCursor: null }),
        setUserVisible: async () => null,
        moveToFolder: async () => null,
        delete: async () => false,
        urlFor: (file) => `https://app.test/files/${file.tenantId}/${file.userId}/${file.id}`,
      },
    },
  };
}

function createTestMemoryRuntime(): MemoryRuntimeService {
  return {
    kind: "finn-memory-runtime",
    provider: "test",
    user: { tenantId: "tenant_test", userId: "usr_test", timezone: "UTC" },
    recorder: {} as MemoryRuntimeService["recorder"],
    reflectAvailable: false,
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
  };
}

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = null;
  }
});

describe("runtime service builders", () => {
  it("fetches with validated addresses when the HTTP client requests all lookup results", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("generated");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected local HTTP server to have a TCP address.");
      }

      const response = await fetchWithValidatedAddresses(
        new URL(`http://creative-download.test:${address.port}/image.png`),
        [{ address: "127.0.0.1", family: 4 }],
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("generated");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("creates cheap process views while preserving shared service references", () => {
    const transport = async () => ({
      response: new Response("ok"),
    });
    const workspaceRoot = createWorkspace();
    const workspace: WorkspaceRuntimeService = { workspaceRoot, artifactsRoot: join(workspaceRoot, "..", "artifacts") };
    const memory = createTestMemoryRuntime();
    const files = createFilesRuntime({
      workspaceRoot: workspace.workspaceRoot,
      access: "write",
      downloadTransport: transport,
    });
    const userRuntime = createUserRuntimeServices({
      workspace,
      files,
      memory,
    });

    const writeProcess = createProcessRuntimeServices(userRuntime, {
      processType: "worker",
      runId: "wrk_write",
      filesAccess: "write",
      grants: ["memory"],
    });
    const readProcess = createProcessRuntimeServices(userRuntime, {
      processType: "my_day",
      runId: "myday_read",
      filesAccess: "read",
      grants: ["memory"],
    });

    expect(writeProcess.processType).toBe("worker");
    expect(writeProcess.runId).toBe("wrk_write");
    expect("userRuntime" in writeProcess).toBe(false);
    expect(writeProcess.workspace).toBe(workspace);
    expect(writeProcess.memory).toBe(memory);
    expect(writeProcess.files).toMatchObject({
      access: "write",
      workspaceRoot: files.workspaceRoot,
      artifactsRoot: join(workspace.artifactsRoot, "wrk_write"),
    });

    expect(readProcess.processType).toBe("my_day");
    expect(readProcess.runId).toBe("myday_read");
    expect("userRuntime" in readProcess).toBe(false);
    expect(readProcess.workspace).toBe(workspace);
    expect(readProcess.memory).toBe(memory);
    expect(readProcess.files).not.toBe(files);
    expect(readProcess.files?.access).toBe("read");
    expect(readProcess.files?.workspaceRoot).toBe(files.workspaceRoot);
    expect(readProcess.files?.artifactsRoot).toBe(join(workspace.artifactsRoot, "myday_read"));
    expect(readProcess.files?.downloads).toBe(files.downloads);
  });

  it("narrows files runtime to read-only for a process view", async () => {
    const { runtime: files } = createStoredFilesRuntime();
    const userRuntime = createUserRuntimeServices({
      workspace: files.workspaceRoot,
      files,
    });

    const processRuntime = createProcessRuntimeServices(userRuntime, {
      processType: "personal_intelligence",
      filesAccess: "read",
    });

    expect(processRuntime.files?.access).toBe("read");
    expect(userRuntime.files?.access).toBe("write");
    await expect(writeFileCommand(processRuntime.files!, {
      path: "blocked.txt",
      content: "nope",
    })).rejects.toThrow("/workspace mount is read-only");
    await expect(writeFileCommand(processRuntime.files!, {
      path: "/artifacts/read-only-note.txt",
      content: "artifact ok",
    })).resolves.toMatchObject({ success: true, path: "/artifacts/read-only-note.txt" });
    expect(readFileSync(join(processRuntime.files!.artifactsRoot!, "read-only-note.txt"), "utf8")).toBe("artifact ok");

    const downloadRuntime: FilesRuntime = {
      ...processRuntime.files!,
      downloads: {
        transport: async () => ({
          response: new Response("downloaded", { headers: { "content-type": "text/plain" } }),
          finalUrl: "https://example.com/report.txt",
        }),
      },
    };
    await expect(downloadFileCommand(downloadRuntime, {
      url: "https://example.com/report.txt",
    })).resolves.toMatchObject({
      success: true,
      path: expect.stringMatching(/^\/artifacts\/downloads\//),
      userVisible: false,
    });
    await expect(downloadFileCommand(downloadRuntime, {
      url: "https://example.com/report.txt",
      path: "/workspace/report.txt",
    })).rejects.toThrow("/workspace mount is read-only");
    await expect(downloadFileCommand(downloadRuntime, {
      url: "https://example.com/report.txt",
      path: "/artifacts/report.txt",
      userVisible: true,
    })).rejects.toThrow("user-visible");

    await expect(processRuntime.files!.storedFiles!.store({
      filename: "blocked.txt",
      mimeType: "text/plain",
      data: Buffer.from("nope"),
      origin: "worker_created",
    })).rejects.toThrow("Files runtime is read-only");
    await expect(processRuntime.files!.storedFiles!.setUserVisible("file_1", true)).rejects.toThrow("Files runtime is read-only");
    await expect(processRuntime.files!.storedFiles!.moveToFolder("file_1", null)).rejects.toThrow("Files runtime is read-only");
    await expect(processRuntime.files!.storedFiles!.delete("file_1")).rejects.toThrow("Files runtime is read-only");
  });

  it("rejects unsafe final URLs reported by custom file download transports", async () => {
    const runtime = createFilesRuntime({
      workspaceRoot: createWorkspace(),
      access: "write",
      downloadTransport: async () => ({
        response: new Response("downloaded", { headers: { "content-type": "text/plain" } }),
        finalUrl: "http://127.0.0.1/private.txt",
      }),
    });

    await expect(downloadFileCommand(runtime, {
      url: "https://93.184.216.34/report.txt",
    })).rejects.toThrow("private or local network");
  });

  it("blocks listing and reading Finn-internal .finn paths", async () => {
    const workspace = createWorkspace();
    const runtime = createFilesRuntime({
      workspaceRoot: workspace,
      access: "write",
      downloadTransport: async () => ({ response: new Response("downloaded") }),
    });
    const secretsDirectory = join(workspace, ".finn", "mcp-secrets");
    mkdirSync(secretsDirectory, { recursive: true });
    const secretPath = join(secretsDirectory, "secret.json");
    writeFileSync(secretPath, JSON.stringify({ token: "s3cr3t" }), "utf8");

    const root = await listWorkspaceFiles(runtime, { path: ".", includeHidden: true });
    expect(root.entries.some((entry) => entry.name === ".finn")).toBe(false);
    await expect(listWorkspaceFiles(runtime, { path: ".finn", includeHidden: true })).rejects.toThrow("Finn-internal path");
    await expect(readFileCommand(runtime, { path: ".finn/mcp-secrets/secret.json" })).rejects.toThrow("Finn-internal path");
    await expect(writeFileCommand(runtime, {
      path: ".finn/mcp-secrets/secret.json",
      content: JSON.stringify({ token: "overwritten" }),
    })).rejects.toThrow("Finn-internal path");
    await expect(downloadFileCommand(runtime, {
      url: "https://93.184.216.34/downloaded.txt",
      path: ".finn/mcp-secrets/downloaded.txt",
    })).rejects.toThrow("Finn-internal path");
    expect(readFileSync(secretPath, "utf8")).toBe(JSON.stringify({ token: "s3cr3t" }));
    symlinkSync(join(workspace, ".finn"), join(workspace, "secret-link"), "dir");
    await expect(writeFileCommand(runtime, {
      path: "secret-link/newdir/secret.json",
      content: JSON.stringify({ token: "created" }),
    })).rejects.toThrow("Finn-internal path");
    expect(existsSync(join(workspace, ".finn", "newdir"))).toBe(false);

    await expect(writeFileCommand(runtime, {
      path: ".finnish/allowed.txt",
      content: "ok",
    })).resolves.toMatchObject({ success: true });
    await expect(readFileCommand(runtime, { path: ".finnish/allowed.txt" }))
      .resolves.toMatchObject({ content: "ok" });
  });

  it("blocks Finn-internal paths when the workspace root is a symlink", async () => {
    const workspace = createWorkspace();
    const realWorkspace = join(workspace, "real");
    const symlinkWorkspace = join(workspace, "linked");
    const secretsDirectory = join(realWorkspace, ".finn", "mcp-secrets");
    mkdirSync(secretsDirectory, { recursive: true });
    writeFileSync(join(secretsDirectory, "secret.json"), JSON.stringify({ token: "s3cr3t" }), "utf8");
    symlinkSync(realWorkspace, symlinkWorkspace, "dir");

    const runtime = createFilesRuntime({ workspaceRoot: symlinkWorkspace, access: "read" });

    const root = await listWorkspaceFiles(runtime, { path: ".", includeHidden: true });
    expect(root.entries.some((entry) => entry.name === ".finn")).toBe(false);
    await expect(readFileCommand(runtime, { path: ".finn/mcp-secrets/secret.json" })).rejects.toThrow("Finn-internal path");
  });

  it("accepts mounted workspace and artifact paths in files commands", async () => {
    const workspace = createWorkspace();
    const artifactsRoot = join(workspace, "..", "artifacts", "run_paths");
    mkdirSync(join(workspace, "notes"), { recursive: true });
    mkdirSync(artifactsRoot, { recursive: true });
    writeFileSync(join(workspace, "notes", "todo.txt"), "workspace-mounted", "utf8");
    writeFileSync(join(artifactsRoot, "output.txt"), "artifact-mounted", "utf8");
    const runtime = createFilesRuntime({
      workspaceRoot: workspace,
      artifactsRoot,
      access: "write",
    });

    await expect(listWorkspaceFiles(runtime, { path: "/workspace/notes" }))
      .resolves.toMatchObject({ path: "/workspace/notes", entries: [expect.objectContaining({ path: "/workspace/notes/todo.txt" })] });
    await expect(readFileCommand(runtime, { path: "/workspace/notes/todo.txt" }))
      .resolves.toMatchObject({ path: "/workspace/notes/todo.txt", content: "workspace-mounted" });
    await expect(readFileCommand(runtime, { path: "/artifacts/output.txt" }))
      .resolves.toMatchObject({ path: "/artifacts/output.txt", content: "artifact-mounted" });
    await expect(writeFileCommand(runtime, {
      path: "/workspace/notes/written.txt",
      content: "written-mounted",
    })).resolves.toMatchObject({ path: "/workspace/notes/written.txt" });
    expect(readFileSync(join(workspace, "notes", "written.txt"), "utf8")).toBe("written-mounted");
    await expect(writeFileCommand(runtime, {
      path: "/artifacts/written.txt",
      content: "artifact-written",
    })).resolves.toMatchObject({ path: "/artifacts/written.txt" });
    expect(readFileSync(join(artifactsRoot, "written.txt"), "utf8")).toBe("artifact-written");
  });

  it("rejects VM-local /tmp paths in host files commands", async () => {
    const workspace = createWorkspace();
    const runtime = createFilesRuntime({ workspaceRoot: workspace, access: "write" });

    await expect(readFileCommand(runtime, { path: "/tmp/result.txt" })).rejects.toThrow("/tmp is disposable Secure Exec scratch");
    await expect(writeFileCommand(runtime, {
      path: "/tmp/result.txt",
      content: "nope",
    })).rejects.toThrow("/tmp is disposable Secure Exec scratch");
    await expect(downloadFileCommand(runtime, {
      url: "https://example.com/result.txt",
      path: "/tmp/result.txt",
    })).rejects.toThrow("/tmp is disposable Secure Exec scratch");
  });

  it("rejects writes through final symlinks before following their targets", async () => {
    const root = createWorkspace();
    const workspace = join(root, "workspace");
    const outsideDirectory = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outsideDirectory);
    const outsidePath = join(outsideDirectory, "escaped.txt");
    symlinkSync(outsidePath, join(workspace, "broken-link.txt"));
    const runtime = createFilesRuntime({ workspaceRoot: workspace, access: "write" });

    await expect(writeFileCommand(runtime, {
      path: "broken-link.txt",
      content: "escaped",
    })).rejects.toThrow("symbolic link");
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("rejects artifact writes through final symlinks before following their targets", async () => {
    const root = createWorkspace();
    const workspace = join(root, "workspace");
    const artifactsRoot = join(root, "artifacts", "run_symlink");
    const outsideDirectory = join(root, "outside-artifacts");
    mkdirSync(workspace);
    mkdirSync(outsideDirectory);
    const outsidePath = join(outsideDirectory, "escaped-artifact.txt");
    mkdirSync(artifactsRoot, { recursive: true });
    symlinkSync(outsidePath, join(artifactsRoot, "broken-link.txt"));
    const runtime = createFilesRuntime({ workspaceRoot: workspace, artifactsRoot, access: "read" });

    await expect(writeFileCommand(runtime, {
      path: "/artifacts/broken-link.txt",
      content: "escaped",
    })).rejects.toThrow("symbolic link");
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("uses artifacts for oversized view_image preparation in read-only runtimes", async () => {
    const workspace = createWorkspace();
    const artifactsRoot = join(workspace, "..", "artifacts", "run_view_image");
    mkdirSync(artifactsRoot, { recursive: true });
    writeFileSync(
      join(workspace, "large.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(maxViewImageModelBytes + 1, 0x61),
      ]),
    );
    const runtime = createFilesRuntime({ workspaceRoot: workspace, artifactsRoot, access: "read" });

    await viewImageCommand(runtime, { path: "large.png" }).catch(() => undefined);

    expect(existsSync(join(workspace, "tmp", "model-images"))).toBe(false);
    expect(existsSync(join(artifactsRoot, "tmp", "model-images"))).toBe(true);
  });

  it("lists workspace and artifacts separately for all file scopes", async () => {
    const workspace = createWorkspace();
    const artifactsRoot = join(workspace, "..", "artifacts", "run_all");
    mkdirSync(join(workspace, "notes"), { recursive: true });
    mkdirSync(artifactsRoot, { recursive: true });
    writeFileSync(join(workspace, "notes", "todo.txt"), "workspace", "utf8");
    writeFileSync(join(artifactsRoot, "output.txt"), "artifact", "utf8");
    const runtime = createFilesRuntime({ workspaceRoot: workspace, artifactsRoot, access: "read" });

    const result = await listFilesCommand(runtime, { scope: "all" });

    expect(result).toMatchObject({
      workspace: {
        path: "/workspace",
        entries: [expect.objectContaining({ path: "/workspace/notes" })],
      },
      artifacts: {
        path: "/artifacts",
        entries: [expect.objectContaining({ path: "/artifacts/output.txt" })],
      },
    });
  });

  it("uses libraryPath only as stored-file display metadata", async () => {
    const { runtime } = createStoredFilesRuntime({ listStoredFiles: true });

    const result = await listFilesCommand(runtime, { scope: "stored" });

    expect(result).toMatchObject({
      stored: {
        files: [expect.objectContaining({
          id: "file_listed",
          libraryPath: "Library/listed.txt",
        })],
      },
    });
    expect((result.stored as { files: Array<Record<string, unknown>> }).files[0]).not.toHaveProperty("path");
  });

  it("does not inherit optional services without explicit grants", () => {
    const workspaceRoot = createWorkspace();
    const workspace: WorkspaceRuntimeService = { workspaceRoot, artifactsRoot: join(workspaceRoot, "..", "artifacts") };
    const memory = createTestMemoryRuntime();
    const userRuntime = createUserRuntimeServices({
      workspace,
      files: createFilesRuntime({ workspaceRoot: workspace.workspaceRoot }),
      memory,
    });

    const processRuntime = createProcessRuntimeServices(userRuntime, {
      processType: "hot_path",
      filesAccess: "read",
    });

    expect(processRuntime.workspace).toBe(workspace);
    expect(processRuntime.files).toBeDefined();
    expect(processRuntime.memory).toBeUndefined();
  });

  it("attaches web runtime services only when explicitly granted", async () => {
    const webClient = {
      provider: "exa" as const,
      search: async () => ({
        provider: "exa" as const,
        results: [{
          id: "result_1",
          url: "https://example.com",
          title: "Example",
        }],
      }),
      getContents: async () => ({
        provider: "exa" as const,
        contents: [{
          url: "https://example.com",
          title: "Example",
          highlights: ["highlight"],
        }],
      }),
    };
    const web = createWebRuntimeService(webClient);
    const userRuntime = createUserRuntimeServices({
      workspace: createWorkspace(),
      web,
    });

    const withoutGrant = createProcessRuntimeServices(userRuntime, {
      processType: "worker",
    });
    const withGrant = createProcessRuntimeServices(userRuntime, {
      processType: "worker",
      grants: ["web"],
    });

    expect(withoutGrant.web).toBeUndefined();
    expect(withGrant.web).toBe(web);
    await expect(withGrant.web?.fetch("https://example.com")).resolves.toEqual(expect.objectContaining({
      provider: "exa",
      contents: [expect.objectContaining({ highlights: ["highlight"] })],
    }));
  });

  it("attaches creative runtime services only when explicitly granted", async () => {
    const creative = createCreativeRuntimeService({
      client: {
        generateImage: mock(async () => []),
        editImage: mock(async () => []),
        generateVideo: mock(async () => ({ url: "https://fal.test/video.mp4", contentType: "video/mp4" })),
        imageToVideo: mock(async () => ({ url: "https://fal.test/video.mp4", contentType: "video/mp4" })),
        editVideo: mock(async () => ({ url: "https://fal.test/video.mp4", contentType: "video/mp4" })),
      },
    });
    const userRuntime = createUserRuntimeServices({
      workspace: createWorkspace(),
      creative,
    });

    const withoutGrant = createProcessRuntimeServices(userRuntime, {
      processType: "worker",
    });
    const withGrant = createProcessRuntimeServices(userRuntime, {
      processType: "worker",
      grants: ["creative"],
    });

    expect(withoutGrant.creative).toBeUndefined();
    expect(withGrant.creative).toBe(creative);
  });

  it("stores generated creative media through the files runtime", async () => {
    const { runtime: files, storedInputs } = createStoredFilesRuntime();
    const client: CreativeRuntimeClient = {
      uploadMedia: mock(async () => "https://fal.upload/source.png"),
      generateImage: mock(async () => []),
      editImage: mock(async () => [{
        url: "https://93.184.216.34/image.png",
        contentType: "image/png",
        width: 1024,
        height: 1024,
      }]),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({
      client,
      files,
      fetchRemote: mock(async () => new Response(Buffer.from("generated"))),
    });

    const result = await creative.createOrEditImage({
      prompt: "brighten it",
      images: [{ fileId: "file_source" }],
      numImages: 1,
    });

    expect(client.editImage).toHaveBeenCalledWith({
      prompt: "brighten it",
      imageUrls: ["https://fal.upload/source.png"],
      imageSize: undefined,
      numImages: 1,
      quality: undefined,
      outputFormat: undefined,
    });
    expect(client.uploadMedia).toHaveBeenCalledWith({
      data: Buffer.from("source"),
      filename: "source.png",
      mimeType: "image/png",
    });
    expect(result).toMatchObject({
      fileIds: ["file_generated_1"],
      images: [{
        fileId: "file_generated_1",
        url: "https://app.test/files/tenant_test/usr_test/file_generated_1",
        remoteUrl: "https://93.184.216.34/image.png",
        contentType: "image/png",
        width: 1024,
        height: 1024,
      }],
      storedLocally: true,
    });
    expect(storedInputs[0]).toMatchObject({
      mimeType: "image/png",
      userVisible: true,
      origin: "assistant_generated",
    });
  });

  it("stores generated creative data URLs through the files runtime", async () => {
    const { runtime: files, storedInputs } = createStoredFilesRuntime();
    const client: CreativeRuntimeClient = {
      generateImage: mock(async () => [{
        url: "data:image/jpeg;base64,Z2VuZXJhdGVk",
        contentType: "image/jpeg",
      }]),
      editImage: mock(async () => []),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({ client, files });

    const result = await creative.createOrEditImage({ prompt: "make one", outputFormat: "jpeg" });

    expect(result).toMatchObject({
      fileIds: ["file_generated_1"],
      images: [{
        fileId: "file_generated_1",
        url: "https://app.test/files/tenant_test/usr_test/file_generated_1",
        remoteUrl: "data:image/jpeg;base64,<omitted>",
        contentType: "image/jpeg",
      }],
      storedLocally: true,
    });
    expect(storedInputs[0]).toMatchObject({
      filename: expect.stringMatching(/generated-image-\d+-1\.jpg/),
      mimeType: "image/jpeg",
      data: Buffer.from("generated"),
      userVisible: true,
      origin: "assistant_generated",
    });
  });

  it("accepts /workspace media references for creative tools", async () => {
    const { runtime: files } = createStoredFilesRuntime();
    mkdirSync(join(files.workspaceRoot, "tmp"), { recursive: true });
    writeFileSync(join(files.workspaceRoot, "tmp", "source.png"), "image-source", "utf8");
    const client: CreativeRuntimeClient = {
      uploadMedia: mock(async () => "https://fal.upload/workspace-source.png"),
      generateImage: mock(async () => []),
      editImage: mock(async () => []),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({ client, files });

    await creative.createOrEditImage({
      prompt: "use workspace source",
      images: [{ path: "/workspace/tmp/source.png" }],
    });

    expect(client.uploadMedia).toHaveBeenCalledWith({
      data: Buffer.from("image-source"),
      filename: "source.png",
      mimeType: "image/png",
    });
  });

  it("passes reference images to text-to-video generation", async () => {
    const { runtime: files } = createStoredFilesRuntime();
    const client: CreativeRuntimeClient = {
      uploadMedia: mock(async () => "https://fal.upload/reference.png"),
      generateImage: mock(async () => []),
      editImage: mock(async () => []),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({
      client,
      files,
      fetchRemote: mock(async () => new Response(Buffer.from("video"))),
    });

    await creative.createOrEditVideo({
      prompt: "make a product reveal",
      referenceImages: [{ fileId: "file_reference" }],
      duration: "5",
    });

    expect(client.generateVideo).toHaveBeenCalledWith({
      prompt: "make a product reveal",
      imageUrls: ["https://fal.upload/reference.png"],
      resolution: undefined,
      duration: "5",
      aspectRatio: undefined,
      generateAudio: undefined,
    });
    expect(client.imageToVideo).not.toHaveBeenCalled();
    expect(client.editVideo).not.toHaveBeenCalled();
  });

  it("rejects /tmp media references for creative tools", async () => {
    const { runtime: files } = createStoredFilesRuntime();
    const client: CreativeRuntimeClient = {
      uploadMedia: mock(async () => "https://fal.upload/source.png"),
      generateImage: mock(async () => []),
      editImage: mock(async () => []),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({ client, files });

    await expect(creative.createOrEditImage({
      prompt: "use tmp source",
      images: [{ path: "/tmp/source.png" }],
    })).rejects.toThrow("/tmp is disposable Secure Exec scratch");
  });

  it("rejects generated creative media that redirects to private network URLs", async () => {
    const { runtime: files } = createStoredFilesRuntime();
    const client: CreativeRuntimeClient = {
      generateImage: mock(async () => [{
        url: "https://93.184.216.34/image.png",
        contentType: "image/png",
      }]),
      editImage: mock(async () => []),
      generateVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      imageToVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
      editVideo: mock(async () => ({ url: "https://93.184.216.34/video.mp4", contentType: "video/mp4" })),
    };
    const creative = createCreativeRuntimeService({
      client,
      files,
      fetchRemote: mock(async () => new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private.png" },
      })),
    });

    await expect(creative.createOrEditImage({ prompt: "make one" }))
      .rejects.toThrow("Media URLs from private or local network addresses are not allowed.");
  });
});
