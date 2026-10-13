import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agents,
  groups,
  groupTools,
  liveTool,
  projectAccess,
  projects,
  secrets,
  sources,
  tools,
} from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { inScope, inSubtree, type Scope, underPath } from '../lib/scope.js';
import { toolUsableCond } from './tools.js';

export const nodePath = (parentPath: string | null, id: string): string => `${parentPath ?? '/'}${id}/`;

/** The owner's root team and default project, created on first use. Idempotent. */
export async function ensureDefaultNodes(ownerId: string): Promise<{ teamId: string; projectId: string }> {
  let [team] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.kind, 'team'), eq(projects.slug, 'team')));
  if (!team) {
    const id = newId();
    team = {
      id,
      ownerId,
      parentId: null,
      kind: 'team',
      name: 'My team',
      slug: 'team',
      path: nodePath(null, id),
      createdAt: new Date(),
    };
    await db.insert(projects).values(team);
  }
  let [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.kind, 'project'), eq(projects.slug, 'default')));
  if (!proj) {
    const id = newId();
    proj = {
      id,
      ownerId,
      parentId: team.id,
      kind: 'project',
      name: 'Default',
      slug: 'default',
      path: nodePath(team.path, id),
      createdAt: new Date(),
    };
    await db.insert(projects).values(proj);
  }
  return { teamId: team.id, projectId: proj.id };
}

export type ProjectRow = typeof projects.$inferSelect;
type ResType = 'source' | 'tool' | 'secret';

const visibleNode = async (scope: Scope, id: string): Promise<ProjectRow | undefined> =>
  (
    await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)))
  )[0];

export async function listNodes(scope: Scope): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
}

export async function createNode(
  scope: Scope,
  input: { kind: 'team' | 'project'; name: string; slug?: string; parentId: string },
): Promise<ProjectRow | 'not_found'> {
  const parent = await visibleNode(scope, input.parentId);
  if (!parent) return 'not_found';
  let slug = slugify(input.slug ?? input.name);
  const [clash] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, scope.ownerId), eq(projects.slug, slug)));
  // same as groups' uniqueSlug; also keeps 'team'/'default' unique for the default-node guard
  if (clash) slug = `${slug}-${newId().slice(0, 4).toLowerCase()}`;
  const id = newId();
  const row = {
    id,
    ownerId: scope.ownerId,
    parentId: parent.id,
    kind: input.kind,
    name: input.name,
    slug,
    path: nodePath(parent.path, id),
    createdAt: new Date(),
  };
  await db.insert(projects).values(row);
  return row;
}

export async function deleteNode(scope: Scope, id: string): Promise<'ok' | 'not_found' | 'default_node'> {
  const node = await visibleNode(scope, id);
  if (!node) return 'not_found';
  if ((node.kind === 'team' && node.slug === 'team') || (node.kind === 'project' && node.slug === 'default'))
    return 'default_node';
  // resources cascade from each node; descendants are deleted by path
  await db.delete(projects).where(and(eq(projects.ownerId, scope.ownerId), underPath(projects.path, node.path)));
  return 'ok';
}

/** Does the scope see this resource (rule 2 or a grant to its node)? */
export async function canSee(scope: Scope, type: ResType, id: string): Promise<boolean> {
  let row: unknown;
  switch (type) {
    case 'source':
      [row] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.id, id),
            eq(sources.ownerId, scope.ownerId),
            inScope(sources.projectId, sources.id, 'source', scope),
          ),
        );
      break;
    case 'tool':
      [row] = await db
        .select({ id: tools.id })
        .from(tools)
        .where(
          and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), inScope(tools.projectId, tools.id, 'tool', scope)),
        );
      break;
    case 'secret':
      [row] = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.id, id),
            eq(secrets.ownerId, scope.ownerId),
            inScope(secrets.projectId, secrets.id, 'secret', scope),
          ),
        );
  }
  return !!row;
}

export async function grantAccess(
  scope: Scope,
  g: { projectId: string; resourceType: ResType; resourceId: string; grantedBy: string | null },
): Promise<'ok' | 'not_found' | 'not_visible'> {
  if (!(await visibleNode(scope, g.projectId))) return 'not_found';
  if (!(await canSee(scope, g.resourceType, g.resourceId))) return 'not_visible';
  await db
    .insert(projectAccess)
    .values({ ...g, createdAt: new Date() })
    .onConflictDoNothing();
  return 'ok';
}

export async function revokeAccess(
  scope: Scope,
  g: { projectId: string; resourceType: ResType; resourceId: string },
): Promise<{ unlinked: number } | 'not_found'> {
  const node = await visibleNode(scope, g.projectId);
  if (!node) return 'not_found';
  await db
    .delete(projectAccess)
    .where(
      and(
        eq(projectAccess.projectId, g.projectId),
        eq(projectAccess.resourceType, g.resourceType),
        eq(projectAccess.resourceId, g.resourceId),
      ),
    );
  if (g.resourceType === 'secret') return { unlinked: 0 };
  // Drop workspace links (in the grantee's subtree) the tool is no longer usable for.
  const toolCond = g.resourceType === 'source' ? eq(tools.sourceId, g.resourceId) : eq(tools.id, g.resourceId);
  const links = await db
    .select({ groupId: groupTools.groupId, toolId: groupTools.toolId, projectId: groups.projectId })
    .from(groupTools)
    .innerJoin(groups, eq(groups.id, groupTools.groupId))
    .innerJoin(tools, eq(tools.id, groupTools.toolId))
    .where(
      and(
        eq(groups.ownerId, scope.ownerId),
        inArray(
          groups.projectId,
          db.select({ id: projects.id }).from(projects).where(underPath(projects.path, node.path)),
        ),
        toolCond,
      ),
    );
  let unlinked = 0;
  for (const l of links) {
    const [ok] = await db
      .select({ id: tools.id })
      .from(tools)
      .where(and(eq(tools.id, l.toolId), toolUsableCond(l.projectId)));
    if (ok) continue;
    await db.delete(groupTools).where(and(eq(groupTools.groupId, l.groupId), eq(groupTools.toolId, l.toolId)));
    unlinked++;
  }
  return { unlinked };
}

export async function listAccess(scope: Scope, projectId: string) {
  if (!(await visibleNode(scope, projectId))) return null;
  return db.select().from(projectAccess).where(eq(projectAccess.projectId, projectId));
}

/** What deleteNode would remove: the node, its descendants and everything in them. No writes. */
export async function previewDelete(scope: Scope, id: string) {
  const node = await visibleNode(scope, id);
  if (!node) return 'not_found' as const;
  const ids = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.ownerId, scope.ownerId), underPath(projects.path, node.path)))
  ).map((r) => r.id);
  const count = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    nodes: ids.length,
    sources: await count(db.select({ id: sources.id }).from(sources).where(inArray(sources.projectId, ids))),
    tools: await count(
      db
        .select({ id: tools.id })
        .from(tools)
        .where(and(inArray(tools.projectId, ids), liveTool())),
    ),
    groups: await count(db.select({ id: groups.id }).from(groups).where(inArray(groups.projectId, ids))),
    agents: await count(db.select({ id: agents.id }).from(agents).where(inArray(agents.projectId, ids))),
    secrets: await count(db.select({ id: secrets.id }).from(secrets).where(inArray(secrets.projectId, ids))),
  };
}

/** Workspaces under the grantee node that hold tools of the resource (a source's
 *  native tools, or the tool itself) — what revoking the grant would affect. No writes. */
export async function previewRevoke(scope: Scope, g: { projectId: string; resourceType: ResType; resourceId: string }) {
  const node = await visibleNode(scope, g.projectId);
  if (!node) return 'not_found' as const;
  if (g.resourceType === 'secret') return { workspaces: [] };
  const toolCond = g.resourceType === 'source' ? eq(tools.sourceId, g.resourceId) : eq(tools.id, g.resourceId);
  const rows = await db
    .select({ id: groups.id, slug: groups.slug, name: groups.name, tool: tools.name })
    .from(groupTools)
    .innerJoin(groups, eq(groups.id, groupTools.groupId))
    .innerJoin(tools, eq(tools.id, groupTools.toolId))
    .where(
      and(
        eq(groups.ownerId, scope.ownerId),
        inArray(
          groups.projectId,
          db.select({ id: projects.id }).from(projects).where(underPath(projects.path, node.path)),
        ),
        toolCond,
        liveTool(),
      ),
    );
  const byGroup = new Map<string, { id: string; slug: string; name: string; tools: string[] }>();
  for (const r of rows) {
    const w = byGroup.get(r.id) ?? { id: r.id, slug: r.slug, name: r.name, tools: [] };
    w.tools.push(r.tool);
    byGroup.set(r.id, w);
  }
  return { workspaces: [...byGroup.values()] };
}
