import { createHash } from "node:crypto";
import { generateId, type UserContext } from "@finn/core";
import type { Database, StoredPersonalIntelligenceSource } from "@finn/db";
import * as schema from "@finn/db";
import { and, eq } from "drizzle-orm";
import { getPersonalIntelligenceAccountScopeId } from "./personal-intelligence-account-scope.js";

type PersonalIntelligenceSourceOwner = Pick<UserContext, "tenantId" | "userId">;

export interface PersonalIntelligenceSourceIdentity {
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  sourceType: string;
  sourceId: string;
}

interface NormalizedPersonalIntelligenceSourceIdentity extends PersonalIntelligenceSourceIdentity {
  accountScopeId: string;
}

export interface RecordPersonalIntelligenceSourceParams extends PersonalIntelligenceSourceIdentity {
  runId?: string | null;
  retainedDocumentId: string;
  title?: string | null;
  sourceUrl?: string | null;
  sourceTimestamp?: string | Date | null;
  metadata?: Record<string, unknown> | null;
}

export function buildPersonalIntelligenceSourceHash(input: PersonalIntelligenceSourceOwner & PersonalIntelligenceSourceIdentity): string {
  const accountScopeId = getPersonalIntelligenceAccountScopeId(input);
  if (!accountScopeId) {
    throw new Error("Personal Intelligence source identity requires an account scope.");
  }
  return createHash("sha256").update([
    input.tenantId,
    input.userId,
    normalizeSlug(input.toolkitSlug),
    accountScopeId,
    normalizeSlug(input.sourceType),
    input.sourceId.trim(),
  ].join("\0")).digest("hex");
}

export class PersonalIntelligenceSourceStore {
  constructor(
    private readonly deps: {
      db: Database;
      user?: PersonalIntelligenceSourceOwner;
    },
  ) {}

  async hasSource(params: PersonalIntelligenceSourceIdentity): Promise<boolean> {
    return Boolean(await this.getBySource(params));
  }

  async getBySource(params: PersonalIntelligenceSourceIdentity): Promise<StoredPersonalIntelligenceSource | null> {
    const owner = this.requireUser();
    const normalized = normalizeIdentity(params);
    const [row] = await this.deps.db
      .select()
      .from(schema.personalIntelligenceSources)
      .where(and(
        eq(schema.personalIntelligenceSources.tenantId, owner.tenantId),
        eq(schema.personalIntelligenceSources.userId, owner.userId),
        eq(schema.personalIntelligenceSources.toolkitSlug, normalized.toolkitSlug),
        eq(schema.personalIntelligenceSources.accountScopeId, normalized.accountScopeId),
        eq(schema.personalIntelligenceSources.sourceType, normalized.sourceType),
        eq(schema.personalIntelligenceSources.sourceId, normalized.sourceId),
      ))
      .limit(1);

    return row ? row as StoredPersonalIntelligenceSource : null;
  }

  async recordRetainedSource(params: RecordPersonalIntelligenceSourceParams): Promise<StoredPersonalIntelligenceSource> {
    const owner = this.requireUser();
    const now = new Date();
    const values = buildPersonalIntelligenceSourceValues({ owner, params, now });

    const [row] = await this.deps.db
      .insert(schema.personalIntelligenceSources)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.personalIntelligenceSources.tenantId,
          schema.personalIntelligenceSources.userId,
          schema.personalIntelligenceSources.toolkitSlug,
          schema.personalIntelligenceSources.accountScopeId,
          schema.personalIntelligenceSources.sourceType,
          schema.personalIntelligenceSources.sourceId,
        ],
        set: {
          runId: values.runId,
          connectedAccountId: values.connectedAccountId,
          sourceHash: values.sourceHash,
          retainedDocumentId: values.retainedDocumentId,
          title: values.title,
          sourceUrl: values.sourceUrl,
          sourceTimestamp: values.sourceTimestamp,
          metadata: values.metadata,
          updatedAt: now,
        },
      })
      .returning();

    return row as StoredPersonalIntelligenceSource;
  }

  private requireUser(): PersonalIntelligenceSourceOwner {
    const owner = this.deps.user;
    if (!owner) {
      throw new Error("PersonalIntelligenceSourceStore requires a user context for owner-scoped operations.");
    }
    return owner;
  }
}

export function buildPersonalIntelligenceSourceValues(input: {
  owner: PersonalIntelligenceSourceOwner;
  params: RecordPersonalIntelligenceSourceParams;
  now?: Date;
}) {
  const normalized = normalizeIdentity(input.params);
  const now = input.now ?? new Date();
  return {
    id: generateId("pisrc"),
    tenantId: input.owner.tenantId,
    userId: input.owner.userId,
    runId: input.params.runId ?? null,
    toolkitSlug: normalized.toolkitSlug,
    accountScopeId: normalized.accountScopeId,
    connectedAccountId: normalized.connectedAccountId,
    sourceType: normalized.sourceType,
    sourceId: normalized.sourceId,
    sourceHash: buildPersonalIntelligenceSourceHash({ ...input.owner, ...normalized }),
    retainedDocumentId: input.params.retainedDocumentId,
    title: normalizeOptionalText(input.params.title),
    sourceUrl: normalizeOptionalText(input.params.sourceUrl),
    sourceTimestamp: normalizeTimestamp(input.params.sourceTimestamp),
    metadata: input.params.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeIdentity(input: PersonalIntelligenceSourceIdentity): NormalizedPersonalIntelligenceSourceIdentity {
  const accountScopeId = getPersonalIntelligenceAccountScopeId(input);
  if (!accountScopeId) {
    throw new Error("Personal Intelligence source identity requires an account scope.");
  }
  return {
    toolkitSlug: normalizeSlug(input.toolkitSlug),
    accountScopeId,
    connectedAccountId: input.connectedAccountId.trim(),
    sourceType: normalizeSlug(input.sourceType),
    sourceId: input.sourceId.trim(),
  };
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTimestamp(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
