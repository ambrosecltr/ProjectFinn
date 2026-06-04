import { createLogger, loadConfig, type AppConfig, type MemoryProvider } from "@finn/core";
import { getDb, getDbClient } from "@finn/db";
import { HindsightClient, HonchoClient, SupermemoryClient, getSafeMemoryFailureReason, type MemoryClient } from "@finn/integrations";
import { runMemoryBackfill, type MemoryBackfillKind, type MemoryBackfillOptions } from "../memory-backfill.js";

const logger = createLogger("memory-backfill");
const validKinds = ["hot_path_turn", "pattern_run_outcome", "user_profile_seed"] as const satisfies readonly MemoryBackfillKind[];
const validProviders = ["supermemory", "hindsight", "honcho"] as const satisfies readonly Exclude<MemoryProvider, "none">[];

interface CliOptions {
  execute: boolean;
  provider?: Exclude<MemoryProvider, "none">;
  kinds?: MemoryBackfillKind[];
  tenantId?: string;
  userId?: string;
  since?: Date;
  limit?: number;
  concurrency?: number;
}

function printUsage(command = "memory:backfill"): void {
  console.log([
    `usage: bun run ${command} [options]`,
    "",
    "dry-run is the default. pass --execute to write documents through the selected memory provider.",
    "",
    "options:",
    "  --execute                 write documents instead of planning only",
    "  --provider <provider>     supermemory, hindsight, or honcho (default: MEMORY_PROVIDER)",
    "  --kind <kind>             hot_path_turn, pattern_run_outcome, user_profile_seed, or all (default: all)",
    "  --tenant-id <tenant_id>   restrict to one tenant",
    "  --user-id <user_id>       restrict to one user",
    "  --since <iso_date>        only include records after this timestamp",
    "  --limit <count>           cap records scanned per selected kind",
    "  --concurrency <count>     concurrent provider writes when executing (default: 4)",
    "  --help                    show this help",
  ].join("\n"));
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseSince(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--since must be a valid ISO date or timestamp.");
  }
  return parsed;
}

function parseProvider(value: string): Exclude<MemoryProvider, "none"> {
  if (!validProviders.includes(value as Exclude<MemoryProvider, "none">)) {
    throw new Error(`Unsupported --provider value: ${value}.`);
  }
  return value as Exclude<MemoryProvider, "none">;
}

function parseKinds(value: string): MemoryBackfillKind[] {
  if (value === "all") {
    return [...validKinds];
  }

  const kinds = value.split(",").map((kind) => kind.trim()).filter(Boolean);
  for (const kind of kinds) {
    if (!validKinds.includes(kind as MemoryBackfillKind)) {
      throw new Error(`Unsupported --kind value: ${kind}.`);
    }
  }
  return kinds as MemoryBackfillKind[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { execute: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      case "--execute":
        options.execute = true;
        break;
      case "--provider":
        options.provider = parseProvider(requireValue(args, index, arg));
        index += 1;
        break;
      case "--kind":
        options.kinds = parseKinds(requireValue(args, index, arg));
        index += 1;
        break;
      case "--tenant-id":
        options.tenantId = requireValue(args, index, arg);
        index += 1;
        break;
      case "--user-id":
        options.userId = requireValue(args, index, arg);
        index += 1;
        break;
      case "--since":
        options.since = parseSince(requireValue(args, index, arg));
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function createMemoryClientForProvider(config: AppConfig, provider: Exclude<MemoryProvider, "none">): MemoryClient {
  switch (provider) {
    case "supermemory": {
      const apiKey = config.integrations?.supermemory?.apiKey;
      if (!apiKey) {
        throw new Error("SUPERMEMORY_API_KEY is required for --provider supermemory.");
      }
      return new SupermemoryClient({
        apiKey,
        baseUrl: config.integrations?.supermemory?.baseUrl,
      });
    }
    case "hindsight": {
      const baseUrl = config.integrations?.hindsight?.baseUrl;
      if (!baseUrl) {
        throw new Error("HINDSIGHT_BASE_URL is required for --provider hindsight.");
      }
      return new HindsightClient({
        apiKey: config.integrations?.hindsight?.apiKey,
        baseUrl,
      });
    }
    case "honcho": {
      const honcho = config.integrations?.honcho;
      if (!honcho?.apiKey && !honcho?.baseUrl) {
        throw new Error("HONCHO_API_KEY or HONCHO_BASE_URL is required for --provider honcho.");
      }
      return new HonchoClient({
        apiKey: honcho.apiKey,
        baseUrl: honcho.baseUrl,
        workspacePrefix: honcho.workspacePrefix,
      });
    }
  }
}

function resolveProvider(config: AppConfig, cliProvider?: Exclude<MemoryProvider, "none">): Exclude<MemoryProvider, "none"> {
  const provider = cliProvider ?? config.memory.provider;
  if (provider === "none") {
    throw new Error("No memory provider selected. Set MEMORY_PROVIDER or pass --provider supermemory|hindsight|honcho.");
  }
  return provider;
}

function printResult(input: { provider: string; result: Awaited<ReturnType<typeof runMemoryBackfill>> }): void {
  console.log(JSON.stringify({
    provider: input.provider,
    dryRun: input.result.dryRun,
    scanned: input.result.scanned,
    planned: input.result.documents.length,
    written: input.result.written,
    failed: input.result.failed,
    skipped: input.result.skipped,
    byKind: input.result.documents.reduce<Record<string, number>>((counts, document) => ({
      ...counts,
      [document.kind]: (counts[document.kind] ?? 0) + 1,
    }), {}),
    samples: input.result.documents.slice(0, 10).map((document) => ({
      kind: document.kind,
      customId: document.customId,
      userId: document.user.userId,
    })),
  }, null, 2));
}

const cli = parseArgs(Bun.argv.slice(2));
if (cli.provider) {
  process.env.MEMORY_PROVIDER = cli.provider;
}
const config = loadConfig();
const provider = resolveProvider(config, cli.provider);
const db = getDb(config.databaseUrl);
const dbClient = getDbClient(config.databaseUrl);
const client = createMemoryClientForProvider(config, provider);
const options: MemoryBackfillOptions = {
  dryRun: !cli.execute,
  kinds: cli.kinds ?? [...validKinds],
  tenantId: cli.tenantId,
  userId: cli.userId,
  since: cli.since,
  limit: cli.limit,
  concurrency: cli.concurrency ?? 4,
  defaultTimezone: config.userTimezone,
};

try {
  logger.info({ provider, dryRun: options.dryRun, kinds: options.kinds, tenantId: options.tenantId, userId: options.userId }, "Starting memory backfill");
  const result = await runMemoryBackfill({ db, client, options });
  logger.info({
    provider,
    operation: "backfill",
    dryRun: result.dryRun,
    kinds: options.kinds,
    tenantId: options.tenantId,
    userId: options.userId,
    scanned: result.scanned,
    planned: result.documents.length,
    written: result.written,
    failed: result.failed,
    skipped: result.skipped,
  }, "Memory backfill finished");
  printResult({ provider, result });
} catch (error) {
  logger.error({
    provider,
    operation: "backfill",
    tenantId: options.tenantId,
    userId: options.userId,
    failureReason: getSafeMemoryFailureReason(error),
  }, "Memory backfill failed");
  throw error;
} finally {
  await dbClient.end();
}
