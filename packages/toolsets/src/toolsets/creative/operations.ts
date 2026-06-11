import type { CreativeRuntimeService } from "@finn/runtime";
import { formatToolsetError } from "../../utils.js";
import { createCreativeImageInputSchema, createCreativeVideoInputSchema } from "./schemas.js";

export async function creativeImageCommand(runtime: CreativeRuntimeService, input: unknown) {
  const parsed = createCreativeImageInputSchema({
    outputFormats: runtime.capabilities.image.outputFormats,
    maxReferenceImages: runtime.capabilities.image.maxReferenceImages,
  }).parse(input);
  try {
    return await runtime.createOrEditImage(parsed);
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function creativeVideoCommand(runtime: CreativeRuntimeService, input: unknown) {
  const parsed = createCreativeVideoInputSchema({
    maxReferenceImages: runtime.capabilities.video.maxReferenceImages,
  }).parse(input);
  try {
    return await runtime.createOrEditVideo(parsed);
  } catch (error) {
    return { error: formatToolsetError(error) };
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
