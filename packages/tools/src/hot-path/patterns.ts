import { tool, type ToolSet } from "ai";
import { getTracer, withSpan, type PatternConnectorScope, type PatternNotifyCondition, type PatternRecord, type PatternReminderContext, type PatternRunRecord, type PatternSchedule, type PatternTriggerConfig, type PatternTriggerFilter, type PatternWeekday, type UserContext, type WorkerType } from "@finn/core";
import { z } from "zod";
import { patternScheduleInputSchema } from "./schedule-schema.js";

const tracer = getTracer("hot-path-tools");
const dateTimeWithOffsetPattern = /(?:z|[+-]\d{2}:?\d{2})$/i;

const reminderScheduleSchema = patternScheduleInputSchema.describe(
  "Structured user-local schedule. Use kind='once' for one-shot tasks, kind='interval' for every-N cadences, kind='daily'/'weekly'/'monthly' for wall-clock recurrences, and startDate/anchorLocalDateTime for delayed starts.",
);

export interface PatternOps {
  user: Pick<UserContext, "timezone">;
  create: (params: {
    name: string;
    description?: string | null;
    userDescription?: string | null;
    triggerType: "schedule" | "composio";
    triggerConfig: PatternTriggerConfig;
    connectorScope?: Partial<PatternConnectorScope>;
    triggerFilters?: PatternTriggerFilter[];
    notifyCondition?: PatternNotifyCondition;
    workerType: WorkerType;
    taskPrompt: string;
    reminderContext?: PatternReminderContext | null;
    timezone?: string;
    nextRunAt?: Date;
  }) => Promise<PatternRecord>;
  list: () => Promise<PatternRecord[]>;
  update: (id: string, params: {
    name?: string;
    userDescription?: string | null;
    taskPrompt?: string;
    active?: boolean;
    triggerType?: "schedule" | "composio";
    triggerConfig?: PatternTriggerConfig;
    connectorScope?: Partial<PatternConnectorScope>;
    triggerFilters?: PatternTriggerFilter[];
    notifyCondition?: PatternNotifyCondition;
    reminderContext?: PatternReminderContext | null;
    timezone?: string;
    nextRunAt?: Date | null;
  }) => Promise<PatternRecord | null>;
  get?: (id: string) => Promise<PatternRecord | null>;
  remove: (id: string) => Promise<PatternRecord | null>;
  listRuns?: (params: { patternId: string; limit?: number; beforeRunId?: string }) => Promise<PatternRunRecord[]>;
  getRun?: (patternId: string, runId: string) => Promise<PatternRunRecord | null>;
}

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
  };
}

function serializeActivePattern(pattern: PatternRecord) {
  const scheduled = pattern.triggerConfig.type === "schedule";

  return {
    id: pattern.id,
    name: pattern.name,
    triggerType: pattern.triggerType,
    scheduleType: pattern.triggerConfig.type === "schedule" ? pattern.triggerConfig.schedule.kind : null,
    nextRun: scheduled ? pattern.nextRunAt?.toISOString() ?? null : null,
    userDescription: pattern.userDescription,
    type: pattern.workerType === "reminder" ? "reminder" : "pattern",
  };
}

const createReminderInputSchema = z.object({
  name: z.string().describe("Short user-visible reminder name"),
  reminder_text: z.string().min(1).describe("The exact thing Finn should remind the user about when this reminder fires."),
  reason: z.string().min(1).describe("Why this reminder was set, based on the user's request and conversation context."),
  supporting_context: z.string().optional().describe("Any relevant supporting context the hot path should know when the reminder fires, such as people, dates, constraints, or wording from the conversation."),
  schedule: reminderScheduleSchema,
});

const editReminderInputSchema = z.object({
  id: z.string().describe("Reminder Pattern ID"),
  name: z.string().optional().describe("New reminder name"),
  reminder_text: z.string().min(1).optional().describe("Updated reminder text."),
  reason: z.string().min(1).optional().describe("Updated reason this reminder exists."),
  supporting_context: z.string().nullable().optional().describe("Updated supporting context, or null to clear it."),
  active: z.boolean().optional().describe("Whether the reminder should be active"),
  schedule: reminderScheduleSchema.optional(),
});

function buildScheduledTriggerParams(input: { schedule?: PatternSchedule }, effectiveTimeZone: string): { triggerConfig: PatternTriggerConfig; timezone: string; nextRunAt?: Date | null } | { error: string } {
  if (!input.schedule) {
    return { error: "A schedule is required." };
  }

  const schedule: PatternSchedule = input.schedule;
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

export function createListActivePatternsTool(ops: Pick<PatternOps, "list">): ToolSet[string] {
  return tool({
    description: "List active Pattern automations with IDs, names, trigger types, and scheduled next runs. Use before discussing or updating existing Patterns.",
    inputSchema: z.object({}),
    execute: async () => withSpan(tracer, "tool.list_active_patterns", {}, async () => {
      const patterns = await ops.list();
      return { patterns: patterns.filter((pattern) => pattern.active && pattern.workerType !== "reminder").map(serializeActivePattern) };
    }),
  });
}

export function createReminderTools(ops: PatternOps): ToolSet {
  if (!ops.user.timezone) {
    throw new Error("Reminder tools require the user's effective timezone.");
  }
  const effectiveTimeZone = ops.user.timezone;
  return {
    list_reminders: tool({
      description: "List the user's reminder Patterns, including IDs and next scheduled run times. Use before updating, deleting, or checking existing reminders.",
      inputSchema: z.object({}),
      execute: async () => withSpan(tracer, "tool.list_reminders", {}, async () => {
        const patterns = await ops.list();
        return {
          reminders: patterns
            .filter((pattern) => pattern.workerType === "reminder")
            .map((pattern) => ({
              id: pattern.id,
              name: pattern.name,
              reminderText: pattern.reminderContext?.reminderText ?? pattern.userDescription ?? pattern.taskPrompt,
              reason: pattern.reminderContext?.reason ?? pattern.taskPrompt,
              supportingContext: pattern.reminderContext?.supportingContext ?? null,
              active: pattern.active,
              schedule: pattern.triggerConfig.type === "schedule" ? pattern.triggerConfig.schedule : null,
              nextRun: pattern.nextRunAt?.toISOString() ?? null,
              lastRun: pattern.lastRunAt?.toISOString() ?? null,
            })),
        };
      }),
    }),
    create_reminder: tool({
      description:
        `Create a lightweight reminder Pattern that only notifies the hot path when due and does not start a worker or LLM Pattern run. ` +
        `Use this only for simple reminders that do not need external tools, research, decisions, or actions. ` +
        `Current user-local time: ${formatRuntimeTimestamp(new Date(), effectiveTimeZone)} (${effectiveTimeZone}). ` +
        `All schedule values are interpreted in the user's current effective timezone.`,
      inputSchema: createReminderInputSchema,
      execute: async (input) => withSpan(tracer, "tool.create_reminder", {}, async (span) => {
        const scheduled = buildScheduledTriggerParams(input, effectiveTimeZone);
        if ("error" in scheduled) {
          return { error: scheduled.error };
        }

        const reminderContext: PatternReminderContext = {
          reminderText: input.reminder_text,
          reason: input.reason,
          supportingContext: input.supporting_context ?? null,
        };
        const reminder = await ops.create({
          name: input.name,
          userDescription: input.reminder_text,
          triggerType: "schedule",
          triggerConfig: scheduled.triggerConfig,
          connectorScope: { composio: [], mcpServerIds: [] },
          notifyCondition: { type: "always" },
          workerType: "reminder",
          taskPrompt: input.reminder_text,
          reminderContext,
          timezone: scheduled.timezone,
          nextRunAt: scheduled.nextRunAt ?? undefined,
        });
        span.setAttribute("pattern.id", reminder.id);
        return serializePattern(reminder);
      }),
    }),
    inspect_reminder: tool({
      description: "Inspect a reminder Pattern by ID, including reminder context and schedule.",
      inputSchema: z.object({ id: z.string().describe("Reminder Pattern ID") }),
      execute: async (input) => withSpan(tracer, "tool.inspect_reminder", { "pattern.id": input.id }, async () => {
        const reminder = ops.get ? await ops.get(input.id) : (await ops.list()).find((item) => item.id === input.id) ?? null;
        if (!reminder || reminder.workerType !== "reminder") {
          return { error: "Reminder not found." };
        }
        return serializePattern(reminder);
      }),
    }),
    edit_reminder: tool({
      description: "Edit an existing reminder Pattern in place by ID. Preserves the same reminder ID and run history.",
      inputSchema: editReminderInputSchema,
      execute: async (input) => withSpan(tracer, "tool.edit_reminder", { "pattern.id": input.id }, async () => {
        const current = ops.get ? await ops.get(input.id) : (await ops.list()).find((item) => item.id === input.id) ?? null;
        if (!current || current.workerType !== "reminder") {
          return { error: "Reminder not found." };
        }

        const reminderContext = input.reminder_text !== undefined || input.reason !== undefined || input.supporting_context !== undefined
          ? {
              reminderText: input.reminder_text ?? current.reminderContext?.reminderText ?? current.userDescription ?? current.taskPrompt,
              reason: input.reason ?? current.reminderContext?.reason ?? current.taskPrompt,
              supportingContext: input.supporting_context !== undefined ? input.supporting_context : current.reminderContext?.supportingContext ?? null,
            }
          : undefined;
        const scheduled = input.schedule ? buildScheduledTriggerParams(input, effectiveTimeZone) : null;
        if (scheduled && "error" in scheduled) {
          return { error: scheduled.error };
        }

        const updateParams: Parameters<PatternOps["update"]>[1] = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(reminderContext ? {
            userDescription: reminderContext.reminderText,
            taskPrompt: reminderContext.reminderText,
            reminderContext,
          } : {}),
          ...(scheduled && !("error" in scheduled) ? {
            triggerType: "schedule" as const,
            triggerConfig: scheduled.triggerConfig,
            timezone: scheduled.timezone,
            ...(scheduled.nextRunAt !== undefined ? { nextRunAt: scheduled.nextRunAt } : {}),
          } : {}),
        };

        if (Object.keys(updateParams).length === 0) {
          return { error: "Provide at least one reminder field to update." };
        }

        const reminder = await ops.update(input.id, updateParams);
        return reminder ? serializePattern(reminder) : { error: "Reminder not found." };
      }),
    }),
    delete_reminder: tool({
      description: "Delete a reminder Pattern by ID.",
      inputSchema: z.object({ id: z.string().describe("Reminder Pattern ID to delete") }),
      execute: async (input) => withSpan(tracer, "tool.delete_reminder", { "pattern.id": input.id }, async () => {
        const current = ops.get ? await ops.get(input.id) : (await ops.list()).find((item) => item.id === input.id) ?? null;
        if (!current || current.workerType !== "reminder") {
          return { deleted: false, id: input.id, error: "Reminder not found." };
        }
        const deleted = await ops.remove(input.id);
        return { deleted: Boolean(deleted), id: input.id };
      }),
    }),
  };
}
