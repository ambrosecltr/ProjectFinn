import type { CreativeRuntimeService } from "@finn/runtime";
import { creativeImageInputSchema, creativeVideoInputSchema } from "./schemas.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function creativeImageCommand(runtime: CreativeRuntimeService, input: unknown) {
  const parsed = creativeImageInputSchema.parse(input);
  try {
    return await runtime.createOrEditImage(parsed);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

export async function creativeVideoCommand(runtime: CreativeRuntimeService, input: unknown) {
  const parsed = creativeVideoInputSchema.parse(input);
  try {
    return await runtime.createOrEditVideo(parsed);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

export async function executeCreativeCommand(runtime: CreativeRuntimeService, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "image":
      return creativeImageCommand(runtime, args);
    case "video":
      return creativeVideoCommand(runtime, args);
    default:
      throw new Error(`Unsupported creative command: ${command}`);
  }
}
