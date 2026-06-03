import { getTracer, withSpan, type UserContext } from "@finn/core";
import { tool } from "ai";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const updateUserProfileParameters = z.object({
  displayName: z.string().trim().min(1).max(80).optional()
    .describe("The user's name, only when the user explicitly states what Finn should call them."),
  location: z.string().trim().min(1).max(120).optional()
    .describe("The user's durable home/base location. Only set or update this when explicit or extremely high-confidence; never for travel, temporary stays, work location, or vague clues."),
  confidence: z.enum(["explicit", "high_confidence_inference"])
    .describe("Use explicit for direct statements. Use high_confidence_inference only for durable relocation/home-base language that is not ambiguous."),
  sourceMessageId: z.string().trim().min(1).optional()
    .describe("The current user message handle that supports this profile update, when available."),
}).refine((input) => input.displayName !== undefined || input.location !== undefined, {
  message: "Provide displayName or location.",
});

export interface UserProfileUpdate {
  displayName?: string;
  location?: string;
  sourceMessageId?: string;
}

export interface UpdateUserProfileToolDeps {
  user: UserContext;
  updateProfile: (update: UserProfileUpdate) => Promise<UserContext>;
}

export function createUpdateUserProfileTool(deps: UpdateUserProfileToolDeps) {
  return tool({
    description: [
      "Update Finn's core user profile details silently. Use this only for operational profile basics, not broader memories.",
      "Set displayName only when the user explicitly says their name and no display name is currently set.",
      "Set or update location only for the user's durable home/base location, and only when explicit or absolutely clear from durable relocation/home language. Do not use for travel, temporary location, workplace, preferences, or weak clues.",
      "Do not mention this tool, profile storage, or onboarding to the user.",
    ].join(" "),
    inputSchema: updateUserProfileParameters,
    execute: async ({ displayName, location, sourceMessageId }) => {
      return withSpan(tracer, "tool.update_user_profile", {}, async () => {
        const trimmedName = displayName?.trim();
        const trimmedLocation = location?.trim();
        const update: UserProfileUpdate = {};
        const skipped: string[] = [];

        if (trimmedName) {
          if (deps.user.displayName?.trim()) {
            skipped.push("displayName already set");
          } else {
            update.displayName = trimmedName;
          }
        }

        if (trimmedLocation) {
          update.location = trimmedLocation;
        }

        if (sourceMessageId?.trim()) {
          update.sourceMessageId = sourceMessageId.trim();
        }

        if (!update.displayName && !update.location) {
          return { updated: false, skipped };
        }

        await deps.updateProfile(update);

        return {
          updated: true,
          fields: {
            displayName: Boolean(update.displayName),
            location: Boolean(update.location),
          },
          skipped,
        };
      });
    },
  });
}
