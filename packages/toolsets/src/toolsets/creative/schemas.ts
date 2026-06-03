import { z } from "zod";
import type { CreativeImageSize } from "@finn/runtime";

const booleanFlagSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

const imageSizeSchema = z.custom<CreativeImageSize>((value) => {
  if (typeof value !== "string") {
    return false;
  }
  return [
    "square_hd",
    "square",
    "portrait_4_3",
    "portrait_16_9",
    "landscape_4_3",
    "landscape_16_9",
    "auto",
  ].includes(value) || /^\d+x\d+$/.test(value);
}, "Invalid image size.");

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseMediaReference(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return parseJson(trimmed);
  }
  if (trimmed.startsWith("file:")) {
    return { fileId: trimmed.slice("file:".length).trim() };
  }
  if (trimmed.startsWith("path:")) {
    return { path: trimmed.slice("path:".length).trim() };
  }
  if (trimmed.startsWith("url:")) {
    return { mediaUrl: trimmed.slice("url:".length).trim() };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { mediaUrl: trimmed };
  }

  return value;
}

function parseMediaReferenceList(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    return parseJson(trimmed);
  }

  return trimmed.split("|").map((entry) => parseMediaReference(entry));
}

const mediaReferenceSchema = z.preprocess(parseMediaReference, z.object({
  fileId: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  mediaUrl: z.string().url().optional(),
}).strict().refine((value) => [value.fileId, value.path, value.mediaUrl].filter(Boolean).length === 1, {
  message: "Provide exactly one of fileId, path, or mediaUrl.",
}));

const mediaReferenceListSchema = z.preprocess(
  parseMediaReferenceList,
  z.array(mediaReferenceSchema).max(4),
);

export const creativeImageInputSchema = z.object({
  prompt: z.string().trim().min(1),
  images: mediaReferenceListSchema.optional().describe("Optional references as JSON array or selector list, e.g. file:file_1|path:/workspace/source.png|url:https://example.com/image.png. Use /workspace paths for files; VM /tmp scratch is not accepted as a creative reference."),
  imageSize: imageSizeSchema.optional(),
  numImages: z.coerce.number().int().min(1).max(4).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  outputFormat: z.enum(["jpeg", "png", "webp"]).optional(),
}).strict();

export const creativeVideoInputSchema = z.object({
  prompt: z.string().trim().min(1),
  image: mediaReferenceSchema.optional().describe("Optional image reference as JSON or selector, e.g. file:file_1, path:/workspace/source.png, or url:https://example.com/source.png. Use /workspace paths for files; VM /tmp scratch is not accepted as a creative reference."),
  video: mediaReferenceSchema.optional().describe("Optional video reference as JSON or selector, e.g. file:file_1, path:/workspace/source.mp4, or url:https://example.com/source.mp4. Use /workspace paths for files; VM /tmp scratch is not accepted as a creative reference."),
  referenceImages: mediaReferenceListSchema.optional().describe("Optional edit references as JSON array or selector list separated with |."),
  resolution: z.enum(["480p", "720p"]).optional(),
  duration: z.enum(["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]).optional(),
  aspectRatio: z.enum(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
  generateAudio: booleanFlagSchema.optional(),
}).strict().refine((value) => !(value.image && value.video), {
  message: "Provide either image or video, not both.",
  path: ["video"],
});

export type CreativeImageInput = z.infer<typeof creativeImageInputSchema>;
export type CreativeVideoInput = z.infer<typeof creativeVideoInputSchema>;
