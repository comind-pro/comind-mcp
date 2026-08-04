# comind-mcp — improvement plan & audit findings

_Generated 2026-07-02. Four parallel audits (auth/OAuth · gateway/runtime · REST/DB/CI · web). Critical items code-verified. Not committed._

## TL;DR

Isolation discipline is solid — **zero direct IDOR** across the control plane, agent keys shown-once and never re-fetchable, JWT verify is alg-confusion-safe, vault is AES-256-GCM, consent page HTML-escaped. The real risks are two verified criticals and a cluster of SSRF/lifecycle gaps:

1. **Empty-string secret env → silent dev-key fallback** (account takeover). Verified.
2. **Connector SSRF** — source connectors fetch owner-supplied URLs with no egress guard. Verified.

Fix P0 before promoting web connectors more widely.

---

## P0 — critical, fix now

### 1. Empty-string secret env silently loads public dev key
`server/src/config.ts:22-27` + `:77-84`. **Verified. STATUS: under discussion — not decided (2026-07-02).**
`env()` returns the fallback when the var is `undefined` **or** `''`; the prod fail-fast only checks `process.env[k] === undefined`. So `JWT_SECRET=""` / `VAULT_KEY=""` in prod (blanked DO secret, bad interpolation) boots on the repo-public dev key → anyone forges a JWT for any `sub` (full cross-tenant takeover) and decrypts the whole vault.
**Fix:** guard rejects empty/whitespace, and compares the *resolved* `config.jwtSecret`/`config.vaultKey` against the known dev constants — not just `undefined`. One change covers all secrets.

**Discussion (owner pushback + how prod/dev is decided):**
- Owner's position: the dev fallback is intentional (local dev convenience); prod operators are expected to set their own secrets. Fair — the finding is NOT "remove the fallback."
- The actual defect: a fail-fast guard *already exists* (config.ts:77, comment: "defaults are public in the repo — anyone could forge a JWT") — the author already decided "prod must not run on dev defaults." The guard just has a hole: catches `undefined`, misses `""`. So it's an inconsistency in existing protection, not a missing one. Missing var → refuses to start (works); empty var → boots on dev key (doesn't work).
- **How prod vs dev is determined:** `serverEnv = SERVER_ENV ?? NODE_ENV ?? 'dev'` (config.ts:49); guard fires when serverEnv ∉ {dev, test} (config.ts:77). Default is `dev`. Prod is flagged ONLY because `server/Dockerfile:23` sets `ENV NODE_ENV=production`, and DO builds server from that Dockerfile (`.do/app.yaml:31 dockerfile_path: server/Dockerfile`). `SERVER_ENV` is never set explicitly.
- **Fragility:** both "this is prod" and "secrets are valid" rest on implicit signals (one Dockerfile line + a non-empty env), not an explicit check. Deploy via buildpack instead of the Dockerfile, or change the base image, → serverEnv falls back to `dev`, guard silently disables, dev keys accepted with no error.
- Exploitability in the CURRENT DO setup: low — DO sets concrete non-empty secrets and NODE_ENV=production comes from the image. Owner considers `""` unlikely in their pipeline.
- **Options on the table (decide later):** (a) won't-fix, downgrade to P3/informational — accept the implicit-signal risk; (b) one-line guard fix (reject empty/whitespace + compare resolved value to dev constants); optionally also set `SERVER_ENV=production` explicitly in `.do/app.yaml` so "this is prod" stops depending on the image. **No decision yet.**

### 2. Connector SSRF — owner URLs fetched with no egress protection
`server/src/connectors/fetch.ts:13`, used by `openapi.ts:165,209`, `http.ts:50,61`, `ga.ts:83,105`. **Verified.**
The full SSRF stack (`assertSafeUrl`/`safeLookup`/`pinnedAgent`, blocks 169.254.169.254 + private ranges + DNS-rebinding) lives **only** in `runtime/virtual.ts`. Source connectors use bare `fetchWithTimeout` → plain global `fetch`. Reachable via `POST /sources/test`, `/sources/:id/objects`, `/sources/:id/import`, `system.context?live=true`, or any native tool call. Attacker source → `http://169.254.169.254/latest/meta-data/...` → cloud IAM creds exfiltrated.
**Fix:** extract `assertSafeUrl` + `pinnedAgent` into a shared `safeFetch`; route every connector outbound through it. Closes it in one place.

---

## P1 — high

3. **Prod deploys not gated on tests.** `.do/app.yaml:36,72` `deploy_on_push: true` — DO rebuilds `main` on every push independent of CI; a red build ships. `release.yml` publishes GHCR image + MCP registry on tag with no test step. **Verified.** → deploy step after CI passes, or required check before DO deploy.

4. **Scheduler runs tools after revoke.** `scheduler/service.ts:87-120` — `createSchedule` checks `toolInGroup` once; `execute()` never rechecks tool-in-group / visibility / agent grant. Removed tool or revoked agent keeps running under the owner. → recheck at execute time.

5. **Group gating only at gateway, not in runtime.** `runtime/invoker.ts:89-92` — `dispatch` resolves by `(name, ownerId)`; `groupId` is log-only. Scheduler + composite steps reach any owner tool regardless of group. → enforce group membership in `invokeTool`, or pass an explicit "cross-group allowed" flag.

6. **mcp_oauth CSRF: `state === sourceId`.** `auth/mcp-oauth.ts:49-50`, callback public (`routes/oauth.ts`). Stable id, not a per-flow secret → attacker who knows a victim's `sourceId` injects their own upstream tokens onto the victim's source. **Verified.** → random state in the `pending` map (generic flow already does this).

7. **Inbound refresh tokens: no absolute lifetime, no reuse detection.** `oauth-provider.ts:192-202` — rotation deletes the old row but a replay just "misses"; a leaked refresh token mints access forever, no signal. → absolute expiry + revoke-family-on-replay.

8. **DCR unauthenticated + agent-key-paste consent = phishable.** `oauth-provider.ts:90-112` — attacker DCRs own `redirect_uri`, phishes victim to real `/authorize`, victim pastes key, code+tokens go to attacker. → at minimum rate-limit/cap DCR; longer-term reconsider paste-key consent UX.

---

## P2 — medium

9. **OAuth token outlives its source agent key.** `gateway/server.ts:57-64` — `resolveBearer` checks agent exists + `expiresAt`, never the key's `archived`. Archiving a leaked key doesn't cut tokens minted from it. → store `agentKeyId` on `oauthAccessTokens`, check `archived`; add a `revoked` column (no kill-switch today).

10. **Token grant validates `client_id`/`redirect_uri` only if present; refresh grant never checks `client_id`.** `oauth-provider.ts:184-186` — any client redeems any stolen refresh token. → require + strictly match both.

11. **Tool-name sanitize collisions → wrong-tool dispatch / silent drop.** `gateway/server.ts` group `find` (`:292`) returns first DB-order match; agent-wide `index` (`:326-334`) first-key-wins drops the later tool. `foo.bar` vs `foo_bar` → agent calls a different, maybe mutating, tool. → collision check at tool registration (reject/merge when `mcpToolName` already exists for owner).

12. **OpenAPI `specCache` cross-tenant bleed + prefix collision + unbounded.** `openapi.ts:33,159` — global Map; inline specs keyed by 200-char prefix (collide → serve each other's ops); `specUrl` keyed without owner/headers (A's auth-gated spec served to B); never evicted. → LRU, key by `ownerId`+full-hash.

13. **Built-in tools shadow real group tools.** `gateway/server.ts:264,284` checked before group lookup (`:291`). A group tool named `schedule_task`/`system_context`/etc. is uncallable — built-in runs instead, silently. → detect collision at registration.

14. **`system.context?live=true` is a write + fan-out from a "read-only" tool.** `system-tools.ts:339-343,394` — any agent forces health pings to every source + `sources.status` writes; concurrent agents race; N-source amplifier. → rate-limit / make it explicitly non-read-only.

15. **Non-atomic group-tools replace.** `routes/groups.ts:120-122` — delete-all then insert, no transaction. **Verified.** Insert throws / crash between → group loses all tools; concurrent reader sees empty. → wrap in `db.transaction`.

16. **Migration 0007 dropped `groups.system_tools` with no backfill.** `drizzle/0007_*.sql:2` — feature moved to agents; existing group values lost irreversibly (0005 backfilled correctly, this didn't). → data-only; note for anyone restoring an old dump.

17. **CORS default `*` reflects any origin.** `config.ts:39` + `app.ts:24-26`. Bearer-auth (not cookies) limits blast radius; prod pins the domain. → closed allowlist default, fail-fast on `*` outside dev.

18. **Web: hardcoded `http://127.0.0.1:8787` API fallback.** `web/src/api.ts:1` — prod build without `VITE_API_BASE` → every call hits user's localhost + mixed-content block, no in-UI diagnosis. → default to same-origin `''` or fail the build when unset.

19. **Web: no error boundary.** `main.tsx` — one render/parse throw (e.g. malformed tool schema → recursive `parseInput`) whites out the whole app. → one top-level `<ErrorBoundary>`.

20. **Web: `JSON.parse` before the 401 check.** `api.ts:43-49` — non-JSON error body (proxy HTML, 502, CF interstitial) throws before the 401 branch → `tokenStore.clear()` never fires, user stuck with dead token + cryptic error. → branch on `res.status`/`res.ok` first, guard the parse.

---

## P3 — low / cleanup

21. **N+1 on hot lists.** `agents.ts:81-89` (3N+1 per `GET /agents`), `secrets.ts:57-63` (N per list). → `inArray` aggregate / join.
22. **No pagination on any list endpoint.** `tools/sources/groups/agents/composite/secrets` return full owner set; `GET /tools` worst (import → thousands). → cursor+limit.
23. **Check-then-insert races → 500 not 409.** `tools.ts:66`, `virtual.ts:77`, `composite.ts:44`, `secrets.ts:41`, `groups.ts` slug, `auth.ts` email. → `onConflictDoNothing().returning()` → 409 (pattern already in `sources.ts` import).
24. **Unvalidated date params.** `observability.ts:39,57` — `?from=garbage` → Invalid Date → `/metrics` 500. → `z.coerce.date()`.
25. **Schedule/composite tool refs by name, no FK.** `schema.ts` `schedules.toolName`, composite steps → dangling on rename/delete, fails only at execution.
26. **SQL connector: leading-keyword regex only.** `connectors/sql.ts:115` — `WITH x AS(...) DELETE` passes; real safety is `SET TRANSACTION READ ONLY` (`:134`). Enforce a read-only DB user; keep regex as defense-in-depth.
27. **DB TLS `rejectUnauthorized:false` unconditional.** `connectors/sql.ts:30` — MITM on tenant DB link undetectable. → only relax for known self-signed CAs.
28. **Source `config` stored plaintext, echoed in responses.** `sources.ts:36,55` — inline raw credential (vs `${secret.NAME}`) persists plaintext + returned every read. → reject inline secrets / mask on read.
29. **PKCE + token comparisons not constant-time.** `oauth-provider.ts:187` `!==`. Low (attacker supplies verifier) but it's a secret compare on the auth path. → `timingSafeEqual`.
30. **`verifyJwt` treats missing `exp` as non-expiring.** `lib/auth.ts:51` — `NaN < now` is false. Not forgeable without secret, but any future exp-less mint = eternal session. → `typeof exp === 'number'` guard.
31. **Outbound token-endpoint fetch has no timeout.** `auth/token-manager.ts:33,73,105` — hung upstream stalls the request. → `fetchWithTimeout`.
32. **Web nav/toggles are `<div onClick>`** — keyboard/AT inaccessible (`App.tsx:63,69,75`, seg toggles, `AuthPage.tsx:178`). → `<button>` / `role`+`tabIndex`.
33. **Web data-loading effects swallow errors** — `LogsTab`/`GroupsTab`/`AgentsTab` GETs reject silently → empty tab looks like "no data". → shared `useLoad(fn)` with error state.
34. **Web: `window.open` without `noopener`** (`SourcesTab.tsx:194`), duplicated clipboard/meta helpers (`AgentsTab.tsx`, `ToolsTab.tsx`). → add `noopener`; dedupe.

---

## Over-engineering to delete

- **Two rate limiters** in `runtime/virtual.ts` (in-memory `rlWindow` `:136` vs `rateLimitedPg` `:152`). Keep pg (multi-process correct), drop the memory path + its never-pruned map.
- **`withTimeout`** (`system-tools.ts:311`) reimplements a timeout race → `AbortSignal.timeout()`.
- Web: `Snip` vs `copy` (`AgentsTab.tsx:4-25` vs `:163`), `emptyMeta()` vs inline literal (`ToolsTab.tsx:132` vs `:161`) — authored twice, will drift.

---

## Suggested order

1. **P0 (1, 2)** — one config-guard change + one shared `safeFetch`. Small diffs, highest impact.
2. **CI gate (3)** — cheap, stops shipping red builds while you fix the rest.
3. **Lifecycle (4, 5, 9)** — the runtime group-gate (5) is the root-cause fix that also covers the scheduler (4).
4. **OAuth hardening (6, 7, 8, 10)** — batch as one pass over `oauth-provider.ts` + `mcp-oauth.ts`.
5. **Collision-at-registration (11, 13)** — one guard kills both.
6. **Web robustness (18, 19, 20)** — 3 small changes, big UX win.
7. Rest as cleanup.
