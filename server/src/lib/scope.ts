import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
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

/** `col` starts with `path` — the subtree test. starts_with() is a literal
 *  prefix match (LIKE would treat the `_` in nanoid ids as a wildcard). */
export const underPath = (col: PgColumn, path: string): SQL => sql`starts_with(${col}, ${path})`;

const subtreeIds = (scope: Scope) =>
  db.select({ id: projects.id }).from(projects).where(underPath(projects.path, scope.nodePath));

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
export function usableBy(
  projectCol: PgColumn,
  idCol: PgColumn,
  type: 'source' | 'tool' | 'secret',
  nodeId: string,
): SQL {
  return or(eq(projectCol, nodeId), granted(idCol, type, nodeId)) as SQL;
}
