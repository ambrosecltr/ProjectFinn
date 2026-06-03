import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ComposioToolkitSummary } from "@finn/integrations";
import { ConnectorCatalogService, type ConnectorCatalogEntry } from "./connector-catalog.js";

function createCatalogEntry(overrides: Partial<ConnectorCatalogEntry> & { toolkitSlug: string; displayName: string }): ConnectorCatalogEntry {
  const now = new Date("2026-05-27T00:00:00.000Z");
  return {
    toolkitSlug: overrides.toolkitSlug,
    displayName: overrides.displayName,
    description: overrides.description ?? null,
    logoPath: overrides.logoPath ?? null,
    logoUrl: overrides.logoUrl ?? null,
    source: overrides.source ?? "admin",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createToolkit(overrides: Partial<ComposioToolkitSummary> & { slug: string; name: string }): ComposioToolkitSummary {
  return {
    slug: overrides.slug,
    name: overrides.name,
    requiresAuth: overrides.requiresAuth ?? true,
    connected: overrides.connected ?? false,
    enabled: overrides.enabled ?? true,
    ...(overrides.description ? { description: overrides.description } : {}),
    ...(overrides.logo ? { logo: overrides.logo } : {}),
    ...(overrides.connectionStatus ? { connectionStatus: overrides.connectionStatus } : {}),
    ...(overrides.connectedAccountId ? { connectedAccountId: overrides.connectedAccountId } : {}),
  };
}

function createCatalogDb(initialRows: ConnectorCatalogEntry[]) {
  const rows = [...initialRows];
  let selectCount = 0;
  let insertCount = 0;

  const createAllRowsQuery = () => {
    const promise = Promise.resolve([...rows]);
    return {
      where: () => ({
        limit: async () => rows.slice(0, 1),
      }),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };

  return {
    db: {
      select: () => ({
        from: () => {
          selectCount += 1;
          return createAllRowsQuery();
        },
      }),
      insert: () => ({
        values: (value: ConnectorCatalogEntry) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              insertCount += 1;
              if (rows.some((row) => row.toolkitSlug === value.toolkitSlug)) {
                return [];
              }
              rows.push(value);
              return [value];
            },
          }),
        }),
      }),
    } as never,
    rows,
    getSelectCount: () => selectCount,
    getInsertCount: () => insertCount,
  };
}

describe("ConnectorCatalogService", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("uses admin catalog metadata without fetching Composio metadata", async () => {
    const catalogDb = createCatalogDb([
      createCatalogEntry({
        toolkitSlug: "gmail",
        displayName: "Finn Gmail",
        description: "Custom Gmail connector copy.",
        logoPath: "/icons/connectors/gmail.svg",
      }),
    ]);
    const service = new ConnectorCatalogService({ db: catalogDb.db });
    const fetchMetadata = mock(async () => {
      throw new Error("metadata should not be fetched for catalog hits");
    });

    const [connector] = await service.decorateToolkits([
      createToolkit({ slug: "gmail", name: "Gmail" }),
    ], fetchMetadata);
    await service.decorateToolkits([
      createToolkit({ slug: "gmail", name: "Gmail" }),
    ], fetchMetadata);

    expect(connector).toMatchObject({
      slug: "gmail",
      name: "Finn Gmail",
      description: "Custom Gmail connector copy.",
      logo: "/icons/connectors/gmail.svg",
    });
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(catalogDb.getInsertCount()).toBe(0);
    expect(catalogDb.getSelectCount()).toBe(1);
  });

  it("seeds missing toolkit metadata once and reuses the in-memory entry", async () => {
    const catalogDb = createCatalogDb([]);
    const service = new ConnectorCatalogService({
      db: catalogDb.db,
      now: () => new Date("2026-05-27T01:00:00.000Z"),
    });
    const fetchMetadata = mock(async (toolkitSlug: string) => ({
      description: `${toolkitSlug} from Composio`,
      logo: `https://cdn.example.com/${toolkitSlug}.png`,
    }));

    const [first] = await service.decorateToolkits([
      createToolkit({ slug: "slack", name: "Slack" }),
    ], fetchMetadata);
    const [second] = await service.decorateToolkits([
      createToolkit({ slug: "slack", name: "Slack" }),
    ], fetchMetadata);

    expect(first).toMatchObject({
      slug: "slack",
      name: "Slack",
      description: "slack from Composio",
      logo: "https://cdn.example.com/slack.png",
    });
    expect(second).toMatchObject({
      slug: "slack",
      description: "slack from Composio",
      logo: "https://cdn.example.com/slack.png",
    });
    expect(catalogDb.rows).toEqual([
      createCatalogEntry({
        toolkitSlug: "slack",
        displayName: "Slack",
        description: "slack from Composio",
        logoUrl: "https://cdn.example.com/slack.png",
        source: "composio",
        createdAt: new Date("2026-05-27T01:00:00.000Z"),
        updatedAt: new Date("2026-05-27T01:00:00.000Z"),
      }),
    ]);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(catalogDb.getInsertCount()).toBe(1);
    expect(catalogDb.getSelectCount()).toBe(1);
  });

  it("refreshes cached catalog rows after the configured interval", async () => {
    let now = new Date("2026-05-27T02:00:00.000Z");
    const catalogDb = createCatalogDb([
      createCatalogEntry({
        toolkitSlug: "gmail",
        displayName: "Old Gmail",
        description: "Old copy.",
      }),
    ]);
    const service = new ConnectorCatalogService({
      db: catalogDb.db,
      now: () => now,
      refreshIntervalMs: 10,
    });
    const fetchMetadata = mock(async () => {
      throw new Error("metadata should not be fetched for catalog hits");
    });

    const [first] = await service.decorateToolkits([
      createToolkit({ slug: "gmail", name: "Gmail" }),
    ], fetchMetadata);
    catalogDb.rows[0] = createCatalogEntry({
      toolkitSlug: "gmail",
      displayName: "New Gmail",
      description: "New copy.",
    });
    now = new Date("2026-05-27T02:00:00.005Z");
    const [cached] = await service.decorateToolkits([
      createToolkit({ slug: "gmail", name: "Gmail" }),
    ], fetchMetadata);
    now = new Date("2026-05-27T02:00:00.020Z");
    const [refreshed] = await service.decorateToolkits([
      createToolkit({ slug: "gmail", name: "Gmail" }),
    ], fetchMetadata);

    expect(first).toMatchObject({ name: "Old Gmail", description: "Old copy." });
    expect(cached).toMatchObject({ name: "Old Gmail", description: "Old copy." });
    expect(refreshed).toMatchObject({ name: "New Gmail", description: "New copy." });
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(catalogDb.getSelectCount()).toBe(2);
  });
});
