import { createLogger } from "@finn/core";
import type { ConnectorCatalog, Database } from "@finn/db";
import * as schema from "@finn/db";
import type { ComposioToolkitMetadata, ComposioToolkitSummary } from "@finn/integrations";
import { eq } from "drizzle-orm";

const logger = createLogger("connector-catalog");
const defaultRefreshIntervalMs = 60_000;

export type ConnectorCatalogEntry = ConnectorCatalog;

type ToolkitMetadataFetcher = (toolkitSlug: string) => Promise<ComposioToolkitMetadata>;

interface ConnectorCatalogServiceDeps {
  db: Database;
  now?: () => Date;
  refreshIntervalMs?: number;
}

export class ConnectorCatalogService {
  private entries: Map<string, ConnectorCatalogEntry> | null = null;
  private loadPromise: Promise<Map<string, ConnectorCatalogEntry>> | null = null;
  private loadedAtMs = 0;
  private seedPromises = new Map<string, Promise<ConnectorCatalogEntry | null>>();

  constructor(private readonly deps: ConnectorCatalogServiceDeps) {}

  async decorateToolkits(toolkits: ComposioToolkitSummary[], fetchMetadata: ToolkitMetadataFetcher): Promise<ComposioToolkitSummary[]> {
    if (toolkits.length === 0) {
      return [];
    }

    await this.getEntries();
    return Promise.all(toolkits.map((toolkit) => this.decorateToolkit(toolkit, fetchMetadata)));
  }

  async decorateToolkit(toolkit: ComposioToolkitSummary, fetchMetadata: ToolkitMetadataFetcher): Promise<ComposioToolkitSummary> {
    const entries = await this.getEntries();
    const existing = entries.get(toolkit.slug);
    const entry = existing ?? await this.seedMissingEntry(toolkit, fetchMetadata);

    return entry ? applyCatalogEntry(toolkit, entry) : toolkit;
  }

  private async getEntries(): Promise<Map<string, ConnectorCatalogEntry>> {
    if (this.entries && this.nowMs() - this.loadedAtMs < (this.deps.refreshIntervalMs ?? defaultRefreshIntervalMs)) {
      return this.entries;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadEntries().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    this.entries = await this.loadPromise;
    this.loadedAtMs = this.nowMs();
    this.loadPromise = null;
    return this.entries;
  }

  private async loadEntries(): Promise<Map<string, ConnectorCatalogEntry>> {
    const rows = await this.deps.db.select().from(schema.connectorCatalog);
    return new Map(rows.map((row) => [row.toolkitSlug, row]));
  }

  private async seedMissingEntry(toolkit: ComposioToolkitSummary, fetchMetadata: ToolkitMetadataFetcher): Promise<ConnectorCatalogEntry | null> {
    const existingSeed = this.seedPromises.get(toolkit.slug);
    if (existingSeed) {
      return existingSeed;
    }

    const seedPromise = this.createMissingEntry(toolkit, fetchMetadata).finally(() => {
      this.seedPromises.delete(toolkit.slug);
    });
    this.seedPromises.set(toolkit.slug, seedPromise);
    return seedPromise;
  }

  private async createMissingEntry(toolkit: ComposioToolkitSummary, fetchMetadata: ToolkitMetadataFetcher): Promise<ConnectorCatalogEntry | null> {
    let metadata: ComposioToolkitMetadata = {};
    try {
      metadata = await fetchMetadata(toolkit.slug);
    } catch (error) {
      logger.warn({ error, toolkitSlug: toolkit.slug }, "Failed to seed connector catalog metadata from Composio");
      return null;
    }

    const now = this.deps.now?.() ?? new Date();
    const values = {
      toolkitSlug: toolkit.slug,
      displayName: toolkit.name,
      description: normalizeOptionalText(metadata.description ?? toolkit.description),
      logoPath: null,
      logoUrl: normalizeOptionalText(metadata.logo ?? toolkit.logo),
      source: "composio" as const,
      createdAt: now,
      updatedAt: now,
    };

    const [created] = await this.deps.db
      .insert(schema.connectorCatalog)
      .values(values)
      .onConflictDoNothing()
      .returning();

    const entry = created ?? await this.loadEntry(toolkit.slug);
    if (!entry) {
      return null;
    }

    const entries = await this.getEntries();
    entries.set(entry.toolkitSlug, entry);
    logger.info({ toolkitSlug: entry.toolkitSlug, source: entry.source }, "Seeded connector catalog metadata");
    return entry;
  }

  private nowMs(): number {
    return this.deps.now?.().getTime() ?? Date.now();
  }

  private async loadEntry(toolkitSlug: string): Promise<ConnectorCatalogEntry | null> {
    const [entry] = await this.deps.db
      .select()
      .from(schema.connectorCatalog)
      .where(eq(schema.connectorCatalog.toolkitSlug, toolkitSlug))
      .limit(1);
    return entry ?? null;
  }
}

function applyCatalogEntry(toolkit: ComposioToolkitSummary, entry: ConnectorCatalogEntry): ComposioToolkitSummary {
  const description = normalizeOptionalText(entry.description) ?? toolkit.description;
  const logo = normalizeOptionalText(entry.logoPath) ?? normalizeOptionalText(entry.logoUrl) ?? toolkit.logo;

  return {
    ...toolkit,
    name: entry.displayName,
    ...(description ? { description } : {}),
    ...(logo ? { logo } : {}),
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
