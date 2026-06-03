import { tool } from "ai";
import { getTracer, withSpan, type SpawnWorkerFn, type UserContext } from "@finn/core";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const delegateParameters = z.object({
  task: z.string().describe("What the worker should do"),
  context: z.string().optional().describe("Additional context for the worker. For email tasks, include tone cues: recipient relationship, how the user typically communicates with them, and any style preferences."),
  worker_id: z.string().optional().describe("Existing follow-up enabled worker ID to resume. Only use worker IDs listed as follow-up enabled in runtime status."),
  worker_type: z.enum(["general", "pattern_management"]).optional().describe("Use pattern_management only for Pattern create/list/update/delete/pause/resume/inspect tasks. Pattern runs use pattern_worker internally and should not be delegated from hot path."),
});

export function createDelegateTool(spawnWorker: SpawnWorkerFn, user?: UserContext) {
  return tool({
    description:
      "Delegate a task to a background worker. The worker runs independently and reports results back when done. Use for tasks that take time (research, drafting emails, calendar ops, creative work).",
    inputSchema: delegateParameters,
    execute: async ({ task, context, worker_id, worker_type }, options) => {
      return withSpan(tracer, "tool.delegate", { "worker.task": task.slice(0, 256) }, async (span) => {
      void options;
      if (!user) {
        throw new Error("Delegate tool requires a user context.");
      }

      const workerId = await spawnWorker({
        tenantId: user.tenantId,
        userId: user.userId,
        task,
        workerId: worker_id,
        type: worker_type ?? "general",
        context,
      });

      span.setAttribute("worker.id", workerId);
      return {
        delegated: true,
        resumed: Boolean(worker_id),
        workerId,
        task,
      };
      });
    },
  });
}
