# Puter Notes

Use this read-only Finn JS workspace API namespace to inspect Apple Notes from the user's paired Mac when this run has live Puter access. Calls run through `finn.puter.notes.*` against the active paired Mac. Notes are private, user-authored material; inspect narrowly and only for the task at hand.

## Finn JS workspace API shape

Use the typed APIs discovered by `workspace_search`:

```js
await finn.puter.notes.listNotes({ limit: 25 });
await finn.puter.notes.searchNotes({ query: "Project Atlas", limit: 25 });
await finn.puter.notes.getNote({ noteId: "note_123" });
await finn.puter.notes.listNotes({ modifiedAfter: "2026-05-01T00:00:00.000Z", cursor: "25" });
```

The runtime validates input objects and rejects unknown fields.

## APIs

- `finn.puter.notes.listNotes({ limit, cursor, modifiedAfter })`
  Start here for broad coverage. It returns note IDs, titles, modified timestamps, and folders without note bodies.
- `finn.puter.notes.searchNotes({ query, modifiedAfter, limit, cursor })`
  Search note titles, bodies, folders, and IDs for people, projects, preferences, responsibilities, routines, places, and long-lived constraints. Results include bounded excerpts.
- `finn.puter.notes.getNote({ noteId })`
  Fetch a specific note when its title or excerpt suggests durable context.

`listNotes` and `searchNotes` accept `limit` and optional `cursor`. When a result includes `nextCursor`, call the same API again with `cursor: nextCursor` to continue that result set.

You can run independent reads back to back when useful, for example a broad note list plus a targeted note search. Do not batch a follow-up API call that depends on the previous result's IDs or cursor.

## Guidance

- For Personal Intelligence runs, preserve source provenance in retained memory: `toolkitSlug: "puter"`, `sourceType: "notes"`, `sourceId`, timestamp, title, and useful flat metadata like `folder`. General workers should cite relevant note titles/IDs in their outcome when useful, not retain memory directly.
- For Personal Intelligence retains, use the server-provided durable Puter account scope `puter:local`. Treat `puter:<deviceId>` as live bridge transport only; do not derive account identity from Mac names, device IDs, Notes accounts, Apple IDs, or iCloud aliases.
- Do not stop on the first page of a relevant result set while `nextCursor` is present; keep paging until coverage is sufficient or the category is exhausted.
- Treat Notes as authored-by-user evidence, but do not overgeneralize from drafts, checklists, or stale notes.
- Retain stable self-knowledge: preferences, project directions, household details, recurring obligations, relationship context, health/care constraints, locations, and long-lived plans.
- Skip raw journal-like detail unless it clearly contains durable context Finn needs. Keep sensitive retained summaries narrow and factual.
- If a note looks important but the excerpt is insufficient, use `get_note` before retaining.
