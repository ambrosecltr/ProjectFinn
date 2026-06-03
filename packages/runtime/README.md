# @finn/runtime

Finn-owned runtime services for model-facing tools and internal automation.

This package owns the shared boundary for user-scoped filesystem access, workspace paths, temporary artifacts, web/creative/MCP connector services, memory, Patterns, and My Day. Tool registries declare what they need; the server composes a per-user/per-process runtime and passes only the allowed service surface into tools.

Toolsets must not construct workspace roots, `FileStorage`, connector clients, memory clients, or sandbox policy directly. Native tools should also consume runtime services so isolation and permissions are enforced in one place.

## Runtime Service Contracts

`UserRuntimeServices` is the per-user service bundle. It has typed slots for `files`, `workspace`, `artifacts`, `web`, `creative`, `mcp`, `composio`, `memory`, `patterns`, and `myDay`.

`ProcessRuntimeServices` is a cheap per-run view over the same user bundle. `createProcessRuntimeServices(userRuntime, { processType: "my_day", filesAccess: "read" })` narrows the Files runtime descriptor for that process; workspace paths and nested service objects remain shared references. The process view must not expose a back-reference to the full user runtime.

Process views do not inherit optional services by default. Grant each slot explicitly with `grants` or pass a narrowed service override through `services`; this prevents attaching a broad user-level MCP, connector, or memory surface to a process that should not see it.

Finn-owned file writes are enforced by the Files runtime access level and tool grants. A read-oriented process view can still list and read files but cannot use Finn file-write commands such as workspace writes, downloads into the workspace, or stored-file visibility changes. Web research, creative generation, MCP, and Patterns are exposed to Finn JS workspace only when their runtime services are explicitly granted.
