import { WorkerToolOutputArtifactStore, formatUnknownError } from "@finn/core";
import { createCodeModeCatalog, formatCodeModeSearchResults, type CodeModeCatalog, type CodeModeCatalogEntry, type CodeModeCatalogOptions } from "@finn/toolsets";
import type { ToolsetRuntime } from "@finn/toolsets";
import { createInMemoryFileSystem, createNodeDriver, NodeExecutionDriver, type BindingTree, type Permissions, type VirtualFileSystem } from "secure-exec";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export interface CodeModeDispatch {
  (apiName: string, args: unknown): Promise<unknown>;
}

export interface CodeModeSearch {
  (query: string, options?: { limit?: number }): string;
}

export interface CodeModeExecutorInput {
  code: string;
  catalog: CodeModeCatalog;
  dispatch: CodeModeDispatch;
  search: CodeModeSearch;
  abortSignal?: AbortSignal;
}

export interface CodeModeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
}

export interface CodeModeExecutor {
  execute(input: CodeModeExecutorInput): Promise<CodeModeExecutionResult>;
  dispose?(): void | Promise<void>;
}

export interface CodeModeToolsOptions {
  executor?: CodeModeExecutor;
  artifacts?: WorkerToolOutputArtifactStore;
  catalog?: CodeModeCatalogOptions;
}

interface ActiveExecution {
  dispatch: CodeModeDispatch;
  search: CodeModeSearch;
  resolve(value: unknown): void;
  reject(error: string): void;
}

const codeSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().min(1).max(25).optional(),
}).strict();

const codeExecuteInputSchema = z.object({
  code: z.string().trim().min(1).max(200_000).describe("JavaScript body to run in the Finn workspace. Use return to emit the final value."),
}).strict();

function errorMessage(error: unknown): string {
  return formatUnknownError(error, { zodPrefix: "Tool input validation failed" });
}

function createSearch(catalog: CodeModeCatalog): CodeModeSearch {
  return (query, options = {}) => formatCodeModeSearchResults(catalog.search(query, options), {
    query,
    total: catalog.entries.length,
  });
}

function createDispatch(runtime: ToolsetRuntime, catalog: CodeModeCatalog, abortSignal?: AbortSignal): CodeModeDispatch {
  return async (apiName, args) => {
    const entry = catalog.resolve(apiName);
    if (!entry) {
      throw new Error(`Finn JS workspace API is not available in this runtime: ${apiName}`);
    }

    try {
      const executed = await runtime.execute({
        toolset: entry.toolset,
        command: entry.command,
        args,
      }, { abortSignal });
      return executed.result;
    } catch (error) {
      throw new Error(`Finn JS workspace API ${apiName} failed. ${errorMessage(error)}`);
    }
  };
}

function appendLog(logs: string[], channel: "stdout" | "stderr", message: string): void {
  const entry = `[${channel}] ${message}`;
  logs.push(entry.length > 8_000 ? `${entry.slice(0, 8_000)}\n[truncated]` : entry);
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100);
  }
}

function serializeSandboxError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "FinnApiError") {
      return error.message || error.name;
    }
    return error.stack || error.message || error.name;
  }
  if (typeof error === "object" && error !== null) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(error, (_key, entry) => {
        if (typeof entry === "bigint") {
          return entry.toString();
        }
        if (typeof entry === "function") {
          return `[Function ${entry.name || "anonymous"}]`;
        }
        if (typeof entry === "object" && entry !== null) {
          if (seen.has(entry)) {
            return "[Circular]";
          }
          seen.add(entry);
        }
        return entry;
      });
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return error === undefined || error === null ? "Unknown error" : String(error);
}

function buildFinnApiBootstrap(entries: readonly CodeModeCatalogEntry[]): string {
  const registrations = entries.map((entry) => {
    const path = JSON.stringify(entry.apiPath);
    const apiName = JSON.stringify(entry.apiName);
    return `__finnDefine(${path}, (input = {}) => __finnCall(${apiName}, input));`;
  });

  return `
const __finnHost = SecureExec.bindings.host;
const __finnRoot = Object.create(null);
function __finnThrowApiError(message) {
  const error = new Error(String(message || "Finn JS workspace API failed."));
  error.name = "FinnApiError";
  throw error;
}
async function __finnCall(apiName, input = {}) {
  const response = await __finnHost.call(apiName, input);
  return __finnReadHostResponse(response);
}
async function __finnSearch(query, options = {}) {
  const response = await __finnHost.search(query, options);
  return __finnReadHostResponse(response);
}
function __finnReadHostResponse(response) {
  if (!response || typeof response !== "object" || response.__finnHostCall !== true) {
    __finnThrowApiError("Finn JS workspace host returned an invalid API response.");
  }
  if (response.ok === true) {
    return response.value;
  }
  __finnThrowApiError(response.error);
}
function __finnDefine(path, fn) {
  let cursor = __finnRoot;
  for (const part of path.slice(0, -1)) {
    cursor[part] ??= Object.create(null);
    cursor = cursor[part];
  }
  cursor[path[path.length - 1]] = fn;
}
__finnRoot.search = (query, options = {}) => __finnSearch(query, options);
${registrations.join("\n")}
Object.defineProperty(globalThis, "finn", {
  value: __finnRoot,
  enumerable: true,
  configurable: false,
  writable: false,
});
`;
}

function wrapCodeForSecureExec(code: string, entries: readonly CodeModeCatalogEntry[]): string {
  return `
${buildFinnApiBootstrap(entries)}
async function __finnMain() {
${code}
}
try {
  const __finnValue = await __finnMain();
  await __finnHost.resolve(__finnValue === undefined ? null : __finnValue);
} catch (__finnError) {
  await __finnHost.reject((${serializeSandboxError.toString()})(__finnError));
}
`;
}

async function createSandboxFileSystem(): Promise<VirtualFileSystem> {
  const filesystem = createInMemoryFileSystem();
  await filesystem.mkdir("/root", { recursive: true });
  await filesystem.mkdir("/workspace", { recursive: true });
  await filesystem.mkdir("/artifacts", { recursive: true });
  await filesystem.mkdir("/tmp", { recursive: true });
  return filesystem;
}

function createSandboxPermissions(): Permissions {
  return {
    fs: () => ({ allow: true }),
    network: () => ({ allow: false, reason: "Finn JS workspace has no direct network access. Use an available finn.web or finn.mcp API instead." }),
    childProcess: () => ({ allow: false, reason: "Finn JS workspace cannot use that API." }),
    env: () => ({ allow: false, reason: "Finn JS workspace does not expose host environment variables." }),
  };
}

export class SecureExecCodeModeExecutor implements CodeModeExecutor {
  private driverPromise?: Promise<NodeExecutionDriver>;
  private activeExecution?: ActiveExecution;
  private executionQueue: Promise<void> = Promise.resolve();

  async execute(input: CodeModeExecutorInput): Promise<CodeModeExecutionResult> {
    const execution = this.executionQueue.then(
      () => this.executeNow(input),
      () => this.executeNow(input),
    );
    this.executionQueue = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private async executeNow(input: CodeModeExecutorInput): Promise<CodeModeExecutionResult> {
    const logs: string[] = [];
    if (input.abortSignal?.aborted) {
      return { success: false, error: "Finn JS workspace execution aborted.", logs };
    }

    let settled = false;
    let result: unknown = null;
    let executionError: string | undefined;
    const driver = await this.getDriver();
    this.activeExecution = {
      dispatch: input.dispatch,
      search: input.search,
      resolve: (value) => {
        settled = true;
        result = value;
      },
      reject: (error) => {
        settled = true;
        executionError = error;
      },
    };

    try {
      const executed = await driver.exec(wrapCodeForSecureExec(input.code, input.catalog.entries), {
        cwd: "/workspace",
        filePath: "/workspace/finn-code-mode.js",
        mode: "run",
        onStdio: (event) => appendLog(logs, event.channel, event.message),
      });
      if (executionError) {
        return { success: false, error: executionError, logs };
      }
      if (executed.code !== 0) {
        return {
          success: false,
          error: executed.errorMessage ?? `Workspace execution exited with code ${executed.code}.`,
          logs,
        };
      }
      return { success: true, result: settled ? result : null, logs };
    } catch (error) {
      return { success: false, error: errorMessage(error), logs };
    } finally {
      this.activeExecution = undefined;
    }
  }

  dispose(): void {
    void this.driverPromise?.then((driver) => driver.dispose()).catch(() => undefined);
    this.driverPromise = undefined;
  }

  private getDriver(): Promise<NodeExecutionDriver> {
    this.driverPromise ??= this.createDriver();
    return this.driverPromise;
  }

  private async createDriver(): Promise<NodeExecutionDriver> {
    const filesystem = await createSandboxFileSystem();
    const system = createNodeDriver({
      filesystem,
      permissions: createSandboxPermissions(),
    });
    const bindings: BindingTree = {
      host: {
        call: async (apiName: unknown, args: unknown) => {
          try {
            return {
              __finnHostCall: true,
              ok: true,
              value: await this.requireActiveExecution().dispatch(String(apiName), args),
            };
          } catch (error) {
            return {
              __finnHostCall: true,
              ok: false,
              error: errorMessage(error),
            };
          }
        },
        search: async (query: unknown, options: unknown) => {
          try {
            return {
              __finnHostCall: true,
              ok: true,
              value: this.requireActiveExecution().search(String(query), options as { limit?: number } | undefined),
            };
          } catch (error) {
            return {
              __finnHostCall: true,
              ok: false,
              error: errorMessage(error),
            };
          }
        },
        resolve: async (value: unknown) => {
          this.requireActiveExecution().resolve(value);
          return null;
        },
        reject: async (error: unknown) => {
          this.requireActiveExecution().reject(errorMessage(error));
          return null;
        },
      },
    };

    return new NodeExecutionDriver({
      system,
      runtime: system.runtime,
      bindings,
      memoryLimit: 128 * 1024 * 1024,
      cpuTimeLimitMs: 15_000,
      timingMitigation: "freeze",
      payloadLimits: {
        base64TransferBytes: 4 * 1024 * 1024,
        jsonPayloadBytes: 2 * 1024 * 1024,
      },
      resourceBudgets: {
        maxOutputBytes: 128 * 1024,
        maxBridgeCalls: 500,
        maxTimers: 100,
        maxChildProcesses: 0,
        maxHandles: 100,
      },
    });
  }

  private requireActiveExecution(): ActiveExecution {
    if (!this.activeExecution) {
      throw new Error("Finn JS workspace binding called outside an active execution.");
    }
    return this.activeExecution;
  }
}

export function createCodeModeTools(runtime: ToolsetRuntime, options: CodeModeToolsOptions = {}): ToolSet {
  const catalog = createCodeModeCatalog(runtime, options.catalog);
  if (catalog.entries.length === 0) {
    return {};
  }

  const executor = options.executor ?? new SecureExecCodeModeExecutor();
  const search = createSearch(catalog);

  return {
    workspace_search: tool({
      description: "Search the Finn JavaScript APIs available in this workspace. Use this before workspace_execute when you need tool schemas or API names.",
      inputSchema: codeSearchInputSchema,
      execute: async (input) => search(input.query, { limit: input.limit }),
    }),
    workspace_execute: tool({
      description: "Run JavaScript inside the Finn workspace. The workspace exposes typed Finn APIs under the global finn object, such as finn.files.read(...). Use return to emit the final value.",
      inputSchema: codeExecuteInputSchema,
      execute: async (input, toolOptions) => {
        const result = await executor.execute({
          code: input.code,
          catalog,
          dispatch: createDispatch(runtime, catalog, toolOptions.abortSignal),
          search,
          abortSignal: toolOptions.abortSignal,
        }).catch((error): CodeModeExecutionResult => ({
          success: false,
          error: errorMessage(error),
          logs: [],
        }));
        return options.artifacts?.replaceIfOversized("workspace_execute", result) ?? result;
      },
    }),
  };
}
