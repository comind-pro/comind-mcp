# Build context = repo root (needs pnpm-lock.yaml + workspace manifests).
# DigitalOcean App Platform: set dockerfile_path: server/Dockerfile

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app

# Install deps with the lockfile. Copy only manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter comind-server...

# Build the server (tsc -> dist).
COPY server ./server
RUN pnpm --filter comind-server build

# Produce a self-contained prod bundle (dist + drizzle + prod node_modules).
RUN pnpm --filter comind-server deploy --prod /app/out

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
# Self-contained bundle: dist/, drizzle/, node_modules/, package.json.
COPY --from=build /app/out ./
EXPOSE 8787
# runMigrations() resolves <cwd>/drizzle -> /app/drizzle ✓
CMD ["node", "dist/index.js"]
