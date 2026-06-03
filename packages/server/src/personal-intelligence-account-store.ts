import { generateId, type UserContext } from "@finn/core";
import type { Database, StoredPersonalIntelligenceAccount } from "@finn/db";
import * as schema from "@finn/db";
import { and, eq, inArray } from "drizzle-orm";

type PersonalIntelligenceAccountOwner = Pick<UserContext, "tenantId" | "userId">;

export type PersonalIntelligenceIdentityStatus = "resolved" | "pending" | "failed" | "unsupported";

export interface PersonalIntelligenceAccountIdentity {
  toolkitSlug: string;
  accountScopeId: string;
  providerAccountType: string;
  providerAccountId: string;
  providerWorkspaceType?: string | null;
  providerWorkspaceId?: string | null;
  currentConnectedAccountId?: string | null;
  identityStatus: PersonalIntelligenceIdentityStatus;
  displayName?: string | null;
  email?: string | null;
  handle?: string | null;
  verifiedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
}

export class PersonalIntelligenceAccountStore {
  constructor(
    private readonly deps: {
      db: Database;
      user?: PersonalIntelligenceAccountOwner;
    },
  ) {}

  async getByScope(toolkitSlug: string, accountScopeId: string): Promise<StoredPersonalIntelligenceAccount | null> {
    const owner = this.requireUser();
    const [row] = await this.deps.db
      .select()
      .from(schema.personalIntelligenceAccounts)
      .where(and(
        eq(schema.personalIntelligenceAccounts.tenantId, owner.tenantId),
        eq(schema.personalIntelligenceAccounts.userId, owner.userId),
        eq(schema.personalIntelligenceAccounts.toolkitSlug, normalizeSlug(toolkitSlug)),
        eq(schema.personalIntelligenceAccounts.accountScopeId, accountScopeId.trim()),
      ))
      .limit(1);

    return row ? row as StoredPersonalIntelligenceAccount : null;
  }

  async getByCurrentConnectedAccount(toolkitSlug: string, connectedAccountId: string): Promise<StoredPersonalIntelligenceAccount | null> {
    const rows = await this.listByCurrentConnectedAccounts([{ toolkitSlug, connectedAccountId }]);
    return rows[0] ?? null;
  }

  async listByCurrentConnectedAccounts(accounts: Array<{ toolkitSlug: string; connectedAccountId: string }>): Promise<StoredPersonalIntelligenceAccount[]> {
    const owner = this.requireUser();
    const connectedAccountIds = [...new Set(accounts.map((account) => account.connectedAccountId.trim()).filter(Boolean))];
    if (connectedAccountIds.length === 0) {
      return [];
    }

    const rows = await this.deps.db
      .select()
      .from(schema.personalIntelligenceAccounts)
      .where(and(
        eq(schema.personalIntelligenceAccounts.tenantId, owner.tenantId),
        eq(schema.personalIntelligenceAccounts.userId, owner.userId),
        inArray(schema.personalIntelligenceAccounts.currentConnectedAccountId, connectedAccountIds),
      ));

    const allowed = new Set(accounts.map((account) => `${normalizeSlug(account.toolkitSlug)}:${account.connectedAccountId.trim()}`));
    return rows
      .filter((row) => allowed.has(`${normalizeSlug(row.toolkitSlug)}:${row.currentConnectedAccountId ?? ""}`))
      .sort(compareIdentityPriority)
      .map((row) => row as StoredPersonalIntelligenceAccount);
  }

  async upsert(identity: PersonalIntelligenceAccountIdentity): Promise<StoredPersonalIntelligenceAccount> {
    const owner = this.requireUser();
    const now = new Date();
    const values = {
      id: generateId("piacct"),
      tenantId: owner.tenantId,
      userId: owner.userId,
      toolkitSlug: normalizeSlug(identity.toolkitSlug),
      accountScopeId: identity.accountScopeId.trim(),
      providerAccountType: identity.providerAccountType.trim(),
      providerAccountId: identity.providerAccountId.trim(),
      providerWorkspaceType: normalizeOptionalText(identity.providerWorkspaceType),
      providerWorkspaceId: normalizeOptionalText(identity.providerWorkspaceId),
      currentConnectedAccountId: normalizeOptionalText(identity.currentConnectedAccountId),
      identityStatus: identity.identityStatus,
      displayName: normalizeOptionalText(identity.displayName),
      email: normalizeOptionalText(identity.email),
      handle: normalizeOptionalText(identity.handle),
      verifiedAt: identity.verifiedAt ?? (identity.identityStatus === "resolved" ? now : null),
      metadata: sanitizeMetadata(identity.metadata),
      createdAt: now,
      updatedAt: now,
    };

    const [row] = await this.deps.db
      .insert(schema.personalIntelligenceAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.personalIntelligenceAccounts.tenantId,
          schema.personalIntelligenceAccounts.userId,
          schema.personalIntelligenceAccounts.toolkitSlug,
          schema.personalIntelligenceAccounts.accountScopeId,
        ],
        set: {
          providerAccountType: values.providerAccountType,
          providerAccountId: values.providerAccountId,
          providerWorkspaceType: values.providerWorkspaceType,
          providerWorkspaceId: values.providerWorkspaceId,
          currentConnectedAccountId: values.currentConnectedAccountId,
          identityStatus: values.identityStatus,
          displayName: values.displayName,
          email: values.email,
          handle: values.handle,
          verifiedAt: values.verifiedAt,
          metadata: values.metadata,
          updatedAt: now,
        },
      })
      .returning();

    return row as StoredPersonalIntelligenceAccount;
  }

  private requireUser(): PersonalIntelligenceAccountOwner {
    const owner = this.deps.user;
    if (!owner) {
      throw new Error("PersonalIntelligenceAccountStore requires a user context for owner-scoped operations.");
    }
    return owner;
  }
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function compareIdentityPriority(
  left: { identityStatus: string; verifiedAt?: Date | null; updatedAt?: Date | null },
  right: { identityStatus: string; verifiedAt?: Date | null; updatedAt?: Date | null },
): number {
  const priority = statusPriority(left.identityStatus) - statusPriority(right.identityStatus);
  if (priority !== 0) {
    return priority;
  }
  return timestamp(right.verifiedAt ?? right.updatedAt) - timestamp(left.verifiedAt ?? left.updatedAt);
}

function statusPriority(status: string): number {
  switch (status) {
    case "resolved":
      return 0;
    case "pending":
      return 1;
    case "failed":
      return 2;
    case "unsupported":
      return 3;
    default:
      return 5;
  }
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}
