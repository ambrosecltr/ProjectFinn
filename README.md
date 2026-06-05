![Finn hero](assets/finn_hero.png)

# Finn

Finn is a personal AI intelligence that lives in iMessage. It is built to move with a real life: texting naturally, remembering what matters, handling work in the background, and running recurring automations without turning into another dashboard you have to babysit.

Finn is part of the [Personal Intelligence Project](https://personalintelligenceproject.com): intelligence that moves with a life, not against it.

## What Finn Does

- **Texts from iMessage** through [Photon Spectrum](https://docs.photon.codes/spectrum-ts/getting-started.md), so the main interface is the conversation you already use.
- **Responds quickly** with a hot-path agent for normal messages.
- **Delegates longer work** to background workers for web research, files, connected apps, creative tools, and other slow tasks.
- **Runs Patterns** for scheduled and connector-triggered automations.
- **Remembers over time** through Finn's own Postgres-backed context plus optional provider-backed memory. The recommended setup uses Hindsight.
- **Connects to your tools** through Composio, MCP, and the Puter macOS companion app.
- **Includes a web dashboard** for profile, connectors, Patterns, My Day, and recent automation runs.

## What Makes Finn Different

Finn is not just a chat prompt wrapped around iMessage. A lot of the work is in the unglamorous parts: context hygiene, tool access, memory boundaries, and prompt iteration.

- **A deeply tuned identity**: Finn's identity and behavior prompts have gone through more than 300 iterations. The goal is not just "friendly assistant"; it is a companion that knows when to be casual, when to delegate, when to ask, when to stay quiet, and how to feel natural in text.
- **Toolsets instead of tool dumps**: most worker capabilities are exposed as typed Finn JS workspace APIs inside Secure Exec, such as `finn.files.*`, `finn.patterns.*`, and Puter toolsets. Native tools still exist where they make sense, especially on the hot path, but broad worker capabilities are routed through scoped toolsets.
- **Deferred context loading**: Finn does not dump every tool description and every possible integration into the model's context window. Workers can search, inspect, and load the APIs or docs they need when they need them, which keeps prompts smaller and makes long tasks less brittle.
- **My Day**: a daily planning surface that summarizes the day, carries open todos forward, keeps source-backed evidence, and can hand work back into the iMessage conversation.
- **Personal Intelligence**: connector-scoped ingestion that builds durable user understanding from opted-in sources. It uses memory recall and source ledgers for dedupe, then retains concise facts rather than raw connector dumps.
- **Patterns**: user-scoped automations for scheduled or trigger-driven work, with persisted run history, notify rules, connector scope, and structured setup confirmations.
- **Secure multi-user hosting**: Finn is single-companion by feel, but the app is built with tenant/user-scoped runtimes, per-user workspaces, scoped connector access, and allowed-number provisioning. You can run it for yourself, or set it up for friends and family without everyone sharing one messy global context.
- **Prompt-budget discipline**: hot-path conversation history is compacted, runtime context is wrapped in explicit internal envelopes, large worker outputs spill into artifacts, and optional memory recall is capped and fail-open.

## Recommended Setup

The easiest production-like path is Docker Compose with bundled Postgres and Hindsight memory:

```bash
git clone <repo-url>
cd <repo-dir>
cp .env.example .env
```

Edit `.env`, then start Finn with Hindsight:

```bash
docker compose -f docker-compose.hindsight.yml up -d --build
```

For a public Cloudflare Tunnel in the same stack:

```bash
docker compose -f docker-compose.hindsight-cloudflared.yml up -d --build
```

The compose files use Docker `expose` rather than fixed host ports, which works well on managed hosts such as Dokploy. Route your proxy to service `finn` on container port `3000`. If you are running locally and need direct host access, use `docker-compose.dev.yml` or add a small local override with `ports: ["3000:3000"]`.

## Required Configuration

At minimum, set these values in `.env`:

```env
PUBLIC_URL=https://your-finn-domain.example

SPECTRUM_PROJECT_ID=your-spectrum-project-id
SPECTRUM_PROJECT_SECRET=your-spectrum-project-secret
SPECTRUM_ALLOWED_NUMBERS=+15551234567

DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=anthropic:claude-sonnet-4-20250514
DEFAULT_API_KEY=your-provider-api-key

HINDSIGHT_API_LLM_API_KEY=your-hindsight-llm-key
```

For OpenAI-compatible endpoints, use `DEFAULT_PROVIDER=openai-compatible`, set `DEFAULT_MODEL=openai-compatible:<model-name>`, and set `DEFAULT_BASE_URL` to the endpoint base URL including `/v1`. `DEFAULT_API_KEY` is optional only when that endpoint does not require authentication. Finn defaults `LLM_FORCE_TOOL_CHOICE` to `false` for OpenAI-compatible models because some gateways reject required tool choice while still accepting optional tool calls.

The Hindsight compose file sets these container values for Finn automatically:

```env
MEMORY_PROVIDER=hindsight
HINDSIGHT_BASE_URL=http://hindsight:8888
```

Useful optional settings:

| Variable | Use |
| --- | --- |
| `POSTGRES_PASSWORD` | Password for the bundled Finn Postgres database. Defaults to `finnpass`; change it outside local demos. |
| `MEMORY_MODE` | `hybrid` injects compact recall and exposes memory tools. `context` injects recall only. `tools` exposes tools only. |
| `HINDSIGHT_API_LLM_PROVIDER` | Hindsight LLM provider. Defaults to `groq` in the compose file. |
| `HINDSIGHT_API_LLM_MODEL` | Hindsight LLM model. Defaults to `openai/gpt-oss-120b`. |
| `HINDSIGHT_CP_DATAPLANE_API_URL` | Public Hindsight API URL when exposing the Hindsight dashboard/API through a reverse proxy. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Required when using `docker-compose.hindsight-cloudflared.yml`. |
| `ADMIN_BEARER_TOKEN` | Protects admin endpoints. Recommended for deployed instances. |

See [Configuration](docs/operations/configuration.mdx), [Deployment](docs/operations/deployment.mdx), and [Hindsight Memory Operations](docs/operations/hindsight-memory.mdx) for the full reference.

## After Boot

1. Point your public route or tunnel at Finn on port `3000`.
2. Make sure `PUBLIC_URL` exactly matches that public HTTPS URL.
3. Configure Spectrum with your project credentials and allowed phone numbers.
4. Open the web dashboard at `PUBLIC_URL` to review profile, connectors, Patterns, and My Day.
5. Text Finn from an allowed number.

Spectrum iMessage ingress uses the long-lived Spectrum message stream. Finn does not require a Spectrum webhook for inbound messages.

If you enable Composio-backed connectors or event-triggered Patterns, set:

```env
COMPOSIO_API_KEY=your-composio-key
COMPOSIO_CALLBACK_URL=https://your-finn-domain.example/connectors
COMPOSIO_WEBHOOK_SECRET=your-webhook-secret
```

Then set the Composio webhook subscription URL to:

```text
https://your-finn-domain.example/webhooks/composio
```

## Web App

![Finn web app](assets/web_app_hero.png)

Finn's web app is the control surface around the iMessage companion. Use it to set profile details, manage connectors, review My Day, create and edit Patterns, inspect recent Pattern runs, and jump back into texting Finn from the right Spectrum line.

The app lives in `packages/web` and is built with Vite and React. In Docker deployments, it is built into the Finn server bundle and served from the same `PUBLIC_URL`.

```bash
bun run web:dev
bun run web:build
```

Small design footnote: Finn's web app is [heavily inspired by Poke by The Interaction Company](https://poke.com). Massive shoutout to The Interaction Company. Please don't sue us.

## Puter

Puter is Finn's macOS companion app. It pairs a user's Mac with Finn so Personal Intelligence can inspect local-only sources such as iMessage and Notes, with the user's permission, through live commands.

The first Puter slice is intentionally narrow: pair the Mac app, expose iMessage and Notes toggles, let opted-in Personal Intelligence runs inspect those sources while the Mac app is online, and retain only selected durable understanding through the normal memory path. It is not a general computer-control layer, and it does not batch-upload local records to the server.

Puter lives in `packages/puter` as a Tauri menu bar app. See [Puter](docs/features/puter.mdx) for setup, permissions, and build notes.

## Local Development

Install dependencies with Bun:

```bash
bun install
```

Run Finn directly against a local Postgres:

```bash
docker compose up postgres -d
bun run db:push
bun run dev
```

Or run the local development compose stack:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Common commands:

| Command | Description |
| --- | --- |
| `bun run dev` | Start the server with hot reload |
| `bun run start` | Start the server in production mode |
| `bun run build` | Build the web app and bundle the server |
| `bun run check` | Type-check all packages |
| `bun run test` | Run the Bun test suite |
| `bun run db:generate` | Generate Drizzle migrations |
| `bun run db:migrate` | Run pending migrations |
| `bun run db:push` | Push schema changes directly |
| `bun run web:dev` | Run the web dashboard dev server |
| `bun run docs:dev` | Preview the docs locally |

## How It Works

```text
iMessage
  <-> Spectrum
  <-> Finn Server
        |-- Hot-path agent
        |-- Background workers
        |-- Pattern scheduler
        |-- Runtime services
        |     |-- files
        |     |-- memory
        |     |-- Composio
        |     |-- MCP
        |     `-- Puter
        `-- Postgres
```

The hot-path agent handles the live conversation. Workers handle slower or tool-heavy tasks. Patterns store scheduled and connector-triggered automations. Postgres stores users, profile context, conversations, files, workers, Patterns, Pattern runs, and My Day. Hindsight adds provider-backed long-term recall and Finn-managed mental models.

## Repository Map

```text
identity/             Finn's personality and voice prompts
prompts/              Agent process instructions
docs/                 Mintlify documentation
docker/               Container entrypoint and sandbox image
packages/core/        Shared config, types, logger, event bus, utilities
packages/db/          Drizzle schema and Postgres client
packages/llm/         Provider-agnostic LLM layer
packages/agents/      Hot-path, worker, and compactor agents
packages/tools/       Hot-path and worker tool definitions
packages/toolsets/    Finn JS workspace toolsets
packages/messaging/   Spectrum adapter, routing, and sender
packages/media/       STT, TTS, storage, and attachment processing
packages/patterns/    Pattern store, scheduler, and run history
packages/runtime/     User and process runtime boundaries
packages/integrations/ External services: Hindsight, Composio, MCP, Exa/Parallel web, Fal
packages/web/         Vite/React dashboard
packages/puter/       Tauri macOS companion app
packages/server/      Hono server, routes, startup, and event wiring
```

## Documentation

- [Quickstart](docs/guides/quickstart.mdx)
- [Architecture](docs/concepts/architecture.mdx)
- [Agents](docs/concepts/agents.mdx)
- [Memory](docs/concepts/memory.mdx)
- [Connectors and Patterns](docs/features/connectors-and-patterns.mdx)
- [Personal Intelligence and My Day](docs/features/personal-intelligence-and-my-day.mdx)
- [Configuration](docs/operations/configuration.mdx)
- [Deployment](docs/operations/deployment.mdx)
- [Hindsight Memory Operations](docs/operations/hindsight-memory.mdx)

Contributor workflow notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Tech Stack

- [Bun](https://bun.sh) and TypeScript
- [Hono](https://hono.dev)
- [Vercel AI SDK](https://sdk.vercel.ai)
- [PostgreSQL](https://www.postgresql.org) and [Drizzle ORM](https://orm.drizzle.team)
- [Photon Spectrum](https://docs.photon.codes/spectrum-ts/getting-started.md)
- [Hindsight](https://github.com/vectorize-io/hindsight) for the recommended memory setup
- [Composio](https://composio.dev), MCP, and PostHog telemetry where configured

## License

Finn is open source software licensed under the GNU Affero General Public License version 3 or later. See [LICENSE](LICENSE) for the full license text and [NOTICE](NOTICE) for project attribution.

Hosted or modified versions of Finn must comply with the AGPL, including the source availability requirements for network services.

---

Built by the [Personal Intelligence Project](https://personalintelligenceproject.com).
