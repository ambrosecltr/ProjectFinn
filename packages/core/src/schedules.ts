import type { PatternSchedule } from "./types.js";
import { z } from "zod";

type PublicPatternScheduleValue = Exclude<PatternSchedule, { kind: "internal_cron" }>;

const timeSchema = z.string().regex(/^\d{1,2}:\d{2}(?::\d{2})?$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/);

export const publicPatternScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), localDateTime: localDateTimeSchema }),
  z.object({
    kind: z.literal("interval"),
    every: z.number().int().min(1).max(10_000),
    unit: z.enum(["minutes", "hours", "days"]),
    anchorLocalDateTime: localDateTimeSchema.optional(),
  }),
  z.object({ kind: z.literal("daily"), time: timeSchema, startDate: dateSchema.optional() }),
  z.object({
    kind: z.literal("weekly"),
    daysOfWeek: z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).min(1),
    time: timeSchema,
    startDate: dateSchema.optional(),
  }),
  z.object({
    kind: z.literal("monthly"),
    dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal("last")]),
    time: timeSchema,
    startDate: dateSchema.optional(),
  }),
]) satisfies z.ZodType<PublicPatternScheduleValue>;

export type PublicPatternSchedule = z.infer<typeof publicPatternScheduleSchema>;
