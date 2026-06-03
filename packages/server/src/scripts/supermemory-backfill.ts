Bun.argv.splice(2, 0, "--provider", "supermemory");
await import("./memory-backfill.js");

export {};
