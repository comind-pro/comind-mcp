import { createContext, useContext } from 'react';
import { type Project, projectStore } from './api.js';
import { buildTree, rowBadges, type TreeNode } from './projects.js';

export const ProjectsContext = createContext<{
  projects: Project[];
  selected: string | null;
  agentNames: Map<string, string>;
}>({ projects: [], selected: null, agentNames: new Map() });

function flatten(nodes: TreeNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((n) => [{ id: n.id, label: '— '.repeat(depth) + n.name }, ...flatten(n.children, depth + 1)]);
}

export function ProjectSelector({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      aria-label="Project"
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value || null;
        projectStore.set(v);
        onChange(v);
      }}
    >
      <option value="">All projects</option>
      {flatten(buildTree(projects)).map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function RowBadges({ row }: { row: { projectId: string; createdByAgentId: string | null } }) {
  const { projects, selected, agentNames } = useContext(ProjectsContext);
  if (!projects.length) return null;
  const b = rowBadges(row, { selected, byId: new Map(projects.map((p) => [p.id, p])), agentNames });
  return (
    <span className="row-badges">
      <span className="badge muted">{b.project}</span>
      {b.sharedFrom && (
        <span className="badge" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
          shared from {b.sharedFrom}
        </span>
      )}
      {b.byAgent && <span className="badge muted">by {b.byAgent}</span>}
    </span>
  );
}
