import { z } from "zod";

export const skillsListInputSchema = z.object({});

export const skillsSearchInputSchema = z.object({
  query: z.string().trim().min(1),
});

export const skillsInstallInputSchema = z.object({
  package: z.string().trim().min(1).describe("skills.sh package or source, for example owner/repo or owner/repo@skill-name"),
  skill: z.string().trim().min(1).optional().describe("Optional skill name when the package contains multiple skills"),
});

export const skillsRemoveInputSchema = z.object({
  name: z.string().trim().min(1),
});

export const skillsUpdateInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
});

export const skillsLoadInputSchema = z.object({
  name: z.string().trim().min(1),
});

export const skillsReadResourceInputSchema = z.object({
  skill: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

export type SkillsListInput = z.infer<typeof skillsListInputSchema>;
export type SkillsSearchInput = z.infer<typeof skillsSearchInputSchema>;
export type SkillsInstallInput = z.infer<typeof skillsInstallInputSchema>;
export type SkillsRemoveInput = z.infer<typeof skillsRemoveInputSchema>;
export type SkillsUpdateInput = z.infer<typeof skillsUpdateInputSchema>;
export type SkillsLoadInput = z.infer<typeof skillsLoadInputSchema>;
export type SkillsReadResourceInput = z.infer<typeof skillsReadResourceInputSchema>;
