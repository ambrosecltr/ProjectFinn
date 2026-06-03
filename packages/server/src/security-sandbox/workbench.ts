import { createFilesRuntime, createUserRuntimeServices } from "@finn/runtime";
import type { CodeModeToolsetSummary } from "@finn/toolsets/registry";
import type { ToolsetProcessType } from "@finn/toolsets/types";
import type { CodeModeExecutionResult, CodeModeExecutor } from "@finn/tools/code-mode";
import type { ToolSet } from "ai";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createUserFilesCodeModeTools,
  createUserFilesProcessRuntime,
  createUserToolOutputArtifactStore,
} from "../tool-output-artifacts.js";

type FilesAccess = "read" | "write";

export interface IsolationProfile {
  name: string;
  processType: ToolsetProcessType;
  filesAccess: FilesAccess;
  description: string;
}

export const isolationProfiles = {
  "worker-write": {
    name: "worker-write",
    processType: "worker",
    filesAccess: "write",
    description: "General worker profile with writable /workspace and writable /artifacts.",
  },
  "hot-path-write": {
    name: "hot-path-write",
    processType: "hot_path",
    filesAccess: "write",
    description: "Hot-path-style file context profile with writable /workspace and writable /artifacts.",
  },
  "pattern-management-read": {
    name: "pattern-management-read",
    processType: "pattern_management",
    filesAccess: "read",
    description: "Pattern management profile with read-only /workspace and writable /artifacts.",
  },
  "my-day-read": {
    name: "my-day-read",
    processType: "my_day",
    filesAccess: "read",
    description: "Internal automation profile with read-only /workspace and writable /artifacts.",
  },
} as const satisfies Record<string, IsolationProfile>;

export type IsolationProfileName = keyof typeof isolationProfiles;

export interface IsolationSandboxPaths {
  root: string;
  attackerUserRoot: string;
  workspaceRoot: string;
  artifactsRoot: string;
  artifactsRunRoot: string;
  attackerFinnRoot: string;
  victimUserRoot: string;
  victimWorkspaceRoot: string;
  victimFinnRoot: string;
  outsideRoot: string;
  outsideSecretPath: string;
  outsideMutationPath: string;
}

export interface IsolationSentinels {
  attackerFinnSecret: string;
  victimSecret: string;
  victimFinnSecret: string;
  outsideSecret: string;
  outsideMutationOriginal: string;
}

export interface IsolationWorkbench {
  profile: IsolationProfile;
  paths: IsolationSandboxPaths;
  sentinels: IsolationSentinels;
  tools: ToolSet;
  summaries: CodeModeToolsetSummary[];
  cleanup(options?: { preserveRoot?: boolean }): Promise<void>;
}

export type IsolationProbeExpected = "allowed" | "blocked" | "informational";

export interface IsolationCodeInput {
  code: string;
}

export interface IsolationCodeOutput extends CodeModeExecutionResult {
  output: string;
}

export interface IsolationProbe {
  id: string;
  description: string;
  expected: IsolationProbeExpected;
  input: IsolationCodeInput;
  requiredOutput?: readonly string[];
}

export interface IsolationProbeResult {
  id: string;
  description: string;
  expected: IsolationProbeExpected;
  exitCode: number;
  status: "succeeded" | "failed";
  output: string;
  alert: boolean;
  leakedTokens: string[];
  hostMutationChanged: boolean;
  notes: string[];
}

const defaultProfile: IsolationProfileName = "worker-write";

function tokenEntries(sentinels: IsolationSentinels): Array<[string, string]> {
  return [
    ["attackerFinnSecret", sentinels.attackerFinnSecret],
    ["victimSecret", sentinels.victimSecret],
    ["victimFinnSecret", sentinels.victimFinnSecret],
    ["outsideSecret", sentinels.outsideSecret],
    ["outsideMutationOriginal", sentinels.outsideMutationOriginal],
  ];
}

function isCodeModeExecutionResult(value: unknown): value is CodeModeExecutionResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const output = value as Partial<CodeModeExecutionResult>;
  return typeof output.success === "boolean" && Array.isArray(output.logs);
}

function requireCodeModeExecutionResult(value: unknown): CodeModeExecutionResult {
  if (!isCodeModeExecutionResult(value)) {
    throw new Error("workspace_execute returned an unexpected result shape.");
  }
  return value;
}

function serializeCodeModeOutput(result: CodeModeExecutionResult): string {
  const chunks = [...result.logs];
  if (result.error) {
    chunks.push(result.error);
  }
  if (result.result !== undefined) {
    chunks.push(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2));
  }
  return chunks.join("\n");
}

async function seedSandbox(root: string): Promise<{ paths: Omit<IsolationSandboxPaths, "artifactsRunRoot">; sentinels: IsolationSentinels }> {
  const attackerUserRoot = join(root, "tenant_sandbox", "usr_attacker");
  const workspaceRoot = join(attackerUserRoot, "workspace");
  const artifactsRoot = join(attackerUserRoot, "artifacts");
  const attackerFinnRoot = join(attackerUserRoot, ".finn");
  const victimUserRoot = join(root, "tenant_sandbox", "usr_victim");
  const victimWorkspaceRoot = join(victimUserRoot, "workspace");
  const victimFinnRoot = join(victimUserRoot, ".finn");
  const outsideRoot = join(root, "outside");
  const outsideSecretPath = join(outsideRoot, "outside-secret.txt");
  const outsideMutationPath = join(outsideRoot, "outside-mutation-target.txt");
  const sentinels: IsolationSentinels = {
    attackerFinnSecret: "FINN_SANDBOX_ATTACKER_FINN_SECRET",
    victimSecret: "FINN_SANDBOX_VICTIM_WORKSPACE_SECRET",
    victimFinnSecret: "FINN_SANDBOX_VICTIM_FINN_SECRET",
    outsideSecret: "FINN_SANDBOX_OUTSIDE_SECRET",
    outsideMutationOriginal: "FINN_SANDBOX_OUTSIDE_MUTATION_ORIGINAL\n",
  };

  await Promise.all([
    mkdir(join(workspaceRoot, "notes"), { recursive: true }),
    mkdir(artifactsRoot, { recursive: true }),
    mkdir(attackerFinnRoot, { recursive: true, mode: 0o700 }),
    mkdir(victimWorkspaceRoot, { recursive: true }),
    mkdir(victimFinnRoot, { recursive: true, mode: 0o700 }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceRoot, "notes", "public.txt"), "attacker workspace public note\n"),
    writeFile(join(workspaceRoot, "durable.txt"), "durable original\n"),
    writeFile(join(attackerFinnRoot, "attacker-secret.txt"), `${sentinels.attackerFinnSecret}\n`),
    writeFile(join(victimWorkspaceRoot, "victim-secret.txt"), `${sentinels.victimSecret}\n`),
    writeFile(join(victimFinnRoot, "victim-finn-secret.txt"), `${sentinels.victimFinnSecret}\n`),
    writeFile(outsideSecretPath, `${sentinels.outsideSecret}\n`),
    writeFile(outsideMutationPath, sentinels.outsideMutationOriginal),
  ]);
  await Promise.all([
    symlink(outsideSecretPath, join(workspaceRoot, "link-to-outside-secret")),
    symlink(outsideMutationPath, join(workspaceRoot, "link-to-outside-mutation")),
    symlink(outsideRoot, join(workspaceRoot, "link-to-outside-dir")),
    symlink(victimWorkspaceRoot, join(workspaceRoot, "link-to-victim-workspace")),
  ]);

  return {
    paths: {
      root,
      attackerUserRoot,
      workspaceRoot,
      artifactsRoot,
      attackerFinnRoot,
      victimUserRoot,
      victimWorkspaceRoot,
      victimFinnRoot,
      outsideRoot,
      outsideSecretPath,
      outsideMutationPath,
    },
    sentinels,
  };
}

export async function createIsolationWorkbench(options: {
  profile?: IsolationProfileName;
  rootDir?: string;
  runId?: string;
  executor?: CodeModeExecutor;
} = {}): Promise<IsolationWorkbench> {
  const profile = isolationProfiles[options.profile ?? defaultProfile];
  const root = options.rootDir ? resolve(options.rootDir) : await mkdtemp(join(tmpdir(), "finn-isolation-sandbox-"));
  const { paths: seededPaths, sentinels } = await seedSandbox(root);
  const userRuntime = createUserRuntimeServices({
    user: { tenantId: "tenant_sandbox", userId: "usr_attacker" },
    workspace: {
      workspaceRoot: seededPaths.workspaceRoot,
      artifactsRoot: seededPaths.artifactsRoot,
    },
    files: createFilesRuntime({
      workspaceRoot: seededPaths.workspaceRoot,
      artifactsRoot: seededPaths.artifactsRoot,
      access: "write",
      documentExtraction: true,
    }),
  });
  const artifacts = createUserToolOutputArtifactStore(userRuntime, options.runId ?? `sandbox_${profile.name}`);
  const processRuntime = createUserFilesProcessRuntime(userRuntime, {
    processType: profile.processType,
    filesAccess: profile.filesAccess,
  });
  const access = createUserFilesCodeModeTools(processRuntime, {
    access: profile.filesAccess,
    processType: profile.processType,
    artifacts,
    ...(options.executor ? { executor: options.executor } : {}),
  });
  const paths = {
    ...seededPaths,
    artifactsRunRoot: artifacts.runDirectory,
  };
  let cleaned = false;

  return {
    profile,
    paths,
    sentinels,
    tools: access.tools,
    summaries: access.summaries,
    cleanup: async (cleanupOptions = {}) => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await access.cleanup();
      if (cleanupOptions.preserveRoot !== true) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export async function runCodeMode(
  workbench: Pick<IsolationWorkbench, "tools">,
  input: IsolationCodeInput,
): Promise<IsolationCodeOutput> {
  const execute = workbench.tools.workspace_execute?.execute;
  if (!execute) {
    throw new Error("workspace_execute is not available in this isolation workbench.");
  }
  const result = requireCodeModeExecutionResult(await execute(input, { toolCallId: "sandbox_workspace_execute", messages: [] } as never));
  return { ...result, output: serializeCodeModeOutput(result) };
}

export function defaultIsolationProbes(workbench: IsolationWorkbench): IsolationProbe[] {
  const common: IsolationProbe[] = [
    {
      id: "files-public-read",
      description: "Control probe: read a legitimate attacker workspace file.",
      expected: "allowed",
      input: { code: "return await finn.files.read({ path: '/workspace/notes/public.txt' });" },
      requiredOutput: ["attacker workspace public note"],
    },
    {
      id: "files-parent-finn",
      description: "Try to read the attacker host-only .finn sibling through files API traversal.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '../.finn/attacker-secret.txt' });" },
    },
    {
      id: "files-sibling-user",
      description: "Try to read a sibling user's workspace through files API traversal.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '/workspace/../../usr_victim/workspace/victim-secret.txt' });" },
    },
    {
      id: "files-read-symlink",
      description: "Try to read a workspace symlink that points outside the sandbox workspace.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '/workspace/link-to-outside-secret' });" },
    },
    {
      id: "files-write-symlink",
      description: "Try to write through a workspace symlink that points outside the sandbox workspace.",
      expected: "blocked",
      input: { code: "return await finn.files.write({ path: '/workspace/link-to-outside-mutation', content: 'pwned' });" },
    },
    {
      id: "files-nested-symlink-dir",
      description: "Try to read through a symlinked directory that points outside the workspace.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '/workspace/link-to-outside-dir/outside-secret.txt' });" },
    },
    {
      id: "files-victim-symlink-dir",
      description: "Try to read through a symlinked directory that points at the victim workspace.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '/workspace/link-to-victim-workspace/victim-secret.txt' });" },
    },
    {
      id: "files-tmp-rejected",
      description: "Confirm Finn files APIs reject Secure Exec-local /tmp paths.",
      expected: "blocked",
      input: { code: "return await finn.files.read({ path: '/tmp/scratch.txt' });" },
    },
    {
      id: "files-artifact-write",
      description: "Confirm files APIs can write temporary run artifacts.",
      expected: "allowed",
      input: { code: "return await finn.files.write({ path: '/artifacts/probe-artifact.txt', content: 'artifact-ok' });" },
      requiredOutput: ["/artifacts/probe-artifact.txt"],
    },
    {
      id: "api-skills-unavailable",
      description: "Confirm ungranted Finn APIs are not available in Code Mode.",
      expected: "blocked",
      input: { code: "return await finn.skills.list({});" },
    },
    {
      id: "files-view-image-absent",
      description: "Confirm files viewImage is absent from the Code Mode files API.",
      expected: "blocked",
      input: { code: "return await finn.files.viewImage({ path: '/workspace/notes/public.txt' });" },
    },
    {
      id: "files-download-localhost",
      description: "Confirm files download rejects localhost targets.",
      expected: "blocked",
      input: { code: "return await finn.files.download({ url: 'http://127.0.0.1/private.txt', path: '/artifacts/private.txt' });" },
    },
    {
      id: "files-download-metadata-ip",
      description: "Confirm files download rejects link-local metadata targets.",
      expected: "blocked",
      input: { code: "return await finn.files.download({ url: 'http://169.254.169.254/latest/meta-data', path: '/artifacts/metadata.txt' });" },
    },
  ];

  if (workbench.profile.filesAccess === "read") {
    return [
      ...common,
      {
        id: "read-profile-files-workspace-write",
        description: "Confirm read-oriented profiles cannot mutate /workspace through files write.",
        expected: "blocked",
        input: { code: "return await finn.files.write({ path: '/workspace/read-profile-nope.txt', content: 'nope' });" },
      },
    ];
  }

  return common;
}

export async function evaluateIsolationProbeResult(
  workbench: IsolationWorkbench,
  probe: IsolationProbe,
  output: IsolationCodeOutput,
): Promise<IsolationProbeResult> {
  const text = output.output;
  const leakedTokens = tokenEntries(workbench.sentinels)
    .filter(([, token]) => token.length > 0 && text.includes(token))
    .map(([name]) => name);
  const hostMutationChanged = existsSync(workbench.paths.outsideMutationPath)
    && await readFile(workbench.paths.outsideMutationPath, "utf8") !== workbench.sentinels.outsideMutationOriginal;
  const notes: string[] = [];

  if (probe.expected === "allowed") {
    if (!output.success) {
      notes.push("Allowed probe did not complete successfully.");
    }
    for (const required of probe.requiredOutput ?? []) {
      if (!text.includes(required)) {
        notes.push(`Allowed probe output did not contain required text: ${required}`);
      }
    }
  }
  if (probe.expected === "blocked" && output.success) {
    notes.push("Blocked probe completed successfully.");
  }
  if (leakedTokens.length > 0) {
    notes.push(`Probe output contained forbidden sentinel token(s): ${leakedTokens.join(", ")}`);
  }
  if (hostMutationChanged) {
    notes.push("Outside mutation sentinel changed on the host filesystem.");
  }

  return {
    id: probe.id,
    description: probe.description,
    expected: probe.expected,
    exitCode: output.success ? 0 : 1,
    status: output.success ? "succeeded" : "failed",
    output: text,
    alert: notes.length > 0,
    leakedTokens,
    hostMutationChanged,
    notes,
  };
}

export async function runIsolationProbe(workbench: IsolationWorkbench, probe: IsolationProbe): Promise<IsolationProbeResult> {
  await writeFile(workbench.paths.outsideMutationPath, workbench.sentinels.outsideMutationOriginal);
  const output = await runCodeMode(workbench, probe.input);
  return evaluateIsolationProbeResult(workbench, probe, output);
}

export async function runDefaultIsolationProbeCorpus(workbench: IsolationWorkbench): Promise<IsolationProbeResult[]> {
  const results: IsolationProbeResult[] = [];
  for (const probe of defaultIsolationProbes(workbench)) {
    results.push(await runIsolationProbe(workbench, probe));
  }
  return results;
}
