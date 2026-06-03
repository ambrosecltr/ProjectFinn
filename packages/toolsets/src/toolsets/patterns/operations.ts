import type { PatternConnectorScope, PatternRecord, PatternSchedule, PatternTriggerConfig, PatternTriggerFilter, PatternWeekday } from "@finn/core";
import type { PatternsRuntimeService } from "@finn/runtime";
import {
  patternsCreateInputSchema,
  patternsDeleteInputSchema,
  patternsEditInputSchema,
  patternsInspectInputSchema,
  patternsListInputSchema,
  patternsSetActiveInputSchema,
  patternsTriggerTypeInputSchema,
  patternsTriggerTypesInputSchema,
  type PatternsCreateInput,
  type PatternsEditInput,
} from "./schemas.js";

const dateTimeWithOffsetPattern = /(?:z|[+-]\d{2}:?\d{2})$/i;
const missingConnectorScopeWarning = [
  "No connector scope is saved for this Pattern.",
  "Future Pattern workers will only receive baseline Pattern-worker tools, not Gmail, Outlook, Slack, MCP, or other connector tools.",
  "If this Pattern needs connected services, edit it in place with connectorScope.composio or connectorScope.mcpServerIds before reporting success.",
].join(" ");

function formatRuntimeTimestamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
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
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Could not format ${type} for timezone ${timeZone}.`);
    return Number(value);
  };
  const asUtc = Date.UTC(
    lookup("year"),
    lookup("month") - 1,
    lookup("day"),
    lookup("hour"),
    lookup("minute"),
    lookup("second"),
  );
  return asUtc - date.getTime();
}

function parseDateTimeInTimeZone(value: string, timeZone: string): Date {
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

function parseScheduleTime(value: string): { hour: number; minute: number; second: number } {
  const [hour = "0", minute = "0", second = "0"] = value.split(":");
  return { hour: Number(hour), minute: Number(minute), second: Number(second) };
}

function parseScheduleDate(value: string): { year: number; month: number; day: number } {
  const [year = "0", month = "0", day = "0"] = value.split("-");
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function formatLocalDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const [datePart] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).split(",");
  return parseScheduleDate(datePart);
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function compareDate(left: { year: number; month: number; day: number }, right: { year: number; month: number; day: number }): number {
  return Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day);
}

function buildLocalDateTime(date: { year: number; month: number; day: number }, time: { hour: number; minute: number; second: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:${String(time.second).padStart(2, "0")}`;
}

function getLocalDateAfterStart(schedule: Extract<PatternSchedule, { startDate?: string }>, after: Date, timeZone: string): { year: number; month: number; day: number } {
  const localDate = formatLocalDate(after, timeZone);
  if (!schedule.startDate) {
    return localDate;
  }

  const startDate = parseScheduleDate(schedule.startDate);
  return compareDate(startDate, localDate) > 0 ? startDate : localDate;
}

function computeScheduledNextRun(schedule: PatternSchedule, timeZone: string, after = new Date()): Date | null {
  if (schedule.kind === "once") {
    const runAt = parseDateTimeInTimeZone(schedule.localDateTime, timeZone);
    return runAt.getTime() > after.getTime() ? runAt : null;
  }

  if (schedule.kind === "interval") {
    const anchor = schedule.anchorLocalDateTime ? parseDateTimeInTimeZone(schedule.anchorLocalDateTime, timeZone) : after;
    const intervalMs = schedule.every * { minutes: 60_000, hours: 60 * 60_000, days: 24 * 60 * 60_000 }[schedule.unit];
    if (anchor.getTime() > after.getTime()) {
      return anchor;
    }

    const intervalsElapsed = Math.floor((after.getTime() - anchor.getTime()) / intervalMs) + 1;
    return new Date(anchor.getTime() + intervalsElapsed * intervalMs);
  }

  if (schedule.kind === "daily") {
    const time = parseScheduleTime(schedule.time);
    let candidateDate = getLocalDateAfterStart(schedule, after, timeZone);
    let candidate = parseDateTimeInTimeZone(buildLocalDateTime(candidateDate, time), timeZone);
    if (candidate.getTime() <= after.getTime()) {
      candidateDate = addDays(candidateDate, 1);
      candidate = parseDateTimeInTimeZone(buildLocalDateTime(candidateDate, time), timeZone);
    }
    return candidate;
  }

  if (schedule.kind === "weekly") {
    const weekdays: Record<PatternWeekday, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const allowedDays = new Set(schedule.daysOfWeek.map((day) => weekdays[day]));
    const time = parseScheduleTime(schedule.time);
    const startDate = getLocalDateAfterStart(schedule, after, timeZone);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidateDate = addDays(startDate, offset);
      const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();
      if (!allowedDays.has(weekday)) continue;

      const candidate = parseDateTimeInTimeZone(buildLocalDateTime(candidateDate, time), timeZone);
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  if (schedule.kind !== "monthly") {
    return null;
  }

  const time = parseScheduleTime(schedule.time);
  const startDate = getLocalDateAfterStart(schedule, after, timeZone);
  for (let offset = 0; offset <= 24; offset += 1) {
    const monthIndex = startDate.month - 1 + offset;
    const year = startDate.year + Math.floor(monthIndex / 12);
    const month = monthIndex % 12 + 1;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = schedule.dayOfMonth === "last" ? daysInMonth : schedule.dayOfMonth;
    if (day < 1 || day > daysInMonth) continue;

    const candidateDate = { year, month, day };
    if (compareDate(candidateDate, startDate) < 0) continue;

    const candidate = parseDateTimeInTimeZone(buildLocalDateTime(candidateDate, time), timeZone);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }
  return null;
}

function serializePattern(pattern: PatternRecord) {
  const runtimeAccessWarning = getPatternRuntimeAccessWarning(pattern);
  return {
    id: pattern.id,
    name: pattern.name,
    userDescription: pattern.userDescription,
    triggerType: pattern.triggerType,
    triggerConfig: pattern.triggerConfig,
    active: pattern.active,
    connectorScope: pattern.connectorScope,
    triggerFilters: pattern.triggerFilters,
    notifyCondition: pattern.notifyCondition,
    nextRun: pattern.nextRunAt?.toISOString() ?? null,
    lastRun: pattern.lastRunAt?.toISOString() ?? null,
    taskPrompt: pattern.taskPrompt,
    reminderContext: pattern.reminderContext,
    workerType: pattern.workerType,
    ...(runtimeAccessWarning ? { runtimeAccessWarning } : {}),
  };
}

function getPatternRuntimeAccessWarning(pattern: PatternRecord): string | null {
  if (pattern.workerType !== "pattern_worker") {
    return null;
  }

  const hasComposioScope = pattern.connectorScope.composio.length > 0;
  const hasMcpScope = pattern.connectorScope.mcpServerIds.length > 0;
  return hasComposioScope || hasMcpScope ? null : missingConnectorScopeWarning;
}

function serializePatternSummary(pattern: PatternRecord) {
  return {
    id: pattern.id,
    name: pattern.name,
    userDescription: pattern.userDescription,
    type: pattern.workerType === "reminder" ? "reminder" : "pattern",
  };
}

function schemaProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const properties = schema?.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : null;
}

function schemaAllowsAdditionalProperties(schema: Record<string, unknown> | undefined): boolean {
  return schema?.additionalProperties === true;
}

function schemaAllowsPath(schema: Record<string, unknown> | undefined, path: string): boolean {
  if (!schema || path.length === 0) {
    return true;
  }

  let current: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".").filter(Boolean)) {
    if (schemaAllowsAdditionalProperties(current)) {
      return true;
    }

    const properties = schemaProperties(current);
    const next = properties?.[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return false;
    }
    current = next as Record<string, unknown>;
  }

  return true;
}

function collectPayloadSchemaPaths(schema: Record<string, unknown> | undefined, prefix = "payload", depth = 0): string[] {
  if (!schema || depth > 4) {
    return [];
  }

  const properties = schemaProperties(schema);
  if (!properties) {
    return [];
  }

  return Object.entries(properties).flatMap(([name, value]) => {
    const path = `${prefix}.${name}`;
    const nested = value && typeof value === "object" && !Array.isArray(value)
      ? collectPayloadSchemaPaths(value as Record<string, unknown>, path, depth + 1)
      : [];
    return [path, ...nested];
  });
}

function normalizeTriggerFilterPath(path: string): { path: string; payloadSchemaPath?: string } {
  const trimmed = path.trim();
  if (trimmed === "payload") {
    return { path: trimmed, payloadSchemaPath: "" };
  }
  if (trimmed.startsWith("payload.")) {
    return { path: trimmed, payloadSchemaPath: trimmed.slice("payload.".length) };
  }
  if (trimmed === "triggerId" || trimmed === "triggerSlug" || trimmed.startsWith("originalPayload.")) {
    return { path: trimmed };
  }

  return { path: `payload.${trimmed}`, payloadSchemaPath: trimmed };
}

function normalizeTriggerFilters(filters: PatternTriggerFilter[] | undefined, payloadSchema: Record<string, unknown> | undefined): { filters: PatternTriggerFilter[]; error?: string } {
  if (!filters?.length) {
    return { filters: [] };
  }

  const normalized = filters.map((filter) => ({ ...filter, ...normalizeTriggerFilterPath(filter.path) }));
  const invalidPaths = normalized
    .filter((filter) => filter.payloadSchemaPath !== undefined && !schemaAllowsPath(payloadSchema, filter.payloadSchemaPath))
    .map((filter) => filter.path);

  if (invalidPaths.length > 0) {
    const availablePaths = collectPayloadSchemaPaths(payloadSchema).slice(0, 40);
    return {
      filters: [],
      error: [
        `Invalid trigger filter path${invalidPaths.length === 1 ? "" : "s"}: ${invalidPaths.join(", ")}.`,
        "Call finn.patterns.triggerType and use exact fields from payloadSchema with a payload. prefix.",
        availablePaths.length > 0 ? `Available payload paths include: ${availablePaths.join(", ")}.` : "No payload schema paths are available for this trigger.",
      ].join(" "),
    };
  }

  return { filters: normalized.map(({ payloadSchemaPath: _payloadSchemaPath, ...filter }) => filter) };
}

function extractEmailAddress(value: string): string | null {
  const match = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/.exec(value);
  return match?.[0].toLowerCase() ?? null;
}

function withNativeTriggerConfigHints(composio: NonNullable<PatternsCreateInput["composio"]>, filters: PatternTriggerFilter[] | undefined): Record<string, unknown> | undefined {
  const triggerConfig = { ...(composio.triggerConfig ?? {}) };
  if (composio.toolkitSlug !== "gmail" || composio.triggerSlug !== "GMAIL_NEW_GMAIL_MESSAGE" || (typeof triggerConfig.query === "string" && triggerConfig.query.trim().length > 0)) {
    return Object.keys(triggerConfig).length > 0 ? triggerConfig : undefined;
  }

  const senderFilter = filters?.find((filter) => filter.path === "payload.sender" && (filter.operator === "equals" || filter.operator === "contains") && typeof filter.value === "string");
  const senderEmail = typeof senderFilter?.value === "string" ? extractEmailAddress(senderFilter.value) : null;
  if (senderEmail) {
    triggerConfig.query = `from:${senderEmail}`;
  }

  return Object.keys(triggerConfig).length > 0 ? triggerConfig : undefined;
}

function connectorScopeForComposioTrigger(
  parsed: PatternsCreateInput | PatternsEditInput,
  existingScope?: PatternConnectorScope,
  previousConnectedAccountId?: string,
): Partial<PatternConnectorScope> | undefined {
  if (!parsed.composio) {
    return parsed.connectorScope ?? existingScope;
  }
  if (parsed.connectorScope) {
    return parsed.connectorScope;
  }

  const composioTrigger = parsed.composio;
  const baseScope = existingScope ?? {
    composio: [],
    mcpServerIds: [],
  };
  const shouldReplaceAccount = (scope: { toolkitSlug: string; connectedAccountId?: string }): boolean => {
    if (scope.toolkitSlug !== composioTrigger.toolkitSlug) {
      return false;
    }
    if (previousConnectedAccountId) {
      return !scope.connectedAccountId || scope.connectedAccountId === previousConnectedAccountId;
    }
    return !scope.connectedAccountId || scope.connectedAccountId === composioTrigger.connectedAccountId;
  };
  let replacedScope = false;
  const composio = baseScope.composio.map((scope) => {
    if (!shouldReplaceAccount(scope)) {
      return scope;
    }
    replacedScope = true;
    return { ...scope, connectedAccountId: composioTrigger.connectedAccountId };
  });
  const hasTargetScope = composio.some((scope) => scope.toolkitSlug === composioTrigger.toolkitSlug && scope.connectedAccountId === composioTrigger.connectedAccountId);
  if (!replacedScope && !hasTargetScope) {
    composio.push({
      toolkitSlug: composioTrigger.toolkitSlug,
      connectedAccountId: composioTrigger.connectedAccountId,
    });
  }
  const issues = baseScope.issues?.filter((issue) => !shouldReplaceAccount(issue)) ?? [];
  return {
    ...baseScope,
    composio,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

function buildScheduledTriggerParams(schedule: PatternSchedule | undefined, effectiveTimeZone: string): { triggerConfig: PatternTriggerConfig; timezone: string; nextRunAt?: Date | null } | { error: string } {
  if (!schedule) {
    return { error: "Either schedule or composio trigger metadata is required." };
  }

  if (schedule.kind === "once") {
    const targetDate = parseDateTimeInTimeZone(schedule.localDateTime, effectiveTimeZone);
    if (Number.isNaN(targetDate.getTime())) {
      return { error: `Invalid one-shot schedule datetime: ${schedule.localDateTime}` };
    }
    if (targetDate.getTime() <= Date.now()) {
      return { error: `One-shot schedule must be in the future. Current user-local time: ${formatRuntimeTimestamp(new Date(), effectiveTimeZone)} (${effectiveTimeZone}), got: ${schedule.localDateTime}` };
    }

    return {
      triggerConfig: { type: "schedule", schedule, timezoneSource: "user" },
      timezone: effectiveTimeZone,
      nextRunAt: targetDate,
    };
  }

  return {
    triggerConfig: { type: "schedule", schedule, timezoneSource: "user" },
    timezone: effectiveTimeZone,
    nextRunAt: computeScheduledNextRun(schedule, effectiveTimeZone),
  };
}

function hasScheduledEdit(input: PatternsEditInput): boolean {
  return Boolean(input.schedule);
}

function resolvesToCurrentComposioTrigger(triggerConfig: PatternTriggerConfig | undefined, currentTriggerId: string | undefined): boolean {
  if (!currentTriggerId || triggerConfig?.type !== "composio") {
    return false;
  }

  return triggerConfig.triggerId === currentTriggerId;
}

async function deleteReplacementComposioTrigger(runtime: PatternsRuntimeService, triggerId: string | null | undefined): Promise<void> {
  if (!triggerId || !runtime.deleteComposioTrigger) {
    return;
  }
  try {
    await runtime.deleteComposioTrigger(triggerId);
  } catch {
    // Cleanup is best-effort so the original edit failure remains visible.
  }
}

async function getPattern(runtime: PatternsRuntimeService, id: string): Promise<PatternRecord | null> {
  return runtime.get ? await runtime.get(id) : (await runtime.list()).find((item) => item.id === id) ?? null;
}

export async function patternsListCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsListInputSchema.parse(input);
  const offset = parsed.cursor ? Number(parsed.cursor) : 0;
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const patterns = (await runtime.list()).filter((pattern) => pattern.workerType !== "reminder");
  const page = patterns.slice(start, start + 5);
  const nextCursor = start + page.length < patterns.length ? String(start + page.length) : null;
  return {
    patterns: page.map(serializePatternSummary),
    nextCursor,
  };
}

export async function patternsInspectCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsInspectInputSchema.parse(input);
  const pattern = await getPattern(runtime, parsed.id);
  return pattern && pattern.workerType !== "reminder" ? serializePattern(pattern) : { error: "Pattern not found." };
}

export async function patternsCreateCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsCreateInputSchema.parse(input);
  const effectiveTimeZone = runtime.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  if (parsed.composio) {
    if (!runtime.createComposioTrigger) {
      return { error: "Composio trigger creation is not configured." };
    }
    const triggerType = runtime.getTriggerType ? await runtime.getTriggerType(parsed.composio.triggerSlug) : null;
    const normalizedFilters = normalizeTriggerFilters(parsed.triggerFilters, triggerType?.payloadSchema);
    if (normalizedFilters.error) {
      return { error: normalizedFilters.error };
    }
    const triggerConfig = withNativeTriggerConfigHints(parsed.composio, normalizedFilters.filters);
    let triggerId: string;
    try {
      triggerId = await runtime.createComposioTrigger({
        toolkitSlug: parsed.composio.toolkitSlug,
        triggerSlug: parsed.composio.triggerSlug,
        connectedAccountId: parsed.composio.connectedAccountId,
        ...(triggerConfig ? { triggerConfig } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Composio toolkit is not connected") && runtime.createComposioConnectionLink) {
        const authUrl = await runtime.createComposioConnectionLink(parsed.composio.toolkitSlug);
        return {
          error: message,
          toolkitSlug: parsed.composio.toolkitSlug,
          authUrl,
        };
      }
      throw error;
    }
    const pattern = await runtime.create({
      name: parsed.name,
      userDescription: parsed.userDescription,
      triggerType: "composio",
      triggerConfig: {
        type: "composio",
        toolkitSlug: parsed.composio.toolkitSlug,
        triggerSlug: parsed.composio.triggerSlug,
        connectedAccountId: parsed.composio.connectedAccountId,
        triggerId,
        ...(triggerConfig ? { triggerConfig } : {}),
      },
      connectorScope: connectorScopeForComposioTrigger(parsed),
      triggerFilters: normalizedFilters.filters,
      notifyCondition: parsed.notifyCondition,
      workerType: "pattern_worker",
      taskPrompt: parsed.prompt,
    });
    return serializePattern(pattern);
  }

  const scheduled = buildScheduledTriggerParams(parsed.schedule, effectiveTimeZone);
  if ("error" in scheduled) {
    return { error: scheduled.error };
  }

  const pattern = await runtime.create({
    name: parsed.name,
    userDescription: parsed.userDescription,
    triggerType: "schedule",
    triggerConfig: scheduled.triggerConfig,
    connectorScope: parsed.connectorScope,
    triggerFilters: parsed.triggerFilters,
    notifyCondition: parsed.notifyCondition,
    workerType: "pattern_worker",
    taskPrompt: parsed.prompt,
    timezone: scheduled.timezone,
    nextRunAt: scheduled.nextRunAt ?? undefined,
  });
  return serializePattern(pattern);
}

export async function patternsEditCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsEditInputSchema.parse(input);
  const effectiveTimeZone = runtime.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const current = await getPattern(runtime, parsed.id);
  if (!current || current.workerType === "reminder") {
    return { error: "Pattern not found." };
  }

  if (parsed.composio && hasScheduledEdit(parsed)) {
    return { error: "Provide either scheduled trigger fields or composio trigger metadata, not both." };
  }

  if (parsed.userDescription !== undefined && !parsed.userDescriptionEdit) {
    return { error: "Changing userDescription requires userDescriptionEdit.reason. Omit userDescription for schedule-only edits." };
  }

  if (parsed.prompt !== undefined && !parsed.promptEdit) {
    return { error: "Changing prompt requires promptEdit.reason. Omit prompt for schedule-only edits." };
  }

  let replacementComposioTriggerId: string | null = null;
  const updateParams: Parameters<PatternsRuntimeService["update"]>[1] = {
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.userDescription !== undefined ? { userDescription: parsed.userDescription } : {}),
    ...(parsed.prompt ? { taskPrompt: parsed.prompt } : {}),
    ...(parsed.active !== undefined ? { active: parsed.active } : {}),
    ...(parsed.connectorScope ? { connectorScope: parsed.connectorScope } : {}),
    ...(parsed.triggerFilters ? { triggerFilters: parsed.triggerFilters } : {}),
    ...(parsed.notifyCondition ? { notifyCondition: parsed.notifyCondition } : {}),
  };

  if (parsed.composio) {
    if (!runtime.createComposioTrigger) {
      return { error: "Composio trigger creation is not configured." };
    }
    const triggerType = runtime.getTriggerType ? await runtime.getTriggerType(parsed.composio.triggerSlug) : null;
    const normalizedFilters = normalizeTriggerFilters(parsed.triggerFilters, triggerType?.payloadSchema);
    if (normalizedFilters.error) {
      return { error: normalizedFilters.error };
    }
    const triggerConfig = withNativeTriggerConfigHints(parsed.composio, normalizedFilters.filters);
    try {
      replacementComposioTriggerId = await runtime.createComposioTrigger({
        toolkitSlug: parsed.composio.toolkitSlug,
        triggerSlug: parsed.composio.triggerSlug,
        connectedAccountId: parsed.composio.connectedAccountId,
        ...(triggerConfig ? { triggerConfig } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Composio toolkit is not connected") && runtime.createComposioConnectionLink) {
        const authUrl = await runtime.createComposioConnectionLink(parsed.composio.toolkitSlug);
        return {
          error: message,
          toolkitSlug: parsed.composio.toolkitSlug,
          authUrl,
        };
      }
      throw error;
    }
    Object.assign(updateParams, {
      triggerType: "composio" as const,
      triggerConfig: {
        type: "composio" as const,
        toolkitSlug: parsed.composio.toolkitSlug,
        triggerSlug: parsed.composio.triggerSlug,
        connectedAccountId: parsed.composio.connectedAccountId,
        triggerId: replacementComposioTriggerId,
        ...(triggerConfig ? { triggerConfig } : {}),
      },
      triggerFilters: normalizedFilters.filters,
      connectorScope: connectorScopeForComposioTrigger(
        parsed,
        current.connectorScope,
        current.triggerConfig.type === "composio" && current.triggerConfig.toolkitSlug === parsed.composio.toolkitSlug
          ? current.triggerConfig.connectedAccountId
          : undefined,
      ),
      nextRunAt: null,
    });
  } else if (hasScheduledEdit(parsed)) {
    const scheduled = buildScheduledTriggerParams(parsed.schedule, effectiveTimeZone);
    if ("error" in scheduled) {
      return { error: scheduled.error };
    }
    Object.assign(updateParams, {
      triggerType: "schedule" as const,
      triggerConfig: scheduled.triggerConfig,
      timezone: scheduled.timezone,
      ...(scheduled.nextRunAt !== undefined ? { nextRunAt: scheduled.nextRunAt } : {}),
    });
  }

  if (Object.keys(updateParams).length === 0) {
    return { error: "Provide at least one Pattern field to update." };
  }

  let pattern: Awaited<ReturnType<PatternsRuntimeService["update"]>>;
  try {
    pattern = await runtime.update(parsed.id, updateParams);
  } catch (error) {
    await deleteReplacementComposioTrigger(runtime, replacementComposioTriggerId);
    throw error;
  }
  if (!pattern) {
    await deleteReplacementComposioTrigger(runtime, replacementComposioTriggerId);
  }
  const currentComposioTriggerId = current.triggerConfig.type === "composio" ? current.triggerConfig.triggerId : undefined;
  const updatedTriggerConfig = "triggerConfig" in updateParams ? updateParams.triggerConfig : pattern?.triggerConfig;
  const patternStillUsesCurrentTrigger = resolvesToCurrentComposioTrigger(updatedTriggerConfig, currentComposioTriggerId);
  if (pattern && currentComposioTriggerId && !patternStillUsesCurrentTrigger) {
    await runtime.deleteComposioTrigger?.(currentComposioTriggerId, { excludedPatternId: current.id });
  }
  return pattern ? serializePattern(pattern) : { error: "Pattern not found." };
}

export async function patternsPauseCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsSetActiveInputSchema.parse(input);
  const current = await getPattern(runtime, parsed.id);
  if (!current || current.workerType === "reminder") {
    return { error: "Pattern not found." };
  }
  const pattern = await runtime.update(parsed.id, { active: false });
  return pattern ? serializePattern(pattern) : { error: "Pattern not found." };
}

export async function patternsResumeCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsSetActiveInputSchema.parse(input);
  const current = await getPattern(runtime, parsed.id);
  if (!current || current.workerType === "reminder") {
    return { error: "Pattern not found." };
  }
  if (current.connectorScope.issues?.length) {
    return { error: "Reconnect this Pattern's connector before resuming it." };
  }
  const pattern = await runtime.update(parsed.id, { active: true });
  return pattern ? serializePattern(pattern) : { error: "Pattern not found." };
}

export async function patternsDeleteCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsDeleteInputSchema.parse(input);
  const current = await getPattern(runtime, parsed.id);
  if (!current || current.workerType === "reminder") {
    return { deleted: false, id: parsed.id, error: "Pattern not found." };
  }
  const deleted = await runtime.remove(parsed.id);
  return { deleted: Boolean(deleted), id: parsed.id };
}

export async function patternsTriggerTypesCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsTriggerTypesInputSchema.parse(input);
  return runtime.listTriggerTypes ? await runtime.listTriggerTypes(parsed.toolkitSlug) : [];
}

export async function patternsTriggerTypeCommand(runtime: PatternsRuntimeService, input: unknown) {
  const parsed = patternsTriggerTypeInputSchema.parse(input);
  if (!runtime.getTriggerType) {
    return { error: "Composio trigger type discovery is not configured." };
  }
  return runtime.getTriggerType(parsed.triggerSlug);
}

export async function executePatternsCommand(runtime: PatternsRuntimeService, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "list":
      return patternsListCommand(runtime, args);
    case "inspect":
      return patternsInspectCommand(runtime, args);
    case "create":
      return patternsCreateCommand(runtime, args);
    case "edit":
      return patternsEditCommand(runtime, args);
    case "pause":
      return patternsPauseCommand(runtime, args);
    case "resume":
      return patternsResumeCommand(runtime, args);
    case "delete":
      return patternsDeleteCommand(runtime, args);
    case "trigger_types":
      return patternsTriggerTypesCommand(runtime, args);
    case "trigger_type":
      return patternsTriggerTypeCommand(runtime, args);
    default:
      throw new Error(`Unsupported Patterns command: ${command}`);
  }
}
