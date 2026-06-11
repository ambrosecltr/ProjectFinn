import {
  resolveConfiguredCreativeProvider,
  resolveConfiguredWebSearchProvider,
  type AppConfig,
} from "@finn/core";
import { createLogger } from "@finn/core";
import { ComposioClient } from "./composio.js";
import { ExaClient } from "./exa.js";
import { FalClient } from "./fal.js";
import { HindsightClient } from "./hindsight.js";
import { HonchoClient } from "./honcho.js";
import { Mem0Client } from "./mem0.js";
import { ParallelClient } from "./parallel.js";
import { SupermemoryClient } from "./supermemory.js";
import type { IntegrationClients } from "./types.js";
import { XaiImagineClient } from "./xai.js";

const logger = createLogger("integrations");

type CreativeImageClient = Pick<FalClient | XaiImagineClient, "capabilities" | "generateImage" | "editImage">;
type CreativeVideoClient = Pick<FalClient | XaiImagineClient, "capabilities" | "generateVideo" | "imageToVideo" | "editVideo">;

function createCreativeRouter(input: {
  image?: CreativeImageClient;
  video?: CreativeVideoClient;
}) {
  return {
    capabilities: {
      image: input.image?.capabilities.image ?? {
        outputFormats: ["jpeg", "png", "webp"] as const,
        maxReferenceImages: 4,
      },
      video: input.video?.capabilities.video ?? {
        maxReferenceImages: 4,
      },
    },
    generateImage: (options: Parameters<CreativeImageClient["generateImage"]>[0]) => {
      if (!input.image) {
        throw new Error("Creative image generation is not configured.");
      }
      return input.image.generateImage(options);
    },
    editImage: (options: Parameters<CreativeImageClient["editImage"]>[0]) => {
      if (!input.image) {
        throw new Error("Creative image editing is not configured.");
      }
      return input.image.editImage(options);
    },
    generateVideo: (options: Parameters<CreativeVideoClient["generateVideo"]>[0]) => {
      if (!input.video) {
        throw new Error("Creative video generation is not configured.");
      }
      return input.video.generateVideo(options);
    },
    imageToVideo: (options: Parameters<CreativeVideoClient["imageToVideo"]>[0]) => {
      if (!input.video) {
        throw new Error("Creative image-to-video generation is not configured.");
      }
      return input.video.imageToVideo(options);
    },
    editVideo: (options: Parameters<CreativeVideoClient["editVideo"]>[0]) => {
      if (!input.video) {
        throw new Error("Creative video editing is not configured.");
      }
      return input.video.editVideo(options);
    },
  };
}

export function createIntegrationClients(config: AppConfig): IntegrationClients {
  const clients: IntegrationClients = {};
  const integrations = config.integrations;

  if (!integrations) {
    logger.warn("No integration config found — all integrations disabled");
    return clients;
  }

  const configured: string[] = [];
  const unconfigured: string[] = [];

  const selectedWebProvider = resolveConfiguredWebSearchProvider({
    requested: config.webSearchProvider,
    integrations,
  });

  if (selectedWebProvider === "exa" && integrations.exa?.apiKey) {
    clients.exa = new ExaClient({ apiKey: integrations.exa.apiKey });
    clients.web = clients.exa;
    configured.push("exa");
    configured.push("web:exa");
  } else if (integrations.exa?.apiKey) {
    configured.push("exa:inactive");
  } else {
    unconfigured.push("exa");
  }

  if (selectedWebProvider === "parallel" && integrations.parallel?.apiKey) {
    clients.parallel = new ParallelClient({
      apiKey: integrations.parallel.apiKey,
      baseUrl: integrations.parallel.baseUrl,
      timeoutMs: integrations.parallel.timeoutMs,
      maxRetries: integrations.parallel.maxRetries,
      clientModel: config.models.worker.model,
    });
    clients.web = clients.parallel;
    configured.push("parallel");
    configured.push("web:parallel");
  } else if (integrations.parallel?.apiKey) {
    configured.push("parallel:inactive");
  } else {
    unconfigured.push("parallel");
  }

  if (!clients.web) {
    unconfigured.push("web");
  }

  if (integrations.fal?.apiKey) {
    clients.fal = new FalClient({
      apiKey: integrations.fal.apiKey,
      imageGenModel: integrations.fal.imageGenModel,
      imageEditModel: integrations.fal.imageEditModel,
      videoGenModel: integrations.fal.videoGenModel,
      imageToVideoModel: integrations.fal.imageToVideoModel,
      videoEditModel: integrations.fal.videoEditModel,
    });
    configured.push("fal");
  } else {
    unconfigured.push("fal");
  }

  if (integrations.xai?.apiKey) {
    clients.xaiImagine = new XaiImagineClient({
      apiKey: integrations.xai.apiKey,
      baseUrl: integrations.xai.baseUrl,
      imageModel: integrations.xai.imageModel,
      videoModel: integrations.xai.videoModel,
      videoPollIntervalMs: integrations.xai.videoPollIntervalMs,
      videoPollTimeoutMs: integrations.xai.videoPollTimeoutMs,
    });
    configured.push("xai");
  } else {
    unconfigured.push("xai");
  }

  const imageProvider = resolveConfiguredCreativeProvider({
    requested: config.mediaGeneration?.imageProvider,
    integrations,
  });
  const videoProvider = resolveConfiguredCreativeProvider({
    requested: config.mediaGeneration?.videoProvider,
    integrations,
  });
  const imageClient = imageProvider === "fal" ? clients.fal : imageProvider === "xai" ? clients.xaiImagine : undefined;
  const videoClient = videoProvider === "fal" ? clients.fal : videoProvider === "xai" ? clients.xaiImagine : undefined;
  if (imageClient || videoClient) {
    clients.creative = createCreativeRouter({ image: imageClient, video: videoClient });
    configured.push(`creative:image:${imageProvider ?? "none"}`);
    configured.push(`creative:video:${videoProvider ?? "none"}`);
  } else {
    unconfigured.push("creative");
  }

  if (integrations.composio?.apiKey) {
    clients.composio = new ComposioClient({
      apiKey: integrations.composio.apiKey,
      allowedToolkits: integrations.composio.allowedToolkits,
    });
    configured.push("composio");
  } else {
    unconfigured.push("composio");
  }

  if (integrations.supermemory?.apiKey) {
    configured.push("supermemory");
  } else {
    unconfigured.push("supermemory");
  }

  if (integrations.hindsight?.baseUrl) {
    configured.push("hindsight");
  } else {
    unconfigured.push("hindsight");
  }

  if (integrations.honcho?.apiKey || integrations.honcho?.baseUrl) {
    configured.push("honcho");
  } else {
    unconfigured.push("honcho");
  }

  if (integrations.mem0?.apiKey) {
    configured.push("mem0");
  } else {
    unconfigured.push("mem0");
  }

  switch (config.memory.provider) {
    case "none":
      unconfigured.push("memory");
      break;
    case "supermemory":
      if (integrations.supermemory?.apiKey) {
        clients.memory = new SupermemoryClient({
          apiKey: integrations.supermemory.apiKey,
          baseUrl: integrations.supermemory.baseUrl,
        });
        configured.push("memory:supermemory");
      } else {
        unconfigured.push("memory:supermemory");
      }
      break;
    case "hindsight":
      if (integrations.hindsight?.baseUrl) {
        clients.memory = new HindsightClient({
          apiKey: integrations.hindsight.apiKey,
          baseUrl: integrations.hindsight.baseUrl,
          provisionMentalModels: config.memory.provisionMentalModels,
        });
        configured.push("memory:hindsight");
      } else {
        unconfigured.push("memory:hindsight");
      }
      break;
    case "honcho":
      if (integrations.honcho?.apiKey || integrations.honcho?.baseUrl) {
        clients.memory = new HonchoClient({
          apiKey: integrations.honcho.apiKey,
          baseUrl: integrations.honcho.baseUrl,
          workspacePrefix: integrations.honcho.workspacePrefix,
          timeoutMs: integrations.honcho.timeoutMs,
        });
        configured.push("memory:honcho");
      } else {
        unconfigured.push("memory:honcho");
      }
      break;
    case "mem0":
      if (integrations.mem0?.apiKey) {
        clients.memory = new Mem0Client({
          apiKey: integrations.mem0.apiKey,
          baseUrl: integrations.mem0.baseUrl,
        });
        configured.push("memory:mem0");
      } else {
        unconfigured.push("memory:mem0");
      }
      break;
  }

  logger.info({ configured, unconfigured }, "Integration clients initialized");

  return clients;
}
