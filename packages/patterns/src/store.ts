import {
  generateId,
  sanitizePostgresJson,
  sanitizePostgresText,
  type PatternConnectorIssue,
  type PatternConnectorScope,
  type PatternNotifyCondition,
  type PatternRecord,
  type PatternRunRecord,
  type PatternRunSkipReason,
  type PatternRunToolScope,
  type PatternRunTrigger,
  type PatternSchedule,
  type PatternNotifyOutcome,
  type PatternReminderContext,
  type PatternTriggerFilter,
  type PatternTriggerConfig,
  type PatternTriggerType,
  type PatternWeekday,
  type UserContext,
  type WorkerResult,
  type WorkerType,
} from "@finn/core";
import * as schema from "@finn/db";
import type { Database, StoredPattern, StoredPatternRun } from "@finn/db";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import CronExpressionParser from "cron-parser";

const intervalMsByUnit = {
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
} as const;

const weekdayNumbers = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const satisfies Record<PatternWeekday, number>;

const weekdayCronNumbers = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const satisfies Record<PatternWeekday, number>;

const dateTimeWithOffsetPattern = /(?:z|[+-]\d{2}:?\d{2})$/i;

function sanitizeNullableText(value: string | null | undefined): string | null {
  return value == null ? null : sanitizePostgresText(value);
}

function isScheduleConfig(triggerConfig: PatternTriggerConfig): triggerConfig is Extract<PatternTriggerConfig, { type: "schedule" }> {
  return triggerConfig.type === "schedule";
}

export function isOneShotScheduleConfig(triggerConfig: PatternTriggerConfig): boolean {
  return isScheduleConfig(triggerConfig)
    && (triggerConfig.schedule.kind === "once" || (triggerConfig.schedule.kind === "internal_cron" && triggerConfig.schedule.oneShot === true));
}

function parseTime(value: string): { hour: number; minute: number; second: number } {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid schedule time: ${value}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid schedule time: ${value}`);
  }

  return { hour, minute, second };
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid schedule date: ${value}`);
  }

  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Could not format ${type} for timezone ${timeZone}.`);
    return value;
  };

  return `${lookup("year")}-${lookup("month")}-${lookup("day")}T${lookup("hour")}:${lookup("minute")}:${lookup("second")}`;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const localDateTime = formatLocalDateTime(date, timeZone);
  const [datePart, timePart] = localDateTime.split("T");
  const { year, month, day } = parseDate(datePart);
  const { hour, minute, second } = parseTime(timePart);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
}

function parseLocalDateTime(value: string, timeZone: string): Date {
  if (dateTimeWithOffsetPattern.test(value)) {
    return new Date(value);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})[tT ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    return new Date(value);
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const utcGuess = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  const firstPass = new Date(utcGuess.getTime() - getTimeZoneOffsetMs(utcGuess, timeZone));
  return new Date(utcGuess.getTime() - getTimeZoneOffsetMs(firstPass, timeZone));
}

function buildLocalDateTime(date: { year: number; month: number; day: number }, time: { hour: number; minute: number; second: number }): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  const hour = String(time.hour).padStart(2, "0");
  const minute = String(time.minute).padStart(2, "0");
  const second = String(time.second).padStart(2, "0");
  return `${date.year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function compareDate(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getLocalDateAfterBoundary(schedule: Extract<PatternSchedule, { startDate?: string }>, after: Date, timeZone: string): { year: number; month: number; day: number } {
  const [datePart] = formatLocalDateTime(after, timeZone).split("T");
  const localDate = parseDate(datePart);
  if (!schedule.startDate) {
    return localDate;
  }

  const startDate = parseDate(schedule.startDate);
  return compareDate(startDate, localDate) > 0 ? startDate : localDate;
}

function computeDailyNextRun(schedule: Extract<PatternSchedule, { kind: "daily" }>, timeZone: string, after: Date): Date {
  const time = parseTime(schedule.time);
  let candidateDate = getLocalDateAfterBoundary(schedule, after, timeZone);
  let candidate = parseLocalDateTime(buildLocalDateTime(candidateDate, time), timeZone);
  if (candidate.getTime() <= after.getTime()) {
    candidateDate = addDays(candidateDate, 1);
    candidate = parseLocalDateTime(buildLocalDateTime(candidateDate, time), timeZone);
  }
  return candidate;
}

function computeWeeklyNextRun(schedule: Extract<PatternSchedule, { kind: "weekly" }>, timeZone: string, after: Date): Date {
  const allowedDays = new Set(schedule.daysOfWeek.map((day) => weekdayNumbers[day]));
  if (allowedDays.size === 0) {
    throw new Error("Weekly schedule requires at least one weekday.");
  }

  const time = parseTime(schedule.time);
  const startDate = getLocalDateAfterBoundary(schedule, after, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDate = addDays(startDate, offset);
    const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();
    if (!allowedDays.has(weekday as (typeof weekdayNumbers)[PatternWeekday])) continue;

    const candidate = parseLocalDateTime(buildLocalDateTime(candidateDate, time), timeZone);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  throw new Error("Could not compute next weekly schedule run.");
}

function computeMonthlyNextRun(schedule: Extract<PatternSchedule, { kind: "monthly" }>, timeZone: string, after: Date): Date {
  const time = parseTime(schedule.time);
  const startDate = getLocalDateAfterBoundary(schedule, after, timeZone);

  for (let offset = 0; offset <= 24; offset += 1) {
    const monthIndex = startDate.month - 1 + offset;
    const year = startDate.year + Math.floor(monthIndex / 12);
    const month = monthIndex % 12 + 1;
    const day = schedule.dayOfMonth === "last" ? daysInMonth(year, month) : schedule.dayOfMonth;
    if (day < 1 || day > daysInMonth(year, month)) continue;

    const candidateDate = { year, month, day };
    if (compareDate(candidateDate, startDate) < 0) continue;

    const candidate = parseLocalDateTime(buildLocalDateTime(candidateDate, time), timeZone);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  throw new Error("Could not compute next monthly schedule run.");
}

export const defaultPatternConnectorScope = (): PatternConnectorScope => ({
  composio: [],
  mcpServerIds: [],
});

export const defaultPatternNotifyCondition = (): PatternNotifyCondition => ({ type: "always" });

export type PatternConnectorScopeInput = Partial<PatternConnectorScope>;

function normalizeConnectorScope(scope?: PatternConnectorScopeInput): PatternConnectorScope {
  return {
    composio: scope?.composio ?? [],
    mcpServerIds: scope?.mcpServerIds ?? [],
    ...(scope?.issues?.length ? { issues: scope.issues } : {}),
  };
}

function composioScopeMatches(input: { toolkitSlug: string; connectedAccountId?: string }, toolkitSlug: string, connectedAccountId?: string): boolean {
  return input.toolkitSlug === toolkitSlug
    && (!connectedAccountId || !input.connectedAccountId || input.connectedAccountId === connectedAccountId);
}

export function patternUsesComposioConnector(pattern: PatternRecord, toolkitSlug: string, connectedAccountId?: string): boolean {
  return pattern.connectorScope.composio.some((scope) => composioScopeMatches(scope, toolkitSlug, connectedAccountId))
    || (
      pattern.triggerConfig.type === "composio"
      && composioScopeMatches(pattern.triggerConfig, toolkitSlug, connectedAccountId)
    );
}

export function addComposioConnectorIssue(
  connectorScope: PatternConnectorScope,
  issue: Omit<PatternConnectorIssue, "type" | "pausedAt"> & { pausedAt?: string },
): PatternConnectorScope {
  const nextIssue: PatternConnectorIssue = {
    type: "composio_connector_unavailable",
    toolkitSlug: issue.toolkitSlug,
    ...(issue.connectedAccountId ? { connectedAccountId: issue.connectedAccountId } : {}),
    reason: issue.reason,
    pausedAt: issue.pausedAt ?? new Date().toISOString(),
    resumeOnReconnect: issue.resumeOnReconnect,
  };
  const issues = [
    ...(connectorScope.issues ?? []).filter((current) => !composioScopeMatches(current, issue.toolkitSlug, issue.connectedAccountId)),
    nextIssue,
  ];
  return {
    ...connectorScope,
    issues,
  };
}

export function replaceComposioConnectorAccount(
  connectorScope: PatternConnectorScope,
  toolkitSlug: string,
  connectedAccountId: string,
  options: { ensureToolkitScope?: boolean; previousConnectedAccountId?: string | null } = {},
): PatternConnectorScope {
  const shouldReplaceAccount = (scope: { toolkitSlug: string; connectedAccountId?: string }): boolean => {
    if (scope.toolkitSlug !== toolkitSlug) {
      return false;
    }
    if (options.previousConnectedAccountId) {
      return !scope.connectedAccountId || scope.connectedAccountId === options.previousConnectedAccountId;
    }
    return !scope.connectedAccountId || scope.connectedAccountId === connectedAccountId;
  };
  let replacedScope = false;
  const composio = connectorScope.composio.map((scope) => {
    if (!shouldReplaceAccount(scope)) {
      return scope;
    }
    replacedScope = true;
    return { ...scope, connectedAccountId };
  });
  const hasTargetScope = composio.some((scope) => scope.toolkitSlug === toolkitSlug && scope.connectedAccountId === connectedAccountId);
  if (!replacedScope && !hasTargetScope && options.ensureToolkitScope) {
    composio.push({ toolkitSlug, connectedAccountId });
  }
  const issues = connectorScope.issues?.filter((issue) => !shouldReplaceAccount(issue)) ?? [];
  const { issues: _issues, ...rest } = connectorScope;
  return {
    ...rest,
    composio,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

export interface CreatePatternParams {
  name: string;
  description?: string | null;
  userDescription?: string | null;
  triggerType: PatternTriggerType;
  triggerConfig: PatternTriggerConfig;
  connectorScope?: PatternConnectorScopeInput;
  triggerFilters?: PatternTriggerFilter[];
  notifyCondition?: PatternNotifyCondition;
  workerType?: WorkerType;
  taskPrompt: string;
  reminderContext?: PatternReminderContext | null;
  timezone?: string;
  active?: boolean;
  nextRunAt?: Date | null;
}

export interface UpdatePatternParams {
  name?: string;
  userDescription?: string | null;
  taskPrompt?: string;
  reminderContext?: PatternReminderContext | null;
  active?: boolean;
  triggerType?: PatternTriggerType;
  triggerConfig?: PatternTriggerConfig;
  connectorScope?: PatternConnectorScopeInput;
  triggerFilters?: PatternTriggerFilter[];
  notifyCondition?: PatternNotifyCondition;
  timezone?: string;
  nextRunAt?: Date | null;
  lastRunAt?: Date | null;
  failureCount?: number;
}

type PatternDatabase = Omit<Database, "$client">;

interface ScheduledRunClaim {
  run: PatternRunRecord;
}

type TransactionalDatabase = PatternDatabase & {
  transaction<T>(operation: (tx: PatternDatabase) => Promise<T>): Promise<T>;
};

type AdvisoryLockDatabase = PatternDatabase & {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
};

function hasTransactions(db: PatternDatabase): db is TransactionalDatabase {
  return typeof (db as Partial<TransactionalDatabase>).transaction === "function";
}

function hasAdvisoryLockExecution(db: PatternDatabase): db is AdvisoryLockDatabase {
  return typeof (db as Partial<AdvisoryLockDatabase>).execute === "function";
}

export class PatternStore {
  constructor(
    private readonly deps: {
      db: PatternDatabase;
      user?: UserContext;
      inTransaction?: boolean;
    },
  ) {}

  async create(params: CreatePatternParams): Promise<PatternRecord> {
    const owner = this.requireUser();
    const now = new Date();
    const timezone = params.timezone ?? owner.timezone ?? "UTC";
    const nextRunAt = params.nextRunAt !== undefined
      ? params.nextRunAt
      : params.triggerType === "schedule"
        ? this.computeNextRun(params.triggerConfig, timezone)
        : null;

    const [created] = await this.deps.db
      .insert(schema.patterns)
      .values({
        id: generateId("ptn"),
        tenantId: owner.tenantId,
        userId: owner.userId,
        name: sanitizePostgresText(params.name),
        description: sanitizeNullableText(params.description),
        userDescription: sanitizeNullableText(params.userDescription),
        triggerType: params.triggerType,
        triggerConfig: sanitizePostgresJson(params.triggerConfig),
        connectorScope: sanitizePostgresJson(normalizeConnectorScope(params.connectorScope)),
        triggerFilters: sanitizePostgresJson(params.triggerFilters ?? []),
        notifyCondition: sanitizePostgresJson(params.notifyCondition ?? defaultPatternNotifyCondition()),
        workerType: params.workerType ?? "pattern_worker",
        taskPrompt: sanitizePostgresText(params.taskPrompt),
        reminderContext: sanitizePostgresJson(params.reminderContext ?? null),
        timezone: sanitizePostgresText(timezone),
        active: params.active ?? true,
        failureCount: 0,
        lastRunAt: null,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapPattern(created);
  }

  async createForUser(user: UserContext, params: CreatePatternParams): Promise<PatternRecord> {
    return new PatternStore({ db: this.deps.db, user }).create(params);
  }

  async list(): Promise<PatternRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(this.ownerWhere())
      .orderBy(schema.patterns.createdAt);

    return rows.map((row) => this.mapPattern(row));
  }

  async listForUser(user: UserContext): Promise<PatternRecord[]> {
    return new PatternStore({ db: this.deps.db, user }).list();
  }

  async listActive(): Promise<PatternRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(and(this.ownerWhere(), eq(schema.patterns.active, true)))
      .orderBy(schema.patterns.createdAt);

    return rows.map((row) => this.mapPattern(row));
  }

  async getById(id: string): Promise<PatternRecord | null> {
    const [row] = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(and(this.ownerWhere(), eq(schema.patterns.id, id)))
      .limit(1);

    return row ? this.mapPattern(row) : null;
  }

  async getByIdForUser(user: UserContext, id: string): Promise<PatternRecord | null> {
    return new PatternStore({ db: this.deps.db, user }).getById(id);
  }

  async getByWorkerId(workerId: string): Promise<PatternRecord | null> {
    const [row] = await this.deps.db
      .select({ pattern: schema.patterns })
      .from(schema.patternRuns)
      .innerJoin(schema.patterns, eq(schema.patternRuns.patternId, schema.patterns.id))
      .where(and(this.runOwnerWhere(), eq(schema.patternRuns.workerId, workerId)))
      .limit(1);

    return row ? this.mapPattern(row.pattern) : null;
  }

  async updateForUser(user: UserContext, id: string, params: UpdatePatternParams): Promise<PatternRecord | null> {
    return new PatternStore({ db: this.deps.db, user }).update(id, params);
  }

  async toggleForUser(user: UserContext, id: string): Promise<PatternRecord | null> {
    return new PatternStore({ db: this.deps.db, user }).toggle(id);
  }

  async setActiveForUser(user: UserContext, id: string, active: boolean): Promise<PatternRecord | null> {
    return new PatternStore({ db: this.deps.db, user }).setActive(id, active);
  }

  async removeForUser(user: UserContext, id: string): Promise<PatternRecord | null> {
    return new PatternStore({ db: this.deps.db, user }).remove(id);
  }

  async getByComposioTriggerId(triggerId: string): Promise<PatternRecord | null> {
    const [row] = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(sql`${schema.patterns.triggerConfig}->>'triggerId' = ${triggerId}`)
      .limit(1);

    return row ? this.mapPattern(row) : null;
  }

  async getAllByComposioTriggerId(triggerId: string): Promise<PatternRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(sql`${schema.patterns.triggerConfig}->>'triggerId' = ${triggerId}`)
      .orderBy(schema.patterns.createdAt);

    return rows.map((row) => this.mapPattern(row));
  }

  async hasComposioTriggerUsers(triggerId: string): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.patterns)
      .where(and(
        this.ownerWhere(),
        sql`${schema.patterns.triggerConfig}->>'triggerId' = ${triggerId}`,
      ));

    return Number(row?.count ?? 0) > 0;
  }

  async hasOtherComposioTriggerUsers(triggerId: string, excludedPatternId: string): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.patterns)
      .where(and(
        this.ownerWhere(),
        sql`${schema.patterns.triggerConfig}->>'triggerId' = ${triggerId}`,
        sql`${schema.patterns.id} <> ${excludedPatternId}`,
      ));

    return Number(row?.count ?? 0) > 0;
  }

  async hasOtherActiveComposioTriggerUsers(triggerId: string, excludedPatternId: string): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.patterns)
      .where(and(
        this.ownerWhere(),
        eq(schema.patterns.active, true),
        sql`${schema.patterns.triggerConfig}->>'triggerId' = ${triggerId}`,
        sql`${schema.patterns.id} <> ${excludedPatternId}`,
      ));

    return Number(row?.count ?? 0) > 0;
  }

  private getScopedLockName(scope: string, id: string): string {
    return this.deps.user
      ? `${scope}:${this.deps.user.tenantId}:${this.deps.user.userId}:${id}`
      : `${scope}:${id}`;
  }

  private async withAdvisoryLock<T>(lockName: string, operation: (store: PatternStore) => Promise<T>): Promise<T> {
    if (this.deps.inTransaction && hasAdvisoryLockExecution(this.deps.db)) {
      await this.deps.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0::bigint))`);
      return operation(this);
    }
    if (hasTransactions(this.deps.db)) {
      return this.deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0::bigint))`);
        return operation(new PatternStore({ db: tx, user: this.deps.user, inTransaction: true }));
      });
    }

    return operation(this);
  }

  async withComposioTriggerLock<T>(triggerId: string, operation: (store: PatternStore) => Promise<T>): Promise<T> {
    return this.withAdvisoryLock(this.getScopedLockName("composio-trigger", triggerId), operation);
  }

  async withPatternLock<T>(patternId: string, operation: (store: PatternStore) => Promise<T>): Promise<T> {
    return this.withAdvisoryLock(this.getScopedLockName("pattern", patternId), operation);
  }

  async listByComposioConnector(toolkitSlug: string, connectedAccountId?: string): Promise<PatternRecord[]> {
    const patterns = await this.list();
    return patterns.filter((pattern) => patternUsesComposioConnector(pattern, toolkitSlug, connectedAccountId));
  }

  async getDue(): Promise<PatternRecord[]> {
    const now = new Date();
    const rows = await this.deps.db
      .select()
      .from(schema.patterns)
      .where(and(
        eq(schema.patterns.active, true),
        eq(schema.patterns.triggerType, "schedule"),
        lte(schema.patterns.nextRunAt, now),
      ));

    return rows.map((row) => this.mapPattern(row));
  }

  async claimScheduledRun(pattern: PatternRecord): Promise<ScheduledRunClaim | null> {
    const now = new Date();
    const nextRunAt = isScheduleConfig(pattern.triggerConfig) && !isOneShotScheduleConfig(pattern.triggerConfig)
      ? this.computeNextRun(pattern.triggerConfig, pattern.timezone)
      : null;
    const [claimed] = await this.deps.db
      .update(schema.patterns)
      .set({
        lastRunAt: now,
        nextRunAt,
        failureCount: 0,
        updatedAt: now,
      })
      .where(and(
        this.ownerWhere(),
        eq(schema.patterns.id, pattern.id),
        eq(schema.patterns.active, true),
        eq(schema.patterns.triggerType, "schedule"),
        lte(schema.patterns.nextRunAt, now),
      ))
      .returning();

    if (!claimed) {
      return null;
    }

    return {
      run: await this.createRun({ pattern: this.mapPattern(claimed), triggeredBy: "schedule", triggerPayload: null }),
    };
  }

  async update(id: string, params: UpdatePatternParams): Promise<PatternRecord | null> {
    const now = new Date();
    const current = params.nextRunAt === undefined && (params.triggerType !== undefined || params.triggerConfig !== undefined || params.timezone !== undefined || params.active !== undefined)
      ? await this.getById(id)
      : null;
    const triggerType = params.triggerType ?? current?.triggerType;
    const triggerConfig = params.triggerConfig ?? current?.triggerConfig;
    const timezone = params.timezone ?? current?.timezone;
    const active = params.active ?? current?.active;
    const nextRunAt = params.nextRunAt !== undefined
      ? params.nextRunAt
      : active === true && triggerType === "schedule" && triggerConfig && timezone
        ? this.computeNextRun(triggerConfig, timezone)
        : undefined;
    const [updated] = await this.deps.db
      .update(schema.patterns)
      .set({
        ...(params.name !== undefined ? { name: sanitizePostgresText(params.name) } : {}),
        ...(params.userDescription !== undefined ? { userDescription: sanitizeNullableText(params.userDescription) } : {}),
        ...(params.taskPrompt !== undefined ? { taskPrompt: sanitizePostgresText(params.taskPrompt) } : {}),
        ...(params.reminderContext !== undefined ? { reminderContext: sanitizePostgresJson(params.reminderContext) } : {}),
        ...(params.active !== undefined ? { active: params.active } : {}),
        ...(params.triggerType !== undefined ? { triggerType: params.triggerType } : {}),
        ...(params.triggerConfig !== undefined ? { triggerConfig: sanitizePostgresJson(params.triggerConfig) } : {}),
        ...(params.connectorScope !== undefined ? { connectorScope: sanitizePostgresJson(normalizeConnectorScope(params.connectorScope)) } : {}),
        ...(params.triggerFilters !== undefined ? { triggerFilters: sanitizePostgresJson(params.triggerFilters) } : {}),
        ...(params.notifyCondition !== undefined ? { notifyCondition: sanitizePostgresJson(params.notifyCondition) } : {}),
        ...(params.timezone !== undefined ? { timezone: sanitizePostgresText(params.timezone) } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(params.lastRunAt !== undefined ? { lastRunAt: params.lastRunAt } : {}),
        ...(params.failureCount !== undefined ? { failureCount: params.failureCount } : {}),
        updatedAt: now,
      })
      .where(and(this.ownerWhere(), eq(schema.patterns.id, id)))
      .returning();

    return updated ? this.mapPattern(updated) : null;
  }

  async toggle(id: string): Promise<PatternRecord | null> {
    const pattern = await this.getById(id);
    if (!pattern) return null;

    return this.setActive(id, !pattern.active);
  }

  async setActive(id: string, active: boolean): Promise<PatternRecord | null> {
    const pattern = await this.getById(id);
    if (!pattern) return null;

    if (pattern.active === active) return pattern;

    const nextRunAt = active && pattern.triggerType === "schedule"
      ? this.computeNextRun(pattern.triggerConfig, pattern.timezone)
      : pattern.nextRunAt;

    return this.update(id, { active, nextRunAt, failureCount: active ? 0 : pattern.failureCount });
  }

  async remove(id: string): Promise<PatternRecord | null> {
    const [deleted] = await this.deps.db
      .delete(schema.patterns)
      .where(and(this.ownerWhere(), eq(schema.patterns.id, id)))
      .returning();

    return deleted ? this.mapPattern(deleted) : null;
  }

  async updateAfterScheduledRun(pattern: PatternRecord, nextRunAt: Date | null): Promise<void> {
    await this.update(pattern.id, {
      lastRunAt: new Date(),
      nextRunAt,
      failureCount: 0,
      active: pattern.active,
    });
  }

  async incrementFailure(id: string): Promise<number> {
    const [updated] = await this.deps.db
      .update(schema.patterns)
      .set({
        failureCount: sql`${schema.patterns.failureCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.patterns.id, id))
      .returning({ failureCount: schema.patterns.failureCount });

    return updated?.failureCount ?? 0;
  }

  async deactivate(id: string): Promise<void> {
    await this.deps.db
      .update(schema.patterns)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.patterns.id, id));
  }

  async getActiveCount(): Promise<number> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.patterns)
      .where(and(this.ownerWhere(), eq(schema.patterns.active, true)));

    return Number(row?.count ?? 0);
  }

  async listRuns(params: { patternId: string; limit?: number; beforeRunId?: string }): Promise<PatternRunRecord[]> {
    const limit = Math.min(Math.max(params.limit ?? 5, 0), 5);
    if (limit === 0) {
      return [];
    }

    const beforeRun = params.beforeRunId
      ? await this.getRunById(params.beforeRunId)
      : null;
    const rows = await this.deps.db
      .select()
      .from(schema.patternRuns)
      .where(and(
        this.runOwnerWhere(),
        eq(schema.patternRuns.patternId, params.patternId),
        beforeRun ? lte(schema.patternRuns.createdAt, beforeRun.createdAt) : undefined,
        params.beforeRunId ? sql`${schema.patternRuns.id} <> ${params.beforeRunId}` : undefined,
      ))
      .orderBy(desc(schema.patternRuns.createdAt))
      .limit(limit);

    return rows.map((row) => this.mapRun(row));
  }

  async countRuns(params: { patternId: string; beforeRunId?: string }): Promise<number> {
    const beforeRun = params.beforeRunId
      ? await this.getRunById(params.beforeRunId)
      : null;
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.patternRuns)
      .where(and(
        this.runOwnerWhere(),
        eq(schema.patternRuns.patternId, params.patternId),
        beforeRun ? lte(schema.patternRuns.createdAt, beforeRun.createdAt) : undefined,
        params.beforeRunId ? sql`${schema.patternRuns.id} <> ${params.beforeRunId}` : undefined,
      ));

    return Number(row?.count ?? 0);
  }

  async getRun(patternId: string, runId: string): Promise<PatternRunRecord | null> {
    const [row] = await this.deps.db
      .select()
      .from(schema.patternRuns)
      .where(and(this.runOwnerWhere(), eq(schema.patternRuns.patternId, patternId), eq(schema.patternRuns.id, runId)))
      .limit(1);

    return row ? this.mapRun(row) : null;
  }

  async markRunSurfaced(runId: string, surfacedAt = new Date()): Promise<PatternRunRecord | null> {
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({ surfacedAt })
      .where(and(this.runOwnerWhere(), eq(schema.patternRuns.id, runId)))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async recordRunToolScope(runId: string, toolScope: PatternRunToolScope): Promise<void> {
    await this.deps.db
      .update(schema.patternRuns)
      .set({ toolScope: sanitizePostgresJson(toolScope) })
      .where(and(this.runOwnerWhere(), eq(schema.patternRuns.id, runId)));
  }

  async createRun(params: {
    pattern: PatternRecord;
    triggeredBy: PatternRunTrigger;
    triggerPayload?: Record<string, unknown> | null;
  }): Promise<PatternRunRecord> {
    const now = new Date();
    const [created] = await this.deps.db
      .insert(schema.patternRuns)
      .values({
        id: generateId("ptrun"),
        tenantId: params.pattern.tenantId,
        userId: params.pattern.userId,
        patternId: params.pattern.id,
        triggeredBy: params.triggeredBy,
        triggerPayload: sanitizePostgresJson(params.triggerPayload ?? null),
        workerId: null,
        state: "queued",
        result: null,
        notifyOutcome: null,
        surfacedAt: null,
        toolScope: null,
        error: null,
        skipReason: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      })
      .returning();

    return this.mapRun(created);
  }

  async markRunStarted(runId: string, workerId: string): Promise<void> {
    await this.deps.db
      .update(schema.patternRuns)
      .set({ workerId, state: "running", startedAt: new Date() })
      .where(eq(schema.patternRuns.id, runId));
  }

  async markRunCompleted(workerId: string, result: WorkerResult, notifyOutcome: PatternNotifyOutcome): Promise<PatternRunRecord | null> {
    const now = new Date();
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({
        state: "done",
        result: sanitizePostgresJson(result),
        notifyOutcome: sanitizePostgresJson(notifyOutcome),
        error: null,
        completedAt: now,
      })
      .where(and(eq(schema.patternRuns.workerId, workerId), inArray(schema.patternRuns.state, ["queued", "running"])))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async markReminderRunCompleted(runId: string, result: WorkerResult, notifyOutcome: PatternNotifyOutcome): Promise<PatternRunRecord | null> {
    const now = new Date();
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({
        state: "done",
        result: sanitizePostgresJson(result),
        notifyOutcome: sanitizePostgresJson(notifyOutcome),
        error: null,
        completedAt: now,
      })
      .where(and(eq(schema.patternRuns.id, runId), inArray(schema.patternRuns.state, ["queued", "running"])))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async markRunFailed(workerId: string, error: string): Promise<PatternRunRecord | null> {
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({ state: "failed", error: sanitizePostgresText(error), completedAt: new Date() })
      .where(and(eq(schema.patternRuns.workerId, workerId), inArray(schema.patternRuns.state, ["queued", "running"])))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async markRunCancelled(workerId: string, error: string): Promise<PatternRunRecord | null> {
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({ state: "cancelled", error: sanitizePostgresText(error), completedAt: new Date() })
      .where(and(eq(schema.patternRuns.workerId, workerId), inArray(schema.patternRuns.state, ["queued", "running"])))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async markRunFailedById(runId: string, error: string): Promise<PatternRunRecord | null> {
    const [updated] = await this.deps.db
      .update(schema.patternRuns)
      .set({ state: "failed", error: sanitizePostgresText(error), completedAt: new Date() })
      .where(and(eq(schema.patternRuns.id, runId), inArray(schema.patternRuns.state, ["queued", "running"])))
      .returning();

    return updated ? this.mapRun(updated) : null;
  }

  async createSkippedRun(params: {
    pattern: PatternRecord;
    triggeredBy: PatternRunTrigger;
    triggerPayload?: Record<string, unknown> | null;
    skipReason: PatternRunSkipReason;
    result: WorkerResult;
  }): Promise<PatternRunRecord> {
    const now = new Date();
    const [created] = await this.deps.db
      .insert(schema.patternRuns)
      .values({
        id: generateId("ptrun"),
        tenantId: params.pattern.tenantId,
        userId: params.pattern.userId,
        patternId: params.pattern.id,
        triggeredBy: params.triggeredBy,
        triggerPayload: sanitizePostgresJson(params.triggerPayload ?? null),
        workerId: null,
        state: "cancelled",
        result: sanitizePostgresJson(params.result),
        notifyOutcome: null,
        surfacedAt: null,
        toolScope: null,
        error: null,
        skipReason: params.skipReason,
        createdAt: now,
        startedAt: null,
        completedAt: now,
      })
      .returning();

    return this.mapRun(created);
  }

  computeNextRun(triggerConfig: PatternTriggerConfig, timezone: string, after = new Date()): Date | null {
    if (!isScheduleConfig(triggerConfig)) {
      return null;
    }

    const schedule = triggerConfig.schedule;
    if (schedule.kind === "once") {
      const runAt = parseLocalDateTime(schedule.localDateTime, timezone);
      return runAt.getTime() > after.getTime() ? runAt : null;
    }

    if (schedule.kind === "internal_cron") {
      return CronExpressionParser.parse(schedule.expression, { tz: timezone, currentDate: after }).next().toDate();
    }

    if (schedule.kind === "interval") {
      const anchor = schedule.anchorLocalDateTime
        ? parseLocalDateTime(schedule.anchorLocalDateTime, timezone)
        : after;
      const intervalMs = schedule.every * intervalMsByUnit[schedule.unit];
      if (anchor.getTime() > after.getTime()) {
        return anchor;
      }

      const intervalsElapsed = Math.floor((after.getTime() - anchor.getTime()) / intervalMs) + 1;
      return new Date(anchor.getTime() + intervalsElapsed * intervalMs);
    }

    if (schedule.kind === "daily") {
      return computeDailyNextRun(schedule, timezone, after);
    }

    if (schedule.kind === "weekly") {
      return computeWeeklyNextRun(schedule, timezone, after);
    }

    return computeMonthlyNextRun(schedule, timezone, after);
  }

  isOneShotSchedule(triggerConfig: PatternTriggerConfig): boolean {
    return isOneShotScheduleConfig(triggerConfig);
  }

  private mapPattern(row: StoredPattern): PatternRecord {
    return row;
  }

  private mapRun(row: StoredPatternRun): PatternRunRecord {
    return row;
  }

  private async getRunById(id: string): Promise<PatternRunRecord | null> {
    const [row] = await this.deps.db
      .select()
      .from(schema.patternRuns)
      .where(and(this.runOwnerWhere(), eq(schema.patternRuns.id, id)))
      .limit(1);

    return row ? this.mapRun(row) : null;
  }

  private requireUser(): UserContext {
    if (!this.deps.user) {
      throw new Error("Pattern operation requires a user context.");
    }

    return this.deps.user;
  }

  private ownerWhere() {
    if (!this.deps.user) {
      return sql`true`;
    }

    return and(
      eq(schema.patterns.tenantId, this.deps.user.tenantId),
      eq(schema.patterns.userId, this.deps.user.userId),
    );
  }

  private runOwnerWhere() {
    if (!this.deps.user) {
      return sql`true`;
    }

    return and(
      eq(schema.patternRuns.tenantId, this.deps.user.tenantId),
      eq(schema.patternRuns.userId, this.deps.user.userId),
    );
  }
}
