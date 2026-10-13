import type { Project } from './api.js';

export type TreeNode = Project & { children: TreeNode[] };

export function buildTree(rows: Project[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n); // unknown parent => root
  }
  const sort = (l: TreeNode[]) => {
    l.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of l) sort(n.children);
  };
  sort(roots);
  return roots;
}

export interface BadgeCtx {
  selected: string | null;
  byId: Map<string, Project>;
  agentNames: Map<string, string>;
}

export function rowBadges(
  row: { projectId: string; createdByAgentId: string | null },
  ctx: BadgeCtx,
): { project: string; sharedFrom: string | null; byAgent: string | null } {
  const p = ctx.byId.get(row.projectId);
  const project = p?.name ?? row.projectId;
  const sel = ctx.selected ? ctx.byId.get(ctx.selected) : undefined;
  const sharedFrom = sel && p && !p.path.startsWith(sel.path) ? project : null;
  const byAgent = row.createdByAgentId ? (ctx.agentNames.get(row.createdByAgentId) ?? 'agent') : null;
  return { project, sharedFrom, byAgent };
}

/** The selected project id if it is among the loaded nodes, else null (stale/foreign `?project=`). */
export const knownProject = (rows: Project[], id: string | null): string | null =>
  id && rows.some((p) => p.id === id) ? id : null;
