import { generateId, type UserContext } from "@finn/core";
import type { Database, StoredPersonalIntelligenceCheckpoint } from "@finn/db";
import * as schema from "@finn/db";
import { and, eq, inArray } from "drizzle-orm";
import { getPersonalIntelligenceAccountScopeId } from "./personal-intelligence-account-scope.js";

type PersonalIntelligenceCheckpointOwner = Pick<UserContext, "tenantId" | "userId">;

export interface PersonalIntelligenceCheckpointScope {
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  sourceType: string;
}

export interface PersonalIntelligenceCheckpointUpdate extends PersonalIntelligenceCheckpointScope {
  runId: string;
  coverageStart: Date;
  coverageEnd: Date;
  lastProcessedSourceTimestamp?: Date | null;
  sourceCursor?: string | null;
  initialBackfillCompletedAt?: Date | null;
  handoffSummary: string;
  lastExploredEntities?: Record<string, unknown>[];
  knownGaps?: Record<string, unknown>[];
  metadata?: Record<string, unknown> | null;
}

export class PersonalIntelligenceCheckpointStore {
  constructor(
    private readonly deps: {
      db: Database;
      user?: PersonalIntelligenceCheckpointOwner;
    },
  ) {}

  async listByAccountScopes(accounts: Array<{ toolkitSlug: string; accountScopeId: string; connectedAccountId?: string }>): Promise<StoredPersonalIntelligenceCheckpoint[]> {
    const owner = this.requireUser();
    const accountScopeIds = [...new Set(accounts.map((account) => account.accountScopeId?.trim()).filter((value): value is string => Boolean(value)))];
    if (accountScopeIds.length === 0) {
      return [];
    }

    const rows = await this.deps.db
      .select()
      .from(schema.personalIntelligenceCheckpoints)
      .where(and(
        eq(schema.personalIntelligenceCheckpoints.tenantId, owner.tenantId),
        eq(schema.personalIntelligenceCheckpoints.userId, owner.userId),
        inArray(schema.personalIntelligenceCheckpoints.accountScopeId, accountScopeIds),
      ));

    return rows.map((row) => row as StoredPersonalIntelligenceCheckpoint);
  }

  async upsertMany(updates: PersonalIntelligenceCheckpointUpdate[]): Promise<StoredPersonalIntelligenceCheckpoint[]> {
    if (updates.length === 0) {
      return [];
    }

    const results: StoredPersonalIntelligenceCheckpoint[] = [];
    for (const update of updates) {
      results.push(await this.upsert(update));
    }
    return results;
  }

  async upsert(update: PersonalIntelligenceCheckpointUpdate): Promise<StoredPersonalIntelligenceCheckpoint> {
    const owner = this.requireUser();
    const now = new Date();
    const normalized = normalizeScope(update);
    const values = {
      id: generateId("pickpt"),
      tenantId: owner.tenantId,
      userId: owner.userId,
      toolkitSlug: normalized.toolkitSlug,
      accountScopeId: normalized.accountScopeId,
      connectedAccountId: normalized.connectedAccountId,
      sourceType: normalized.sourceType,
      coverageStart: update.coverageStart,
      coverageEnd: update.coverageEnd,
      lastProcessedSourceTimestamp: update.lastProcessedSourceTimestamp ?? update.coverageEnd,
      sourceCursor: normalizeOptionalText(update.sourceCursor),
      initialBackfillCompletedAt: update.initialBackfillCompletedAt ?? update.coverageEnd,
      lastSuccessfulRunId: update.runId,
      lastExploredEntities: update.lastExploredEntities ?? [],
      knownGaps: update.knownGaps ?? [],
      handoffSummary: normalizeOptionalText(update.handoffSummary),
      metadata: update.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const [row] = await this.deps.db
      .insert(schema.personalIntelligenceCheckpoints)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.personalIntelligenceCheckpoints.tenantId,
          schema.personalIntelligenceCheckpoints.userId,
          schema.personalIntelligenceCheckpoints.toolkitSlug,
          schema.personalIntelligenceCheckpoints.accountScopeId,
          schema.personalIntelligenceCheckpoints.sourceType,
        ],
        set: {
          connectedAccountId: values.connectedAccountId,
          coverageStart: values.coverageStart,
          coverageEnd: values.coverageEnd,
          lastProcessedSourceTimestamp: values.lastProcessedSourceTimestamp,
          sourceCursor: values.sourceCursor,
          initialBackfillCompletedAt: values.initialBackfillCompletedAt,
          lastSuccessfulRunId: values.lastSuccessfulRunId,
          lastExploredEntities: values.lastExploredEntities,
          knownGaps: values.knownGaps,
          handoffSummary: values.handoffSummary,
          metadata: values.metadata,
          updatedAt: now,
        },
      })
      .returning();

    return row as StoredPersonalIntelligenceCheckpoint;
  }

  private requireUser(): PersonalIntelligenceCheckpointOwner {
    const owner = this.deps.user;
    if (!owner) {
      throw new Error("PersonalIntelligenceCheckpointStore requires a user context for owner-scoped operations.");
    }
    return owner;
  }
}

export function normalizeCheckpointScope(input: PersonalIntelligenceCheckpointScope): PersonalIntelligenceCheckpointScope {
  return normalizeScope(input);
}

export function buildCheckpointKey(input: PersonalIntelligenceCheckpointScope): string {
  const normalized = normalizeScope(input);
  return `${normalized.toolkitSlug}:${normalized.accountScopeId}:${normalized.sourceType}`;
}

function normalizeScope(input: PersonalIntelligenceCheckpointScope): PersonalIntelligenceCheckpointScope {
  const accountScopeId = getPersonalIntelligenceAccountScopeId(input);
  if (!accountScopeId) {
    throw new Error("Personal Intelligence checkpoint scope requires an account scope.");
  }
  return {
    toolkitSlug: normalizeSlug(input.toolkitSlug),
    accountScopeId,
    connectedAccountId: input.connectedAccountId.trim(),
    sourceType: normalizeSlug(input.sourceType),
  };
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
