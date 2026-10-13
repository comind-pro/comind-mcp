import type { AccessRow, Project, ProjectSummary, ResourceType } from './api.js';

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

export type MoveType = ResourceType | 'group' | 'agent';

export interface Candidate {
  type: MoveType;
  id: string;
  name: string;
  projectId: string;
  /** tools only: native tools move with their source */
  kind?: string;
}

/** Resources owned outside the node's subtree that the node has not been granted yet. */
export function grantCandidates(
  all: Candidate[],
  access: AccessRow[],
  node: Project,
  projects: Project[],
): Candidate[] {
  const own = new Set(projects.filter((p) => p.path.startsWith(node.path)).map((p) => p.id));
  const granted = new Set(access.map((a) => `${a.resourceType}:${a.resourceId}`));
  return all.filter((c) => !own.has(c.projectId) && !granted.has(`${c.type}:${c.id}`));
}

/** Resources not already homed in the node; a native tool only moves with its source. */
export const moveCandidates = (all: Candidate[], node: Project): Candidate[] =>
  all.filter((c) => c.projectId !== node.id && !(c.type === 'tool' && c.kind === 'native'));

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export function deleteConfirmText({ node, counts: c }: ProjectSummary): string {
  const parts = [
    n(c.children, 'descendant', 'descendants'),
    n(c.sources, 'source', 'sources'),
    n(c.tools, 'tool', 'tools'),
    n(c.groups, 'workspace', 'workspaces'),
    n(c.agents, 'agent', 'agents'),
    n(c.secrets, 'secret', 'secrets'),
  ];
  return `Delete "${node.name}"? This removes ${parts.join(', ')}.`;
}

export const revokeWarnText = (row: AccessRow): string | null =>
  row.usedBy.length ? `Workspaces ${row.usedBy.map((u) => u.name).join(', ')} will lose its tools.` : null;
