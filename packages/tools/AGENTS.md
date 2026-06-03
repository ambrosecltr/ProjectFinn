# packages/tools

Tool definitions for hot-path and worker agents. Native tools use Vercel AI SDK `tool()` plus Zod. Project-local toolsets live in `packages/toolsets` and are exposed to models through Secure Exec Finn JS workspace, not as shell tools.

## Structure

```
src/
├── code-mode.ts        # workspace_search / workspace_execute Secure Exec wrapper
├── view-image.ts       # native model-ready image inspection
├── hot-path/           # real-time agent tools
└── worker/             # background worker runtime factory + memory tools
```

## Tool Pattern

```typescript
import { tool } from "ai";
import { z } from "zod";

export function createMyTool(dep: SomeDep) {
  return tool({
    description: "What this tool does",
    inputSchema: z.object({ /* params */ }),
    execute: async (input) => { /* return JSON-serializable result */ },
  });
}
```

Creator functions take deps; do not import user-scoped globals.

## Hot Path

`createHotPathTools(deps)` returns delivery/control tools (`send_message`, `send_media`, `react`, `wait`, `display_draft`, `finish_turn`), optional profile/memory/Pattern context tools, Finn JS workspace file context tools, and native `view_image`. `delegate` is added by `HotPathAgent` only for user-sourced turns with a worker manager.

Hot-path file lookup uses `workspace_search` and `workspace_execute` with the `finn.files.*` APIs. Keep this lightweight; document extraction stays worker/internal-automation only and image pixels go through native `view_image`.

`finish_turn` is hot-path-only. It marks streamed hot-path execution complete after text/tool work is done.

## Worker Runtime

`createWorkerRuntimeConfig(deps)` builds the worker ToolSet for a single run:

- Starts from native worker tools such as `set_status` and optional provider-neutral memory tools.
- Adds Finn JS workspace `workspace_search` / `workspace_execute` for enabled toolsets: `files`, `web`, `creative`, `mcp`, `patterns`, `pattern`, and scoped Puter namespaces.
- Adds native `view_image` when files access is present.
- Adds Composio Vercel AI SDK tools only when configured for the user and capability-gated.
- Returns `{ tools, promptAppendix }` so the model receives discovery-first instructions for the exact APIs loaded in that run.

Secure Exec is a JavaScript sandbox, not a shell. Do not expose host child processes, package managers, long-running sessions, or shell-parity tools to LLM workers.

## Project Toolsets

Use `packages/toolsets/src/` when a runtime should expose a compact, searchable Finn API namespace rather than many native tools. Toolsets must define schemas, effects, process availability, and executors, then be gated by the owning runtime/connector policy before reaching Finn JS workspace.

Puter toolsets must use live paired Mac commands in production. The local-record executor path exists for tests only; do not build product behavior around batch-uploaded local records.

Puter iMessage results should mirror what the paired user can see in Messages. Exclude archived/deleted/recoverable rows, preserve Apple `message.is_from_me` as `metadata.isFromMe`, and normalize sent rows to `sender: "me"` plus `metadata.localUser: true`; never hardcode a user's name, email, or phone number to decide local identity.

## Conventions

- Optional deps omit tools when unavailable.
- Prompt/tool alignment is mandatory: do not add static prompt text for an optional tool family without matching capability gating.
- Worker tools must not send messages to the user; only hot-path has delivery tools.
- Media outputs should be stored locally whenever file storage is available so hot path can send them via `send_media`.
- Tool deps should consume `ProcessRuntimeServices` / `UserRuntimeServices`; do not derive workspace roots or construct user-scoped storage, memory, MCP, or sandbox services in tool code.
- All file operations are user-scoped through `FilesRuntime`.
- `patterns` is exposed only to `pattern_management`; `pattern` run history is exposed only to `pattern_worker`.
- `list_active_patterns` is a read-only hot-path helper, not Pattern CRUD.
- Document extraction stays local through `finn.files.extract`; connector-provided/signed URL reads must reject private/internal network targets before fetching.
- User-visible files go under `workspace/files/`; temporary files that Finn files APIs need to inspect should use run-scoped `/artifacts/...`; Secure Exec-local `/tmp` is not a Finn files path.

## PR Guidance

- Name affected tool families in PR notes: hot-path tools, worker tools, Finn JS workspace, files, web, creative, MCP, or Pattern tooling.
- Call out capability-gating changes, new or removed tool exposure, schema changes, and runtime-boundary implications.
- Include exact validation, typically `bun run check` plus relevant tests.
