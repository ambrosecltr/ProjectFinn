import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createIsolationWorkbench,
  isolationProfiles,
  runDefaultIsolationProbeCorpus,
  runCodeMode,
  type IsolationCodeInput,
  type IsolationCodeOutput,
  type IsolationProbeResult,
  type IsolationProfileName,
} from "./workbench.js";

export interface IsolationSandboxCliOptions {
  mode: "interactive" | "corpus";
  profile: IsolationProfileName;
  allProfiles: boolean;
  keep: boolean;
  help: boolean;
  listProfiles: boolean;
}

const defaultCliOptions: IsolationSandboxCliOptions = {
  mode: "interactive",
  profile: "worker-write",
  allProfiles: false,
  keep: false,
  help: false,
  listProfiles: false,
};

function profileNames(): IsolationProfileName[] {
  return Object.keys(isolationProfiles) as IsolationProfileName[];
}

function parseProfile(value: string | undefined): IsolationProfileName {
  if (!value) {
    throw new Error("--profile requires a profile name.");
  }
  if (!profileNames().includes(value as IsolationProfileName)) {
    throw new Error(`Unknown profile: ${value}. Available profiles: ${profileNames().join(", ")}`);
  }
  return value as IsolationProfileName;
}

export function parseIsolationSandboxArgs(args: string[]): IsolationSandboxCliOptions {
  const options: IsolationSandboxCliOptions = { ...defaultCliOptions };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--profiles":
      case "--list-profiles":
        options.listProfiles = true;
        break;
      case "--corpus":
        options.mode = "corpus";
        break;
      case "--all-profiles":
        options.allProfiles = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--profile":
        options.profile = parseProfile(args[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    "Usage: bun run security:sandbox -- [options]",
    "",
    "Options:",
    "  --profile <name>   Profile to launch. Default: worker-write.",
    "  --corpus           Run the fixed isolation probe corpus and exit.",
    "  --all-profiles     With --corpus, run every profile.",
    "  --keep             Preserve the temp sandbox root after shutdown.",
    "  --profiles         List profiles.",
    "  --help             Show this help.",
    "",
    "Interactive commands:",
    "  <code>                      Run JavaScript through workspace_execute.",
    "  :run {\"code\":\"return await finn.files.list({});\"}",
    "  :probes                     Run the fixed corpus in this workbench.",
    "  :context                    Print sandbox paths and compromise markers.",
    "  :help                       Show interactive help.",
    "  :exit                       Stop the workbench.",
  ].join("\n");
}

function printProfiles(): void {
  for (const profile of profileNames()) {
    const value = isolationProfiles[profile];
    console.log(`${value.name}: ${value.description}`);
  }
}

function renderCodeOutput(result: IsolationCodeOutput): void {
  if (result.output.length > 0) {
    console.log(result.output.trimEnd());
  } else if (result.error) {
    console.log(result.error);
  }
  console.log(`[${result.success ? "succeeded" : "failed"}]`);
}

function renderProbeResult(result: IsolationProbeResult): string {
  const status = result.alert ? "ALERT" : "ok";
  const exit = `exit=${result.exitCode}`;
  const notes = result.notes.length > 0 ? ` :: ${result.notes.join("; ")}` : "";
  return `${status.padEnd(5)} ${result.id} (${result.expected}, ${exit})${notes}`;
}

function printProbeResults(results: IsolationProbeResult[]): boolean {
  let hasAlert = false;
  for (const result of results) {
    if (result.alert) {
      hasAlert = true;
    }
    console.log(renderProbeResult(result));
  }
  return hasAlert;
}

async function runCorpus(profile: IsolationProfileName, keep: boolean): Promise<boolean> {
  const workbench = await createIsolationWorkbench({ profile });
  try {
    console.log(`Profile: ${workbench.profile.name}`);
    console.log(`Sandbox root: ${workbench.paths.root}`);
    const results = await runDefaultIsolationProbeCorpus(workbench);
    return printProbeResults(results);
  } finally {
    await workbench.cleanup({ preserveRoot: keep });
  }
}

function printWorkbenchContext(workbench: Awaited<ReturnType<typeof createIsolationWorkbench>>): void {
  console.log(JSON.stringify({
    profile: workbench.profile,
    hostRoot: workbench.paths.root,
    vmMounts: {
      workspace: "/workspace",
      artifacts: "/artifacts",
      tmp: "/tmp",
    },
    hostSentinelPaths: {
      attackerFinnRoot: workbench.paths.attackerFinnRoot,
      victimWorkspaceRoot: workbench.paths.victimWorkspaceRoot,
      victimFinnRoot: workbench.paths.victimFinnRoot,
      outsideRoot: workbench.paths.outsideRoot,
      outsideMutationPath: workbench.paths.outsideMutationPath,
    },
    compromiseMarkers: workbench.sentinels,
  }, null, 2));
}

function parseRunJson(value: string): IsolationCodeInput {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { code?: unknown }).code !== "string") {
    throw new Error(":run expects JSON shaped like {\"code\":\"return await finn.files.list({});\"}.");
  }
  return parsed as IsolationCodeInput;
}

async function runInteractive(profile: IsolationProfileName, keep: boolean): Promise<void> {
  const workbench = await createIsolationWorkbench({ profile });
  const rl = createInterface({ input, output });
  try {
    console.log("Finn Code Mode isolation sandbox");
    console.log(`Profile: ${workbench.profile.name}`);
    console.log(`Sandbox root: ${workbench.paths.root}`);
    console.log("Read packages/server/src/security-sandbox/AGENTS.md before directing agents here.");
    console.log("Type :help for commands.");
    for (;;) {
      const line = (await rl.question("sandbox> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === ":exit" || line === ":quit") {
        return;
      }
      if (line === ":help") {
        console.log(usage());
        continue;
      }
      if (line === ":context") {
        printWorkbenchContext(workbench);
        continue;
      }
      if (line === ":probes") {
        const results = await runDefaultIsolationProbeCorpus(workbench);
        printProbeResults(results);
        continue;
      }
      if (line.startsWith(":run ")) {
        try {
          renderCodeOutput(await runCodeMode(workbench, parseRunJson(line.slice(":run ".length))));
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      renderCodeOutput(await runCodeMode(workbench, { code: line }));
    }
  } finally {
    rl.close();
    await workbench.cleanup({ preserveRoot: keep });
  }
}

async function main(): Promise<void> {
  const options = parseIsolationSandboxArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.listProfiles) {
    printProfiles();
    return;
  }
  if (options.mode === "corpus") {
    const profiles = options.allProfiles ? profileNames() : [options.profile];
    let hasAlert = false;
    for (const profile of profiles) {
      hasAlert = await runCorpus(profile, options.keep) || hasAlert;
    }
    process.exitCode = hasAlert ? 1 : 0;
    return;
  }
  await runInteractive(options.profile, options.keep);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
