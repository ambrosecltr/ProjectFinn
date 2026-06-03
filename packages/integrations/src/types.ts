import type { ExaClient } from "./exa.js";
import type { FalClient } from "./fal.js";
import type { ComposioClient } from "./composio.js";
import type { McpBroker } from "./mcp-service.js";
import type { MemoryClient } from "./memory.js";

export interface IntegrationClients {
  exa?: ExaClient;
  fal?: FalClient;
  composio?: ComposioClient;
  mcp?: McpBroker;
  memory?: MemoryClient;
}
