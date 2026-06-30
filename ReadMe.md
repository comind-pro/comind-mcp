# comind-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Repository: **https://github.com/comind-pro/comind-mcp**

**MCP gateway** — connects various MCP servers and REST APIs, lets you curate and combine tools, organize them into **groups** (each = a separate virtual MCP server with a single endpoint) and hand them out to agents. An agent sees only the narrow set of tools assigned to it and can **schedule its own crons** through MCP.

Self-hosted: a single Node service + Postgres. Multi-user with per-account isolation.

```
Source (mcp │ openapi │ http) ──import──▶ Tool (native │ composite, curated)
                                              │
Group = virtual MCP ◀──toolset[]──────────────┘   + built-in self-cron tools
   └─▶  /g/:groupId/mcp   (Streamable HTTP, single endpoint)
            └─▶ Agent (Bearer key) — only granted V-MCPs, schedules itself
Vault (${secret.X}) · Scheduler · CallLog / Metrics
```

---

## Quick start

Prerequisites: Node 20+, pnpm 9 (`corepack enable`), Docker (local Postgres).

```bash
make setup        # install deps, start Postgres, apply migrations
make dev          # Postgres + server :8787 + web :5173
```

- **Web UI** — http://localhost:5173 (register an account, then sign in)
- **Gateway + Control API** — http://localhost:8787 (`GET /healthz`)
- **Postgres** — runs in Docker (`docker compose`); repo `.env` maps host port `5434`

See `make help` for all targets. Underlying pnpm scripts (`pnpm dev`, `pnpm dev:server`, `pnpm dev:web`) still work but don't manage the Postgres container.

### Database modes

The store is selected by the `DATABASE_URL` scheme — same schema, same migrations:

| `DATABASE_URL` | Mode | Use for |
| --- | --- | --- |
| `postgres://…` | External **Postgres** | Production, multi-instance (horizontal scale). |
| `file:/data/comind` | Embedded **Postgres (PGlite)** | Zero-infra self-host, single container, demos, Glama. |
| `memory:` | Embedded, in-memory | Throwaway / CI smoke. |

PGlite *is* Postgres (WASM), so everything (jsonb, `percentile_cont`, migrations) runs unchanged — no external DB process. **Persistence:** the `file:` directory is a real Postgres data dir; mount it as a volume (e.g. `/data`) to keep data across releases. Migrations are additive and idempotent, so an upgrade never wipes existing data. Embedded mode is single-node (no multi-instance — one writer).

```bash
# zero-infra: no Docker/Postgres needed
DATABASE_URL=file:/data/comind SERVER_ENV=dev pnpm --filter comind-server start
```

---

## End-to-end scenario

1. **Sources** → add a source (MCP proxy, OpenAPI, or HTTP) → **Test** → **Import tools**.
2. **Tools** → rename / hide the unnecessary / assemble a **composite** (an intent tool from several calls).
3. **Groups** → create a group → mark the toolset (checkboxes) → (optional) add a schedule.
4. **Agents** → create an agent in the group → get an **API key (once)** + MCP **endpoint**.
5. Connect any MCP client to `http://localhost:8787/g/<groupId>/mcp` with `Authorization: Bearer <key>`. The client sees only the group's toolset (+ self-cron tools).
6. **Logs** → calls, metrics, errors.

---

## Concepts

| Term | What it is |
|---|---|
| **Source** | Upstream: another MCP server (proxy), a REST API (OpenAPI 3.x → tools), or an HTTP service with explicit endpoints |
| **Tool** | A single call. `native` (proxied from a source) or `composite` (a saved multi-step intent) |
| **Composite** | Deterministically runs several calls and assembles a single result (output template, `$.input.*`/`$.steps.ID.*`) |
| **Group** | A virtual MCP server: a curated set of tools, exposed as a single endpoint `/g/:groupId/mcp` |
| **Agent** | A consumer bound to a group via an API key. Sees only the group's toolset |
| **Self-cron** | MCP tools `schedule_task` / `list_schedules` / `cancel_schedule` inside a group — the agent schedules itself |
| **Secret** | An encrypted credential (AES-256-GCM) or an env reference. Substituted at runtime via `${secret.NAME}`; the agent never sees it |

---

## API (Control Plane, REST on :8787)

```
GET  /healthz
# sources
POST/GET /sources          GET/PATCH/DELETE /sources/:id
POST /sources/:id/test     POST /sources/:id/import
# tools
GET /tools  (?sourceId&kind&visible)   GET/PATCH/DELETE /tools/:id
# composites
POST/GET /composite-tools  GET/DELETE /composite-tools/:id   POST /composite-tools/:id/run
# groups
POST/GET /groups           GET/PATCH/DELETE /groups/:id
GET/PUT /groups/:id/tools
# agents
POST/GET /agents           GET/DELETE /agents/:id            POST /agents/:id/rotate-key
# schedules
POST/GET /groups/:id/schedules    DELETE /schedules/:id
POST /schedules/:id/run           GET /schedules/:id/runs
# secrets (metadata only; value/ciphertext is NEVER returned)
POST/GET /secrets          DELETE /secrets/:id
# observability
GET /logs (?groupId&agentId&toolName&status&limit)   GET /metrics
GET /agents/:id/inspect    POST /agents/:id/invoke
```

## Gateway (for agents, MCP)

```
POST /g/:groupId/mcp   — Streamable HTTP endpoint (Authorization: Bearer <agent-key>)
```
SSE transport — planned.

---

## Structure

| Path | Purpose |
|---|---|
| `server/` | Node service (Fastify + MCP SDK + Drizzle/Postgres) — control API + gateway |
| `server/src/connectors/` | MCP proxy · OpenAPI→tools · HTTP connectors |
| `server/src/composite/` | Composite engine (intent tools) |
| `server/src/runtime/` | `invokeTool` — shared runtime (gateway / composite / scheduler) |
| `server/src/gateway/` | Group's virtual MCP server + agent auth |
| `server/src/scheduler/` | node-cron registry + JobRun + self-cron |
| `server/src/secrets/` | Vault (AES-256-GCM) + `${secret.X}` injection |
| `server/src/routes/` | REST endpoints |
| `server/src/db/` | Drizzle schema + pg client (Postgres) |
| `web/` | Web UI (Vite + React) — Sources / Tools / V-MCP / Agents / Secrets / Logs |

Development details — [DEVELOPMENT.md](DEVELOPMENT.md).

---

## Security

- Secrets are encrypted at-rest (AES-256-GCM); the agent/config see only the `${secret.NAME}` placeholder, the value is substituted at runtime.
- An agent gets only its group's toolset; calls are gated by toolset on every request.
- API keys are stored as an sha256 hash, the token is shown once.
- A failure of one upstream does not bring down the endpoint (fault isolation in the runtime).

## Modules & features

Built iteratively, module by module. Everything below is implemented and working.

### Core gateway
- ✅ **Connectors** — proxy an existing MCP server, import a REST API from OpenAPI 3.x (own parser → tools), or wire an HTTP service with explicit endpoints.
- ✅ **Tool registry & curation** — import tools, rename, edit descriptions, toggle visibility, per-owner unique names.
- ✅ **Composite engine** — intent tools that run several calls in sequence; conditional `when`; templating (`$.input.*`, `$.steps.ID.text`); output template; per-step **trace** for tuning.
- ✅ **Shared runtime** (`invokeTool`) — one dispatcher for gateway, composites and scheduler; native→connector, composite→recursion (depth-limited); fault isolation (a bad upstream never crashes the caller).
- ✅ **Groups = virtual MCP** — bundle curated tools into a single MCP endpoint `/g/:groupId/mcp` (Streamable HTTP).
- ✅ **Agents** — consumer identities with one API key (sha256-hashed, shown once) + key rotation.
- ✅ **Agent ↔ V-MCP grants (M2M)** — grant/revoke access per group; one agent can reach many group endpoints; the key only works for granted groups.

### Scheduling
- ✅ **Scheduler** — cron registry (node-cron), JobRun log, run-now, loaded on boot.
- ✅ **Self-cron over MCP** — built-in `schedule_task` / `list_schedules` / `cancel_schedule` tools inside a group; a connected agent schedules itself.

### Secrets & auth-to-upstreams
- ✅ **Vault** — credentials encrypted at rest (AES-256-GCM); injected at runtime via `${secret.NAME}`; agents/config never see the value.
- ✅ **Source-scoped secrets** — same name can exist per source; scoped overrides global.
- ✅ **Static auth** — bearer/api-key/custom headers, basic (username/password).
- ✅ **Dynamic token flows** — `oauth2_client_credentials`, `token_request` (login→JSON-path), `oauth2_refresh` (cached + auto-refresh).
- ✅ **User OAuth** — `oauth2_authorization_code` (Connect flow) and **MCP-native OAuth** (`mcp_oauth`: SDK discovery + DCR + PKCE + refresh, with optional pre-registered `clientId`).

### Accounts & isolation
- ✅ **Auth** — email/password (scrypt) + HS256 session JWTs; register / login / me.
- ✅ **Multi-user isolation** — every resource is owned by a user; all routes scoped by owner; tools resolve only within the owner's namespace. No cross-account access.

### Observability
- ✅ **Call logs** — who/which tool/status/duration/token estimate per invocation.
- ✅ **Metrics** — totals + by-tool + by-agent.
- ✅ **Inspector & test-invoke** — see what an agent sees per granted V-MCP; run any tool to view the raw response.

### Web UI (Vite + React)
- ✅ **Auth** — login / register, token gating, logout.
- ✅ **Form ⟷ JSON builders** for sources and composites (edit a form or the raw JSON, two-way).
- ✅ **Inline secrets** in the source wizard (scoped to the source).
- ✅ **Grouped, collapsible, searchable** tool picker & registry (scales to large imported APIs).
- ✅ **Connect snippets** per V-MCP (`claude mcp add …`, curl) with copy buttons.
- ✅ Tabs: Sources · Tools · V-MCP · Agents · Secrets · Logs.

### Infrastructure
- ✅ **Postgres** via Drizzle (migrations auto-applied on boot).
- ✅ **Docker Compose** for local Postgres + **Makefile** (`make setup` / `make dev` / `make db-*`).
- ✅ `.env` loading, generated dev secrets.

### Not yet (optional next)
- ⬜ Org / project layer (teams, sharing).
- ⬜ SSE transport on the gateway (Streamable HTTP only today).
- ⬜ Hot-reload `tools/changed` notifications.
- ⬜ OpenAPI endpoint for a toolset; traces.

---

## Production readiness

The core is solid; the production hardening is not done yet. Roughly **60–65%** — usable for an internal/trusted, single-instance deployment after the quick fixes below; **not** ready for public, untrusted, multi-tenant SaaS until the blockers are closed.

### 🔴 Blockers
1. **Rate limiting — mostly missing.** Executable virtual tools are now rate-limited per owner (in-memory or shared via Postgres) and SSRF-guarded, but `/auth` (password brute-force), the gateway (abuse) and per-agent quotas still aren't. Critical for any public exposure.
2. **Timeouts — partial.** Executable virtual tools now run with a 15s timeout + `AbortController` (and a connect-time SSRF pin). Remaining: connector upstream calls (GA / HTTP / OpenAPI / MCP `fetch`) still run without an explicit per-call timeout → a hung upstream can hang the request.
3. **Scheduler is not multi-replica safe.** In-memory cron → with more than one instance every schedule fires N times. Needs a distributed lock (Postgres advisory lock / a dedicated worker).
4. **Migrations run on every instance boot** — a race with multiple replicas. Move migrations to a separate deploy step.
5. **JWTs cannot be revoked.** A 7-day token can't be invalidated before it expires (logout is local-only); a leaked token stays valid for a week. Needs revocation, or short-lived access + refresh tokens.
6. **OAuth `state` is predictable** (`sourceId` / a hash) — a CSRF risk. Use a random nonce.
7. **TLS & secrets.** `VAULT_KEY` / `JWT_SECRET` live in env with no KMS or rotation; CORS defaults to `*`; no HTTPS (must sit behind a TLS reverse proxy).

### 🟡 Important
- No Dockerfile / CI (lint + test + build); no production web serving (Vite dev today — build & serve `dist` behind a CDN/proxy).
- No graceful shutdown (close the pool, drain in-flight requests, stop the scheduler).
- `call_logs` grow unbounded — no retention/cleanup; list endpoints have no pagination (thousands of tools).
- Thin tests — only pure modules. No automated route / auth / isolation / e2e tests in the repo (those were manual smokes). Scheduler has no retry/backoff/alerting.
- The OpenAPI parser is minimal — complex specs (`allOf`, deep `$ref`) may not parse correctly.
- No password reset / email verification; no user audit log.

---

## Distribution

Packaged as an **OCI image** (`ghcr.io/comind-pro/comind-mcp`) and listed in the
**official MCP Registry** (`registry.modelcontextprotocol.io`) — the canonical
source that downstream catalogs (PulseMCP, Smithery, Docker Hub, …) consume. The
metadata lives in [`server.json`](./server.json) under the GitHub-verified
namespace `io.github.comind-pro/comind-mcp`.

Run the image (zero-infra, embedded Postgres):

```bash
docker run -p 8787:8787 -v comind-data:/data \
  -e SERVER_ENV=dev ghcr.io/comind-pro/comind-mcp:latest
# prod: drop SERVER_ENV=dev and set VAULT_KEY + JWT_SECRET
```

Releasing is automated — push a version tag and CI ([`release.yml`](./.github/workflows/release.yml))
builds & pushes the image to GHCR, then publishes `server.json` to the registry
via GitHub OIDC (no tokens):

```bash
git tag v0.2.0 && git push origin v0.2.0
```

> Note: ComindMCP is a multi-tenant **gateway** (HTTP MCP at `/g/:slug/mcp`, agent-key auth),
> not a single stdio server — registry clients self-deploy it and connect their own agents.

---

## Contributing

**comind-mcp is open source** (MIT) and contributions are welcome — bug reports, features, docs, tests.

1. Fork & branch from `main` (`feat/...`, `fix/...`).
2. Set up locally — see [DEVELOPMENT.md](./DEVELOPMENT.md). TL;DR: `corepack enable && pnpm install`, then `pnpm dev`.
3. Before opening a PR: `pnpm typecheck` and `pnpm -r test` must pass.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for messages (`feat:`, `fix:`, `docs:`, `chore:`).
5. Open a PR against `comind-pro/comind-mcp` with a clear description; link any related issue.

Questions or ideas? Open an [issue](https://github.com/comind-pro/comind-mcp/issues). See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## License

[MIT](./LICENSE) © comind — open source, free to use, modify, and distribute anywhere, including commercially.

Repository: https://github.com/comind-pro/comind-mcp