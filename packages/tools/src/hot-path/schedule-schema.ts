import { publicPatternScheduleSchema } from "@finn/core";
import { z } from "zod";

export const patternScheduleInputSchema = publicPatternScheduleSchema;

export type PatternScheduleInput = z.infer<typeof patternScheduleInputSchema>;
