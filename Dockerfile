FROM node:25-bookworm-slim AS node-runtime

FROM oven/bun:1 AS base
WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends \
  libatomic1 \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
ENV NODE_ENV=development
COPY package.json bun.lock ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/agents/package.json packages/agents/
COPY packages/tools/package.json packages/tools/
COPY packages/toolsets/package.json packages/toolsets/
COPY packages/runtime/package.json packages/runtime/
COPY packages/messaging/package.json packages/messaging/
COPY packages/media/package.json packages/media/
COPY packages/patterns/package.json packages/patterns/
COPY packages/integrations/package.json packages/integrations/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

FROM deps AS development
WORKDIR /app
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["bun", "run", "dev"]

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  ffmpeg \
  git \
  libheif-examples \
  libreoffice \
  ocrmypdf \
  poppler-utils \
  tesseract-ocr \
  tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN bun run web:build
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && mkdir -p /data/logs /data/workspaces
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
