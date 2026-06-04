import type { McpRuntimeService } from "@finn/runtime";
import { formatToolsetError } from "../../utils.js";
import {
  mcpCallInputSchema,
  mcpReadResourceInputSchema,
  mcpResourcesInputSchema,
  mcpSearchInputSchema,
  type McpResourcesInput,
} from "./schemas.js";

const defaultResourceLimit = 25;

function capResources(resources: Awaited<ReturnType<McpRuntimeService["listResources"]>>, limit: McpResourcesInput["limit"]) {
  const capped = resources.slice(0, limit ?? defaultResourceLimit);
  return {
    resources: capped,
    total: resources.length,
    truncated: capped.length < resources.length,
  };
}

export async function mcpServersCommand(runtime: McpRuntimeService) {
  return { servers: runtime.getStatuses() };
}

export async function mcpSearchCommand(runtime: McpRuntimeService, input: unknown) {
  const parsed = mcpSearchInputSchema.parse(input);
  try {
    const tools = await runtime.searchTools(parsed);
    return { tools };
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function mcpResourcesCommand(runtime: McpRuntimeService, input: unknown) {
  const parsed = mcpResourcesInputSchema.parse(input);
  try {
    const resources = await runtime.listResources({ server: parsed.server });
    return capResources(resources, parsed.limit);
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function mcpReadResourceCommand(runtime: McpRuntimeService, input: unknown) {
  const parsed = mcpReadResourceInputSchema.parse(input);
  try {
    return await runtime.readResource(parsed);
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function mcpCallCommand(runtime: McpRuntimeService, input: unknown) {
  const parsed = mcpCallInputSchema.parse(input);
  try {
    return await runtime.callTool(parsed);
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function executeMcpCommand(runtime: McpRuntimeService, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "servers":
      return mcpServersCommand(runtime);
    case "search":
      return mcpSearchCommand(runtime, args);
    case "resources":
      return mcpResourcesCommand(runtime, args);
    case "read_resource":
      return mcpReadResourceCommand(runtime, args);
    case "call":
      return mcpCallCommand(runtime, args);
    default:
      throw new Error(`Unsupported MCP command: ${command}`);
  }
}
