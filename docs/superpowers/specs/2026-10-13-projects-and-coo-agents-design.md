# Projects and COO agents — design

Status: approved in conversation 2026-10-13. Implementation in three shippable stages (see §9).

## 1. Goal

Let an agent administer the gateway for other agents. A **COO** agent (master) provisions
connections, tools, workspaces and **Lead** agents (sub-agents) inside a **project**, without
ever seeing secret values. The owner watches everything the COO does in the admin UI, fills in
secrets, and can share existing resources with a project. Several COOs can coexist; each one
sees only its own subtree.

Vocabulary (the owner's): tenant = user account; team / project = nodes of one tree;
COO = administering agent; Lead = consuming agent.

## 2. Data model

### 2.1 Tree

```
projects
  id          text pk
  owner_id    → users.id cascade
  parent_id   → projects.id cascade, null = top-level
  kind        'team' | 'project'
  name        text
  slug        text            unique(owner_id, slug)
  path        text            materialized '/<id>/<id>/…/' — subtree = path LIKE '<path>%'
  created_at
```

One table for both kinds: `kind` is organisation and a label; the visibility rules below do not
depend on it. Depth is unbounded.

Every user gets a default `team` node and, under it, a default `project` node. The migration
creates both for existing users and back-fills every resource into the default project. Nothing
has a null project after migration.

### 2.2 Resources

`project_id text NOT NULL → projects.id cascade` is added to: `sources`, `tools`, `groups`,
`agents`, `secrets`, `schedules`. `call_logs` gets a nullable `project_id` for filtering.

`created_by_agent_id text null → agents.id set null` is added to `sources`, `tools`, `groups`,
`agents`, `secrets` — the "by COO X" badge in the admin UI.

`agents.role text NOT NULL default 'lead'` — `'lead' | 'coo'`.

`owner_id` stays on every table as a second isolation layer. Tool names stay unique per owner.

### 2.3 Sharing

```
project_access
  project_id     → projects.id cascade        the node that receives access
  resource_type  'source' | 'tool' | 'secret'
  resource_id    text
  granted_by     text null (agent id, null = owner)
  pk(project_id, resource_type, resource_id)
```

A grant on a `source` also exposes its native tools. A grant on a `tool` is for composite /
virtual / python tools. A grant on a `secret` lets a project reference `${secret.NAME}` from
its own connections without seeing the value. No grant type for groups (no use case).

## 3. Visibility rules

A **scope** is `{ ownerId, nodeId }` — the node on whose behalf we act.

- Owner (JWT): `nodeId` = the project selected in the UI (`?project=`), default = the root
  team, i.e. everything.
- COO (agent key): `nodeId` = `agent.project_id`. Not overridable.
- Lead: never has a scope; it only sees its groups' tools, as today.

Node N sees a resource R when either rule holds:

1. **own + shared** — `R.project_id == N`, or `project_access(N, type(R), R.id)` exists.
   This is what N may put into its workspaces.
2. **subtree** — `R.project_id ∈ descendants(N)` (including N). This is what N administers.

Writes (edit / delete) are allowed only under rule 2. A shared resource can be used, never
modified. Grants to a child may only cover resources the granting node itself sees.

Three enforcement points beyond list/CRUD filters:

- `PUT /groups/:id/tools` — every tool must be visible (rule 1) to the group's project.
- Secret resolution — `${secret.NAME}` inside a source resolves only from secrets visible
  (rule 1) to that source's project. `resolveSourceConfig` gains the source's project id.
  A declared-but-empty secret resolves to a clear error (see §4.3), never to `''`.
- Tool names — unique per owner as today; a COO gets `409 name_taken` and picks another.
  The invoker resolves by `(owner_id, name)` and stays unambiguous.

Implementation: one SQL helper `inScope(table, scope)` producing

```
table.project_id IN (SELECT id FROM projects WHERE path LIKE :scopePath || '%')
OR table.id IN (SELECT resource_id FROM project_access
                WHERE project_id = :nodeId AND resource_type = :type)
```

replaces `eq(table.ownerId, owner)` in every route; `ownerId` is still AND-ed.

## 4. COO agent

### 4.1 Identity

A COO is an ordinary agent with `role = 'coo'`. Keys, `/a/mcp`, system tools all unchanged.
When `role = 'coo'`, `tools/list` additionally returns the `project.*` tools (same mechanism
as `system.*`, MCP-safe names via `lib/tool-name`). A Lead never sees them.

Role is set by the owner in the admin UI, or by a COO via `agent_mcp_provision(role: 'coo')`
into a node of its own subtree. A COO cannot change its own role or node.

### 4.2 Tools

| Tool | Does | Backed by |
|---|---|---|
| `project.list` | subtree under the caller's node | services/projects |
| `project.create_child(kind, name, parentId?)` | new team/project in the subtree | services/projects |
| `project.delete(id, confirm)` | cascade-delete a descendant; without `confirm` returns what would be removed | services/projects |
| `project.access_create(projectId, resourceType, resourceId)` | grant to a descendant, only from what the caller sees | services/access |
| `project.access_revoke(projectId, resourceType, resourceId, confirm)` | revoke; without `confirm` lists workspaces that would lose tools | services/access |
| `project.connections_list` | visible sources: id, name, kind, status, project, sharedFrom — never `config` | services/sources |
| `project.connection_describe(id)` | cached objects (GA properties, tables, mailboxes) + tools with schemas | services/sources, services/tools |
| `project.connection_create(name, kind, config)` | config may contain `${secret.NAME}`; validated by `parseSourceConfig` | services/sources |
| `project.connection_test(id)` | health check | services/sources |
| `project.connection_import(id, force?, confirm?)` | the per-tool import report; `force` without `confirm` previews removals | services/sources |
| `project.secret_declare(name, sourceId?)` | secret row with no value → "pending" in admin | services/secrets |
| `project.tool_candidate_create(def)` | virtual / composite / python tool in the caller's node, in no workspace (= staging) | services/tools |
| `project.tool_candidate_test(id, args)` | run it, return the result | runtime/invoker |
| `project.workspace_create(name, slug?, toolIds)` | a group in the caller's node | services/groups |
| `project.workspace_set_tools(groupId, toolIds)` | replace the tool set (rule 1 enforced) | services/groups |
| `project.tool_candidate_promote(toolId, groupId)` | add one tool to a workspace | services/groups |
| `project.agent_mcp_provision(name, projectId?, groupIds, role?)` | agent + key; returns MCP URLs and the raw key **once** | services/agents |
| `project.agent_revoke(agentId)` | archive all keys | services/agents |

Secret values are never accepted by any tool. Destructive tools take `confirm: true`; without
it they return a preview of the change (same idea as the import report).

### 4.3 Pending secrets

`secret_declare` inserts a row with `encrypted_value = null` and `env_ref = null`. The admin
UI shows it as `pending` with a value field. Resolving a pending secret fails the call with
`secret NAME is pending — set its value in admin`; it never silently injects `''`.

### 4.4 Audit

`project.*` calls are written to `call_logs` like any tool call, with `tool_name = 'project.x'`
and `args` always recorded (not only on error; they contain no secrets by construction) and
`project_id` set. Activity → filter by agent shows what a COO did.

## 5. Services layer

Route handlers for sources, tools, groups, agents, secrets, schedules move into
`server/src/services/*.ts` functions taking a `Scope`. Routes and `project.*` tools become thin
wrappers. Isolation (§3) lives in the services only.

## 6. Admin UI

- **Project selector** in the header: tree `All → teams → projects`. The choice is `?project=`
  in the URL and on every API call. Default `All`.
- **Badges on every row** (Connections, Tools, Workspaces, Agents, Secrets, Schedules,
  Activity): project name; `shared from <project>` when visible via a grant; `by <agent>` when
  `created_by_agent_id` is set.
- **Projects tab** (new): tree; per node — kind, COO agents, resource counts, allowlist editor
  (the single place to share: pick from the owner's resources, grant / revoke), create child,
  delete with confirm.
- **Secrets tab**: `pending` badge + inline value field (uses existing `PATCH /secrets/:id`).
- **Agents tab**: `role` selector and project.
- **Activity tab**: `project.*` calls show args.

Not built: an approval flow for staged tools (the COO promotes after testing), drag-and-drop
of the tree, bulk operations, multi-user teams.

## 7. Error handling

- Unknown / invisible resource → `404 not_found` (never 403; do not reveal existence).
- Grant outside the caller's visibility → `400 not_visible`.
- Edit of a shared (rule-1-only) resource → `404 not_found`.
- Pending secret at call time → tool result `isError` with the message in §4.3.
- Tool name clash → `409 name_taken`.
- Migration: runs inside the existing advisory lock; idempotent (skips users that already
  have a default team).

## 8. Testing

Server (vitest, embedded PGlite in CI via `DATABASE_URL`):
- `isolation.integration.test.ts` extended: two projects under one owner; COO A cannot list,
  read, edit or delete B's resources; a grant makes a source and its tools visible to A; A's
  workspace refuses an ungranted tool id; A's source cannot resolve B's secret by name; a
  pending secret fails with the §4.3 message.
- `project-tools.test.ts`: each `project.*` tool through `/a/mcp` with a COO key; Lead key
  does not see them; `agent_mcp_provision` returns a working key; `confirm` previews.
- Migration test: a user with existing resources gets a default team/project and all
  resources back-filled.

Web (vitest + jsdom, React Testing Library):
- Project selector renders the tree and writes `?project=`.
- Row badges: project / shared-from / by-agent.
- Projects tab: allowlist grant and revoke call the API with the right body.
- Secrets tab: pending badge and value submit.

## 9. Delivery stages

1. **Projects + isolation**: schema + migration, `Scope`, services extraction, `inScope` in
   every route, secret resolution by project, project selector + badges in the UI.
2. **COO**: `agents.role`, `project.*` tools on `/a/mcp`, audit args, pending secrets.
3. **Projects tab**: tree, allowlist editor, create/delete, Secrets/Agents tab changes.

Each stage ships green on CI and on its own.
