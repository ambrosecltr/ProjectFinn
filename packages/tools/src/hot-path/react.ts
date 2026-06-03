import { tool } from "ai";
import type { MessageSender } from "@finn/messaging";
import { getTracer, withSpan } from "@finn/core";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const reactParameters = z.object({
  messageHandle: z.string().describe("Exact handle attribute value from the relevant <message> element to react to."),
  reaction: z.enum([
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
  ]),
});

export function createReactTool(sender: MessageSender) {
  return tool({
    description: "React to a specific user message with a tapback reaction.",
    inputSchema: reactParameters,
    execute: async ({
      messageHandle,
      reaction,
    }, options) => {
      return withSpan(tracer, "tool.react", { "tool.reaction": reaction }, async () => {
      void options;
      await sender.sendReaction(messageHandle, reaction);

      return {
        sent: true,
      };
      });
    },
  });
}
