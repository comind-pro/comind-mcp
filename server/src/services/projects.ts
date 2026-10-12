import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectAccess, projects, secrets, sources, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { inScope, inSubtree, type Scope, underPath } from '../lib/scope.js';

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
): Promise<ProjectRow | 'not_found' | 'slug_taken'> {
  const parent = await visibleNode(scope, input.parentId);
  if (!parent) return 'not_found';
  const slug = slugify(input.slug ?? input.name);
  const [clash] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, scope.ownerId), eq(projects.slug, slug)));
  if (clash) return 'slug_taken';
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
): Promise<'ok' | 'not_found'> {
  if (!(await visibleNode(scope, g.projectId))) return 'not_found';
  await db
    .delete(projectAccess)
    .where(
      and(
        eq(projectAccess.projectId, g.projectId),
        eq(projectAccess.resourceType, g.resourceType),
        eq(projectAccess.resourceId, g.resourceId),
      ),
    );
  return 'ok';
}

export async function listAccess(scope: Scope, projectId: string) {
  if (!(await visibleNode(scope, projectId))) return null;
  return db.select().from(projectAccess).where(eq(projectAccess.projectId, projectId));
}
