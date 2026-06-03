import { tool } from "ai";
import { getTracer, withSpan } from "@finn/core";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const waitParameters = z.object({
  reason: z.string().optional(),
});

export const wait = tool({
  description:
    "Do nothing. Use when no response is needed (e.g., internal status update that doesn't warrant a message to the user).",
  inputSchema: waitParameters,
  execute: async ({ reason }: z.infer<typeof waitParameters>) => {
    return withSpan(tracer, "tool.wait", {}, async () => {
    return {
      action: "none",
      reason,
    };
    });
  },
});
