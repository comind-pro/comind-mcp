# Projects — Stage 2 (COO agent + `project.*` tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent with `role = 'coo'` administers its project subtree over MCP: it lists/describes/creates connections, declares secrets, stages and promotes tools, creates workspaces, child projects, grants, and provisions Lead/COO agents — with every action audited and nothing escaping its subtree.

**Architecture:** Route bodies that the COO needs move into `server/src/services/*.ts` functions taking a `Scope` (Stage 1's `lib/scope.ts`), so REST routes and the new `gateway/project-tools.ts` MCP handler share one implementation and one isolation layer. `project.*` tools are exposed on `/a/mcp` (and on `/g/:slug/mcp`) only when `auth.role === 'coo'`, following the `system.*` pattern (`pickSystemTools` / `canonicalSystemToolName`). Each call is written to `call_logs` with `args` always and `project_id` = the COO's node. Destructive tools require `confirm: true` and otherwise return a preview.

**Tech Stack:** Fastify, drizzle-orm (Postgres / PGlite), zod, `@modelcontextprotocol/sdk` server, vitest; React 18 for the one UI change.

**Spec:** `docs/superpowers/specs/2026-10-13-projects-and-coo-agents-design.md` — §4 (all), §5, §6 (Agents tab role only), §7, §8 (`project-tools.test.ts`).

## Global Constraints

- Stage 1 invariants hold: reads = `inScope`/`toolVisibleCond`, writes = `inSubtree`, invisible → `404 not_found` on REST and an `isError` text result on MCP; never `like()` on `projects.path` (use `underPath`); never call `scopeFor`/`ensureDefaultNodes`/`scopeForOwner` inside `db.transaction` (PGlite is single-connection).
- A COO's scope is `scopeForOwner(auth.ownerId, auth.projectId)` → `createIn = auth.projectId`. It is never taken from tool arguments. Tools that accept a `projectId` argument must verify it is in the caller's subtree (`inSubtree`), else `not_found`.
- Secret values are never accepted by any `project.*` tool (spec §4.3). `project.connection_create` config may contain `${secret.NAME}` references only.
- `project.*` tool names are exposed MCP-safe via `mcpToolName` (dots → underscores) and resolved back with the same canonicalisation used by `system.*`.
- Audit: every `project.*` call inserts one `call_logs` row: `toolName: 'project.<x>'`, `source: 'live'`, `agentId`, `groupId: null`, `projectId: auth.projectId`, `args: JSON.stringify(args).slice(0, 2000)` ALWAYS, `error` on failure, `durationMs`.
- Destructive tools (`project.delete`, `project.access_revoke`, `project.connection_import` with `force`, `project.agent_revoke`) take `confirm: boolean`; without `confirm: true` they return `{ preview: true, … }` describing what would change and perform no write.
- Tool names unique per owner (`409`/`name_taken`), secret names unique per owner (Stage 1 ruling): the COO receives the error text and picks another name.
- Biome (`./node_modules/.bin/biome check --write <files>` from repo root), `cd server && npx tsc -p tsconfig.json --noEmit`, `DATABASE_URL=memory: npx vitest run` green before every commit; web: `cd web && npx tsc --noEmit && npx vitest run`.
- Commits: conventional, `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer, branch `feat/projects`.

## Review Focus

1. A COO must not be able to act on a node outside its subtree by passing an id — every `projectId`/`groupId`/`sourceId`/`toolId`/`agentId` argument is resolved through the COO's scope (Task 2 tests: each tool with a foreign id → `not_found`).
2. `agent_mcp_provision` returns the raw key exactly once and never again (Task 2 test: a second `project.agent_*` call never includes a key).
3. A COO cannot change its own role or node, nor delete its own node or an ancestor (Task 3 tests).
4. Revoking a grant must stop workspaces from using the resource (Task 3: `revokeAccess` unlinks `group_tools` rows that are no longer usable by the group's project; test asserts the Lead's `tools/list` shrinks).
5. A composite/python tool in project A must not reach a tool in project B at runtime by name (Task 3: invoker nested-call scoping; test asserts `Unknown tool`).

---

### Task 1: Services extraction (sources, groups, agents, secrets, custom tools)

**Files:**
- Create: `server/src/services/sources.ts`, `server/src/services/groups.ts`, `server/src/services/agents.ts`, `server/src/services/secrets.ts`, `server/src/services/tools.ts`
- Modify: `server/src/routes/sources.ts`, `groups.ts`, `agents.ts`, `secrets.ts`, `virtual.ts`, `composite.ts`, `python.ts` (become thin wrappers)
- Test: existing route tests must stay green (`sources-import.test.ts`, `project-isolation.test.ts`, `bundles.test.ts`, `gateway-auth.test.ts`, `python.test.ts`); add `server/src/services/services.test.ts` with one test per service function exercising the scope rule (use the register + `scopeForOwner` fixture style from `project-isolation.test.ts`).

**Interfaces (Produces — exact names; Task 2 calls these):**
```ts
// services/sources.ts
export type SourceRow = typeof sources.$inferSelect;
export type ServiceErr = { error: 'not_found' | 'name_taken' | 'not_visible' | 'unknown_tools' | 'validation'; detail?: unknown };
export const isErr = (r: unknown): r is ServiceErr => typeof r === 'object' && r !== null && 'error' in r;
export async function listSources(scope: Scope): Promise<SourceRow[]>                       // inScope
export async function getSource(scope: Scope, id: string): Promise<SourceRow | ServiceErr>  // inScope (read)
export async function createSource(scope: Scope, input: { name: string; kind: SourceKind; config: Record<string, unknown> }, createdByAgentId: string | null): Promise<SourceRow | ServiceErr>  // slug-prefix clash → name_taken
export async function testSource(scope: Scope, id: string): Promise<{ ok: boolean; message?: string } | ServiceErr>   // visible; status write only if administered
export async function refreshObjects(scope: Scope, id: string): Promise<{ objects: unknown[]; objectsCheckedAt: Date } | ServiceErr>  // administered
export type ImportReport = { mode: 'force' | 'new'; total: number; created: number; updated: number; removed: number; restored: number; skipped: number; imported: number; changes: ImportChange[]; tools: ToolRow[] };
export async function importSource(scope: Scope, id: string, opts: { force: boolean; createdByAgentId: string | null }): Promise<ImportReport | ServiceErr>  // administered; foreign-tool clash → name_taken {names}
export async function previewImportRemovals(scope: Scope, id: string): Promise<{ removed: string[] } | ServiceErr>  // what a force import would soft-delete (no writes)

// services/groups.ts
export async function createGroup(scope: Scope, input: { name: string; slug?: string; description?: string }, createdByAgentId: string | null): Promise<GroupRow>
export async function setGroupTools(scope: Scope, groupId: string, toolIds: string[]): Promise<{ groupId: string; toolIds: string[] } | ServiceErr>   // rule 1 vs group.projectId → unknown_tools {missing}
export async function addGroupTool(scope: Scope, groupId: string, toolId: string): Promise<{ groupId: string; toolIds: string[] } | ServiceErr>
export async function listGroupTools(scope: Scope, groupId: string): Promise<ToolRow[] | ServiceErr>

// services/agents.ts
export async function createAgent(scope: Scope, input: { name: string; role: 'lead' | 'coo'; projectId?: string; groupIds: string[] }, createdByAgentId: string | null): Promise<{ agent: AgentRow; apiKey: string; endpoints: { agent: string; groups: { id: string; slug: string; url: string }[] } } | ServiceErr>
  // projectId (default scope.createIn) must be inSubtree; each groupId inSubtree; role 'coo' allowed only when the target node is in the scope's subtree (always true here) — caller's own role is checked by the MCP layer
export async function revokeAgent(scope: Scope, agentId: string): Promise<{ archivedKeys: number } | ServiceErr>   // administered; archives all keys
export async function setAgentRole(scope: Scope, agentId: string, role: 'lead' | 'coo'): Promise<AgentRow | ServiceErr>

// services/secrets.ts
export async function declareSecret(scope: Scope, input: { name: string; sourceId?: string }, createdByAgentId: string | null): Promise<PublicSecret | ServiceErr>   // pending row; sourceId administered → projectId = source.projectId
export async function listSecrets(scope: Scope): Promise<PublicSecret[]>   // names + pending flag, never values

// services/tools.ts
export async function listTools(scope: Scope, filter?: { sourceId?: string; kind?: ToolKind }): Promise<ToolRow[]>
export async function getTool(scope: Scope, id: string): Promise<ToolRow | ServiceErr>
export async function createVirtualTool(scope: Scope, input: VirtualCreateInput, createdByAgentId: string | null): Promise<ToolRow | ServiceErr>
export async function createCompositeTool(scope: Scope, input: CompositeCreateInput, createdByAgentId: string | null): Promise<ToolRow | ServiceErr>   // refs vs toolUsableCond(scope.createIn)
export async function createPythonTool(scope: Scope, input: PythonCreateInput, createdByAgentId: string | null): Promise<ToolRow | ServiceErr>          // feature gate hasFeature(PYTHON_TOOLS)
export async function testTool(scope: Scope, id: string, args: Record<string, unknown>, ctx: { agentId: string | null }): Promise<CallResult | ServiceErr>   // visible; invokeTool(source:'test')
```
`VirtualCreateInput` / `CompositeCreateInput` / `PythonCreateInput` are the existing zod `createBody` inferred types, exported from the services (move the zod schemas there; routes import them).

- [ ] **Step 1:** Write `services.test.ts` first (one `it` per function above; each asserts the success path AND a foreign-id → `{ error: 'not_found' }` path using two child projects A/B). Run; expect FAIL (modules missing).
- [ ] **Step 2:** Move the logic. Rule: a service returns data or a `ServiceErr`; it never touches `req`/`reply`. The route maps `ServiceErr` to the same HTTP codes as today (`not_found`→404, `name_taken`→409, `not_visible`/`unknown_tools`/`validation`→400). Keep every existing response shape byte-for-byte (the web client depends on them).
- [ ] **Step 3:** Run the full server suite; fix regressions; biome; commit `refactor(server): extract scoped services for sources, groups, agents, secrets, tools`.

---

### Task 2: `project.*` tools on the gateway

**Files:**
- Create: `server/src/gateway/project-tools.ts`
- Modify: `server/src/gateway/server.ts` (expose when `auth.role === 'coo'` on both `buildAgentServer` and `buildGroupServer`; dispatch before the group gate, exactly like `system.*`)
- Modify: `server/src/services/projects.ts` (add `listSubtree(scope)`, `previewDelete(scope, id)` returning counts of nodes/sources/tools/groups/agents to be removed, `previewRevoke(scope, g)` returning workspaces that would lose tools)
- Test: `server/src/gateway/project-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 services; `scopeForOwner`; `AgentAuthAll.role/projectId` (Stage 1 Task 6).
- Produces: `export const PROJECT_TOOLS: ToolDef[]`, `export const PROJECT_TOOL_NAMES: Set<string>`, `export function canonicalProjectToolName(name): string | null`, `export function pickProjectTools(): ToolDef[]` (all, MCP-safe names), `export async function handleProjectTool(ctx: ProjectCtx, name: string, args: Record<string, unknown>): Promise<CallResult>` where `ProjectCtx = { agentId: string; ownerId: string; projectId: string }`.

Tool catalogue (names, required args, behaviour). Input schemas are JSON Schema objects like `SYSTEM_TOOLS`; validate args with zod inside the handler and return `isError` text on validation failure.

| name | args | does |
|---|---|---|
| `project.list` | — | `listSubtree(scope)` → `{ nodes: [{id, parentId, kind, name, slug, path}] }` |
| `project.create_child` | `kind`, `name`, `slug?`, `parentId?` (default caller node) | `createNode` |
| `project.delete` | `id`, `confirm?` | refuses `id === ctx.projectId` or an ancestor (`not_allowed`); without confirm → `previewDelete` |
| `project.access_create` | `projectId`, `resourceType`, `resourceId` | `grantAccess(scope, {…, grantedBy: ctx.agentId})` |
| `project.access_revoke` | `projectId`, `resourceType`, `resourceId`, `confirm?` | without confirm → `previewRevoke`; with → `revokeAccess` (Task 3 makes it unlink tools) |
| `project.connections_list` | — | `listSources` mapped to `{id, name, kind, status, statusMessage, projectId, sharedFrom: boolean}` — NEVER `config` |
| `project.connection_describe` | `id` | `getSource` → `{ objects, tools: [{id, name, description, inputSchema, readOnly, dangerous}] }` via `listTools(scope,{sourceId})` |
| `project.connection_create` | `name`, `kind`, `config` | `createSource(scope, input, ctx.agentId)` |
| `project.connection_test` | `id` | `testSource` |
| `project.connection_import` | `id`, `force?`, `confirm?` | `force && !confirm` → `previewImportRemovals`; else `importSource(scope, id, {force, createdByAgentId: ctx.agentId})` |
| `project.secret_declare` | `name`, `sourceId?` | `declareSecret` → `{ name, pending: true, reference: '${secret.NAME}' }` |
| `project.tool_candidate_create` | `kind: 'virtual'|'composite'|'python'`, `definition` | dispatch to the matching `create*Tool` |
| `project.tool_candidate_test` | `toolId`, `args?` | `testTool` |
| `project.tool_candidate_promote` | `toolId`, `groupId` | `addGroupTool` |
| `project.workspace_create` | `name`, `slug?`, `toolIds?` | `createGroup` then `setGroupTools` when toolIds given |
| `project.workspace_set_tools` | `groupId`, `toolIds` | `setGroupTools` |
| `project.agent_mcp_provision` | `name`, `projectId?`, `groupIds`, `role?` (default `lead`) | `createAgent` → `{ agentId, role, apiKey, endpoints }` — the only response that ever carries a key |
| `project.agent_revoke` | `agentId`, `confirm?` | without confirm → `{ preview: true, keys: n }`; with → `revokeAgent` |

- [ ] **Step 1: Failing tests** (`project-tools.test.ts`): register owner; create child project A under the team via REST; create a COO agent in A (`POST /agents?project=A` then `PATCH /agents/:id {role:'coo'}` — Task 3 adds the route; until then set `role` with a direct `db.update(agents)`), a Lead agent in A, a sibling project B with a source. Then over `/a/mcp` JSON-RPC (`tools/list`, `tools/call`; mirror `gateway-auth.test.ts`'s inject helper, `accept: application/json, text/event-stream`):
  - Lead's `tools/list` has no `project_*` names; COO's has all of them.
  - `project_connections_list` from COO returns no B source and no `config` key.
  - `project_connection_create` + `project_connection_import` creates tools in A with `createdByAgentId === coo.id` (assert via REST `GET /tools?project=A`).
  - `project_secret_declare` → REST `GET /secrets?project=A` shows `pending: true`.
  - `project_workspace_create` with a tool id → Lead granted to that group lists the tool.
  - `project_agent_mcp_provision` returns `apiKey`; using that key on `/a/mcp` works; calling `project_agent_revoke` with `confirm:true` → that key 401s.
  - `project_delete` on A itself → error text contains `not_allowed`; on a child created via `project_create_child` without confirm → `preview: true`; with confirm → gone from `project_list`.
  - `project_access_create` targeting B (outside subtree) → `not_found`.
  - Every call above leaves a `call_logs` row with `toolName` starting `project.` and non-null `args` (REST `GET /logs?project=A`).
- [ ] **Step 2:** Implement `project-tools.ts`; wire into `server.ts` (`if (auth.role === 'coo' && projName) …` before the self-cron branch; `tools/list` appends `pickProjectTools()` when coo). Audit insert mirrors `invokeTool`'s log block (fire-and-forget, `args` always).
- [ ] **Step 3:** PASS, full suite, biome, commit `feat(server): project.* admin tools for COO agents`.

---

### Task 3: COO guards, role route, revoke unlinks, invoker nested-call scoping

**Files:**
- Modify: `server/src/routes/agents.ts` (add `PATCH /agents/:id { role }` → `setAgentRole`), `server/src/services/projects.ts` (`revokeAccess` unlinks `group_tools`; `deleteNode` refuses when `id` is the scope node or an ancestor of it), `server/src/runtime/invoker.ts` (`InvokeContext.projectId?: string` — when set, the tool must satisfy `toolUsableCond(ctx.projectId)`; nested calls pass `projectId: parentTool.projectId`), `server/src/gateway/project-tools.ts` (`agent_mcp_provision` with `role:'coo'` only for a `projectId` in the subtree — already enforced by `createAgent`; additionally a COO may not set `role` on itself: `agent_revoke`/provision cannot target `ctx.agentId`)
- Test: extend `project-tools.test.ts` and `project-isolation.test.ts`

- [ ] **Step 1: Failing tests:** (a) `PATCH /agents/<id> {role:'coo'}` → 200 and `GET /agents` shows `role`; foreign agent → 404. (b) COO `project_agent_revoke` with its own `agentId` → `not_allowed`. (c) After `project_access_revoke` (confirm) of B's source granted to A, A's workspace `GET /groups/<g>/tools` no longer contains B's tools and the Lead's `tools/list` shrinks. (d) Composite in A with a step naming B's tool (inserted directly in the DB to bypass create-time validation) → `POST /composite-tools/:id/run` result `isError` with `Unknown tool`. (e) `project_delete` on an ancestor (the root team id) → `not_allowed`.
- [ ] **Step 2:** Implement; PASS; full suite; biome; commit `feat(server): COO guards, agent role route, revoke unlinks workspace tools, nested calls scoped to the caller's project`.

---

### Task 4: Web — Agents tab role selector, Activity shows admin calls

**Files:**
- Modify: `web/src/tabs/AgentsTab.tsx` (per-agent `role` `<select>` → `PATCH /agents/:id {role}`; `COO` badge in the list row), `web/src/tabs/LogsTab.tsx` (row is expandable when `l.args` is present, not only on error; expanded row shows `Called with`), `web/src/api.ts` (`Agent.role` already present)
- Test: `web/src/tabs/AgentsTab.role.test.tsx` (RTL: renders the select with the agent's role; changing it calls `api.patch` with `{ role: 'coo' }` — mock `api` via `vi.mock('../api.js')`), `web/src/tabs/LogsTab.args.test.tsx` (a success row with args is clickable and reveals the args)

- [ ] **Step 1:** Failing RTL tests → implement → PASS → `npx tsc --noEmit` → biome → commit `feat(web): agent role selector and admin-call details in Activity`.

---

### Task 5: Docs

**Files:** `ReadMe.md` (Concepts: COO / Lead roles; API: `PATCH /agents/:id {role}`; a "COO agents" section listing the `project_*` tools in one table with one line each), `server/src/stdio.ts` (onboarding: one sentence on provisioning a COO).

- [ ] **Step 1:** Write; commit `docs: COO agents and project.* tools`.

---

## Self-review
- Spec §4.1 ✔ T2 (exposure by role) + T3 (role route, self-guard); §4.2 table ✔ T2 (all 18 tools; `access_revoke` preview + `delete` preview ✔; `connections_list` never returns config ✔); §4.3 ✔ T2 `secret_declare` + Stage 1 pending resolution; §4.4 ✔ T2 audit; §5 ✔ T1; §6 Agents role ✔ T4; §7 ✔ error mapping in T1/T2; §8 `project-tools.test.ts` ✔ T2/T3.
- Review Focus 1 → T2 tests (foreign ids); 2 → T2 provision/revoke test; 3 → T3 (b)(e); 4 → T3 (c); 5 → T3 (d).
- Type consistency: `ServiceErr`/`isErr` defined in `services/sources.ts` and imported by the others (single definition); `ProjectCtx` fields match `AgentAuthAll` fields used in `server.ts`.
