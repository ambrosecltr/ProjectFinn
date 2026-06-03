import { describe, expect, it, mock } from "bun:test";
import type { CreativeRuntimeService } from "@finn/runtime";
import { createToolsetRuntime } from "../../registry.js";
import { createCreativeToolsetDefinition } from "./index.js";

function createCreativeRuntime(): CreativeRuntimeService {
  return {
    kind: "finn-creative-runtime",
    createOrEditImage: mock(async () => ({
      fileIds: ["file_image"],
      images: [{
        fileId: "file_image",
        url: "https://app.test/files/tenant/user/file_image",
        remoteUrl: "https://fal.test/image.png",
        contentType: "image/png",
      }],
      storedLocally: true,
    })),
    createOrEditVideo: mock(async () => ({
      fileId: "file_video",
      url: "https://app.test/files/tenant/user/file_video",
      remoteUrl: "https://fal.test/video.mp4",
      contentType: "video/mp4",
      storedLocally: true,
    })),
  };
}

function createRuntime(creative = createCreativeRuntime(), options: { image?: boolean; video?: boolean } = {}) {
  return {
    creative,
    runtime: createToolsetRuntime({
      processType: "worker",
      enabledTools: ["creative"],
      includeBuiltInToolsets: false,
      toolsetGrants: { creative: "write" },
      definitions: [createCreativeToolsetDefinition({
        processTypes: ["worker", "pattern_worker"],
        runtime: creative,
        ...options,
      })],
      context: {},
    }),
  };
}

describe("creative toolset", () => {
  it("creates or edits images using selector references", async () => {
    const { creative, runtime } = createRuntime();

    const result = await runtime.execute({
      toolset: "creative",
      command: "image",
      args: {
        prompt: "paint this brighter",
        images: "file:file_source|url:https://example.com/ref.png",
        numImages: 2,
        quality: "high",
        outputFormat: "png",
      },
    });

    expect(result).toMatchObject({
      toolset: "creative",
      command: "image",
      result: { fileIds: ["file_image"], storedLocally: true },
    });
    expect(creative.createOrEditImage).toHaveBeenCalledWith({
      prompt: "paint this brighter",
      images: [
        { fileId: "file_source" },
        { mediaUrl: "https://example.com/ref.png" },
      ],
      imageSize: undefined,
      numImages: 2,
      quality: "high",
      outputFormat: "png",
    });
  });

  it("creates videos and rejects conflicting primary inputs", async () => {
    const { creative, runtime } = createRuntime();

    const result = await runtime.execute({
      toolset: "creative",
      command: "video",
      args: {
        prompt: "make it move",
        image: "file:file_image",
        duration: "5",
        generateAudio: true,
      },
    });

    expect(result).toMatchObject({
      toolset: "creative",
      command: "video",
      result: { fileId: "file_video", storedLocally: true },
    });
    await expect(runtime.execute({
      toolset: "creative",
      command: "video",
      args: { prompt: "conflict", image: "file:file_image", video: "file:file_video" },
    })).rejects.toThrow("Provide either image or video, not both.");
    expect(creative.createOrEditVideo).toHaveBeenCalledWith({
      prompt: "make it move",
      image: { fileId: "file_image" },
      video: undefined,
      referenceImages: undefined,
      resolution: undefined,
      duration: "5",
      aspectRatio: undefined,
      generateAudio: true,
    });
  });

  it("generates gated instructions from the manifest", async () => {
    const { runtime } = createRuntime(createCreativeRuntime(), { video: false });

    const loaded = await runtime.load("creative");

    expect(loaded.instructions).toContain("API: finn.creative.image(input)");
    expect(loaded.instructions).toContain("images is optional");
    expect(loaded.instructions).not.toContain("finn.creative.video");
  });
});
