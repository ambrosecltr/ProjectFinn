import { tool } from "ai";
import { getTracer, normalizeOutgoingAssistantText, withSpan } from "@finn/core";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const displayDraftParameters = z.object({
  type: z.enum(["email", "message", "post"]).describe("Type of draft content"),
  to: z.string().optional().describe("Recipient (email address, name, etc.)"),
  subject: z.string().optional().describe("Subject line for emails"),
  body: z.string().describe("The draft content"),
});

type DisplayDraftInput = z.infer<typeof displayDraftParameters>;

interface DraftSender {
  sendText(text: string): Promise<unknown> | unknown;
}

export function formatDraftForDisplay(input: DisplayDraftInput): string {
  const heading = input.type === "email" ? "draft email" : input.type === "post" ? "draft post" : "draft message";
  return [
    heading,
    input.to ? `to: ${input.to}` : null,
    input.subject ? `subject: ${input.subject}` : null,
    "",
    normalizeOutgoingAssistantText(input.body),
  ].filter((line): line is string => line !== null).join("\n").trim();
}

export function createDisplayDraftTool(sender: DraftSender) {
  return tool({
    description:
      "Send a draft message to the user for review before dispatch. Use when composing important messages (emails, formal replies) that the user should approve before sending.",
    inputSchema: displayDraftParameters,
    execute: async (input) => {
      return withSpan(tracer, "tool.display_draft", { "tool.draftType": input.type }, async () => {
        const text = formatDraftForDisplay(input);
        await sender.sendText(text);
        return {
          displayed: true,
          type: input.type,
          to: input.to,
          subject: input.subject,
          body: input.body,
        };
      });
    },
  });
}
