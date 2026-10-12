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
