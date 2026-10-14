import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, groupTools, liveTool, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { inSubtree, type Scope } from '../lib/scope.js';
import { NOT_FOUND, type ServiceErr, type ToolRow } from './sources.js';
import { toolUsableCond } from './tools.js';

export type GroupRow = typeof groups.$inferSelect;

async function uniqueSlug(base: string, owner: string): Promise<string> {
  const slug = slugify(base);
  const [clash] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.slug, slug), eq(groups.ownerId, owner)));
  if (!clash) return slug;
  return `${slug}-${newId().slice(0, 4).toLowerCase()}`;
}

/** A group in the scope's subtree (groups are never shared). */
export async function ownedGroup(scope: Scope, id: string): Promise<GroupRow | null> {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.ownerId, scope.ownerId), inSubtree(groups.projectId, scope)));
  return row ?? null;
}

export async function createGroup(
  scope: Scope,
  input: { name: string; slug?: string; description?: string; schedulingEnabled?: boolean; compactResults?: boolean },
  createdByAgentId: string | null,
): Promise<GroupRow> {
  const row = {
    id: newId(),
    ownerId: scope.ownerId,
    projectId: scope.createIn,
    createdByAgentId,
    slug: await uniqueSlug(input.slug ?? input.name, scope.ownerId),
    name: input.name,
    description: input.description ?? null,
    schedulingEnabled: input.schedulingEnabled ?? true,
    compactResults: input.compactResults ?? true,
    createdAt: new Date(),
  };
  await db.insert(groups).values(row);
  return row;
}

/** Tool ids (of `toolIds`) the group's own project may not use (rule 1). */
async function unusable(scope: Scope, grp: GroupRow, toolIds: string[]): Promise<string[]> {
  if (!toolIds.length) return [];
  const found = await db
    .select({ id: tools.id })
    .from(tools)
    .where(
      and(inArray(tools.id, toolIds), eq(tools.ownerId, scope.ownerId), liveTool(), toolUsableCond(grp.projectId)),
    );
  return toolIds.filter((t) => !found.some((f) => f.id === t));
}

const linkedIds = async (groupId: string) =>
  (await db.select().from(groupTools).where(eq(groupTools.groupId, groupId))).map((l) => l.toolId);

export async function setGroupTools(
  scope: Scope,
  groupId: string,
  toolIds: string[],
): Promise<{ groupId: string; toolIds: string[] } | ServiceErr> {
  const grp = await ownedGroup(scope, groupId);
  if (!grp) return NOT_FOUND;
  const missing = await unusable(scope, grp, toolIds);
  if (missing.length) return { error: 'unknown_tools', detail: { missing } };
  await db.delete(groupTools).where(eq(groupTools.groupId, groupId));
  if (toolIds.length) await db.insert(groupTools).values(toolIds.map((toolId) => ({ groupId, toolId })));
  return { groupId, toolIds };
}

export async function addGroupTool(
  scope: Scope,
  groupId: string,
  toolId: string,
): Promise<{ groupId: string; toolIds: string[] } | ServiceErr> {
  const grp = await ownedGroup(scope, groupId);
  if (!grp) return NOT_FOUND;
  const missing = await unusable(scope, grp, [toolId]);
  if (missing.length) return { error: 'unknown_tools', detail: { missing } };
  const ids = await linkedIds(groupId);
  if (!ids.includes(toolId)) {
    await db.insert(groupTools).values({ groupId, toolId });
    ids.push(toolId);
  }
  return { groupId, toolIds: ids };
}

export async function listGroupTools(scope: Scope, groupId: string): Promise<ToolRow[] | ServiceErr> {
  if (!(await ownedGroup(scope, groupId))) return NOT_FOUND;
  const ids = await linkedIds(groupId);
  if (!ids.length) return [];
  return db
    .select()
    .from(tools)
    .where(and(inArray(tools.id, ids), liveTool()));
}
