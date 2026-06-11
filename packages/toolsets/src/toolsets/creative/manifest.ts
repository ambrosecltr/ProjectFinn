import type { CreativeRuntimeCapabilities } from "@finn/runtime";
import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import { createCreativeImageInputSchema, createCreativeVideoInputSchema } from "./schemas.js";

export interface CreativeManifestOptions {
  processTypes: ToolsetProcessType[];
  image?: boolean;
  video?: boolean;
  capabilities?: CreativeRuntimeCapabilities;
}

export function createCreativeManifest(options: CreativeManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [];
  const imageOutputFormats = options.capabilities?.image.outputFormats ?? ["jpeg", "png", "webp"];
  const imageMaxReferenceImages = options.capabilities?.image.maxReferenceImages ?? 4;
  const videoMaxReferenceImages = options.capabilities?.video.maxReferenceImages ?? 4;
  const outputFormatText = imageOutputFormats.join(", ");
  const preferredOutputFormat = imageOutputFormats.includes("png") ? "png" : imageOutputFormats[0] ?? "jpeg";

  if (options.image !== false) {
    commands.push({
      name: "image",
      description: `Create a new image from a prompt, or edit up to ${imageMaxReferenceImages} referenced images. References can be JSON or selectors like file:file_1, path:/workspace/tmp/source.png, or url:https://example.com/source.png.`,
      effects: ["write"],
      inputSchema: createCreativeImageInputSchema({
        outputFormats: imageOutputFormats,
        maxReferenceImages: imageMaxReferenceImages,
      }),
      argumentGuidance: [
        "prompt is required. Describe the desired image or edit explicitly.",
        "images is optional. Use selector refs separated by |, such as file:file_123|path:/workspace/tmp/ref.png|url:https://example.com/ref.png, or a JSON array.",
        "For straightforward edits of a user attachment, pass the stored file selector directly; do not call view_image first unless you need to inspect ambiguous visual details.",
        "imageSize accepts square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9, auto, or WIDTHxHEIGHT.",
        `numImages is 1-4. quality is low, medium, or high. outputFormat accepts: ${outputFormatText}.`,
      ],
      examples: [
        { purpose: "Generate a new image", code: `await finn.creative.image({ prompt: "editorial product photo of a matte black desk lamp on a walnut table", imageSize: "landscape_16_9", numImages: 2, outputFormat: "${preferredOutputFormat}" })` },
        { purpose: "Edit one stored image", code: `await finn.creative.image({ prompt: "make the background warmer and remove clutter", images: "file:file_123", quality: "high", outputFormat: "${preferredOutputFormat}" })` },
        { purpose: "Use multiple references", code: "await finn.creative.image({ prompt: \"combine the product from the first image with the color palette of the second\", images: \"file:file_123|path:/workspace/tmp/palette.png\", numImages: 1 })" },
      ],
      outputGuidance: [
        "Generated assets are stored as Finn files when file storage is available. Return or send the stored file IDs/URLs according to the worker task.",
      ],
    });
  }
  if (options.video !== false) {
    commands.push({
      name: "video",
      description: `Create a new video, animate one image, edit one existing video, or generate from up to ${videoMaxReferenceImages} reference images. Provide either image or video, not both.`,
      effects: ["write"],
      inputSchema: createCreativeVideoInputSchema({
        maxReferenceImages: videoMaxReferenceImages,
      }),
      argumentGuidance: [
        "prompt is required. Provide clear motion, scene, subject, and style instructions.",
        "Use image to animate an image, video to edit a video, referenceImages to guide text-to-video or video edits, or none for pure text-to-video. Do not provide both image and video.",
        `referenceImages accepts up to ${videoMaxReferenceImages} selector refs separated by | or a JSON array for edit guidance.`,
        "duration accepts auto or 4 through 15 as strings. aspectRatio accepts auto, 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16.",
        "Media selectors use file:file_123, path:/workspace/tmp/source.png, url:https://example.com/source.png, or JSON objects with fileId/path/mediaUrl.",
      ],
      examples: [
        { purpose: "Generate a short text-to-video clip", code: "await finn.creative.video({ prompt: \"slow push-in on a modern kitchen in morning light\", duration: \"5\", aspectRatio: \"16:9\", resolution: \"720p\" })" },
        { purpose: "Animate a stored image", code: "await finn.creative.video({ prompt: \"subtle camera drift, steam rising, natural light\", image: \"file:file_123\", duration: \"5\", aspectRatio: \"9:16\" })" },
        { purpose: "Edit a stored video with a reference image", code: "await finn.creative.video({ prompt: \"match the reference color grade\", video: \"file:file_456\", referenceImages: \"path:/workspace/tmp/reference.png\", duration: \"auto\" })" },
      ],
      outputGuidance: [
        "Generated video assets are stored as Finn files when file storage is available. Preserve file IDs and content type in the final outcome.",
      ],
    });
  }

  return {
    slug: "creative",
    displayName: "Creative",
    description: "Finn JS workspace access to Finn's gated image and video generation runtime.",
    capability: "write",
    effects: ["write"],
    runtimeRequirements: ["creative"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset for image generation/editing and video generation/editing through Finn's gated creative runtime.",
        "Stored Finn file references are preferred for user attachments because they stay inside the scoped file runtime.",
        "For direct image transformation requests, use the provided file selector directly instead of viewing the image first.",
      ],
      referenceFormats: [
        "Use file:file_123 for stored Finn files.",
        "Use path:/workspace/tmp/source.png for workspace files. Workspace-relative paths are also accepted as an input convenience, but never use VM /tmp paths as creative references.",
        "Use url:https://example.com/source.png for safe raw URLs.",
        "For multiple media references, separate selectors with | or pass a JSON array.",
      ],
      syntaxRules: [
        "Quote prompts and URLs.",
        "Use the camelCase input fields shown by workspace_search, such as imageSize, numImages, outputFormat, referenceImages, aspectRatio, and generateAudio.",
      ],
      safetyRules: [
        "Do not use unsafe private/internal URLs as media inputs.",
        "Use the finn.files APIs first when you need to inspect or prepare references before generation.",
      ],
    },
    commands,
  };
}
