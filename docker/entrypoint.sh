#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
bun run db:migrate
echo "[entrypoint] Database migrations complete."

echo "[entrypoint] Starting Finn server..."
exec bun run packages/server/src/index.ts
