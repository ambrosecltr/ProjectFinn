import { tool } from "ai";
import { getTracer, withSpan } from "@finn/core";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const finishTurnParameters = z.object({
  reason: z.string().optional(),
});

export const finish_turn = tool({
  description:
    "Finish the current hot-path turn after all needed side-effect tools for this inbound message have been called. This does not message the user or start work; if you said you are checking/doing something, call delegate first. Use wait when the intended user-facing outcome is silence.",
  inputSchema: finishTurnParameters,
  execute: async ({ reason }: z.infer<typeof finishTurnParameters>) => {
    return withSpan(tracer, "tool.finish_turn", {}, async () => ({
      finished: true,
      reason,
    }));
  },
});
