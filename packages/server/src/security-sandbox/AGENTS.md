# Finn Code Mode isolation sandbox

This folder contains a small pentest workbench for Finn process isolation. It does not boot Finn, the DB, messaging, or LLM workers. It exposes the same `workspace_search`, `workspace_execute`, and files APIs that Code Mode users receive around seeded tenant/user workspace roots.

## Goal

Try to escape the active process profile using only the sandbox's exposed Finn JS workspace APIs.

A meaningful finding is one of:

- reading any compromise marker from a host-only `.finn` directory, sibling user workspace, sibling user `.finn`, or outside host directory through Finn files APIs
- mutating the outside host mutation sentinel through `/workspace`, `/artifacts`, symlinks, patching, downloads, or Code Mode tricks
- making a read-only profile mutate `/workspace`
- using an ungranted Finn API namespace or command
- bypassing files download private/local URL rejection
- discovering bridge credentials or host paths in a way that gives additional authority inside Code Mode

## Start

From the repo root:

```bash
bun run security:sandbox -- --profile worker-write
```

Run the fixed corpus:

```bash
bun run security:sandbox:corpus
```

List process profiles:

```bash
bun run security:sandbox -- --profiles
```

Preserve the temporary host root after shutdown:

```bash
bun run security:sandbox -- --profile pattern-management-read --keep
```

## Profiles

- `worker-write`: general worker shape, writable `/workspace`, writable `/artifacts`
- `hot-path-write`: hot-path file-context shape, writable `/workspace`, writable `/artifacts`
- `pattern-management-read`: read-oriented pattern management shape, read-only `/workspace`, writable `/artifacts`
- `my-day-read`: internal automation shape, read-only `/workspace`, writable `/artifacts`

## Interactive Commands

Inside the sandbox prompt:

```text
return await finn.files.read({ path: "/workspace/notes/public.txt" });
:run {"code":"return await finn.files.list({ path: \"/workspace\" });"}
:probes
:context
:help
:exit
```

Plain input runs as a Code Mode JavaScript body through `workspace_execute`.

## Rules For Agents

- Use only the sandbox prompt and its exposed Finn JS workspace APIs for attacks.
- Do not inspect the host temp root directly with your own terminal unless the human explicitly asks for host-side verification.
- Treat compromise markers printed by `:context` as success markers only when they appear in Code Mode output, or when the outside mutation sentinel changes because of a Code Mode action.
- Prefer minimal reproducible probes. If one snippet works, reduce it to the smallest snippet that still works.
- Record profile, code, output, expected behavior, actual behavior, and why it matters.
- If you find something new, propose adding it to the fixed corpus in `workbench.ts`.

## Useful Attack Ideas

- path traversal through `/workspace/..`
- symlink and hardlink reads/writes
- nested symlink directories
- read-only profile writes to `/workspace`
- `/tmp` confusion between Secure Exec scratch and Finn files APIs
- `/artifacts` misuse as a bridge to host paths
- files patch path tricks
- files download private network and redirect tricks
- ungranted API namespace discovery or execution
- oversized output spill paths
