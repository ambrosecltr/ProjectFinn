import { createLogger, getTracer, withSpan } from "@finn/core";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  existsSync as existsSyncLegacy,
  readFileSync,
  readdirSync as readdirSyncLegacy,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { formatToolsetError } from "../../utils.js";
import {
  skillsInstallInputSchema,
  skillsLoadInputSchema,
  skillsReadResourceInputSchema,
  skillsRemoveInputSchema,
  skillsSearchInputSchema,
  skillsUpdateInputSchema,
} from "./schemas.js";

const logger = createLogger("skills-toolset");
const tracer = getTracer("skills-toolset");

const skillFrontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const MAX_SKILL_INSTRUCTIONS_CHARS = 24_000;
const MAX_SKILL_RESOURCE_CHARS = 24_000;
const SKILLS_SH_AGENT = "claude-code";
const SKILLS_CLI_COMMAND = ["bunx", "skills"] as const;
const SKILL_METADATA_FILENAME = ".finn-skill.json";

export interface SkillCommandRunner {
  spawn(command: string[], options: { cwd: string; env?: Record<string, string> }): {
    stdout?: ReadableStream;
    stderr?: ReadableStream;
    exited: Promise<number>;
  };
}

export interface SkillsToolsetRuntime {
  rootDir: string;
  commandRunner: SkillCommandRunner;
}

export interface WorkerSkill {
  name: string;
  description: string;
  directoryPath: string;
  instructionPath: string;
  instructions: string;
  resources: string[];
}

type ParsedFrontmatter = z.infer<typeof skillFrontmatterSchema>;

interface SkillsShSearchResult {
  package: string;
  skill: string;
  installs?: string;
  url?: string;
}

interface InstalledSkillInfo {
  name: string;
  description: string;
  path: string;
  resources: string[];
  source?: string;
}

interface SkillInstallMetadata {
  source: string;
  installedAt: string;
}

function normalizeResourcePath(path: string): string {
  return path.split(/[/\\]+/).filter(Boolean).join("/");
}

function parseFrontmatterValue(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function parseSkillDocument(documentPath: string, content: string): { frontmatter: ParsedFrontmatter; instructions: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Skill file is missing YAML frontmatter: ${documentPath}`);
  }

  const [, rawFrontmatter, rawBody] = match;
  const parsedFrontmatter: Record<string, string> = {};
  for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (key.length > 0) {
      parsedFrontmatter[key] = parseFrontmatterValue(line.slice(separatorIndex + 1));
    }
  }

  const frontmatter = skillFrontmatterSchema.parse(parsedFrontmatter);
  const instructions = rawBody.trim();
  if (instructions.length === 0) {
    throw new Error(`Skill instructions are empty: ${documentPath}`);
  }
  if (instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
    throw new Error(`Skill instructions exceed ${MAX_SKILL_INSTRUCTIONS_CHARS} characters: ${documentPath}`);
  }
  return { frontmatter, instructions };
}

function collectSkillResources(rootDir: string, currentDir = rootDir): string[] {
  const entries = readdirSyncLegacy(currentDir, { withFileTypes: true });
  const resources: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      resources.push(...collectSkillResources(rootDir, entryPath));
      continue;
    }
    if (entry.name === "SKILL.md" || entry.name === SKILL_METADATA_FILENAME) {
      continue;
    }
    resources.push(normalizeResourcePath(relative(rootDir, entryPath)));
  }
  return resources.sort((left, right) => left.localeCompare(right));
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  return { content: `${content.slice(0, maxChars)}\n\n[truncated]`, truncated: true };
}

function sanitizeInstalledSkillDirectoryName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function assertPathInsideRoot(rootDir: string, path: string, label: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`${label} escapes the skill root: ${path}`);
  }
  return resolvedPath;
}

function buildSkillMap(skills: WorkerSkill[]): Map<string, WorkerSkill> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

function resolveSkillResource(skill: WorkerSkill, requestedPath: string): string {
  const normalizedPath = normalizeResourcePath(requestedPath);
  if (normalizedPath.length === 0) {
    throw new Error("Skill resource path is required.");
  }
  if (!skill.resources.includes(normalizedPath)) {
    throw new Error(`Skill resource not found: ${normalizedPath}`);
  }
  const resolvedPath = resolve(skill.directoryPath, normalizedPath);
  const relativePath = relative(skill.directoryPath, resolvedPath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Skill resource path escapes the skill directory: ${normalizedPath}`);
  }
  return resolvedPath;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readSkillMetadata(directoryPath: string): Promise<SkillInstallMetadata | null> {
  const metadataPath = join(directoryPath, SKILL_METADATA_FILENAME);
  if (!existsSyncLegacy(metadataPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<SkillInstallMetadata>;
    if (typeof parsed.source !== "string" || parsed.source.trim().length === 0) {
      return null;
    }
    return { source: parsed.source, installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : new Date(0).toISOString() };
  } catch {
    return null;
  }
}

async function writeSkillMetadata(directoryPath: string, metadata: SkillInstallMetadata): Promise<void> {
  await writeFile(join(directoryPath, SKILL_METADATA_FILENAME), JSON.stringify(metadata, null, 2));
}

export function discoverWorkerSkills(rootDir: string): WorkerSkill[] {
  if (!existsSyncLegacy(rootDir)) {
    return [];
  }

  const skills: WorkerSkill[] = [];
  const seenNames = new Set<string>();
  const entries = readdirSyncLegacy(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const skillDirectory = join(rootDir, entry.name);
    const instructionPath = join(skillDirectory, "SKILL.md");
    if (!existsSyncLegacy(instructionPath)) {
      continue;
    }
    try {
      const source = readFileSync(instructionPath, "utf8");
      const { frontmatter, instructions } = parseSkillDocument(instructionPath, source);
      if (seenNames.has(frontmatter.name)) {
        logger.warn({ skill: frontmatter.name, path: instructionPath }, "Skipping duplicate worker skill name");
        continue;
      }
      seenNames.add(frontmatter.name);
      skills.push({ name: frontmatter.name, description: frontmatter.description, directoryPath: skillDirectory, instructionPath, instructions, resources: collectSkillResources(skillDirectory) });
    } catch (error) {
      logger.warn({ error, path: instructionPath }, "Skipping invalid worker skill");
    }
  }
  return skills;
}

async function summarizeInstalledSkills(rootDir: string): Promise<InstalledSkillInfo[]> {
  const installedSkills: InstalledSkillInfo[] = [];
  for (const skill of discoverWorkerSkills(rootDir)) {
    const metadata = await readSkillMetadata(skill.directoryPath);
    installedSkills.push({ name: skill.name, description: skill.description, path: skill.directoryPath, resources: skill.resources, source: metadata?.source });
  }
  return installedSkills;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseSkillsShFindResults(output: string): SkillsShSearchResult[] {
  const cleaned = stripAnsi(output);
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const results: SkillsShSearchResult[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([\w.-]+\/[\w.-]+)@([\w.-]+)(?:\s+([\d.]+[KMB]?\s+installs))?$/i);
    if (!match) {
      continue;
    }
    const nextLine = lines[index + 1];
    const urlMatch = nextLine?.match(/https:\/\/skills\.sh\/\S+/);
    results.push({ package: match[1], skill: match[2], installs: match[3], url: urlMatch?.[0] });
  }
  return results;
}

async function runCommand(command: string[], cwd: string, commandRunner: SkillCommandRunner): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = commandRunner.spawn(command, { cwd, env: { NO_COLOR: "1" } });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    proc.stderr ? new Response(proc.stderr).text() : "",
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function moveInstalledSkillIntoStore(installedSkillDir: string, runtime: SkillsToolsetRuntime, source: string): Promise<WorkerSkill> {
  const instructionPath = join(installedSkillDir, "SKILL.md");
  const document = await readFile(instructionPath, "utf8");
  const { frontmatter } = parseSkillDocument(instructionPath, document);
  const targetDir = join(runtime.rootDir, sanitizeInstalledSkillDirectoryName(frontmatter.name));
  await rm(targetDir, { recursive: true, force: true });
  await ensureDirectory(runtime.rootDir);
  await cp(installedSkillDir, targetDir, { recursive: true, force: true, errorOnExist: false });
  await writeSkillMetadata(targetDir, { source, installedAt: new Date().toISOString() });
  const [targetSkill] = discoverWorkerSkills(runtime.rootDir).filter((skill) => skill.directoryPath === targetDir);
  if (!targetSkill) {
    throw new Error(`Installed skill could not be loaded after copy: ${frontmatter.name}`);
  }
  return targetSkill;
}

async function findInstalledSkillDirectories(projectDir: string): Promise<string[]> {
  const skillRoots = [join(projectDir, ".claude", "skills"), join(projectDir, ".agents", "skills")];
  const directories: string[] = [];
  for (const root of skillRoots) {
    if (!existsSync(root)) {
      continue;
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = join(root, entry.name);
      if (existsSync(resolve(directory, "SKILL.md"))) {
        directories.push(directory);
      }
    }
  }
  return directories.sort((left, right) => left.localeCompare(right));
}

async function installSkillFromSource(runtime: SkillsToolsetRuntime, source: string): Promise<{ installed: boolean; skill?: WorkerSkill; source: string; cliOutput: string; error?: string }> {
  await ensureDirectory(runtime.rootDir);
  const tempDir = await mkdtemp(join(runtime.rootDir, ".finn-skills-install-"));
  const projectDir = join(tempDir, "project");
  try {
    await ensureDirectory(projectDir);
    await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "finn-skill-installer", private: true }));
    const command = [...SKILLS_CLI_COMMAND, "add", source, "--copy", "--agent", SKILLS_SH_AGENT, "-y"];
    const { stdout, stderr, exitCode } = await runCommand(command, projectDir, runtime.commandRunner);
    const cliOutput = stripAnsi([stdout, stderr].filter(Boolean).join("\n")).trim();
    if (exitCode !== 0) {
      return { installed: false, source, cliOutput, error: cliOutput || `skills add exited with code ${exitCode}` };
    }
    const installedSkillDirectories = await findInstalledSkillDirectories(projectDir);
    if (installedSkillDirectories.length === 0) {
      return { installed: false, source, cliOutput, error: "skills.sh completed but no installed skill directory was found" };
    }
    if (installedSkillDirectories.length > 1) {
      return { installed: false, source, cliOutput, error: "skills.sh installed multiple skills; narrow the request to a single skill" };
    }
    const skill = await moveInstalledSkillIntoStore(installedSkillDirectories[0], runtime, source);
    return { installed: true, source, skill, cliOutput };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function removeInstalledSkill(runtime: SkillsToolsetRuntime, name: string): Promise<{ removed: boolean; error?: string }> {
  const skill = discoverWorkerSkills(runtime.rootDir).find((entry) => entry.name === name);
  if (!skill) {
    return { removed: false, error: `Unknown skill: ${name}` };
  }
  await rm(assertPathInsideRoot(runtime.rootDir, skill.directoryPath, "Skill directory"), { recursive: true, force: true });
  return { removed: true };
}

async function updateInstalledSkills(runtime: SkillsToolsetRuntime, name?: string): Promise<{ updated: Array<{ name: string; source: string }>; failed: Array<{ name: string; error: string }> }> {
  const installedSkills = discoverWorkerSkills(runtime.rootDir);
  const selectedSkills = name ? installedSkills.filter((skill) => skill.name === name) : installedSkills;
  if (name && selectedSkills.length === 0) {
    return { updated: [], failed: [{ name, error: `Unknown skill: ${name}` }] };
  }
  const updated: Array<{ name: string; source: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const skill of selectedSkills) {
    const metadata = await readSkillMetadata(skill.directoryPath);
    if (!metadata) {
      failed.push({ name: skill.name, error: "No install metadata recorded for this skill." });
      continue;
    }
    const result = await installSkillFromSource(runtime, metadata.source);
    if (!result.installed || !result.skill) {
      failed.push({ name: skill.name, error: result.error ?? "Skill update failed." });
      continue;
    }
    updated.push({ name: result.skill.name, source: metadata.source });
  }
  return { updated, failed };
}

export async function skillsListCommand(runtime: SkillsToolsetRuntime) {
  return { skills: await summarizeInstalledSkills(runtime.rootDir) };
}

export async function skillsSearchCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const { query } = skillsSearchInputSchema.parse(input);
  return withSpan(tracer, "toolset.skills.search", { "tool.query": query.slice(0, 256) }, async () => {
    const { stdout, stderr, exitCode } = await runCommand([...SKILLS_CLI_COMMAND, "find", query], runtime.rootDir, runtime.commandRunner);
    const output = stripAnsi([stdout, stderr].filter(Boolean).join("\n")).trim();
    if (exitCode !== 0) {
      return { error: output || `skills find exited with code ${exitCode}` };
    }
    return { results: parseSkillsShFindResults(output), raw: output };
  });
}

export async function skillsInstallCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const parsed = skillsInstallInputSchema.parse(input);
  const source = parsed.skill ? `${parsed.package}@${parsed.skill}` : parsed.package;
  return withSpan(tracer, "toolset.skills.install", { "tool.package": parsed.package.slice(0, 256) }, async () => {
    const result = await installSkillFromSource(runtime, source);
    if (!result.installed || !result.skill) {
      return { installed: false, source: result.source, error: result.error ?? "Skill installation failed.", cliOutput: result.cliOutput };
    }
    return {
      installed: true,
      source: result.source,
      skill: { name: result.skill.name, description: result.skill.description, instructionPath: result.skill.instructionPath, resources: result.skill.resources },
      cliOutput: result.cliOutput,
    };
  });
}

export async function skillsRemoveCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const { name } = skillsRemoveInputSchema.parse(input);
  const result = await removeInstalledSkill(runtime, name);
  return result.removed ? { removed: true, name } : { removed: false, error: result.error ?? "Skill removal failed." };
}

export async function skillsUpdateCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const { name } = skillsUpdateInputSchema.parse(input);
  return updateInstalledSkills(runtime, name);
}

export function skillsLoadCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const { name } = skillsLoadInputSchema.parse(input);
  const skillsByName = buildSkillMap(discoverWorkerSkills(runtime.rootDir));
  const skill = skillsByName.get(name);
  if (!skill) {
    return { error: `Unknown skill: ${name}`, availableSkills: discoverWorkerSkills(runtime.rootDir).map(({ name: skillName }) => skillName) };
  }
  return { name: skill.name, description: skill.description, instructionPath: skill.instructionPath, instructions: skill.instructions, resources: skill.resources };
}

export async function skillsReadResourceCommand(runtime: SkillsToolsetRuntime, input: unknown) {
  const { skill: skillName, path } = skillsReadResourceInputSchema.parse(input);
  const skillsByName = buildSkillMap(discoverWorkerSkills(runtime.rootDir));
  const skill = skillsByName.get(skillName);
  if (!skill) {
    return { error: `Unknown skill: ${skillName}`, availableSkills: discoverWorkerSkills(runtime.rootDir).map(({ name }) => name) };
  }
  try {
    const resourcePath = resolveSkillResource(skill, path);
    const buffer = await readFile(resourcePath);
    if (buffer.includes(0)) {
      return { error: `Skill resource is not a text file: ${path}` };
    }
    const { content, truncated } = truncateContent(buffer.toString("utf8"), MAX_SKILL_RESOURCE_CHARS);
    return { skill: skill.name, path: normalizeResourcePath(path), content, truncated };
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function executeSkillsCommand(runtime: SkillsToolsetRuntime, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "list":
      return skillsListCommand(runtime);
    case "search":
      return skillsSearchCommand(runtime, args);
    case "install":
      return skillsInstallCommand(runtime, args);
    case "remove":
      return skillsRemoveCommand(runtime, args);
    case "update":
      return skillsUpdateCommand(runtime, args);
    case "load":
      return skillsLoadCommand(runtime, args);
    case "read_resource":
      return skillsReadResourceCommand(runtime, args);
    default:
      throw new Error(`Unsupported skills command: ${command}`);
  }
}
