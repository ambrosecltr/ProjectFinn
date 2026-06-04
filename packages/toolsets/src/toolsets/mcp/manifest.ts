import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import {
  mcpCallInputSchema,
  mcpReadResourceInputSchema,
  mcpResourcesInputSchema,
  mcpSearchInputSchema,
  mcpServersInputSchema,
} from "./schemas.js";

export interface McpManifestOptions {
  processTypes: ToolsetProcessType[];
}

export function createMcpManifest(options: McpManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [
    {
      name: "servers",
      description: "List configured MCP servers and their runtime status.",
      effects: ["read"],
      inputSchema: mcpServersInputSchema,
      argumentGuidance: [
        "This API takes an empty input object.",
      ],
      examples: [
        { purpose: "List available MCP servers and status", code: "await finn.mcp.servers({})" },
      ],
      outputGuidance: [
        "Use returned server names exactly with server in later MCP API calls.",
      ],
    },
    {
      name: "search",
      description: "Search configured MCP servers for remote tools relevant to a task.",
      effects: ["read"],
      inputSchema: mcpSearchInputSchema,
      argumentGuidance: [
        "query should describe the remote capability you need, not the API syntax.",
        "server narrows search to one server name returned by finn.mcp.servers.",
        "limit defaults to the runtime limit; keep it small unless discovery coverage matters.",
      ],
      examples: [
        { purpose: "Search all scoped MCP servers for a docs search tool", code: "await finn.mcp.search({ query: \"search documentation\", limit: 10 })" },
        { purpose: "Search one server only", code: "await finn.mcp.search({ server: \"docs\", query: \"read page content\", limit: 5 })" },
      ],
      outputGuidance: [
        "Inspect the returned input schema before calling a remote tool.",
      ],
    },
    {
      name: "resources",
      description: "List available resources from configured MCP servers.",
      effects: ["read"],
      inputSchema: mcpResourcesInputSchema,
      argumentGuidance: [
        "server is optional. Use it when you already know the server from finn.mcp.servers or search results.",
        "limit caps returned resources.",
      ],
      examples: [
        { purpose: "List resources across scoped servers", code: "await finn.mcp.resources({ limit: 25 })" },
        { purpose: "List resources for one server", code: "await finn.mcp.resources({ server: \"docs\", limit: 25 })" },
      ],
      outputGuidance: [
        "Use returned server and uri values exactly with finn.mcp.readResource.",
      ],
    },
    {
      name: "read_resource",
      description: "Read a specific MCP resource by server and URI.",
      effects: ["read"],
      inputSchema: mcpReadResourceInputSchema,
      argumentGuidance: [
        "server must be a server name returned by finn.mcp.servers, finn.mcp.resources, or finn.mcp.search.",
        "uri must be a resource URI returned by finn.mcp.resources.",
      ],
      examples: [
        { purpose: "Read one listed MCP resource", code: "await finn.mcp.readResource({ server: \"docs\", uri: \"docs://intro\" })" },
      ],
      outputGuidance: [
        "Use the returned resource content as read-only context. If the server returns multiple content parts, inspect each part before summarizing.",
        "If the result reports an error or empty content, use finn.mcp.resources/search to verify the server and URI before retrying.",
      ],
    },
    {
      name: "call",
      description: "Call a specific remote MCP tool by server and tool name. Treat every call as write/unknown-effect.",
      effects: ["write"],
      inputSchema: mcpCallInputSchema,
      argumentGuidance: [
        "server and tool must match a search result exactly.",
        "arguments must be an object matching the remote tool schema.",
        "Call only after finn.mcp.search has shown the tool and schema unless the exact server/tool/schema is already known in context.",
      ],
      examples: [
        { purpose: "Call a remote search tool with JSON arguments", code: "await finn.mcp.call({ server: \"docs\", tool: \"search_docs\", arguments: { query: \"rate limits\", limit: 5 } })" },
        { purpose: "Call a remote read tool with a path argument", code: "await finn.mcp.call({ server: \"docs\", tool: \"read_page\", arguments: { path: \"/api/models\" } })" },
      ],
      outputGuidance: [
        "Remote tool calls can have unknown side effects. Treat errors and isError outputs as failed calls, not facts.",
      ],
    },
  ];

  return {
    slug: "mcp",
    displayName: "MCP",
    description: "Brokered Finn JS workspace access to Finn's configured MCP servers, tools, and resources.",
    capability: "write",
    effects: ["read", "write"],
    runtimeRequirements: ["mcp"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset to discover and use scoped MCP servers, tools, and resources.",
        "The APIs listed in this loaded toolkit are the only MCP actions available in this run.",
      ],
      referenceFormats: [
        "Server names come from finn.mcp.servers, finn.mcp.resources, or finn.mcp.search results.",
        "Resource URIs come from finn.mcp.resources and must be passed exactly as uri.",
      ],
      syntaxRules: [
        "Do not invent server names, resource URIs, remote tool names, or argument schemas.",
      ],
      safetyRules: [
        "Do not use remote tools for irreversible actions without explicit user confirmation and task authorization.",
      ],
    },
    defaultLimit: 25,
    maxLimit: 100,
    commands,
  };
}
