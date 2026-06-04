import type { AppConfig } from "@finn/core";
import { createLogger } from "@finn/core";
import { ComposioClient } from "./composio.js";
import { ExaClient } from "./exa.js";
import { FalClient } from "./fal.js";
import { HindsightClient } from "./hindsight.js";
import { HonchoClient } from "./honcho.js";
import { SupermemoryClient } from "./supermemory.js";
import type { IntegrationClients } from "./types.js";

const logger = createLogger("integrations");

export function createIntegrationClients(config: AppConfig): IntegrationClients {
  const clients: IntegrationClients = {};
  const integrations = config.integrations;

  if (!integrations) {
    logger.warn("No integration config found — all integrations disabled");
    return clients;
  }

  const configured: string[] = [];
  const unconfigured: string[] = [];

  if (integrations.exa?.apiKey) {
    clients.exa = new ExaClient({ apiKey: integrations.exa.apiKey });
    configured.push("exa");
  } else {
    unconfigured.push("exa");
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
  }

  logger.info({ configured, unconfigured }, "Integration clients initialized");

  return clients;
}
