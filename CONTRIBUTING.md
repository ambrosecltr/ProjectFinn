# Contributing to Finn

Thanks for contributing. Finn is a Bun and TypeScript monorepo for a personal AI companion that lives in iMessage. It combines a hot-path agent for live conversations, background workers for longer-running tasks, and Pattern workers for scheduled or trigger-driven automation.

This guide focuses on how to make changes that fit Finn's architecture and are easy to review.

## Contribution Priorities

We generally value contributions in this order:

1. Bug fixes and regressions.
2. Reliability, safety, and security improvements.
3. Focused UX improvements in the web app or operator workflows.
4. Tests, docs, and clarity improvements.
5. New features that fit Finn's existing product direction.

For large features, architectural shifts, or new integrations, open an issue or discussion first so maintainers can confirm the direction before you invest heavily.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1+
- PostgreSQL 16+
- Docker Desktop or Docker Engine
- Photon Spectrum project credentials if you want to exercise the live iMessage path
- At least one hosted LLM provider key, or access to an OpenAI-compatible endpoint

### Clone and install

```bash
git clone <repo-url>
cd FinnAI
bun install
```

### Configure environment

```bash
cp .env.example .env
```

Fill in the required values in `.env`. The full configuration reference lives in `docs/operations/configuration.mdx`.

### Start supporting services

```bash
docker compose up postgres -d
bun run db:push
```

### Run Finn locally

```bash
bun run dev
```

Useful commands:

```bash
bun run check
bun run test
bun run build
bun run docs:dev
bun run docs:validate
bun run docs:broken-links
bun run db:generate
bun run db:migrate
```

## Project Map

Start with these areas:

- `packages/agents`: hot-path, worker, and compactor agents
- `packages/tools`: model-facing hot-path and worker tools
- `packages/toolsets`: project-local CLI toolsets used by workers and automation
- `packages/server`: Hono server, routes, event wiring, and runtime composition
- `packages/web`: Vite React dashboard
- `packages/db`: Drizzle schema and database access
- `packages/integrations`: Exa/Parallel web research, Fal, Composio, BrowserUse, MCP, and memory integrations
- `packages/patterns`: Pattern persistence, scheduling, and run history
- `prompts/`: runtime instructions for each agent process
- `identity/`: Finn's personality and voice
- `docs/`: Mintlify documentation site

The repo-level `AGENTS.md` is the best high-signal map of the architecture and project conventions. If you are changing a package that has its own `AGENTS.md`, read that too before editing.

## Finn-Specific Guidelines

### Treat prompts and identity as code

Files in `prompts/` and `identity/` directly affect runtime behavior. Review them with the same care as application code.

If you change these files in Docker-based development, restart Finn afterward:

```bash
docker compose restart finn
```

If you touch `identity/FINN.xml`, preserve Finn's existing voice rules. In particular, Finn's user-facing messages are intentionally lowercase and should not be split into multiple messages unless the product behavior explicitly changes.

### Use Bun, not pnpm

This is a Bun workspace. Use `bun install`, `bun run ...`, and the existing Bun scripts from the repo root.

`pnpm-lock.yaml` still exists for historical reasons, but `bun.lock` is the primary lockfile.

### Keep changes aligned with the runtime model

Finn has separate runtime surfaces with different constraints:

- Hot path: real-time user-facing conversation handling
- Workers: longer-running delegated tasks
- Pattern workers: scheduled or trigger-driven automation
- Web app: dashboard and operator UI
- User runtime services: scoped file, memory, MCP, and sandbox access

Prefer improving the existing path for the right runtime rather than adding parallel logic or fallback-heavy code.

### Capability and config changes need full wiring

`packages/core/src/config.ts` is the shared source of truth for config and capability gates.

If you add or change a capability, also update the relevant runtime exposure points, such as tool factories, prompt assembly, status visibility, tests, and docs.

### Database changes should be complete

Schema changes belong in `packages/db/src/schema.ts`.

When a schema change is required:

```bash
bun run db:generate
bun run db:migrate
```

Include the generated migration in your PR and mention any rollout implications.

### Be careful with user runtime boundaries

Finn is multi-user internally even if the product is a personal companion. User-scoped services should be resolved through the runtime system, not manually reconstructed in feature code.

In general:

- Do not derive workspace roots ad hoc
- Do not instantiate memory or MCP resources outside the runtime boundary
- Do not bypass process-specific runtime views for file or tool access

### Keep tools and integrations scoped

Tool exposure in Finn is intentionally gated. Do not expose new tools, MCP servers, or connector capabilities unless the relevant runtime is explicitly allowed to use them.

This matters especially for Composio, Puter, Pattern management, and read-oriented automation flows.

### Web changes should hold up on mobile

The web app is the dashboard for profile, connectors, My Day, patterns, and recent Pattern run history. If you change UI behavior, test both desktop and mobile layouts.

Include screenshots or a short recording in the PR when that will speed up review.

## Testing and Validation

Run the smallest set of checks that fully cover your change, and include the exact commands in the PR.

Common validation commands:

```bash
bun run check
bun run test
bun run build
```

When relevant, also run:

```bash
bun run docs:validate
bun run docs:broken-links
```

Expected validation by change type:

- TypeScript or runtime logic: `bun run check` and relevant tests
- Web UI: `bun run build` plus manual desktop and mobile verification
- Docs: `bun run docs:validate` and `bun run docs:broken-links` when links or navigation changed
- Database schema: migration generation plus a local migration run
- Prompts or identity: manual verification of the affected behavior

There is no ESLint or Prettier setup in this repo. Clarity, strict TypeScript, focused tests, and small diffs matter more than style-only churn.

## Documentation

If your change affects behavior that users or operators need to understand, update the docs in the same PR.

Useful entry points:

- `README.md`
- `docs/guides/quickstart.mdx`
- `docs/guides/project-structure.mdx`
- `docs/concepts/architecture.mdx`
- `docs/operations/configuration.mdx`
- `docs/operations/deployment.mdx`

## Pull Requests

Use one of the PR templates in `.github/PULL_REQUEST_TEMPLATE/`.

Good PRs for Finn are:

- Small enough to review in one pass
- Explicit about which runtime surfaces changed
- Clear about risk, rollout notes, and validation
- Backed by focused tests or manual verification

Please include:

- A short explanation of the problem and the chosen fix
- The key files or flows reviewers should inspect first
- Exact validation commands you ran
- Screenshots, logs, or traces when helpful
- Links to any related GitHub issues or discussions

Conventional commit messages are preferred but not required for outside contributors.

## Security and Secrets

- Never commit `.env` files, API keys, credentials, or connector secrets
- Be careful with logging around auth, tokens, and user data
- Treat connector, memory, and file-access changes as security-sensitive
- Do not weaken gating around dangerous or irreversible actions without clear justification

If your PR changes authentication, external tool access, file access, or user data handling, call that out clearly in the PR description.

## Good First Areas to Contribute

If you are new to the codebase, these are usually the safest places to start:

- Docs and setup clarifications
- Focused bug fixes with a clear reproduction
- Small web dashboard improvements
- Test coverage for existing behavior
- Prompt or tool wording fixes with a clear behavioral goal

## Questions

If something is unclear, open an issue or discussion before making a large change. A short alignment step up front is usually the fastest path to a successful PR.
