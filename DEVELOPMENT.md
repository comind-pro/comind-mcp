# Developing `comind-mcp`

## Prerequisites
- Node 20+
- pnpm 9 (`corepack enable`)
- Docker (for the local Postgres container)

## First run

```bash
make setup        # install deps, start Postgres, apply migrations
make dev          # Postgres (if down) + server :8787 + web :5173
```

`make setup` runs `pnpm install`, `docker compose up -d postgres`, then applies migrations.
The server also applies migrations automatically on boot (`runMigrations`).

- Control API + Gateway: http://localhost:8787 — `GET /healthz` → `{ "status": "ok", "db": true }`
- Web UI: http://localhost:5173 (Vite listens on `localhost` / IPv6 — open `localhost`, not `127.0.0.1`)
- Postgres: `localhost:${POSTGRES_PORT:-5432}` (the repo `.env` uses `5434` to avoid a host Postgres on 5432)

## Make targets

```bash
make help         # list targets
make db-up        # start Postgres container
make db-down      # stop it
make db-reset     # drop volume + recreate + migrate (DESTRUCTIVE)
make db-generate  # generate SQL migrations from the Drizzle schema
make db-migrate   # apply migrations
make db-psql      # psql shell into the container
make dev          # Postgres + server + web (watch)
make build        # build server + web
make typecheck    # typecheck all packages
```

Underlying pnpm scripts (`pnpm dev`, `pnpm dev:server`, `pnpm dev:web`, `pnpm build`, `pnpm typecheck`) still work; they just don't manage the Postgres container.

## Structure

| Path | Purpose |
|---|---|
| `server/src/config.ts` | Env (loads `server/.env`) + defaults |
| `server/src/app.ts` | Fastify: CORS, auth guard, error-handler, route registration |
| `server/src/index.ts` | Boot: migrations → scheduler → listen |
| `server/src/db/{schema,client}.ts` | Drizzle schema (Postgres) + pg pool + auto-migrate |
| `server/src/lib/auth.ts` | scrypt password hash + HS256 JWT |
| `server/src/connectors/` | `mcp` (proxy), `openapi` (own 3.x parser), `http`; `index` = zod-config + factory |
| `server/src/composite/engine.ts` | `runComposite` — intent tools |
| `server/src/runtime/invoker.ts` | `invokeTool` — shared runtime + CallLog |
| `server/src/gateway/server.ts` | `authenticateAgent` + `buildGroupServer` (virtual MCP) |
| `server/src/scheduler/service.ts` | node-cron registry, `execute`→JobRun, self-cron CRUD |
| `server/src/secrets/{vault,loader}.ts` | AES-256-GCM + `${secret.X}` injection |
| `server/src/routes/` | sources · tools · composite · groups · agents · schedules · secrets · observability · gateway |
| `web/src/api.ts` | API client (`VITE_API_BASE`, default `http://127.0.0.1:8787`) |
| `web/src/tabs/` | Sources · Tools · Groups · Agents · Logs |

## Env

The server loads `server/.env` on boot (values already in the environment win).
See `server/.env.example` and the repo-root `.env.example` (Postgres / docker-compose vars).

Key items for prod:
- `DATABASE_URL` — Postgres connection string.
- `VAULT_KEY` — 32 bytes base64 (`openssl rand -base64 32`). The dev fallback is **unsafe**.
- `JWT_SECRET` — HMAC secret for session tokens. The dev fallback is **unsafe**.
- `PORT`, `HOST`, `CORS_ORIGINS`. Compose: `POSTGRES_USER/PASSWORD/DB/PORT`.

## Database

Postgres via Drizzle ORM (node-postgres). Local Postgres runs in Docker (`docker compose`).
Changing the schema:
1. edit `server/src/db/schema.ts`
2. `make db-generate` → a new file in `server/drizzle/`
3. `make db-migrate` (or just restart the server — it migrates on boot)

Inspect: `make db-psql`.

### Production
Point `DATABASE_URL` at a managed Postgres, set `VAULT_KEY` + `JWT_SECRET`, run migrations
(`pnpm --filter comind-server db:migrate` or boot the server), then `pnpm build` + `pnpm --filter comind-server start`.

## Roadmap (done)

G0 scaffold ✅ · G1 connectors+sources ✅ · G2 curation+composite ✅ · G3 groups ✅ ·
G4 gateway endpoint+agents ✅ · G5 self-cron+scheduler ✅ · G6 vault ✅ · G7 observability ✅ · G8 Web UI ✅.

Next (optional): org/project as a thin layer, SSE transport, hot-reload `tools/changed`, an OpenAPI endpoint for a toolset, OAuth/OIDC, traces, e2e scripts.
