import { createLogger, getTracer, IntegrationError, withSpan } from "@finn/core";

const logger = createLogger("xai-imagine");
const tracer = getTracer("xai-imagine");

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_IMAGE_MODEL = "grok-imagine-image-quality";
const DEFAULT_VIDEO_MODEL = "grok-imagine-video";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_IMAGE_EDIT_REFERENCES = 3;
const MAX_VIDEO_REFERENCE_IMAGES = 7;

type XaiImageSize =
  | "square_hd"
  | "square"
  | "portrait_4_3"
  | "portrait_16_9"
  | "landscape_4_3"
  | "landscape_16_9"
  | "auto"
  | `${number}x${number}`;
type XaiImageQuality = "low" | "medium" | "high";
type XaiImageFormat = "jpeg" | "png" | "webp";
type XaiVideoResolution = "480p" | "720p";
type XaiVideoDuration = "auto" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15";
type XaiVideoAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type XaiImageResult = {
  url: string;
  contentType: string;
};

export type XaiVideoResult = {
  url: string;
  contentType: string;
};

export interface XaiImagineClientOptions {
  apiKey: string;
  baseUrl?: string;
  imageModel?: string;
  videoModel?: string;
  videoPollIntervalMs?: number;
  videoPollTimeoutMs?: number;
}

interface XaiImageData {
  url?: string | null;
  b64_json?: string | null;
  revised_prompt?: string | null;
}

interface XaiImageResponse {
  data?: XaiImageData[];
}

interface XaiVideoStartResponse {
  request_id?: string;
}

interface XaiVideoPollResponse {
  status?: "queued" | "processing" | "done" | "failed" | "expired";
  video?: {
    url?: string | null;
  } | null;
  error?: string | { message?: string };
}

function compactInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function mapImageSizeToAspectRatio(imageSize: XaiImageSize | undefined): string | undefined {
  switch (imageSize) {
    case "square_hd":
    case "square":
      return "1:1";
    case "portrait_4_3":
      return "3:4";
    case "portrait_16_9":
      return "9:16";
    case "landscape_4_3":
      return "4:3";
    case "landscape_16_9":
      return "16:9";
    case "auto":
    case undefined:
      return imageSize;
    default:
      return mapCustomImageSizeToAspectRatio(imageSize);
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function mapCustomImageSizeToAspectRatio(imageSize: `${number}x${number}`): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(imageSize);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function mapImageQualityToResolution(quality: XaiImageQuality | undefined): "1k" | "2k" | undefined {
  return quality === "high" ? "2k" : quality ? "1k" : undefined;
}

function assertSupportedImageFormat(format: XaiImageFormat | undefined): void {
  if (!format || format === "jpeg") {
    return;
  }
  throw new IntegrationError("xAI image generation only supports JPEG output; use the FAL provider for PNG or WebP output.", "xai");
}

function mapDuration(duration: XaiVideoDuration | undefined): number | undefined {
  if (!duration || duration === "auto") {
    return undefined;
  }
  return Number(duration);
}

function mapAspectRatio(aspectRatio: XaiVideoAspectRatio | undefined): string | undefined {
  return aspectRatio === "auto" ? undefined : aspectRatio;
}

function parseImageResponse(response: XaiImageResponse): XaiImageResult[] {
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new IntegrationError("xAI image response missing data", "xai");
  }

  return response.data.map((image) => {
    if (image.url) {
      return {
        url: image.url,
        contentType: "image/jpeg",
      };
    }
    if (image.b64_json) {
      return {
        url: `data:image/jpeg;base64,${image.b64_json}`,
        contentType: "image/jpeg",
      };
    }
    throw new IntegrationError("xAI image payload missing URL", "xai");
  });
}

function getVideoError(response: XaiVideoPollResponse): string {
  if (typeof response.error === "string" && response.error.trim().length > 0) {
    return response.error;
  }
  if (response.error && typeof response.error !== "string" && typeof response.error.message === "string" && response.error.message.trim().length > 0) {
    return response.error.message;
  }
  return `xAI video request ended with status ${response.status ?? "unknown"}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XaiImagineClient {
  readonly capabilities = {
    image: {
      outputFormats: ["jpeg"] as const,
      maxReferenceImages: MAX_IMAGE_EDIT_REFERENCES,
    },
    video: {
      maxReferenceImages: MAX_VIDEO_REFERENCE_IMAGES,
    },
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly imageModel: string;
  private readonly videoModel: string;
  private readonly videoPollIntervalMs: number;
  private readonly videoPollTimeoutMs: number;

  constructor(options: XaiImagineClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.imageModel = options.imageModel ?? DEFAULT_IMAGE_MODEL;
    this.videoModel = options.videoModel ?? DEFAULT_VIDEO_MODEL;
    this.videoPollIntervalMs = options.videoPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.videoPollTimeoutMs = options.videoPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    logger.info("XaiImagineClient initialized");
  }

  async generateImage(options: {
    prompt: string;
    imageSize?: XaiImageSize;
    numImages?: number;
    quality?: XaiImageQuality;
    outputFormat?: XaiImageFormat;
  }): Promise<XaiImageResult[]> {
    return withSpan(tracer, "xai.generateImage", { "xai.model": this.imageModel }, async () => {
      assertSupportedImageFormat(options.outputFormat);
      const response = await this.postJson<XaiImageResponse>("/images/generations", compactInput({
        model: this.imageModel,
        prompt: options.prompt,
        n: options.numImages,
        aspect_ratio: mapImageSizeToAspectRatio(options.imageSize),
        resolution: mapImageQualityToResolution(options.quality),
      }));
      return parseImageResponse(response);
    });
  }

  async editImage(options: {
    prompt: string;
    imageUrls: string[];
    imageSize?: XaiImageSize;
    numImages?: number;
    quality?: XaiImageQuality;
    outputFormat?: XaiImageFormat;
  }): Promise<XaiImageResult[]> {
    if (options.imageUrls.length > MAX_IMAGE_EDIT_REFERENCES) {
      throw new IntegrationError(`xAI image editing supports up to ${MAX_IMAGE_EDIT_REFERENCES} reference images.`, "xai");
    }

    return withSpan(tracer, "xai.editImage", { "xai.model": this.imageModel }, async () => {
      assertSupportedImageFormat(options.outputFormat);
      const imageRefs = options.imageUrls.map((url) => ({ url, type: "image_url" }));
      const response = await this.postJson<XaiImageResponse>("/images/edits", compactInput({
        model: this.imageModel,
        prompt: options.prompt,
        ...(imageRefs.length === 1 ? { image: imageRefs[0] } : { images: imageRefs }),
        n: options.numImages,
        aspect_ratio: mapImageSizeToAspectRatio(options.imageSize),
        resolution: mapImageQualityToResolution(options.quality),
      }));
      return parseImageResponse(response);
    });
  }

  async generateVideo(options: {
    prompt: string;
    imageUrls?: string[];
    duration?: XaiVideoDuration;
    resolution?: XaiVideoResolution;
    aspectRatio?: XaiVideoAspectRatio;
    generateAudio?: boolean;
  }): Promise<XaiVideoResult> {
    if (options.imageUrls && options.imageUrls.length > MAX_VIDEO_REFERENCE_IMAGES) {
      throw new IntegrationError(`xAI reference-to-video supports up to ${MAX_VIDEO_REFERENCE_IMAGES} reference images.`, "xai");
    }

    return this.startAndPollVideo("/videos/generations", compactInput({
      model: this.videoModel,
      prompt: options.prompt,
      reference_images: options.imageUrls?.map((url) => ({ url })),
      duration: mapDuration(options.duration),
      resolution: options.resolution,
      aspect_ratio: mapAspectRatio(options.aspectRatio),
      generate_audio: options.generateAudio,
    }));
  }

  async imageToVideo(options: {
    prompt: string;
    imageUrl: string;
    duration?: XaiVideoDuration;
    resolution?: XaiVideoResolution;
    aspectRatio?: XaiVideoAspectRatio;
    generateAudio?: boolean;
  }): Promise<XaiVideoResult> {
    return this.startAndPollVideo("/videos/generations", compactInput({
      model: this.videoModel,
      prompt: options.prompt,
      image: { url: options.imageUrl },
      duration: mapDuration(options.duration),
      resolution: options.resolution,
      aspect_ratio: mapAspectRatio(options.aspectRatio),
      generate_audio: options.generateAudio,
    }));
  }

  async editVideo(options: {
    prompt: string;
    videoUrl: string;
    imageUrls?: string[];
  }): Promise<XaiVideoResult> {
    if (options.imageUrls?.length) {
      throw new IntegrationError("xAI video editing does not support extra reference images; use image-to-video for image references.", "xai");
    }

    return this.startAndPollVideo("/videos/edits", compactInput({
      model: this.videoModel,
      prompt: options.prompt,
      video: { url: options.videoUrl },
    }));
  }

  private async startAndPollVideo(path: string, body: Record<string, unknown>): Promise<XaiVideoResult> {
    return withSpan(tracer, "xai.video", { "xai.model": this.videoModel }, async () => {
      const started = await this.postJson<XaiVideoStartResponse>(path, body);
      if (!started.request_id) {
        throw new IntegrationError("xAI video response missing request_id", "xai");
      }

      const deadline = Date.now() + this.videoPollTimeoutMs;
      while (Date.now() <= deadline) {
        const polled = await this.getJson<XaiVideoPollResponse>(`/videos/${started.request_id}`);
        if (polled.status === "done") {
          const url = polled.video?.url;
          if (!url) {
            throw new IntegrationError("xAI video payload missing URL", "xai");
          }
          return { url, contentType: "video/mp4" };
        }
        if (polled.status === "failed" || polled.status === "expired") {
          throw new IntegrationError(getVideoError(polled), "xai");
        }
        await delay(this.videoPollIntervalMs);
      }

      throw new IntegrationError(`xAI video request timed out after ${this.videoPollTimeoutMs}ms`, "xai");
    });
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(buildUrl(this.baseUrl, path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response, path);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(buildUrl(this.baseUrl, path), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return this.parseResponse<T>(response, path);
  }

  private async parseResponse<T>(response: Response, path: string): Promise<T> {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      logger.error({ status: response.status, body: errorBody, path }, "xAI Imagine request failed");
      throw new IntegrationError(`xAI Imagine request failed: ${response.status} ${errorBody}`, "xai");
    }
    return await response.json() as T;
  }
}
