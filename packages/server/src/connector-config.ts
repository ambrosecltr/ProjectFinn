import { generateId, requiredComposioToolkits, type ConnectorPermissionMode, type UserContext } from "@finn/core";
import type { Database, UserConnectorConfig } from "@finn/db";
import * as schema from "@finn/db";
import { and, eq } from "drizzle-orm";

export function normalizeConnectorPermissionMode(mode?: string | null): ConnectorPermissionMode {
  return mode === "read_only" ? "read_only" : "all";
}

const primaryComposioConnectorSlugs = new Set<string>(requiredComposioToolkits);

export function isPrimaryComposioConnectorSlug(toolkitSlug: string): boolean {
  return primaryComposioConnectorSlugs.has(toolkitSlug.trim().toLowerCase());
}

export async function upsertConnectorConfig(db: Database, params: {
  tenantId: string;
  userId: string;
  toolkitSlug: string;
  toolkitName?: string;
  connected: boolean;
  connectedAccountId?: string | null;
  connectionStatus?: string | null;
  permissionMode?: ConnectorPermissionMode;
  myDayEnabled?: boolean;
  personalIntelligenceEnabled?: boolean;
  enabledTools?: string[] | null;
  lastNotifiedConnectedAccountId?: string | null;
}): Promise<UserConnectorConfig> {
  const now = new Date();
  const isPrimaryConnector = isPrimaryComposioConnectorSlug(params.toolkitSlug);
  const [existing] = await db
    .select()
    .from(schema.userConnectorConfigs)
    .where(and(
      eq(schema.userConnectorConfigs.tenantId, params.tenantId),
      eq(schema.userConnectorConfigs.userId, params.userId),
      eq(schema.userConnectorConfigs.toolkitSlug, params.toolkitSlug),
    ))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.userConnectorConfigs)
      .set({
        toolkitName: params.toolkitName ?? existing.toolkitName,
        connected: params.connected,
        connectedAccountId: params.connectedAccountId ?? null,
        connectionStatus: params.connectionStatus ?? null,
        permissionMode: normalizeConnectorPermissionMode(params.permissionMode ?? existing.permissionMode),
        myDayEnabled: isPrimaryConnector ? true : params.myDayEnabled ?? existing.myDayEnabled,
        personalIntelligenceEnabled: isPrimaryConnector ? true : params.personalIntelligenceEnabled ?? existing.personalIntelligenceEnabled,
        enabledTools: params.enabledTools !== undefined ? normalizeEnabledTools(params.enabledTools) : existing.enabledTools,
        lastNotifiedConnectedAccountId: params.lastNotifiedConnectedAccountId !== undefined
          ? params.lastNotifiedConnectedAccountId
          : existing.lastNotifiedConnectedAccountId,
        updatedAt: now,
      })
      .where(eq(schema.userConnectorConfigs.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(schema.userConnectorConfigs)
    .values({
      id: generateId("ucc"),
      tenantId: params.tenantId,
      userId: params.userId,
      toolkitSlug: params.toolkitSlug,
      toolkitName: params.toolkitName ?? null,
      connected: params.connected,
      connectedAccountId: params.connectedAccountId ?? null,
      connectionStatus: params.connectionStatus ?? null,
      permissionMode: normalizeConnectorPermissionMode(params.permissionMode),
      myDayEnabled: isPrimaryConnector ? true : params.myDayEnabled ?? false,
      personalIntelligenceEnabled: isPrimaryConnector ? true : params.personalIntelligenceEnabled ?? false,
      enabledTools: normalizeEnabledTools(params.enabledTools),
      lastNotifiedConnectedAccountId: params.lastNotifiedConnectedAccountId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

export async function listConnectorConfigs(db: Database, user: Pick<UserContext, "tenantId" | "userId">): Promise<UserConnectorConfig[]> {
  return db
    .select()
    .from(schema.userConnectorConfigs)
    .where(and(
      eq(schema.userConnectorConfigs.tenantId, user.tenantId),
      eq(schema.userConnectorConfigs.userId, user.userId),
    ));
}

export async function getConnectorConfig(db: Database, user: Pick<UserContext, "tenantId" | "userId">, toolkitSlug: string): Promise<UserConnectorConfig | null> {
  const [config] = await db
    .select()
    .from(schema.userConnectorConfigs)
    .where(and(
      eq(schema.userConnectorConfigs.tenantId, user.tenantId),
      eq(schema.userConnectorConfigs.userId, user.userId),
      eq(schema.userConnectorConfigs.toolkitSlug, toolkitSlug),
    ))
    .limit(1);

  return config ?? null;
}

function normalizeEnabledTools(tools: string[] | null | undefined): string[] | null {
  if (!tools) {
    return null;
  }

  const normalized = [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}
