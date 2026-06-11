import { fetchWithValidatedAddresses, validateRemoteHttpUrl, type FilesRuntime } from "./files.js";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";

export type CreativeImageSize =
  | "square_hd"
  | "square"
  | "portrait_4_3"
  | "portrait_16_9"
  | "landscape_4_3"
  | "landscape_16_9"
  | "auto"
  | `${number}x${number}`;

export type CreativeImageQuality = "low" | "medium" | "high";
export type CreativeImageFormat = "jpeg" | "png" | "webp";
export type CreativeVideoResolution = "480p" | "720p";
export type CreativeVideoDuration = "auto" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15";
export type CreativeVideoAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface CreativeImageCapabilities {
  outputFormats: readonly CreativeImageFormat[];
  maxReferenceImages: number;
}

export interface CreativeVideoCapabilities {
  maxReferenceImages: number;
}

export interface CreativeRuntimeCapabilities {
  image: CreativeImageCapabilities;
  video: CreativeVideoCapabilities;
}

export const defaultCreativeRuntimeCapabilities: CreativeRuntimeCapabilities = {
  image: {
    outputFormats: ["jpeg", "png", "webp"],
    maxReferenceImages: 4,
  },
  video: {
    maxReferenceImages: 4,
  },
};

export interface CreativeMediaReference {
  fileId?: string;
  path?: string;
  mediaUrl?: string;
}

export interface CreativeImageInput {
  prompt: string;
  images?: CreativeMediaReference[];
  imageSize?: CreativeImageSize;
  numImages?: number;
  quality?: CreativeImageQuality;
  outputFormat?: CreativeImageFormat;
}

export interface CreativeVideoInput {
  prompt: string;
  image?: CreativeMediaReference;
  video?: CreativeMediaReference;
  referenceImages?: CreativeMediaReference[];
  resolution?: CreativeVideoResolution;
  duration?: CreativeVideoDuration;
  aspectRatio?: CreativeVideoAspectRatio;
  generateAudio?: boolean;
}

export interface CreativeGeneratedImage {
  url: string;
  contentType: string;
  width?: number;
  height?: number;
}

export interface CreativeGeneratedVideo {
  url: string;
  contentType: string;
}

export interface CreativeRuntimeClient {
  readonly capabilities?: Partial<CreativeRuntimeCapabilities>;
  uploadMedia?(input: {
    data: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<string>;
  generateImage(options: {
    prompt: string;
    imageSize?: CreativeImageSize;
    numImages?: number;
    quality?: CreativeImageQuality;
    outputFormat?: CreativeImageFormat;
  }): Promise<CreativeGeneratedImage[]>;
  editImage(options: {
    prompt: string;
    imageUrls: string[];
    imageSize?: CreativeImageSize;
    numImages?: number;
    quality?: CreativeImageQuality;
    outputFormat?: CreativeImageFormat;
  }): Promise<CreativeGeneratedImage[]>;
  generateVideo(options: {
    prompt: string;
    imageUrls?: string[];
    duration?: CreativeVideoDuration;
    resolution?: CreativeVideoResolution;
    aspectRatio?: CreativeVideoAspectRatio;
    generateAudio?: boolean;
  }): Promise<CreativeGeneratedVideo>;
  imageToVideo(options: {
    prompt: string;
    imageUrl: string;
    duration?: CreativeVideoDuration;
    resolution?: CreativeVideoResolution;
    aspectRatio?: CreativeVideoAspectRatio;
    generateAudio?: boolean;
  }): Promise<CreativeGeneratedVideo>;
  editVideo(options: {
    prompt: string;
    videoUrl: string;
    imageUrls?: string[];
    duration?: CreativeVideoDuration;
    resolution?: CreativeVideoResolution;
    aspectRatio?: CreativeVideoAspectRatio;
    generateAudio?: boolean;
  }): Promise<CreativeGeneratedVideo>;
}

export interface StoredCreativeImageResult {
  fileId: string | null;
  url: string;
  remoteUrl: string;
  contentType: string;
  width?: number;
  height?: number;
}

export interface StoredCreativeVideoResult {
  fileId: string | null;
  url: string;
  remoteUrl: string;
  contentType: string;
}

export interface CreativeImageResult {
  fileIds: string[];
  images: StoredCreativeImageResult[];
  storedLocally: boolean;
  note?: string;
}

export interface CreativeVideoResult {
  fileId: string | null;
  url: string;
  remoteUrl: string;
  contentType: string;
  storedLocally: boolean;
  note?: string;
}

export interface CreativeRuntimeService {
  readonly kind: "finn-creative-runtime";
  readonly capabilities: CreativeRuntimeCapabilities;
  createOrEditImage(input: CreativeImageInput): Promise<CreativeImageResult>;
  createOrEditVideo(input: CreativeVideoInput): Promise<CreativeVideoResult>;
}

export interface CreativeRuntimeServiceOptions {
  client: CreativeRuntimeClient;
  files?: FilesRuntime;
  fetchRemote?: CreativeFetch;
}

export type CreativeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface StoredFileUrlOwner {
  tenantId: string;
  userId: string;
  id: string;
}

type StoredRemoteFile = {
  fileId: string;
  remoteUrl: string;
  localUrl?: string;
};

type DataUrlMedia = {
  data: Buffer;
  mimeType: string;
  resultUrl: string;
};

const maxRemoteMediaRedirects = 5;
const remoteMediaRedirectStatuses = new Set([301, 302, 303, 307, 308]);
const remoteMediaUrlSafetyMessages = {
  protocolMessage: "Only HTTP(S) media URLs are supported.",
  hostMessage: "Media URLs from local or internal hosts are not allowed.",
  addressMessage: "Media URLs from private or local network addresses are not allowed.",
};
const workspaceMountPath = "/workspace";
const tmpMountPath = "/tmp";
const dataUrlPattern = /^data:([^;,]+)?(;base64)?,(.*)$/is;

function uniqueImageFormats(values: readonly CreativeImageFormat[]): CreativeImageFormat[] {
  const seen = new Set<CreativeImageFormat>();
  for (const value of values) {
    if (value === "jpeg" || value === "png" || value === "webp") {
      seen.add(value);
    }
  }
  return [...seen];
}

function normalizeCreativeCapabilities(capabilities: Partial<CreativeRuntimeCapabilities> | undefined): CreativeRuntimeCapabilities {
  const outputFormats = uniqueImageFormats(capabilities?.image?.outputFormats ?? defaultCreativeRuntimeCapabilities.image.outputFormats);

  return {
    image: {
      outputFormats: outputFormats.length > 0 ? outputFormats : [...defaultCreativeRuntimeCapabilities.image.outputFormats],
      maxReferenceImages: capabilities?.image?.maxReferenceImages ?? defaultCreativeRuntimeCapabilities.image.maxReferenceImages,
    },
    video: {
      maxReferenceImages: capabilities?.video?.maxReferenceImages ?? defaultCreativeRuntimeCapabilities.video.maxReferenceImages,
    },
  };
}

function getExtension(contentType: string, fallback: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return fallback;
  }
}

function mimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function sanitizeFilename(value: string): string {
  const safe = basename(value).replace(/[^\w .@()-]+/g, "_").trim();
  return safe.length > 0 ? safe : `creative-${Date.now()}`;
}

async function assertSafeRemoteMediaUrl(value: string | URL): Promise<string> {
  const url = new URL(value);
  await validateRemoteHttpUrl(url, remoteMediaUrlSafetyMessages);
  return url.toString();
}

async function fetchSafeRemoteMedia(fetchRemote: CreativeFetch | undefined, value: string): Promise<{ response: Response; safeUrl: string }> {
  let currentUrl = new URL(value);
  let response: Response | null = null;
  let safeUrl = currentUrl.toString();

  for (let redirectCount = 0; redirectCount <= maxRemoteMediaRedirects; redirectCount += 1) {
    const addresses = await validateRemoteHttpUrl(currentUrl, remoteMediaUrlSafetyMessages);
    safeUrl = currentUrl.toString();
    response = fetchRemote
      ? await fetchRemote(safeUrl, { redirect: "manual" })
      : await fetchWithValidatedAddresses(currentUrl, addresses);

    if (response.url) {
      const responseUrl = new URL(response.url, currentUrl);
      if (responseUrl.toString() !== currentUrl.toString()) {
        await validateRemoteHttpUrl(responseUrl, remoteMediaUrlSafetyMessages);
        currentUrl = responseUrl;
        safeUrl = currentUrl.toString();
      }
    }

    if (!remoteMediaRedirectStatuses.has(response.status)) {
      break;
    }

    const location = response.headers.get("location");
    if (!location) {
      break;
    }
    currentUrl = new URL(location, currentUrl);
  }

  if (!response) {
    throw new Error("Media fetch failed before a request was made.");
  }
  if (remoteMediaRedirectStatuses.has(response.status)) {
    throw new Error(`Media URL exceeded ${maxRemoteMediaRedirects} redirects.`);
  }

  return { response, safeUrl };
}

function parseDataUrl(value: string): DataUrlMedia | null {
  const match = dataUrlPattern.exec(value);
  if (!match) {
    return null;
  }

  const mimeType = match[1]?.trim() || "application/octet-stream";
  const body = match[3] ?? "";
  const data = match[2] ? Buffer.from(body.replace(/\s+/g, ""), "base64") : Buffer.from(decodeURIComponent(body));

  return {
    data,
    mimeType,
    resultUrl: `data:${mimeType}${match[2] ?? ""},<omitted>`,
  };
}

function assertPathInsideWorkspace(workspaceRoot: string, path: string): string {
  const relativePath = relative(workspaceRoot, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path escapes the worker workspace: ${path}`);
  }
  return path;
}

function normalizeWorkspacePath(path: string): string {
  if (path === tmpMountPath || path.startsWith(`${tmpMountPath}/`)) {
    throw new Error("/tmp is disposable Secure Exec scratch and is not a creative media reference path.");
  }
  if (path === workspaceMountPath) {
    return ".";
  }
  if (path.startsWith(`${workspaceMountPath}/`)) {
    return path.slice(`${workspaceMountPath}/`.length);
  }
  return path;
}

async function resolveExistingWorkspacePath(workspaceRoot: string, path: string): Promise<string> {
  const resolved = resolve(workspaceRoot, normalizeWorkspacePath(path));
  assertPathInsideWorkspace(workspaceRoot, resolved);
  const [realRoot, realPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(resolved),
  ]);
  return assertPathInsideWorkspace(realRoot, realPath);
}

function requireStoredFiles(files?: FilesRuntime) {
  if (!files?.storedFiles) {
    throw new Error("Stored file runtime is not available for creative media.");
  }
  return files.storedFiles;
}

function requireStoredFileUrl(files?: FilesRuntime): (file: StoredFileUrlOwner) => string {
  const storedFiles = requireStoredFiles(files);
  if (!storedFiles.urlFor) {
    throw new Error("Stored file URL generation is not available for creative media.");
  }
  return storedFiles.urlFor;
}

async function uploadMediaOrStoredUrl(
  client: CreativeRuntimeClient,
  files: FilesRuntime | undefined,
  input: {
    data: Buffer;
    filename: string;
    mimeType: string;
    storedFile?: StoredFileUrlOwner;
    origin?: "worker_created";
  },
): Promise<string> {
  if (client.uploadMedia) {
    return client.uploadMedia({
      data: input.data,
      filename: input.filename,
      mimeType: input.mimeType,
    });
  }

  if (input.storedFile) {
    const urlFor = requireStoredFileUrl(files);
    return urlFor(input.storedFile);
  }

  const storedFiles = requireStoredFiles(files);
  const urlFor = requireStoredFileUrl(files);
  const stored = await storedFiles.store({
    filename: input.filename,
    mimeType: input.mimeType,
    data: input.data,
    userVisible: false,
    origin: input.origin ?? "worker_created",
  });
  return urlFor(stored);
}

async function workspacePathToMediaUrl(client: CreativeRuntimeClient, files: FilesRuntime, path: string): Promise<string> {
  const absolutePath = await resolveExistingWorkspacePath(files.workspaceRoot, path);
  const data = Buffer.from(await readFile(absolutePath));
  const filename = sanitizeFilename(basename(absolutePath));
  return uploadMediaOrStoredUrl(client, files, {
    data,
    filename,
    mimeType: mimeTypeFromFilename(filename),
    origin: "worker_created",
  });
}

async function resolveMediaUrl(client: CreativeRuntimeClient, reference: CreativeMediaReference, files?: FilesRuntime): Promise<string> {
  const referenceCount = [reference.fileId, reference.path, reference.mediaUrl].filter(Boolean).length;
  if (referenceCount !== 1) {
    throw new Error("Provide exactly one of fileId, path, or mediaUrl.");
  }

  if (reference.mediaUrl) {
    return assertSafeRemoteMediaUrl(reference.mediaUrl);
  }

  if (reference.path) {
    if (!files) {
      throw new Error("Files runtime is required when using a workspace path.");
    }
    return workspacePathToMediaUrl(client, files, reference.path);
  }

  const storedFiles = requireStoredFiles(files);
  const fileId = reference.fileId;
  if (!fileId) {
    throw new Error("Stored file ID is required for creative media.");
  }

  const stored = await storedFiles.get(fileId);
  if (!stored) {
    throw new Error(`Stored file not found: ${fileId}`);
  }

  return uploadMediaOrStoredUrl(client, files, {
    data: stored.data,
    filename: stored.file.filename,
    mimeType: stored.file.mimeType,
    storedFile: stored.file,
  });
}

async function resolveMediaUrls(client: CreativeRuntimeClient, references: CreativeMediaReference[] | undefined, files?: FilesRuntime): Promise<string[]> {
  return Promise.all((references ?? []).map((reference) => resolveMediaUrl(client, reference, files)));
}

async function storeRemoteFile(
  files: FilesRuntime | undefined,
  fetchRemote: CreativeFetch | undefined,
  url: string,
  filename: string,
  mimeType: string,
): Promise<StoredRemoteFile | null> {
  if (!files?.storedFiles) {
    return null;
  }

  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    const stored = await files.storedFiles.store({
      filename,
      mimeType: dataUrl.mimeType || mimeType,
      data: dataUrl.data,
      userVisible: true,
      origin: "assistant_generated",
    });

    return {
      fileId: stored.id,
      remoteUrl: dataUrl.resultUrl,
      ...(files.storedFiles.urlFor ? { localUrl: files.storedFiles.urlFor(stored as StoredFileUrlOwner) } : {}),
    };
  }

  const { response, safeUrl } = await fetchSafeRemoteMedia(fetchRemote, url);
  if (!response.ok) {
    throw new Error(`Failed to fetch generated file: ${response.status} ${response.statusText}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  const stored = await files.storedFiles.store({
    filename,
    mimeType,
    data,
    userVisible: true,
    origin: "assistant_generated",
  });

  return {
    fileId: stored.id,
    remoteUrl: safeUrl,
    ...(files.storedFiles.urlFor ? { localUrl: files.storedFiles.urlFor(stored as StoredFileUrlOwner) } : {}),
  };
}

function buildStoredImageResult(
  stored: StoredRemoteFile | null,
  image: CreativeGeneratedImage,
): StoredCreativeImageResult {
  return {
    fileId: stored?.fileId ?? null,
    url: stored?.localUrl ?? image.url,
    remoteUrl: stored?.remoteUrl ?? image.url,
    contentType: image.contentType,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
  };
}

function buildStoredVideoResult(
  stored: StoredRemoteFile | null,
  video: CreativeGeneratedVideo,
): StoredCreativeVideoResult {
  return {
    fileId: stored?.fileId ?? null,
    url: stored?.localUrl ?? video.url,
    remoteUrl: stored?.remoteUrl ?? video.url,
    contentType: video.contentType,
  };
}

async function storeImages(
  files: FilesRuntime | undefined,
  fetchRemote: CreativeFetch | undefined,
  images: CreativeGeneratedImage[],
  filenamePrefix: string,
): Promise<CreativeImageResult> {
  const timestamp = Date.now();
  const storedImages = await Promise.all(
    images.map(async (image, index) => {
      const stored = await storeRemoteFile(
        files,
        fetchRemote,
        image.url,
        `${filenamePrefix}-${timestamp}-${index + 1}.${getExtension(image.contentType, "png")}`,
        image.contentType,
      );
      return buildStoredImageResult(stored, image);
    }),
  );

  return {
    fileIds: storedImages.map((image) => image.fileId).filter((fileId): fileId is string => typeof fileId === "string"),
    images: storedImages,
    storedLocally: storedImages.every((image) => image.fileId !== null),
    ...(files?.storedFiles ? {} : { note: "Files were not stored locally because file storage is not configured." }),
  };
}

async function storeVideo(
  files: FilesRuntime | undefined,
  fetchRemote: CreativeFetch | undefined,
  video: CreativeGeneratedVideo,
  filenamePrefix: string,
): Promise<CreativeVideoResult> {
  const stored = await storeRemoteFile(
    files,
    fetchRemote,
    video.url,
    `${filenamePrefix}-${Date.now()}.${getExtension(video.contentType, "mp4")}`,
    video.contentType,
  );
  const storedVideo = buildStoredVideoResult(stored, video);

  return {
    fileId: storedVideo.fileId,
    url: storedVideo.url,
    remoteUrl: storedVideo.remoteUrl,
    contentType: storedVideo.contentType,
    storedLocally: storedVideo.fileId !== null,
    ...(files?.storedFiles ? {} : { note: "Files were not stored locally because file storage is not configured." }),
  };
}

export function createCreativeRuntimeService(options: CreativeRuntimeServiceOptions): CreativeRuntimeService {
  const fetchRemote = options.fetchRemote;
  const capabilities = normalizeCreativeCapabilities(options.client.capabilities);

  return {
    kind: "finn-creative-runtime",
    capabilities,
    async createOrEditImage(input) {
      const imageUrls = await resolveMediaUrls(options.client, input.images, options.files);
      const generatedImages = imageUrls.length > 0
        ? await options.client.editImage({
            prompt: input.prompt,
            imageUrls,
            imageSize: input.imageSize,
            numImages: input.numImages,
            quality: input.quality,
            outputFormat: input.outputFormat,
          })
        : await options.client.generateImage({
            prompt: input.prompt,
            imageSize: input.imageSize,
            numImages: input.numImages,
            quality: input.quality,
            outputFormat: input.outputFormat,
          });

      return storeImages(
        options.files,
        fetchRemote,
        generatedImages,
        imageUrls.length > 0 ? "edited-image" : "generated-image",
      );
    },
    async createOrEditVideo(input) {
      if (input.image && input.referenceImages?.length) {
        throw new Error("referenceImages cannot be combined with image; use image for image-to-video or referenceImages for reference-to-video.");
      }

      const commonOptions = {
        prompt: input.prompt,
        resolution: input.resolution,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        generateAudio: input.generateAudio,
      };
      const referenceImageUrls = input.referenceImages?.length
        ? await resolveMediaUrls(options.client, input.referenceImages, options.files)
        : undefined;
      const generatedVideo = input.image
        ? await options.client.imageToVideo({
            ...commonOptions,
            imageUrl: await resolveMediaUrl(options.client, input.image, options.files),
          })
        : input.video
          ? await options.client.editVideo({
              ...commonOptions,
              videoUrl: await resolveMediaUrl(options.client, input.video, options.files),
              imageUrls: referenceImageUrls,
            })
          : await options.client.generateVideo({
              ...commonOptions,
              imageUrls: referenceImageUrls,
            });

      return storeVideo(
        options.files,
        fetchRemote,
        generatedVideo,
        input.video ? "edited-video" : input.image ? "image-to-video" : "generated-video",
      );
    },
  };
}
