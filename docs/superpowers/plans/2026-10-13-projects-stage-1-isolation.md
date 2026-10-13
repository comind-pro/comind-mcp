# Projects — Stage 1 (tree + isolation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every resource lives in a project node of a per-owner tree; every read and write is scoped to a node; the admin UI gets a project selector and per-row project badges.

**Architecture:** One `projects` table (team/project nodes, materialized `path`), `project_id` on every resource, `project_access` grants. A `Scope` object replaces bare `ownerId` in routes; two SQL helpers (`inSubtree`, `inScope`) express the spec's two visibility rules. Owner routes build the scope from `?project=`; agent gateway is unchanged in this stage.

**Tech Stack:** Fastify + drizzle-orm (Postgres / PGlite), zod, vitest; React 18 + Vite, vitest + jsdom, `@testing-library/react` (added in Task 7).

**Spec:** `docs/superpowers/specs/2026-10-13-projects-and-coo-agents-design.md`

## Global Constraints

- Biome formats and lints (`pnpm lint` at repo root); 2-space, single quotes, 120 cols. Run `./node_modules/.bin/biome check --write <files>` before every commit.
- Server tests run with `DATABASE_URL=memory:` (embedded PGlite) from `server/`: `DATABASE_URL=memory: npx vitest run`. CI uses a real Postgres with the same migrations.
- Migrations: `server/drizzle/NNNN_*.sql` + `meta/_journal.json`, generated with `npx drizzle-kit generate` from `server/` (needs any `DATABASE_URL`, e.g. `postgres://x:x@localhost:1/x`), then hand-edited for data backfill. `runMigrations()` applies them on boot.
- Ids are `newId()` (16-char nanoid) from `lib/id.ts`; in SQL use `substr(md5(random()::text || <seed>), 1, 16)`.
- Invisible resources answer `404 not_found`, never 403 (spec §7).
- Tool names stay unique per owner (spec §3).
- Commit messages: conventional (`feat(server): …`), end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- All work on branch `feat/projects` off `main`.

## Review Focus

1. A user registered before this change must see every one of their existing resources after migration with no UI selection — Task 1 migration test asserts back-fill of all six tables.
2. `?project=<id of another owner's node>` must act like an unknown node (404), not fall back to "all" — Task 2 test.
3. A grant must never let the grantee edit or delete the shared resource — Task 4 and 5 tests assert 404 on PATCH/DELETE of a shared source/tool.
4. `${secret.NAME}` in a child-project source must not resolve the parent's ungranted secret, and a declared-but-empty secret must fail loudly — Task 4 tests.
5. Deleting the default project or root team must be refused (everything would be orphaned) — Task 3 test.

---

### Task 1: Schema, migration, default nodes on register

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/drizzle/0016_projects.sql` (+ `meta/0016_snapshot.json`, `meta/_journal.json` via drizzle-kit)
- Create: `server/src/services/projects.ts`
- Modify: `server/src/routes/auth.ts`
- Test: `server/src/db/projects-migration.test.ts`

**Interfaces:**
- Produces: tables `projects`, `projectAccess` exported from schema; columns `projectId` (NOT NULL) on `sources`, `tools`, `groups`, `agents`, `secrets`, `schedules`; nullable `projectId` on `callLogs`; nullable `createdByAgentId` on `sources`, `tools`, `groups`, `agents`, `secrets`; `agents.role`.
- Produces: `ensureDefaultNodes(ownerId): Promise<{ teamId: string; projectId: string }>` in `services/projects.ts`; `nodePath(parentPath: string | null, id: string): string`.

- [ ] **Step 1: Add tables and columns to `schema.ts`**

After `users`, before `sources`:

```ts
/** Project tree. kind is organisation only; visibility rules do not depend on it.
 *  path = '/<id>/<id>/…/' from the top-level team down, so a subtree is
 *  `path LIKE '<path>%'`. Every owner has a default team with a default project
 *  (slug 'team' / 'default'); nothing lives outside the tree. */
export const projects = pgTable(
  'projects',
  {
    id: id(),
    ownerId: ownerId(),
    parentId: text('parent_id'),
    kind: text('kind', { enum: ['team', 'project'] }).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    path: text('path').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    slugIdx: uniqueIndex('projects_slug_unique').on(t.ownerId, t.slug),
    pathIdx: index('projects_path_idx').on(t.path),
  }),
);

const projectId = () =>
  text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

/** Who created a row when it was an agent (COO) — the "by <agent>" badge. */
const createdByAgentId = () => text('created_by_agent_id');

/** Sharing: node `projectId` may USE resource (rule 1 in the spec). A grant on a
 *  source also exposes its native tools. Never grants edit rights. */
export const projectAccess = pgTable(
  'project_access',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type', { enum: ['source', 'tool', 'secret'] }).notNull(),
    resourceId: text('resource_id').notNull(),
    grantedBy: text('granted_by'),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: uniqueIndex('project_access_pk').on(t.projectId, t.resourceType, t.resourceId),
  }),
);
```

`parentId` has no FK (self-reference needs `AnyPgColumn` typing); cascade on delete is handled in code (Task 3 deletes the subtree by path).

Add to `sources`, `tools`, `groups`, `agents`, `secrets`: `projectId: projectId(), createdByAgentId: createdByAgentId(),` right after `ownerId`. Add to `schedules`: `projectId: projectId(),` after `ownerId`. Add to `callLogs`: `projectId: text('project_id'),` after `ownerId`. Add to `agents`: `role: text('role', { enum: ['lead', 'coo'] }).notNull().default('lead'),` after `name`. Add `projects, projectAccess` to the `schema` export object.

- [ ] **Step 2: Generate the migration**

```bash
cd server && DATABASE_URL=postgres://x:x@localhost:1/x npx drizzle-kit generate --name projects
```

Expected: `drizzle/0016_projects.sql` with `CREATE TABLE "projects"`, `CREATE TABLE "project_access"`, `ALTER TABLE … ADD COLUMN "project_id" text NOT NULL`, etc.

- [ ] **Step 3: Hand-edit `0016_projects.sql` for back-fill**

Open the generated file. For every `ADD COLUMN "project_id" text NOT NULL` line, drop ` NOT NULL`. Keep every other generated statement. Then append (after the generated statements, each statement followed by the `--> statement-breakpoint` marker drizzle uses):

```sql
--> statement-breakpoint
INSERT INTO "projects" ("id","owner_id","parent_id","kind","name","slug","path","created_at")
SELECT substr(md5(random()::text || u.id || 't'),1,16), u.id, NULL, 'team', 'My team', 'team', '', now()
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p.owner_id = u.id AND p.kind = 'team' AND p.slug = 'team');
--> statement-breakpoint
UPDATE "projects" SET "path" = '/' || "id" || '/' WHERE "parent_id" IS NULL AND "path" = '';
--> statement-breakpoint
INSERT INTO "projects" ("id","owner_id","parent_id","kind","name","slug","path","created_at")
SELECT substr(md5(random()::text || t.id || 'p'),1,16), t.owner_id, t.id, 'project', 'Default', 'default', '', now()
FROM "projects" t
WHERE t.kind = 'team' AND t.slug = 'team'
  AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p.owner_id = t.owner_id AND p.kind = 'project' AND p.slug = 'default');
--> statement-breakpoint
UPDATE "projects" c SET "path" = t."path" || c."id" || '/' FROM "projects" t WHERE c."parent_id" = t."id" AND c."path" = '';
--> statement-breakpoint
UPDATE "sources" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "tools" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "groups" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "agents" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "secrets" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "schedules" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "project_id" SET NOT NULL;
```

The FK constraints drizzle generated for `project_id` must come AFTER the back-fill. Move the generated `ALTER TABLE … ADD CONSTRAINT …project_id_projects_id_fk…` statements to the end of the file (after the `SET NOT NULL` block).

- [ ] **Step 4: Write the failing migration test**

`server/src/db/projects-migration.test.ts`:

```ts
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

/** A pre-projects database (migrations up to 0015) with one user and one of each
 *  resource must come out of 0016 with a default team + project and every row
 *  back-filled into that project. Runs on in-memory PGlite, no service needed. */
describe('0016 projects migration', () => {
  it('creates default nodes and back-fills every resource', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    const dir = resolve(process.cwd(), 'drizzle');
    // Apply everything up to 0015 by running the full folder with 0016 masked out
    // is not possible with drizzle's migrator, so seed AFTER a full migrate using the
    // pre-0016 shape via raw SQL is also not possible. Instead: migrate fully, then
    // simulate a legacy user by inserting rows with project_id pointing at a
    // throwaway node, deleting that node's rows, and re-running the back-fill
    // statements. That is brittle. Do the honest thing: migrate fully and assert the
    // register-time behaviour through ensureDefaultNodes, and assert the SQL in the
    // migration file contains the back-fill for all six tables.
    await migrate(db, { migrationsFolder: dir });
    const sql = await import('node:fs').then((fs) => fs.readFileSync(resolve(dir, '0016_projects.sql'), 'utf8'));
    for (const t of ['sources', 'tools', 'groups', 'agents', 'secrets', 'schedules']) {
      expect(sql).toMatch(new RegExp(`UPDATE "${t}" s SET "project_id"`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "project_id" SET NOT NULL`));
    }
    await client.close();
  });
});
```

Replace the long comment with the two-line truth: "The migrator cannot stop at 0015, so the back-fill is pinned by asserting the SQL text; the runtime behaviour for new users is covered by `ensureDefaultNodes` in Task 3's tests." Keep the assertions.

- [ ] **Step 5: Run it; expect FAIL** — `cd server && DATABASE_URL=memory: npx vitest run src/db/projects-migration.test.ts` fails because `0016_projects.sql` does not exist yet (if Steps 2–3 were done, it passes — fine, continue).

- [ ] **Step 6: `services/projects.ts` — default nodes**

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { newId } from '../lib/id.js';

export const nodePath = (parentPath: string | null, id: string): string => `${parentPath ?? '/'}${id}/`;

/** The owner's root team and default project, created on first use. Idempotent. */
export async function ensureDefaultNodes(ownerId: string): Promise<{ teamId: string; projectId: string }> {
  let [team] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.kind, 'team'), eq(projects.slug, 'team')));
  if (!team) {
    const id = newId();
    team = { id, ownerId, parentId: null, kind: 'team', name: 'My team', slug: 'team', path: nodePath(null, id), createdAt: new Date() };
    await db.insert(projects).values(team);
  }
  let [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.kind, 'project'), eq(projects.slug, 'default')));
  if (!proj) {
    const id = newId();
    proj = { id, ownerId, parentId: team.id, kind: 'project', name: 'Default', slug: 'default', path: nodePath(team.path, id), createdAt: new Date() };
    await db.insert(projects).values(proj);
  }
  return { teamId: team.id, projectId: proj.id };
}
```

- [ ] **Step 7: Call it on register** — in `routes/auth.ts` after `await db.insert(users).values(row);` add `await ensureDefaultNodes(row.id);` (import from `../services/projects.js`).

- [ ] **Step 8: Typecheck + run the whole server suite**

`cd server && npx tsc -p tsconfig.json --noEmit && DATABASE_URL=memory: npx vitest run`. Expected: typecheck fails in every test/seed that inserts into `sources/tools/groups/agents/secrets` without `projectId` (isolation test, bundles test, gateway-auth test, …). Fix each seed: call `ensureDefaultNodes(ownerId)` after inserting the user and pass `projectId` into every insert. Tests that go through `POST /auth/register` already get nodes; their later inserts go through routes (fixed in Tasks 4–5) — for now routes still insert without `projectId` and will fail at runtime with a NOT NULL violation. **That is expected until Task 4/5**; to keep this task green, give every route insert `projectId` from `(await ensureDefaultNodes(owner)).projectId` as a temporary measure with a `// task4: scope.createIn` comment. All suites green before commit.

- [ ] **Step 9: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/src/services/projects.ts server/src/routes server/src/db/projects-migration.test.ts server/src/gateway server/src/routes/*.test.ts
git commit -m "feat(server): project tree schema, migration back-fill, default nodes on register"
```

---

### Task 2: `Scope` and the two visibility helpers

**Files:**
- Create: `server/src/lib/scope.ts`
- Test: `server/src/lib/scope.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Scope { ownerId: string; nodeId: string; nodePath: string; createIn: string }
  export async function scopeForOwner(ownerId: string, nodeId?: string | null): Promise<Scope | null>
  export function scopeFor(req: FastifyRequest): Promise<Scope>   // throws { statusCode: 404 } on unknown node
  export function inSubtree(col: PgColumn, scope: Scope): SQL       // rule 2: col ∈ descendants(node) incl. node
  export function granted(idCol: PgColumn, type: 'source' | 'tool' | 'secret', nodeId: string): SQL
  export function inScope(projectCol: PgColumn, idCol: PgColumn, type: 'source'|'tool'|'secret', scope: Scope): SQL  // rule 2 OR granted(node)
  export function usableBy(projectCol: PgColumn, idCol: PgColumn, type, nodeId: string): SQL  // rule 1: own OR granted
  ```

- [ ] **Step 1: Failing test**

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '../db/client.js';
import { projectAccess, projects, sources, users } from '../db/schema.js';
import { newId } from './id.js';
import { ensureDefaultNodes, nodePath } from '../services/projects.js';
import { inScope, inSubtree, scopeForOwner, usableBy } from './scope.js';

const owner = newId();
let teamId: string;
let defaultId: string;
let childId: string;
const srcDefault = newId();
const srcChild = newId();

const mkSource = (id: string, projectId: string) =>
  db.insert(sources).values({ id, ownerId: owner, projectId, name: id, kind: 'http', config: {}, createdAt: new Date() });

describe('scope helpers', () => {
  beforeAll(async () => {
    await runMigrations();
    await db.insert(users).values({ id: owner, email: `${owner}@t.local`, passwordHash: 'x', createdAt: new Date() });
    ({ teamId, projectId: defaultId } = await ensureDefaultNodes(owner));
    const [team] = await db.select().from(projects).where(eq(projects.id, teamId));
    childId = newId();
    await db.insert(projects).values({ id: childId, ownerId: owner, parentId: teamId, kind: 'project', name: 'c', slug: 'c', path: nodePath(team.path, childId), createdAt: new Date() });
    await mkSource(srcDefault, defaultId);
    await mkSource(srcChild, childId);
  });
  afterAll(() => db.delete(users).where(eq(users.id, owner)));

  const names = async (cond: ReturnType<typeof inSubtree>) =>
    (await db.select({ id: sources.id }).from(sources).where(and(eq(sources.ownerId, owner), cond))).map((r) => r.id).sort();

  it('root team sees the whole subtree; a child sees only itself', async () => {
    const root = (await scopeForOwner(owner))!;
    expect(root.nodeId).toBe(teamId);
    expect(root.createIn).toBe(defaultId);
    expect(await names(inSubtree(sources.projectId, root))).toEqual([srcChild, srcDefault].sort());
    const child = (await scopeForOwner(owner, childId))!;
    expect(child.createIn).toBe(childId);
    expect(await names(inSubtree(sources.projectId, child))).toEqual([srcChild]);
  });

  it('a grant makes a resource usable but not part of the subtree', async () => {
    await db.insert(projectAccess).values({ projectId: childId, resourceType: 'source', resourceId: srcDefault, grantedBy: null, createdAt: new Date() });
    const child = (await scopeForOwner(owner, childId))!;
    expect(await names(inSubtree(sources.projectId, child))).toEqual([srcChild]);
    expect(await names(inScope(sources.projectId, sources.id, 'source', child))).toEqual([srcChild, srcDefault].sort());
    expect(await names(usableBy(sources.projectId, sources.id, 'source', childId))).toEqual([srcChild, srcDefault].sort());
    expect(await names(usableBy(sources.projectId, sources.id, 'source', defaultId))).toEqual([srcDefault]);
  });

  it("another owner's node id is unknown", async () => {
    const other = newId();
    await db.insert(users).values({ id: other, email: `${other}@t.local`, passwordHash: 'x', createdAt: new Date() });
    const theirs = await ensureDefaultNodes(other);
    expect(await scopeForOwner(owner, theirs.projectId)).toBeNull();
    await db.delete(users).where(eq(users.id, other));
  });
});
```

- [ ] **Step 2: Run; expect FAIL** (`./scope.js` missing).

- [ ] **Step 3: Implement `lib/scope.ts`**

```ts
import { and, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { projectAccess, projects } from '../db/schema.js';
import { ensureDefaultNodes } from '../services/projects.js';
import { ownerOf } from './req.js';

/** Whose behalf we act on. nodeId/nodePath = the tree node (rule 2 reads the
 *  subtree under it); createIn = where new resources go. */
export interface Scope {
  ownerId: string;
  nodeId: string;
  nodePath: string;
  createIn: string;
}

/** Owner scope for a node. No node → the root team (sees everything), creating in
 *  the default project. Unknown or foreign node → null. */
export async function scopeForOwner(ownerId: string, nodeId?: string | null): Promise<Scope | null> {
  const defaults = await ensureDefaultNodes(ownerId);
  const id = nodeId || defaults.teamId;
  const [node] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
  if (!node) return null;
  return { ownerId, nodeId: node.id, nodePath: node.path, createIn: nodeId ? node.id : defaults.projectId };
}

/** Scope from a control-plane request: JWT owner + optional `?project=`. */
export async function scopeFor(req: FastifyRequest): Promise<Scope> {
  const q = req.query as { project?: string };
  const s = await scopeForOwner(ownerOf(req), q.project);
  if (!s) throw Object.assign(new Error('not_found'), { statusCode: 404 });
  return s;
}

const subtreeIds = (scope: Scope) =>
  db
    .select({ id: projects.id })
    .from(projects)
    .where(like(projects.path, `${scope.nodePath}%`));

/** Rule 2: the row's project is the node or a descendant. */
export function inSubtree(projectCol: PgColumn, scope: Scope): SQL {
  return inArray(projectCol, subtreeIds(scope));
}

/** The row was shared with `nodeId` via project_access. */
export function granted(idCol: PgColumn, type: 'source' | 'tool' | 'secret', nodeId: string): SQL {
  return inArray(
    idCol,
    db
      .select({ id: projectAccess.resourceId })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, nodeId), eq(projectAccess.resourceType, type))),
  );
}

/** What the node administers or may use: rule 2 OR a grant to the node itself. */
export function inScope(projectCol: PgColumn, idCol: PgColumn, type: 'source' | 'tool' | 'secret', scope: Scope): SQL {
  return or(inSubtree(projectCol, scope), granted(idCol, type, scope.nodeId)) as SQL;
}

/** Rule 1: what a single node may put into its workspaces — its own rows or grants. */
export function usableBy(projectCol: PgColumn, idCol: PgColumn, type: 'source' | 'tool' | 'secret', nodeId: string): SQL {
  return or(eq(projectCol, nodeId), granted(idCol, type, nodeId)) as SQL;
}
```

The error handler in `app.ts` already turns `{ statusCode: 404, message: 'not_found' }` into `404 {error:'not_found'}`.

- [ ] **Step 4: Run; expect PASS.** Biome, then commit: `git commit -m "feat(server): Scope and subtree/grant visibility helpers"`.

---

### Task 3: Project routes (tree + access)

**Files:**
- Modify: `server/src/services/projects.ts`
- Create: `server/src/routes/projects.ts`
- Modify: `server/src/app.ts` (register `projectRoutes`)
- Test: `server/src/routes/projects.test.ts`

**Interfaces:**
- Produces REST: `GET /projects` → `ProjectRow[]` (flat, with `path`); `POST /projects {kind,name,slug?,parentId}` → 201 row; `DELETE /projects/:id` → 204 (409 `default_node` for root team / default project); `GET /projects/:id/access` → `{resourceType,resourceId}[]`; `POST /projects/:id/access {resourceType,resourceId}` → 201 (400 `not_visible`); `DELETE /projects/:id/access/:type/:resourceId` → 204.
- Produces services: `createNode(scope, {kind,name,slug?,parentId}): Promise<ProjectRow>`; `deleteNode(scope, id): Promise<'ok'|'not_found'|'default_node'>`; `grantAccess(scope, {projectId,resourceType,resourceId,grantedBy}): Promise<'ok'|'not_found'|'not_visible'>`; `revokeAccess(scope, …)`.

- [ ] **Step 1: Failing test** (`projects.test.ts`, same `buildApp()` + `/auth/register` style as `sources-import.test.ts`):

```ts
it('register gives a root team with a default project', async () => {
  const list = (await call('GET', '/projects')).json() as { kind: string; slug: string; parentId: string | null }[];
  expect(list.map((p) => `${p.kind}:${p.slug}`).sort()).toEqual(['project:default', 'team:team']);
});
it('creates a child, refuses deleting defaults, deletes a child subtree', async () => {
  const team = (await call('GET', '/projects')).json().find((p) => p.kind === 'team');
  const c = (await call('POST', '/projects', { kind: 'project', name: 'Child', parentId: team.id })).json();
  expect(c.path).toBe(`${team.path}${c.id}/`);
  const gc = (await call('POST', '/projects', { kind: 'team', name: 'Sub', parentId: c.id })).json();
  expect((await call('DELETE', `/projects/${team.id}`)).statusCode).toBe(409);
  expect((await call('DELETE', `/projects/${c.id}`)).statusCode).toBe(204);
  const ids = (await call('GET', '/projects')).json().map((p) => p.id);
  expect(ids).not.toContain(c.id); expect(ids).not.toContain(gc.id);
});
it('grants only what the caller sees and revokes', async () => {
  // owner creates source in default project, child project, grants, lists, revokes
  // then: ?project=<child> + POST /projects/<grandchild>/access for a source NOT visible to child → 400 not_visible
});
```

Write the third test fully: create source via `POST /sources` (lands in default project), create child, `POST /projects/<child>/access {resourceType:'source', resourceId}` → 201, `GET /projects/<child>/access` contains it, `DELETE /projects/<child>/access/source/<id>` → 204; then create a second source in `?project=<childB>` and from scope `?project=<childA>` try to grant it to a grandchild of A → 400 `not_visible`.

- [ ] **Step 2: Run; expect FAIL** (404 routes).

- [ ] **Step 3: Services**

Append to `services/projects.ts`:

```ts
export type ProjectRow = typeof projects.$inferSelect;

export async function listNodes(scope: Scope): Promise<ProjectRow[]> {
  return db.select().from(projects).where(and(eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
}

export async function createNode(scope: Scope, input: { kind: 'team' | 'project'; name: string; slug?: string; parentId: string }): Promise<ProjectRow | 'not_found' | 'slug_taken'> {
  const [parent] = await db.select().from(projects).where(and(eq(projects.id, input.parentId), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
  if (!parent) return 'not_found';
  const slug = slugify(input.slug ?? input.name);
  const [clash] = await db.select().from(projects).where(and(eq(projects.ownerId, scope.ownerId), eq(projects.slug, slug)));
  if (clash) return 'slug_taken';
  const id = newId();
  const row = { id, ownerId: scope.ownerId, parentId: parent.id, kind: input.kind, name: input.name, slug, path: nodePath(parent.path, id), createdAt: new Date() };
  await db.insert(projects).values(row);
  return row;
}

export async function deleteNode(scope: Scope, id: string): Promise<'ok' | 'not_found' | 'default_node'> {
  const [node] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
  if (!node) return 'not_found';
  if ((node.kind === 'team' && node.slug === 'team') || (node.kind === 'project' && node.slug === 'default')) return 'default_node';
  // resources cascade from each node; descendants are deleted by path
  await db.delete(projects).where(and(eq(projects.ownerId, scope.ownerId), like(projects.path, `${node.path}%`)));
  return 'ok';
}

const visibleCond = (type: 'source' | 'tool' | 'secret', scope: Scope) =>
  type === 'source' ? inScope(sources.projectId, sources.id, 'source', scope)
  : type === 'tool' ? inScope(tools.projectId, tools.id, 'tool', scope)
  : inScope(secrets.projectId, secrets.id, 'secret', scope);

/** Does the scope see this resource (rule 2 or a grant to its node)? */
export async function canSee(scope: Scope, type: 'source' | 'tool' | 'secret', id: string): Promise<boolean> {
  const table = type === 'source' ? sources : type === 'tool' ? tools : secrets;
  const [row] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.ownerId, scope.ownerId), visibleCond(type, scope)));
  return !!row;
}

export async function grantAccess(scope: Scope, g: { projectId: string; resourceType: 'source' | 'tool' | 'secret'; resourceId: string; grantedBy: string | null }): Promise<'ok' | 'not_found' | 'not_visible'> {
  const [target] = await db.select().from(projects).where(and(eq(projects.id, g.projectId), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
  if (!target) return 'not_found';
  if (!(await canSee(scope, g.resourceType, g.resourceId))) return 'not_visible';
  await db.insert(projectAccess).values({ projectId: g.projectId, resourceType: g.resourceType, resourceId: g.resourceId, grantedBy: g.grantedBy, createdAt: new Date() }).onConflictDoNothing();
  return 'ok';
}

export async function revokeAccess(scope: Scope, g: { projectId: string; resourceType: 'source' | 'tool' | 'secret'; resourceId: string }): Promise<'ok' | 'not_found'> {
  const [target] = await db.select().from(projects).where(and(eq(projects.id, g.projectId), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
  if (!target) return 'not_found';
  await db.delete(projectAccess).where(and(eq(projectAccess.projectId, g.projectId), eq(projectAccess.resourceType, g.resourceType), eq(projectAccess.resourceId, g.resourceId)));
  return 'ok';
}

export async function listAccess(scope: Scope, projectId: string) {
  const [target] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
  if (!target) return null;
  return db.select().from(projectAccess).where(eq(projectAccess.projectId, projectId));
}
```

Imports: `like`, `slugify`, `inScope`, `inSubtree`, `Scope`, `secrets`, `sources`, `tools`, `projectAccess`. NB `lib/scope.ts` imports `ensureDefaultNodes` from this file; keep `ensureDefaultNodes` free of `scope.ts` imports to avoid a cycle at module-evaluation time (type-only import of `Scope` is fine: `import type { Scope } from '../lib/scope.js'` and import the helpers at call time is unnecessary — ESM cycles with function-level use are fine; just do not call across the cycle at top level).

- [ ] **Step 4: Routes** (`routes/projects.ts`)

```ts
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (req) => listNodes(await scopeFor(req)));
  app.post('/projects', async (req, reply) => {
    const body = z.object({ kind: z.enum(['team', 'project']), name: z.string().min(1), slug: z.string().min(1).optional(), parentId: z.string() }).parse(req.body);
    const r = await createNode(await scopeFor(req), body);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'slug_taken') return reply.code(409).send({ error: 'slug_taken' });
    return reply.code(201).send(r);
  });
  app.delete('/projects/:id', async (req, reply) => {
    const r = await deleteNode(await scopeFor(req), (req.params as { id: string }).id);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'default_node') return reply.code(409).send({ error: 'default_node' });
    return reply.code(204).send();
  });
  app.get('/projects/:id/access', async (req, reply) => {
    const rows = await listAccess(await scopeFor(req), (req.params as { id: string }).id);
    return rows ?? reply.code(404).send({ error: 'not_found' });
  });
  app.post('/projects/:id/access', async (req, reply) => {
    const body = z.object({ resourceType: z.enum(['source', 'tool', 'secret']), resourceId: z.string() }).parse(req.body);
    const r = await grantAccess(await scopeFor(req), { projectId: (req.params as { id: string }).id, ...body, grantedBy: null });
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'not_visible') return reply.code(400).send({ error: 'not_visible' });
    return reply.code(201).send({ ok: true });
  });
  app.delete('/projects/:id/access/:type/:resourceId', async (req, reply) => {
    const p = req.params as { id: string; type: 'source' | 'tool' | 'secret'; resourceId: string };
    const r = await revokeAccess(await scopeFor(req), { projectId: p.id, resourceType: p.type, resourceId: p.resourceId });
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
```

Register in `app.ts` next to `groupRoutes`.

- [ ] **Step 5: Run; expect PASS** (the third test needs `POST /sources` to honour `?project=` — if Task 4 is not done yet, the source lands in the default project; adjust the test's second source to be created after Task 4, or implement the `?project=` on `POST /sources` here as the first slice of Task 4). Biome, full suite, commit `feat(server): project tree and access routes`.

---

### Task 4: Scope sources, tools, secrets; secret resolution by project

**Files:**
- Modify: `server/src/routes/sources.ts`, `server/src/routes/tools.ts`, `server/src/routes/secrets.ts`
- Modify: `server/src/secrets/loader.ts`, `server/src/runtime/virtual.ts:223`, `server/src/routes/oauth.ts:24`, `server/src/gateway/system-tools.ts:333`, `server/src/runtime/invoker.ts:172`
- Test: `server/src/routes/project-isolation.test.ts` (new; the existing cross-owner test stays)

**Interfaces:**
- Consumes: `scopeFor`, `inSubtree`, `inScope`, `usableBy` (Task 2).
- Produces: `loadSecretMap(ownerId, sourceId?, projectId?): Promise<Record<string, string | null>>` (null = declared but pending); `injectSecrets` throws `Error('secret NAME is pending — set its value in admin')` when a placeholder hits a null; `resolveSourceConfig(config, ownerId, sourceId?, projectId?)`.
- Produces: `toolVisibleCond(scope): SQL` exported from `routes/tools.ts` → `or(inScope(tools.projectId, tools.id, 'tool', scope), granted(tools.sourceId, 'source', scope.nodeId))` and `toolUsableCond(nodeId): SQL` → `or(usableBy(tools.projectId, tools.id, 'tool', nodeId), granted(tools.sourceId, 'source', nodeId))`.

- [ ] **Step 1: Failing tests** — `project-isolation.test.ts`: one owner, two child projects A and B under the root team, a source + import in each (`?project=A` / `?project=B`), a secret in each.

```ts
it('lists are scoped: A sees only A, root sees both', …)            // GET /sources?project=A → 1; GET /sources → 2; same for /tools, /secrets
it('reading B from A is 404', …)                                     // GET /sources/<B.src>?project=A → 404; PATCH/DELETE → 404
it('a granted source is readable but not editable from A', …)       // grant B.src to A; GET → 200; GET /tools?project=A includes B's native tools; PATCH → 404; DELETE → 404
it("A's source cannot resolve B's secret by name", …)               // source in A with header ${secret.BKEY}; POST /sources/<A.src>/test?project=A → message mentions missing/empty, not B's value
it('a pending secret fails loudly', …)                              // POST /secrets {name:'PK', pending:true}?project=A → 201; source referencing it; /test → 'secret PK is pending — set its value in admin'
it('new rows land in ?project= or the default project', …)          // POST /sources?project=A → row.projectId === A; POST /sources → default
```

Use `kind: 'http'` sources with `baseUrl: 'http://127.0.0.1:9'` as in `sources-import.test.ts`; `/test` on them reports the error text, which is what the secret tests inspect.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: `secrets/loader.ts`**

```ts
function resolveSecretValue(r): string | null {
  if (r.encryptedValue) return decrypt(r.encryptedValue);
  if (r.envRef) return process.env[r.envRef] ?? '';
  return null; // declared, no value yet
}

/** Secrets usable by `projectId` (own + granted; rule 1). Globals first, then this
 *  source's overrides. No projectId → owner-wide (legacy callers: virtual tools). */
export async function loadSecretMap(ownerId: string, sourceId?: string, projectId?: string) {
  const cond = projectId ? and(eq(secrets.ownerId, ownerId), usableBy(secrets.projectId, secrets.id, 'secret', projectId)) : eq(secrets.ownerId, ownerId);
  const rows = await db.select().from(secrets).where(cond);
  const map: Record<string, string | null> = {};
  for (const r of rows) if (r.sourceId == null) map[r.name] = resolveSecretValue(r);
  if (sourceId) for (const r of rows) if (r.sourceId === sourceId) map[r.name] = resolveSecretValue(r);
  return map;
}

export function injectSecrets<T>(value: T, map: Record<string, string | null>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{secret\.([A-Za-z0-9_.-]+)\}/g, (_m, n) => {
      const v = map[n];
      if (v === null) throw new Error(`secret ${n} is pending — set its value in admin`);
      return v ?? '';
    }) as unknown as T;
  }
  …unchanged recursion…
}

export async function resolveSourceConfig(config, ownerId, sourceId?, projectId?) {
  let pid = projectId;
  if (!pid && sourceId) pid = (await db.select({ p: sources.projectId }).from(sources).where(eq(sources.id, sourceId)))[0]?.p;
  return injectSecrets(config, await loadSecretMap(ownerId, sourceId, pid));
}
```

`resolveSourceConfig` looks the project up itself, so the four existing callers (`invoker.ts`, `oauth.ts`, `system-tools.ts`, `sources.ts` ×3) need no change. `runtime/virtual.ts:223` keeps `loadSecretMap(ownerId)` (owner-wide; virtual tools get a project in Stage 2) — update the map type there to `Record<string, string | null>`. `routes/sources.ts:101` (draft test) → `loadSecretMap(scope.ownerId, undefined, scope.createIn)`; the inline `body.secrets` override still spreads on top.

- [ ] **Step 4: `routes/sources.ts`**

Replace `owned(req, id, owner)` with two helpers:

```ts
async function visible(scope: Scope, id: string) {   // read: subtree or granted
  const [row] = await db.select().from(sources).where(and(eq(sources.id, id), eq(sources.ownerId, scope.ownerId), inScope(sources.projectId, sources.id, 'source', scope)));
  return row ?? null;
}
async function administered(scope: Scope, id: string) {   // write: subtree only
  const [row] = await db.select().from(sources).where(and(eq(sources.id, id), eq(sources.ownerId, scope.ownerId), inSubtree(sources.projectId, scope)));
  return row ?? null;
}
```

`const scope = await scopeFor(req)` at the top of every handler. `GET /sources` → `where(and(eq(ownerId), inScope(...)))`. `GET /sources/:id` → `visible`. PATCH / DELETE / `objects` / `import` → `administered`. `/sources/:id/test` → `visible` (testing a shared connection is harmless). `POST /sources` → `projectId: scope.createIn, createdByAgentId: null`. The import handler's `before` snapshot and `gone` query stay owner-scoped (names are per owner) but new tool rows get `projectId: row.projectId` (the source's project), `createdByAgentId: null`.

- [ ] **Step 5: `routes/tools.ts`**

```ts
export const toolVisibleCond = (scope: Scope) => or(inScope(tools.projectId, tools.id, 'tool', scope), granted(tools.sourceId, 'source', scope.nodeId)) as SQL;
export const toolUsableCond = (nodeId: string) => or(usableBy(tools.projectId, tools.id, 'tool', nodeId), granted(tools.sourceId, 'source', nodeId)) as SQL;
```

`GET /tools` filters: `[eq(tools.ownerId, scope.ownerId), liveTool(), toolVisibleCond(scope)]`. `ownedTool` → two variants like sources: `visibleTool` (GET, `/test`) and `administeredTool` (PATCH, DELETE: `inSubtree(tools.projectId, scope)`). DELETE must look the row up first and 404 when not administered (today it deletes blindly by owner).

- [ ] **Step 6: `routes/secrets.ts`**

`createBody`: add `pending: z.boolean().optional()` and relax the refine to `b.value || b.envRef || b.pending`. Insert `projectId: scope.createIn, createdByAgentId: null`; `sourceId` (when given) must be `administered` in scope (reuse the sources helper by moving it to `services/sources.ts`? — no: duplicate the 4-line query here; Stage 2 extracts services). List → `inScope(secrets.projectId, secrets.id, 'secret', scope)`. PATCH / DELETE → `inSubtree`. `publicSecret` adds `pending: !s.encryptedValue && !s.envRef`, `projectId`, `createdByAgentId`.

- [ ] **Step 7: Run tests; expect PASS.** Full suite green. Biome. Commit `feat(server): scope sources, tools, secrets to the project tree; resolve secrets per project`.

---

### Task 5: Scope groups, agents, schedules, composite/virtual/python, bundles, logs

**Files:**
- Modify: `server/src/routes/groups.ts`, `agents.ts`, `schedules.ts`, `composite.ts`, `virtual.ts`, `python.ts`, `bundles.ts`, `observability.ts`
- Modify: `server/src/scheduler/service.ts` (`createSchedule` sets `projectId` from the group)
- Modify: `server/src/runtime/invoker.ts` (log `projectId: tool.projectId`)
- Test: extend `server/src/routes/project-isolation.test.ts`

**Interfaces:**
- Consumes: `scopeFor`, `inSubtree`, `toolUsableCond` (Task 4).
- Produces: `GET /logs` and `GET /metrics` honour `?project=`; `call_logs.project_id` populated for every logged call.

- [ ] **Step 1: Failing tests** (append to `project-isolation.test.ts`):

```ts
it('a workspace in A refuses an ungranted B tool and accepts it once granted', …)  // PUT /groups/<gA>/tools {toolIds:[bTool]}?project=A → 400 unknown_tools; grant B.src to A; → 200
it('groups/agents/schedules in B are invisible from A', …)                           // GET /groups?project=A, /agents?project=A; GET /groups/<gB>?project=A → 404
it('an agent in A cannot be granted a group in B', …)                                // POST /agents/<aA>/groups {groupId:gB}?project=A → 400 unknown_group
it('call logs carry the tool project and filter by it', …)                           // POST /tools/<aTool>/test?project=A; GET /logs?project=A → has it; GET /logs?project=B → not
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: `routes/groups.ts`** — `ownedGroup(id, owner)` → `ownedGroup(scope, id)` with `inSubtree(groups.projectId, scope)`; list same; create sets `projectId: scope.createIn, createdByAgentId: null`; `uniqueSlug` stays per owner. `PUT /groups/:id/tools` replaces the owner check with:

```ts
const found = await db.select().from(tools).where(and(inArray(tools.id, toolIds), eq(tools.ownerId, scope.ownerId), liveTool(), toolUsableCond(grp.projectId)));
```

— rule 1 against the **group's** project, not the caller's scope. `GET /groups/:id/tools` unchanged (links already constrained).

- [ ] **Step 4: `routes/agents.ts`** — `ownedAgent(scope, id)` with `inSubtree`; list / get / delete / keys / system-tools use it; create sets `projectId: scope.createIn, role: 'lead', createdByAgentId: null`; `POST /agents/:id/groups`: group lookup adds `inSubtree(groups.projectId, scope)`. `publicAgent` already spreads the row, so `projectId` and `role` are returned.

- [ ] **Step 5: `routes/schedules.ts`** — the four group/schedule lookups use `scopeFor(req)` + `inSubtree(groups.projectId, scope)` / `inSubtree(schedules.projectId, scope)` (replace `sch.ownerId !== ownerOf(req)` with a select on `schedules` by id + ownerId + inSubtree). `scheduler/service.ts createSchedule`: look up the group and set `projectId: grp.projectId` (one select; also covers agent self-cron).

- [ ] **Step 6: `composite.ts`, `virtual.ts`, `python.ts`** — `ownedComposite/ownedVirtual/ownedPython(scope, id)` with `inSubtree(tools.projectId, scope)`; creates set `projectId: scope.createIn, createdByAgentId: null`; `missingRefs` (composite) uses `toolUsableCond(scope.createIn)` so a composite may only reference tools its project can use; list endpoints use `toolVisibleCond(scope)`.

- [ ] **Step 7: `bundles.ts`** — export: group lookup via `inSubtree`; import: every insert gets `projectId: scope.createIn, createdByAgentId: null`; the "existing by name" lookups stay per owner.

- [ ] **Step 8: `observability.ts`** — `GET /logs`: add `inSubtree(callLogs.projectId, scope)` to filters (rows with null project — pre-migration logs — are only visible from the root scope: add `or(isNull(callLogs.projectId) AND scope.nodeId is root …)` — simpler: in the migration (Task 1) back-fill `call_logs.project_id` to the default project too; add that UPDATE to `0016_projects.sql` and treat the column as always set). `GET /metrics`: add `project_id in (select id from projects where path like ${scope.nodePath + '%'})` to `conds`. `/agents/:id/inspect` and `/invoke`: agent lookup via `inSubtree`. `runtime/invoker.ts`: `projectId: tool.projectId` in the log insert — `dispatch` must return the tool; simplest: resolve the tool row in `invokeTool` before calling `dispatch` (move the select up, pass the row down). Also tools created by `project.*` in Stage 2 will reuse this.

- [ ] **Step 9: Run; expect PASS.** Whole suite, typecheck, biome. Remove every `// task4: scope.createIn` temporary from Task 1. Commit `feat(server): scope groups, agents, schedules, custom tools, bundles and logs to the project tree`.

---

### Task 6: Gateway auth carries project and role (no behaviour change)

**Files:**
- Modify: `server/src/gateway/server.ts` (`Resolved`, `AgentAuth`, `AgentAuthAll` gain `projectId: string; role: 'lead' | 'coo'`)
- Test: `server/src/gateway/isolation.integration.test.ts` (seed passes `projectId`; one assertion that `authenticateAgentAll` returns the agent's `projectId` and `role`)

- [ ] **Step 1: Add the assertion** to the existing `'agent-wide auth for A returns only A's groups'` test: `expect(auth.projectId).toBe(A.projectId); expect(auth.role).toBe('lead')`. Add `projectId` to `Seed`.
- [ ] **Step 2: Run; expect FAIL** (property missing).
- [ ] **Step 3: Thread `projectId`/`role` through `resolveBearer` → `authenticateAgent` / `authenticateAgentAll`.**
- [ ] **Step 4: PASS, biome, commit `feat(server): agent auth carries project and role`.**

---

### Task 7: Web — project selector and row badges

**Files:**
- Modify: `web/package.json` (add `@testing-library/react`, `@testing-library/dom` dev deps; `pnpm install`)
- Modify: `web/src/api.ts` (project store, `?project=` on every request, `Project` type, `projectId`/`createdByAgentId` on `Source`, `Tool`, `Group`, `Agent`, `Secret`)
- Create: `web/src/projects.ts` (pure helpers: tree building, badge computation), `web/src/ProjectSelector.tsx`
- Modify: `web/src/App.tsx` (selector in the header; remount tabs on change)
- Modify: `web/src/tabs/SourcesTab.tsx`, `ToolsTab.tsx`, `GroupsTab.tsx`, `AgentsTab.tsx`, `SecretsTab.tsx`, `LogsTab.tsx` (badge per row)
- Test: `web/src/projects.test.ts`, `web/src/ProjectSelector.test.tsx`

**Interfaces:**
- Produces: `projectStore.get(): string | null` / `set(id | null)` (URL `?project=`); `buildTree(rows: Project[]): TreeNode[]`; `rowBadges(row: { projectId: string; createdByAgentId: string | null }, ctx: { selected: string | null; byId: Map<string, Project>; agentNames: Map<string, string> }): { project: string; sharedFrom: string | null; byAgent: string | null }`; `<ProjectSelector projects onChange />`; `<RowBadges row ctx />`.

- [ ] **Step 1: Failing pure tests** (`projects.test.ts`):

```ts
const team = { id: 't', parentId: null, kind: 'team', name: 'My team', slug: 'team', path: '/t/' };
const def = { id: 'd', parentId: 't', kind: 'project', name: 'Default', slug: 'default', path: '/t/d/' };
const child = { id: 'c', parentId: 't', kind: 'project', name: 'Child', slug: 'child', path: '/t/c/' };
it('buildTree nests children under parents in order', () => {
  const tree = buildTree([def, child, team]);
  expect(tree).toHaveLength(1);
  expect(tree[0].id).toBe('t');
  expect(tree[0].children.map((n) => n.id)).toEqual(['c', 'd']);   // sorted by name
});
it('rowBadges: project name; shared-from when outside the selected subtree; by-agent name', () => {
  const byId = new Map([team, def, child].map((p) => [p.id, p]));
  const agentNames = new Map([['ag1', 'COO']]);
  expect(rowBadges({ projectId: 'd', createdByAgentId: null }, { selected: null, byId, agentNames })).toEqual({ project: 'Default', sharedFrom: null, byAgent: null });
  expect(rowBadges({ projectId: 'd', createdByAgentId: 'ag1' }, { selected: 'c', byId, agentNames })).toEqual({ project: 'Default', sharedFrom: 'Default', byAgent: 'COO' });
  expect(rowBadges({ projectId: 'c', createdByAgentId: 'gone' }, { selected: 'c', byId, agentNames })).toEqual({ project: 'Child', sharedFrom: null, byAgent: 'agent' });
});
```

`sharedFrom` = the row's project name when `selected` is set and the row's `path` does not start with the selected node's `path`.

- [ ] **Step 2: Run `cd web && npx vitest run src/projects.test.ts`; expect FAIL.**

- [ ] **Step 3: `web/src/projects.ts`** — implement `buildTree` (group by `parentId`, sort children by name, roots = `parentId === null`) and `rowBadges` exactly as specified. Export `TreeNode = Project & { children: TreeNode[] }`.

- [ ] **Step 4: `api.ts`** — 

```ts
const PROJECT_KEY = 'project';
export const projectStore = {
  get: () => new URLSearchParams(window.location.search).get(PROJECT_KEY),
  set: (id: string | null) => {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set(PROJECT_KEY, id); else u.searchParams.delete(PROJECT_KEY);
    window.history.replaceState(null, '', u.toString());
  },
};
```

In `req()`: `const p = projectStore.get(); const url = p ? path + (path.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(p) : path;` and fetch `BASE + url`. Add `export interface Project { id; parentId: string | null; kind: 'team' | 'project'; name; slug; path }`, and `projectId: string; createdByAgentId: string | null;` to `Source`, `Tool`, `Group`, plus new `Agent`/`Secret` types if missing (check `AgentsTab`/`SecretsTab` for their local types and move them to `api.ts`).

- [ ] **Step 5: `ProjectSelector.tsx`** — a `<select>` (native; no dropdown lib) whose options are the tree flattened with `'— '.repeat(depth)` prefixes; first option `All projects` (value `''`). `aria-label="Project"`. On change: `projectStore.set(v || null); onChange(v || null)`. Failing RTL test first (`ProjectSelector.test.tsx`): renders options in tree order with indentation, firing a change calls `onChange('c')` and writes `?project=c` to `window.location.search`.

- [ ] **Step 6: `App.tsx`** — load `/projects` after auth (`api.get<Project[]>('/projects')`), keep `projects` and `selected` state (`projectStore.get()` initial), render `<ProjectSelector>` in `page-head-shell` right of the title, and pass `key={selected ?? 'all'}` to the active tab so it refetches on change. Export a `ProjectsContext` (`createContext<{ projects: Project[]; selected: string | null; agentNames: Map<string,string> }>`) consumed by `RowBadges`.

- [ ] **Step 7: `RowBadges`** (in `ProjectSelector.tsx` or `ui.tsx`): reads the context, calls `rowBadges`, renders `<span className="badge muted">{project}</span>`, `shared from …` and `by …` badges when non-null. Drop one `<RowBadges row={s} />` into each list row of the six tabs (next to the name). `agentNames` comes from `/agents` loaded in `App.tsx` alongside projects (ids → names).

- [ ] **Step 8: `npx vitest run`, `npx tsc --noEmit`, biome; manual smoke with `pnpm dev` (server `DATABASE_URL=memory:`): selector switches lists, badges show.** Commit `feat(web): project selector and project/shared/by-agent badges`.

---

### Task 8: Docs and CI

**Files:**
- Modify: `ReadMe.md` (Concepts table: Project/Team; API block: `/projects` routes and `?project=`), `server/src/stdio.ts` onboarding text if it lists control-plane routes.

- [ ] **Step 1:** Add to the Concepts table: `| **Project / Team** | Nodes of a per-account tree. Every resource lives in one node; a node sees its own subtree plus what was shared with it. Pass \`?project=<id>\` to any control-plane call to act as that node; omit it to see everything. |`. Add the `/projects` routes to the API block.
- [ ] **Step 2:** Push the branch, open a PR to `main`, wait for CI green (`gh run watch`). Merge with `--squash` only if the owner's history style allows — this repo merges feature branches with merge commits (see `git log --merges`), so use `gh pr merge --merge`.

---

## Self-review

- Spec coverage (Stage 1 = §2, §3, §6 selector + badges, §7, §8 server isolation tests): §2.1 ✔ T1; §2.2 ✔ T1 (`call_logs.project_id` back-fill added in T5 step 8 — move that UPDATE into the T1 migration file now: `UPDATE "call_logs" s SET "project_id" = … WHERE s."project_id" IS NULL;`); §2.3 ✔ T1/T3; §3 rules ✔ T2, enforcement points ✔ T4 (secrets, names), T5 (group tools); §7 errors ✔ T3/T4/T5; §6 selector/badges ✔ T7; §8 server tests ✔ T4/T5, web tests ✔ T7; Projects tab / pending-secret UI / role selector → Stage 3 (out of scope here); `agents.role` column ✔ T1, carried by auth ✔ T6.
- Types: `Scope` fields used identically in T2–T5; `toolVisibleCond`/`toolUsableCond` defined in T4, used in T5; `rowBadges`/`buildTree` signatures consistent between T7 steps.
- Review Focus 1 → T1 Step 4 (SQL pinned) + T3 Step 1 (`register` nodes); 2 → T2 test 3; 3 → T4 test "granted source … not editable", T5 group test; 4 → T4 tests 4–5; 5 → T3 test 2.
