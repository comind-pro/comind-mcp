import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '../db/client.js';
import { projectAccess, projects, sources, users } from '../db/schema.js';
import { ensureDefaultNodes, nodePath } from '../services/projects.js';
import { newId } from './id.js';
import { inScope, inSubtree, scopeForOwner, usableBy } from './scope.js';

const owner = newId();
let teamId: string;
let defaultId: string;
let childId: string;
const srcDefault = newId();
const srcChild = newId();

const mkSource = (id: string, projectId: string) =>
  db
    .insert(sources)
    .values({ id, ownerId: owner, projectId, name: id, kind: 'http', config: {}, createdAt: new Date() });

describe('scope helpers', () => {
  beforeAll(async () => {
    await runMigrations();
    await db.insert(users).values({ id: owner, email: `${owner}@t.local`, passwordHash: 'x', createdAt: new Date() });
    ({ teamId, projectId: defaultId } = await ensureDefaultNodes(owner));
    const [team] = await db.select().from(projects).where(eq(projects.id, teamId));
    childId = newId();
    await db.insert(projects).values({
      id: childId,
      ownerId: owner,
      parentId: teamId,
      kind: 'project',
      name: 'c',
      slug: 'c',
      path: nodePath(team.path, childId),
      createdAt: new Date(),
    });
    await mkSource(srcDefault, defaultId);
    await mkSource(srcChild, childId);
  });
  afterAll(() => db.delete(users).where(eq(users.id, owner)));

  const names = async (cond: ReturnType<typeof inSubtree>) =>
    (
      await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.ownerId, owner), cond))
    )
      .map((r) => r.id)
      .sort();

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
    await db.insert(projectAccess).values({
      projectId: childId,
      resourceType: 'source',
      resourceId: srcDefault,
      grantedBy: null,
      createdAt: new Date(),
    });
    const child = (await scopeForOwner(owner, childId))!;
    expect(await names(inSubtree(sources.projectId, child))).toEqual([srcChild]);
    expect(await names(inScope(sources.projectId, sources.id, 'source', child))).toEqual([srcChild, srcDefault].sort());
    expect(await names(usableBy(sources.projectId, sources.id, 'source', childId))).toEqual(
      [srcChild, srcDefault].sort(),
    );
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
