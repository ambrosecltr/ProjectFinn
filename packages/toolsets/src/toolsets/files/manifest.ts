import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import {
  downloadFileInputSchema,
  extractFileInputSchema,
  listFilesInputSchema,
  patchFileInputSchema,
  readFileInputSchema,
  searchFileInputSchema,
  setFileVisibilityInputSchema,
  writeFileInputSchema,
} from "./schemas.js";

export interface FilesManifestOptions {
  processTypes: ToolsetProcessType[];
  documentExtraction?: boolean;
  storedFileVisibility?: boolean;
}

export function createFilesManifest(options: FilesManifestOptions): ToolsetManifest {
  const extractCommands: ToolsetCommandDefinition[] = options.documentExtraction === false
    ? []
    : [{
        name: "extract",
        description: "Extract text or markdown from documents, spreadsheets, HTML, PDFs, Office files, stored file IDs, or connector URLs.",
        effects: ["read"],
        inputSchema: extractFileInputSchema,
        argumentGuidance: [
          "Provide exactly one source: path for a workspace-relative, /workspace/..., or /artifacts/... path, fileId for a stored Finn file, or url for a connector-provided/public document URL.",
          "maxCharacters and offset page through large extracted text. Use ocrMode auto unless scanned/flattened PDFs need always or never.",
        ],
        examples: [
          { purpose: "Extract a PDF already stored in Finn Library", code: "await finn.files.extract({ fileId: \"file_123\", maxCharacters: 12000 })" },
          { purpose: "Extract a downloaded workspace document", code: "await finn.files.extract({ path: \"/workspace/tmp/downloads/report.pdf\", ocrMode: \"auto\" })" },
          { purpose: "Extract a connector-provided document URL", code: "await finn.files.extract({ url: \"https://example.com/report.pdf\", maxCharacters: 8000 })" },
        ],
        outputGuidance: [
          "Large documents may return a slice plus continuation metadata; continue with offset when the answer depends on later sections.",
        ],
      }];
  const visibilityCommands: ToolsetCommandDefinition[] = options.storedFileVisibility === false
    ? []
    : [{
        name: "set_visibility",
        description: "Show or hide one stored Finn file in the user's Library.",
        effects: ["write"],
        inputSchema: setFileVisibilityInputSchema,
        argumentGuidance: [
          "Use only stored Finn file IDs with fileId; workspace paths cannot be made visible directly with this API.",
          "Use userVisible true for deliverables the user should see and false for internal artifacts that should stay hidden.",
        ],
        examples: [
          { purpose: "Show a generated deliverable in Library", code: "await finn.files.setVisibility({ fileId: \"file_123\", userVisible: true })" },
          { purpose: "Hide an internal stored file", code: "await finn.files.setVisibility({ fileId: \"file_123\", userVisible: false })" },
        ],
        outputGuidance: [
          "Use the returned file record as the source of truth for userVisible state and file metadata.",
        ],
      }];
  const commands: ToolsetCommandDefinition[] = [
    {
      name: "list",
      description: "List stored files, workspace files, temporary artifacts, or all available file scopes.",
      effects: ["read"],
      inputSchema: listFilesInputSchema,
      argumentGuidance: [
        "scope stored lists Finn Library files, workspace lists workspace paths, artifacts lists temporary /artifacts outputs, and all combines visible scopes.",
        "path narrows workspace or artifact listing. Use workspace-relative or /workspace/... paths for user files and /artifacts/... paths for run artifacts.",
        "Stored file list entries use libraryPath for display only; pass their fileId to later API calls, not libraryPath as path.",
        "userVisible filters stored files by Library visibility when stored files are included.",
      ],
      examples: [
        { purpose: "Find recent files and artifacts", code: "await finn.files.list({ scope: \"all\", limit: 20 })" },
        { purpose: "List temporary artifacts for a run", code: "await finn.files.list({ scope: \"artifacts\", path: \"/artifacts\", limit: 20 })" },
        { purpose: "List visible Library files only", code: "await finn.files.list({ scope: \"stored\", userVisible: true, limit: 20 })" },
      ],
      outputGuidance: [
        "Use returned file IDs as fileId and returned workspace paths as path in later API calls.",
        "If a cursor is returned, call finn.files.list again with cursor to continue.",
      ],
    },
    {
      name: "read",
      description: "Read a UTF-8 slice from a workspace path or stored Finn file ID.",
      effects: ["read"],
      inputSchema: readFileInputSchema,
      argumentGuidance: [
        "Provide exactly one of path or fileId.",
        "path must be a workspace-relative user file path such as drafts/reply.txt, a /workspace/... user file path, or a returned /artifacts/... run artifact path. Never use other absolute paths.",
        "fileId is for stored Finn files returned by finn.files.list or file-producing tools, such as file_123.",
        "Use maxBytes and offset to inspect large files in slices.",
      ],
      examples: [
        { purpose: "Read a stored Library text file", code: "await finn.files.read({ fileId: \"file_123\", maxBytes: 4000 })" },
        { purpose: "Read a run artifact slice", code: "await finn.files.read({ path: \"/artifacts/output.txt\", maxBytes: 6000, offset: 0 })" },
      ],
      outputGuidance: [
        "Read text from result.content. The result also includes path/fileId, offset, sizeBytes, truncated, and nextOffset metadata when available.",
        "If the result is truncated or more content is needed, call finn.files.read again with the next offset.",
      ],
    },
    {
      name: "search",
      description: "Search a UTF-8 workspace file or stored Finn file ID and return compact matching lines.",
      effects: ["read"],
      inputSchema: searchFileInputSchema,
      argumentGuidance: [
        "Provide exactly one of path or fileId.",
        "Use query for a literal keyword, ID, date, or name. Prefer search before reading large tool-output artifacts.",
        "Use contextLines 1 or 2 only when surrounding lines are needed.",
      ],
      examples: [
        { purpose: "Search a temporary artifact for an invoice number", code: "await finn.files.search({ path: \"/artifacts/output.txt\", query: \"INV-1042\", contextLines: 2 })" },
        { purpose: "Search a stored text file case-sensitively", code: "await finn.files.search({ fileId: \"file_123\", query: \"Project Atlas\", caseSensitive: true })" },
      ],
      outputGuidance: [
        "Search returns compact matches; use finn.files.read with an offset only when you need a larger surrounding slice.",
      ],
    },
    ...extractCommands,
    ...visibilityCommands,
    {
      name: "write",
      description: "Write or append UTF-8 content to a /workspace user file or /artifacts run artifact.",
      effects: ["write"],
      inputSchema: writeFileInputSchema,
      argumentGuidance: [
        "path is a workspace-relative, /workspace/..., or /artifacts/... destination. Use /artifacts for temporary run outputs and /workspace for user workspace files.",
        "If /workspace is read-only in this process, writes to /workspace will fail; write temporary files under /artifacts.",
        "Never pass /tmp paths to files APIs. /tmp is workspace-local scratch, not a Finn files path.",
        "content is the exact UTF-8 text to write. Prefer finn.files.patch for complex code edits when available.",
        "append true appends instead of replacing. userVisible true is valid only for /workspace destinations and stores a visible Library copy for user-facing deliverables.",
      ],
      examples: [
        { purpose: "Write a hidden draft in the workspace", code: "await finn.files.write({ path: \"drafts/reply.txt\", content: \"Thanks, I will take a look.\", userVisible: false })" },
        { purpose: "Write a temporary artifact in a read-only process", code: "await finn.files.write({ path: \"/artifacts/notes.txt\", content: \"Checked invoice email\" })" },
        { purpose: "Create a visible text deliverable", code: "await finn.files.write({ path: \"reports/summary.md\", content: \"# Summary\", userVisible: true, mimeType: \"text/markdown\" })" },
      ],
      outputGuidance: [
        "The result includes the written path and may include a stored fileId when the content was stored in Finn Library.",
        "Use returned paths or file IDs exactly in follow-up files APIs.",
      ],
    },
    {
      name: "patch",
      description: "Apply a structured patch to /workspace user files or /artifacts run artifacts.",
      effects: ["write"],
      inputSchema: patchFileInputSchema,
      argumentGuidance: [
        "input must contain the full patch text from *** Begin Patch through *** End Patch.",
        "Patch paths may be workspace-relative, /workspace/..., or /artifacts/... paths. Do not mix /workspace and /artifacts paths in one patch.",
        "If /workspace is read-only in this process, patches to /workspace will fail; patch /artifacts for temporary run files.",
        "Never target /tmp, other absolute paths, parent directories, symlinks, or Finn internal files.",
        "Prefer this API for code and multi-line edits.",
      ],
      examples: [
        { purpose: "Edit a workspace file with a structured patch", code: "await finn.files.patch({ input: \"*** Begin Patch\\n*** Update File: notes.txt\\n@@\\n-old\\n+new\\n*** End Patch\\n\" })" },
      ],
      outputGuidance: [
        "The result lists changed files and line counts. Read changed files after applying if you need to verify exact content.",
      ],
    },
    {
      name: "download",
      description: "Download a public or connector-provided URL into /workspace or /artifacts for later files commands.",
      effects: ["read", "write"],
      inputSchema: downloadFileInputSchema,
      argumentGuidance: [
        "url must be http(s). The runtime rejects private/local/internal network targets and unsafe redirects.",
        "Use path /artifacts/... for temporary downloads in read-only processes. Use path /workspace/... or a workspace-relative path only when /workspace is writable.",
        "When path is omitted, writable processes default to hidden /workspace/tmp/downloads and read-only processes default to /artifacts/downloads when artifacts are available.",
        "userVisible true is valid only when downloading to /workspace; /artifacts downloads are temporary and cannot be shown in Library.",
        "Never pass /tmp paths to files APIs. Use /artifacts for temporary downloads that Finn files APIs need to read later.",
      ],
      examples: [
        { purpose: "Download a document for internal extraction in a read-only process", code: "await finn.files.download({ url: \"https://example.com/report.pdf\", path: \"/artifacts/report.pdf\", userVisible: false })" },
        { purpose: "Download a user-visible deliverable", code: "await finn.files.download({ url: \"https://example.com/photo.png\", path: \"/workspace/files/photo.png\", userVisible: true })" },
      ],
      outputGuidance: [
        "Use the returned path for follow-up read/extract calls, or the returned fileId when the download was stored in Finn Library.",
        "If download fails, inspect the error before retrying; do not assume private or redirected URLs are allowed.",
      ],
    },
  ];

  return {
    slug: "files",
    displayName: "Files",
    description: "Finn JS workspace access to scoped Finn workspace files, stored Library files, and temporary tool-output artifacts.",
    capability: "write",
    effects: ["read", "write"],
    runtimeRequirements: ["files", "workspace", "artifacts"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset for scoped Finn Library files, /workspace user files, and temporary /artifacts tool-output artifacts.",
        "Use the loaded API list to choose text reads/searches, document extraction when available, downloads, patches, writes, and visibility changes.",
        "Files APIs can read and write only /workspace and /artifacts paths. /tmp is workspace-local scratch, not a Finn files path.",
      ],
      referenceFormats: [
        "Stored Finn file IDs look like file_123 and must be passed as fileId.",
        "Workspace paths are relative paths such as drafts/reply.txt or mounted paths such as /workspace/drafts/reply.txt. Run artifact paths start with /artifacts/ and must be passed as path exactly as returned.",
        "Document URLs are passed as url only on APIs whose schema includes a url field.",
      ],
      syntaxRules: [
        "For source arguments, provide exactly one accepted source field for the API you are using.",
        "Boolean fields use true or false, for example userVisible: false.",
        "Pass paths, URLs, queries, and content exactly as JavaScript string values.",
      ],
      safetyRules: [
        "Never use absolute paths except the mounted /workspace/... and /artifacts/... paths described here.",
        "/workspace may be read-only for this process. If a /workspace write fails, use /artifacts for temporary outputs or ask for a write-capable process before modifying user files.",
        "/tmp is disposable workspace scratch and is not available through files commands. Use /artifacts for scratch that files commands need to read later.",
      ],
    },
    defaultLimit: 200,
    maxLimit: 1_000,
    commands,
  };
}
