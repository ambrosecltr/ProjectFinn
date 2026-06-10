import type { ExaClient } from "./exa.js";
import type { ParallelClient } from "./parallel.js";
import type { FalClient } from "./fal.js";
import type { XaiImagineClient } from "./xai.js";
import type { ComposioClient } from "./composio.js";
import type { McpBroker } from "./mcp-service.js";
import type { MemoryClient } from "./memory.js";

export interface CreativeIntegrationClient {
  generateImage(options: Parameters<FalClient["generateImage"]>[0]): ReturnType<FalClient["generateImage"]>;
  editImage(options: Parameters<FalClient["editImage"]>[0]): ReturnType<FalClient["editImage"]>;
  generateVideo(options: Parameters<FalClient["generateVideo"]>[0]): ReturnType<FalClient["generateVideo"]>;
  imageToVideo(options: Parameters<FalClient["imageToVideo"]>[0]): ReturnType<FalClient["imageToVideo"]>;
  editVideo(options: Parameters<FalClient["editVideo"]>[0]): ReturnType<FalClient["editVideo"]>;
}

export interface IntegrationClients {
  web?: ExaClient | ParallelClient;
  exa?: ExaClient;
  parallel?: ParallelClient;
  fal?: FalClient;
  xaiImagine?: XaiImagineClient;
  creative?: CreativeIntegrationClient;
  composio?: ComposioClient;
  mcp?: McpBroker;
  memory?: MemoryClient;
}
