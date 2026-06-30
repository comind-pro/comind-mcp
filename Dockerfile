# ── build ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app

# Install server deps against the frozen lockfile (workspace-aware).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter comind-server...

# Build the server (tsc → server/dist).
COPY . .
RUN pnpm --filter comind-server build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
# Ties this OCI image to its MCP-registry server name (ownership verification).
LABEL io.modelcontextprotocol.server.name="io.github.comind-pro/comind-mcp"
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# Production-only deps (PGlite is a normal dep → embedded Postgres, no compiler).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --prod --filter comind-server...

# App + migrations.
COPY --from=build /app/server/dist ./server/dist
COPY server/drizzle ./server/drizzle

# Defaults: embedded Postgres persisted under /data (mount a volume to keep data
# across releases). For a non-dev SERVER_ENV the server requires VAULT_KEY +
# JWT_SECRET (fail-fast) — set them, or pass SERVER_ENV=dev for a quick start.
ENV DATABASE_URL=file:/data/comind \
    HOST=0.0.0.0 \
    PORT=8787
VOLUME /data
EXPOSE 8787

WORKDIR /app/server
CMD ["node", "dist/index.js"]
