# packages/agents

Agent implementations: hot path, worker, worker manager, compactor, and status context.

## Structure

```
src/
├── factory.ts
├── hot-path.ts
├── prompt-factory.ts
├── worker.ts
├── worker-manager.ts
├── compactor.ts
├── status.ts
└── index.ts
```

## Hot Path

`HotPathAgent.handleMessage()` receives `user`, `worker`, and `trigger` messages. It appends structured conversation history, builds a capability-gated system prompt plus trailing runtime envelopes, streams with `streamText()`, narrows active tools per step, and ends with explicit `finish_turn`.

Only `human_message` envelopes are user-authored. Runtime, memory, status, worker, trigger, and attachment context must stay inside internal envelopes and must not masquerade as a new user turn.

Attachments include stored `fileId`, app-hosted URL, MIME type, and extracted context. Current-turn inline vision is bounded and every loaded image goes through the shared model-image preparation path. Omitted images remain available as file metadata for delegation or explicit inspection.

Hot-path file context uses Finn JS workspace `workspace_search` and `workspace_execute` with `finn.files.*` plus native `view_image`. Keep hot-path file work lightweight; document extraction and content-heavy inspection belong in workers.

## Worker Agent

`WorkerAgent` is a stateless executor created by `WorkerManager.runWorker()`.

Flow: `generateText()` with runtime tools plus injected `set_status` -> model calls `set_status({ kind: "outcome", detail })` -> if missing, a forced finalization pass runs with only `set_status` active -> returns `WorkerResult`.

`set_status` is the worker's only completion channel. Pattern-triggered workers must report a Pattern notify outcome with `notify`, `summary`, and optional `reason`/`data`; the scheduler validates notify conditions before surfacing anything to the hot path.

Workers receive a dynamic prompt appendix for the exact tools loaded in the run. Toolsets are exposed through Secure Exec Finn JS workspace: the model should discover APIs with `workspace_search`, then compose JavaScript against the global `finn` object in `workspace_execute`. Secure Exec is not a shell and should not expose host child processes, package managers, or long-running sessions.

Document extraction is part of `finn.files.extract`, not the hot path. Eligible general and Pattern workers receive it through runtime-scoped files access. `pattern_management`, My Day, and Personal Intelligence receive read-only files access.

Large tool results may be replaced with temporary `/artifacts/...` paths before entering model history. Workers should inspect those paths with `finn.files.search`, `finn.files.read`, or `finn.files.extract` while the run is active, then summarize or persist meaningful outputs before finishing.

## Pattern Workers

Pattern-management workers should prefer edit-in-place over delete/recreate so Pattern IDs and run history survive. Start with `finn.patterns.list` before mutating, and use inspect-by-ID for full details before edits, deletes, replacements, or prompt/scope changes.

Scheduled Pattern create/edit inputs use structured schedule configs: `once`, `interval`, `daily`, `weekly`, or `monthly`. Pattern tools do not accept timezone overrides; schedules use the user's effective timezone from runtime context.

## Worker Manager

`WorkerManager` runs workers in-process, tracks DB state, emits lifecycle events, applies timeout/concurrency limits, and preserves resumable run artifacts until follow-up is no longer possible.

## Conventions

- Hot path uses `streamText()`; workers and compactor use `generateText()`.
- Workers are invisible and never message the user directly.
- Hot-path completion is explicit through `finish_turn`.
- Delivery tool results are outbound receipts, not user replies.
- Worker completion is explicit through `set_status(kind: "outcome")`.
- Worker runtime is dynamic and user-scoped. Never share worker tool deps, file storage, memory runtime, MCP services, or Finn JS workspace executors across users.
- Transient artifact paths are not deliverables.
- Optional features must be gated in both tool factories and LLM-visible prompt text.
- Baseline prompts are loaded from `prompts/*.xml`; runtime-specific capability appendices are assembled in code.
- EventBus is the inter-agent communication boundary.
- AI SDK telemetry should carry Finn-scoped metadata so PostHog traces correlate across runs.

## PR Guidance

- Name the affected agent path: hot path, worker, compactor, or status/runtime wiring.
- Call out prompt changes, tool exposure changes, delivery behavior, memory context, and Pattern outcome changes.
- Include exact validation, usually `bun run check` plus relevant tests.
