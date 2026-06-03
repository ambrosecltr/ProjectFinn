import { generateId, type AutomationRunRecord, type AutomationRunState, type AutomationRunType, type UserContext } from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

type AutomationRunOwner = Pick<UserContext, "tenantId" | "userId">;

export interface StartAutomationRunParams {
  runType: AutomationRunType;
  userLocalDate?: string | null;
  toolkitSlug?: string | null;
  accountScopeId?: string | null;
  connectedAccountId?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  contributorStatus?: Record<string, unknown> | null;
}

export interface AutomationRunConnectorScope {
  toolkitSlug: string | null;
  accountScopeId?: string | null;
  connectedAccountId: string | null;
}

export interface CompleteAutomationRunParams {
  state: Extract<AutomationRunState, "done" | "failed">;
  contributorStatus?: Record<string, unknown> | null;
  resultSummary?: string | null;
  acceptedTodoIds?: string[] | null;
  retainedDocumentIds?: string[] | null;
  skippedReasons?: Record<string, unknown> | null;
  error?: string | null;
}

export class AutomationRunStore {
  constructor(
    private readonly deps: {
      db: Database;
      user?: AutomationRunOwner;
    },
  ) {}

  async start(params: StartAutomationRunParams): Promise<AutomationRunRecord> {
    const owner = this.requireUser();
    const now = new Date();
    const [created] = await this.deps.db
      .insert(schema.automationRuns)
      .values({
        id: generateId("arun"),
        tenantId: owner.tenantId,
        userId: owner.userId,
        runType: params.runType,
        state: "running",
        userLocalDate: params.userLocalDate ?? null,
        toolkitSlug: params.toolkitSlug ?? null,
        accountScopeId: params.accountScopeId ?? null,
        connectedAccountId: params.connectedAccountId ?? null,
        windowStart: params.windowStart ?? null,
        windowEnd: params.windowEnd ?? null,
        contributorStatus: params.contributorStatus ?? null,
        resultSummary: null,
        acceptedTodoIds: null,
        retainedDocumentIds: null,
        skippedReasons: null,
        error: null,
        createdAt: now,
        completedAt: null,
      })
      .returning();

    return created as AutomationRunRecord;
  }

  async startForUser(user: AutomationRunOwner, params: StartAutomationRunParams): Promise<AutomationRunRecord> {
    return new AutomationRunStore({ db: this.deps.db, user }).start(params);
  }

  async complete(id: string, params: CompleteAutomationRunParams): Promise<AutomationRunRecord | null> {
    const [updated] = await this.deps.db
      .update(schema.automationRuns)
      .set({
        state: params.state,
        ...(params.contributorStatus !== undefined ? { contributorStatus: params.contributorStatus } : {}),
        ...(params.resultSummary !== undefined ? { resultSummary: normalizeOptionalText(params.resultSummary) } : {}),
        ...(params.acceptedTodoIds !== undefined ? { acceptedTodoIds: params.acceptedTodoIds } : {}),
        ...(params.retainedDocumentIds !== undefined ? { retainedDocumentIds: params.retainedDocumentIds } : {}),
        ...(params.skippedReasons !== undefined ? { skippedReasons: params.skippedReasons } : {}),
        ...(params.error !== undefined ? { error: normalizeOptionalText(params.error) } : {}),
        completedAt: new Date(),
      })
      .where(and(this.ownerWhere(), eq(schema.automationRuns.id, id)))
      .returning();

    return updated ? updated as AutomationRunRecord : null;
  }

  async completeForUser(user: AutomationRunOwner, id: string, params: CompleteAutomationRunParams): Promise<AutomationRunRecord | null> {
    return new AutomationRunStore({ db: this.deps.db, user }).complete(id, params);
  }

  async getLatest(runType: AutomationRunType): Promise<AutomationRunRecord | null> {
    const [run] = await this.deps.db
      .select()
      .from(schema.automationRuns)
      .where(and(this.ownerWhere(), eq(schema.automationRuns.runType, runType)))
      .orderBy(desc(schema.automationRuns.createdAt))
      .limit(1);

    return run ? run as AutomationRunRecord : null;
  }

  async getLatestForUser(user: AutomationRunOwner, runType: AutomationRunType): Promise<AutomationRunRecord | null> {
    return new AutomationRunStore({ db: this.deps.db, user }).getLatest(runType);
  }

  async getLatestForDate(runType: AutomationRunType, userLocalDate: string): Promise<AutomationRunRecord | null> {
    const [run] = await this.deps.db
      .select()
      .from(schema.automationRuns)
      .where(and(
        this.ownerWhere(),
        eq(schema.automationRuns.runType, runType),
        eq(schema.automationRuns.userLocalDate, userLocalDate),
      ))
      .orderBy(desc(schema.automationRuns.createdAt))
      .limit(1);

    return run ? run as AutomationRunRecord : null;
  }

  async hasCompletedRunSince(user: AutomationRunOwner, runType: AutomationRunType, since: Date, scope?: AutomationRunConnectorScope): Promise<boolean> {
    return Boolean(await this.getLatestCompletedRunSince(user, runType, since, scope));
  }

  async getLatestCompletedRunSince(user: AutomationRunOwner, runType: AutomationRunType, since: Date, scope?: AutomationRunConnectorScope): Promise<AutomationRunRecord | null> {
    const [run] = await this.deps.db
      .select()
      .from(schema.automationRuns)
      .where(and(
        eq(schema.automationRuns.tenantId, user.tenantId),
        eq(schema.automationRuns.userId, user.userId),
        eq(schema.automationRuns.runType, runType),
        ...connectorScopeWhere(scope),
        eq(schema.automationRuns.state, "done"),
        gte(schema.automationRuns.completedAt, since),
      ))
      .orderBy(desc(schema.automationRuns.completedAt))
      .limit(1);

    return run ? run as AutomationRunRecord : null;
  }

  async failRunningOlderThan(runTypes: AutomationRunType[], cutoff: Date, reason: string): Promise<number> {
    if (runTypes.length === 0) {
      return 0;
    }

    const failed = await this.deps.db
      .update(schema.automationRuns)
      .set({
        state: "failed",
        error: reason,
        completedAt: new Date(),
      })
      .where(and(
        inArray(schema.automationRuns.runType, runTypes),
        eq(schema.automationRuns.state, "running"),
        lte(schema.automationRuns.createdAt, cutoff),
      ))
      .returning({ id: schema.automationRuns.id });

    return failed.length;
  }

  private ownerWhere() {
    const owner = this.requireUser();
    return and(
      eq(schema.automationRuns.tenantId, owner.tenantId),
      eq(schema.automationRuns.userId, owner.userId),
    );
  }

  private requireUser(): AutomationRunOwner {
    const owner = this.deps.user;
    if (!owner) {
      throw new Error("AutomationRunStore requires a user context for owner-scoped operations.");
    }
    return owner;
  }
}

function connectorScopeWhere(scope: AutomationRunConnectorScope | undefined) {
  if (!scope) {
    return [];
  }

  const scopeConditions = [
    scope.toolkitSlug === null
      ? isNull(schema.automationRuns.toolkitSlug)
      : eq(schema.automationRuns.toolkitSlug, scope.toolkitSlug),
  ];

  if (scope.accountScopeId) {
    scopeConditions.push(eq(schema.automationRuns.accountScopeId, scope.accountScopeId));
  } else {
    scopeConditions.push(scope.connectedAccountId === null
      ? isNull(schema.automationRuns.connectedAccountId)
      : eq(schema.automationRuns.connectedAccountId, scope.connectedAccountId));
  }

  return scopeConditions;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
