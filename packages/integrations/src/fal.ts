import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";
import { createFalClient } from "@fal-ai/client";

const logger = createLogger("fal");
const tracer = getTracer("fal");

const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";
const DEFAULT_IMAGE_EDIT_MODEL = "openai/gpt-image-2/edit";
const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.0/text-to-video";
const DEFAULT_IMAGE_TO_VIDEO_MODEL = "bytedance/seedance-2.0/image-to-video";
const DEFAULT_VIDEO_EDIT_MODEL = "bytedance/seedance-2.0/reference-to-video";

export type FalImageSize =
  | "square_hd"
  | "square"
  | "portrait_4_3"
  | "portrait_16_9"
  | "landscape_4_3"
  | "landscape_16_9"
  | "auto"
  | `${number}x${number}`;

export type FalImageQuality = "low" | "medium" | "high";
export type FalImageFormat = "jpeg" | "png" | "webp";
export type FalVideoResolution = "480p" | "720p";
export type FalVideoDuration = "auto" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15";
export type FalVideoAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type FalGenerateImageOptions = {
  prompt: string;
  imageSize?: FalImageSize;
  numImages?: number;
  quality?: FalImageQuality;
  outputFormat?: FalImageFormat;
};

export type FalUploadMediaInput = {
  data: Buffer;
  filename: string;
  mimeType: string;
};

export type FalEditImageOptions = {
  prompt: string;
  imageUrls: string[];
  imageSize?: FalImageSize;
  numImages?: number;
  quality?: FalImageQuality;
  outputFormat?: FalImageFormat;
};

export type FalGenerateVideoOptions = {
  prompt: string;
  duration?: FalVideoDuration;
  resolution?: FalVideoResolution;
  aspectRatio?: FalVideoAspectRatio;
  generateAudio?: boolean;
};

export type FalImageToVideoOptions = FalGenerateVideoOptions & {
  imageUrl: string;
};

export type FalEditVideoOptions = FalGenerateVideoOptions & {
  prompt: string;
  videoUrl: string;
  imageUrls?: string[];
};

export type FalImageResult = {
  url: string;
  width?: number;
  height?: number;
  contentType: string;
};

export type FalVideoResult = {
  url: string;
  contentType: string;
};

type FalClientOptions = {
  apiKey: string;
  imageGenModel?: string;
  imageEditModel?: string;
  videoGenModel?: string;
  imageToVideoModel?: string;
  videoEditModel?: string;
};

type FalImageFile = {
  url?: string | null;
  width?: number | null;
  height?: number | null;
  content_type?: string | null;
  contentType?: string | null;
};

type FalImageResponse = {
  images?: FalImageFile[];
};

type FalVideoResponse = {
  video?: {
    url?: string | null;
    content_type?: string | null;
    contentType?: string | null;
  } | null;
};

function compactInput<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "FAL request failed";
}

function parseImageResult(image: FalImageFile): FalImageResult {
  if (typeof image.url !== "string" || image.url.length === 0) {
    throw new IntegrationError("FAL image payload missing url", "fal");
  }

  const contentType = image.contentType ?? image.content_type;
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw new IntegrationError("FAL image payload missing content type", "fal");
  }

  return {
    url: image.url,
    contentType,
    ...(typeof image.width === "number" ? { width: image.width } : {}),
    ...(typeof image.height === "number" ? { height: image.height } : {}),
  };
}

function parseImageResults(response: FalImageResponse): FalImageResult[] {
  if (!Array.isArray(response.images) || response.images.length === 0) {
    throw new IntegrationError("FAL image response missing images", "fal");
  }

  return response.images.map(parseImageResult);
}

function parseVideoResult(response: FalVideoResponse): FalVideoResult {
  if (!response.video || typeof response.video !== "object") {
    throw new IntegrationError("FAL video payload missing video object", "fal");
  }

  if (typeof response.video.url !== "string" || response.video.url.length === 0) {
    throw new IntegrationError("FAL video payload missing url", "fal");
  }

  const contentType = response.video.contentType ?? response.video.content_type;
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw new IntegrationError("FAL video payload missing content type", "fal");
  }

  return {
    url: response.video.url,
    contentType,
  };
}

export class FalClient {
  private readonly client;
  private readonly imageGenModel: string;
  private readonly imageEditModel: string;
  private readonly videoGenModel: string;
  private readonly imageToVideoModel: string;
  private readonly videoEditModel: string;

  constructor(opts: FalClientOptions) {
    this.client = createFalClient({ credentials: opts.apiKey });
    this.imageGenModel = opts.imageGenModel ?? DEFAULT_IMAGE_MODEL;
    this.imageEditModel = opts.imageEditModel ?? DEFAULT_IMAGE_EDIT_MODEL;
    this.videoGenModel = opts.videoGenModel ?? DEFAULT_VIDEO_MODEL;
    this.imageToVideoModel = opts.imageToVideoModel ?? DEFAULT_IMAGE_TO_VIDEO_MODEL;
    this.videoEditModel = opts.videoEditModel ?? DEFAULT_VIDEO_EDIT_MODEL;
  }

  private async subscribe<TInput extends Record<string, unknown>, TOutput>(
    model: string,
    input: TInput,
  ): Promise<TOutput> {
    return withSpan(tracer, "fal.subscribe", { "fal.model": model }, async () => {
      logger.debug({ model }, "Submitting FAL request via SDK");

      try {
        const response = await this.client.subscribe(model, {
          input,
          logs: true,
        });

        logger.info({ model, requestId: response.requestId }, "FAL request completed");
        return response.data as TOutput;
      } catch (error) {
        throw new IntegrationError(getErrorMessage(error), "fal");
      }
    });
  }

  async uploadMedia(input: FalUploadMediaInput): Promise<string> {
    return withSpan(tracer, "fal.uploadMedia", {}, async () => {
      logger.debug({ filename: input.filename, mimeType: input.mimeType, size: input.data.length }, "Uploading media to FAL storage");
      const file = new File([input.data], input.filename, { type: input.mimeType });

      try {
        return await this.client.storage.upload(file);
      } catch (error) {
        throw new IntegrationError(getErrorMessage(error), "fal");
      }
    });
  }

  async generateImage(opts: FalGenerateImageOptions): Promise<FalImageResult[]> {
    return withSpan(tracer, "fal.generateImage", { "fal.model": this.imageGenModel }, async () => {
      const response = await this.subscribe<Record<string, unknown>, FalImageResponse>(
        this.imageGenModel,
        compactInput({
          prompt: opts.prompt,
          image_size: opts.imageSize,
          num_images: opts.numImages,
          quality: opts.quality,
          output_format: opts.outputFormat,
        }),
      );

      return parseImageResults(response);
    });
  }

  async editImage(opts: FalEditImageOptions): Promise<FalImageResult[]> {
    return withSpan(tracer, "fal.editImage", { "fal.model": this.imageEditModel }, async () => {
      const response = await this.subscribe<Record<string, unknown>, FalImageResponse>(
        this.imageEditModel,
        compactInput({
          prompt: opts.prompt,
          image_urls: opts.imageUrls,
          image_size: opts.imageSize,
          num_images: opts.numImages,
          quality: opts.quality,
          output_format: opts.outputFormat,
        }),
      );

      return parseImageResults(response);
    });
  }

  async generateVideo(opts: FalGenerateVideoOptions): Promise<FalVideoResult> {
    return withSpan(tracer, "fal.generateVideo", { "fal.model": this.videoGenModel }, async () => {
      const response = await this.subscribe<Record<string, unknown>, FalVideoResponse>(
        this.videoGenModel,
        compactInput({
          prompt: opts.prompt,
          duration: opts.duration,
          resolution: opts.resolution,
          aspect_ratio: opts.aspectRatio,
          generate_audio: opts.generateAudio,
        }),
      );

      return parseVideoResult(response);
    });
  }

  async imageToVideo(opts: FalImageToVideoOptions): Promise<FalVideoResult> {
    return withSpan(tracer, "fal.imageToVideo", { "fal.model": this.imageToVideoModel }, async () => {
      const response = await this.subscribe<Record<string, unknown>, FalVideoResponse>(
        this.imageToVideoModel,
        compactInput({
          prompt: opts.prompt,
          image_url: opts.imageUrl,
          duration: opts.duration,
          resolution: opts.resolution,
          aspect_ratio: opts.aspectRatio,
          generate_audio: opts.generateAudio,
        }),
      );

      return parseVideoResult(response);
    });
  }

  async editVideo(opts: FalEditVideoOptions): Promise<FalVideoResult> {
    return withSpan(tracer, "fal.editVideo", { "fal.model": this.videoEditModel }, async () => {
      const response = await this.subscribe<Record<string, unknown>, FalVideoResponse>(
        this.videoEditModel,
        compactInput({
          prompt: opts.prompt,
          video_urls: [opts.videoUrl],
          image_urls: opts.imageUrls,
          duration: opts.duration,
          resolution: opts.resolution,
          aspect_ratio: opts.aspectRatio,
          generate_audio: opts.generateAudio,
        }),
      );

      return parseVideoResult(response);
    });
  }
}
