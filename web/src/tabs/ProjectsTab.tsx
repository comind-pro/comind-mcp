import { useContext, useEffect, useRef, useState } from 'react';
import type { PageId } from '../App.js';
import { type AccessRow, type Agent, api, type ProjectSummary, type ResourceType } from '../api.js';
import { ProjectsContext } from '../ProjectSelector.js';
import {
  buildTree,
  type Candidate,
  deleteConfirmText,
  grantCandidates,
  type MoveType,
  moveCandidates,
  revokeWarnText,
  type TreeNode,
} from '../projects.js';
import { EmptyState, useConfirm } from '../ui.js';

const isDefaultNode = (n: { kind: string; slug: string }) =>
  (n.kind === 'team' && n.slug === 'team') || (n.kind === 'project' && n.slug === 'default');

const flatten = (nodes: TreeNode[], depth = 0): { node: TreeNode; depth: number }[] =>
  nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);

const errMsg = (e: unknown) => String((e as Error).message);

// ponytail: every call is unscoped — node management is owner-wide; a header `?project=` would 404 nodes outside it.
export function ProjectsTab({ onNavigate }: { onNavigate?: (p: PageId) => void }) {
  const { projects, selected, reload, agentNames } = useContext(ProjectsContext);
  const { confirm, element: confirmEl } = useConfirm();
  // land on something useful instead of an empty "select" panel
  const [selId, setSelId] = useState<string | null>(selected ?? buildTree(projects)[0]?.id ?? null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [all, setAll] = useState<Candidate[]>([]);
  const [grantType, setGrantType] = useState<ResourceType | ''>('');
  const [grantId, setGrantId] = useState('');
  const [moveType, setMoveType] = useState<MoveType | ''>('');
  const [moveId, setMoveId] = useState('');
  const [parentId, setParentId] = useState('');
  const [childKind, setChildKind] = useState<'project' | 'team'>('project');
  const [childName, setChildName] = useState('');
  const [err, setErr] = useState('');
  const current = useRef(selId);
  current.current = selId;

  useEffect(() => {
    api
      .getUnscoped<Agent[]>('/agents')
      .then(setAgents)
      .catch(() => {});
  }, []);

  const loadCandidates = async () => {
    type Row = { id: string; name?: string; displayName?: string | null; projectId: string; kind?: string };
    const list = (type: MoveType, path: string) =>
      api
        .getUnscoped<Row[]>(path)
        .then((rs) =>
          rs.map((r) => ({
            type,
            id: r.id,
            name: r.displayName || r.name || r.id,
            projectId: r.projectId,
            kind: r.kind,
          })),
        )
        .catch(() => [] as Candidate[]);
    await Promise.all([
      list('source', '/sources'),
      list('tool', '/tools'),
      list('secret', '/secrets'),
      list('group', '/groups'),
      list('agent', '/agents'),
    ]).then((ls) => setAll(ls.flat()));
  };

  const load = async (id: string) => {
    setErr('');
    void loadCandidates();
    try {
      const [s, a] = await Promise.all([
        api.getUnscoped<ProjectSummary>(`/projects/${id}/summary`),
        api.getUnscoped<AccessRow[]>(`/projects/${id}/access`),
      ]);
      if (current.current !== id) return; // user moved on to another node
      setSummary(s);
      setAccess(a);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  useEffect(() => {
    setSummary(null);
    setAccess([]);
    if (selId) void load(selId);
  }, [selId]);

  const node = projects.find((p) => p.id === selId) ?? null;
  const nameOf = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? id) : '—');
  const cooCount = (id: string) => agents.filter((a) => a.role === 'coo' && a.projectId === id).length;
  const candidates = node ? grantCandidates(all, access, node, projects).filter((c) => c.type === grantType) : [];
  const movable = node ? moveCandidates(all, node).filter((c) => c.type === moveType) : [];
  const roots = buildTree(projects);
  const parent = parentId || selId || roots[0]?.id || '';

  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const grant = () =>
    run(async () => {
      if (!node || !grantType || !grantId) return;
      await api.postUnscoped(`/projects/${node.id}/access`, { resourceType: grantType, resourceId: grantId });
      setGrantId('');
      await load(node.id);
    });

  const revoke = (row: AccessRow) =>
    run(async () => {
      if (!node) return;
      const warn = revokeWarnText(row);
      if (warn && !(await confirm(warn, 'Revoke'))) return;
      await api.delUnscoped(`/projects/${node.id}/access/${row.resourceType}/${row.resourceId}`);
      await load(node.id);
    });

  const addChild = () =>
    run(async () => {
      if (!parent || !childName.trim()) return;
      await api.postUnscoped('/projects', { kind: childKind, name: childName.trim(), parentId: parent });
      setChildName('');
      await reload();
      if (node) await load(node.id);
    });

  const move = () =>
    run(async () => {
      if (!node || !moveType || !moveId) return;
      await api.postUnscoped(`/projects/${node.id}/move`, { resourceType: moveType, resourceId: moveId });
      setMoveId('');
      await reload();
      await load(node.id);
    });

  const remove = () =>
    run(async () => {
      if (!node || !summary || !(await confirm(deleteConfirmText(summary), 'Delete'))) return;
      await api.delUnscoped(`/projects/${node.id}`);
      setSelId(null);
      await reload();
      void loadCandidates();
    });

  return (
    <div className="projects-layout">
      {confirmEl}
      <div className="card projects-tree">
        {flatten(buildTree(projects)).map(({ node: n, depth }) => (
          <button
            key={n.id}
            className={`ghost projects-node${n.id === selId ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            aria-current={n.id === selId ? 'true' : undefined}
            onClick={() => setSelId(n.id)}
          >
            {n.name} <span className="tbadge">{n.kind}</span>
            {cooCount(n.id) > 0 && <span className="badge muted">{cooCount(n.id)} COO</span>}
          </button>
        ))}
        <h4>Add a team or project</h4>
        <div className="hint mb-8">Teams group projects; each project keeps its own connections, tools and agents.</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label="New child parent"
            title="Inside"
            value={parent}
            onChange={(e) => setParentId(e.target.value)}
          >
            {flatten(roots).map(({ node: n, depth }) => (
              <option key={n.id} value={n.id}>
                {'— '.repeat(depth) + n.name}
              </option>
            ))}
          </select>
          <select
            aria-label="New child kind"
            value={childKind}
            onChange={(e) => setChildKind(e.target.value as 'project' | 'team')}
          >
            <option value="project">Project</option>
            <option value="team">Team</option>
          </select>
          <input
            aria-label="New child name"
            placeholder="Name"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
          />
          <button className="ghost" disabled={!childName.trim() || !parent} onClick={() => void addChild()}>
            + Add
          </button>
        </div>
      </div>
      <div>
        {err && <div className="err-msg">{err}</div>}
        {!node ? (
          <EmptyState title="Select a team or project" body="Pick one on the left to see what it holds and shares." />
        ) : (
          <div className="card">
            <div className="card-head-row">
              <h3>{node.name}</h3>
              <span className="badge muted mono">{node.slug}</span>
              <span className="tbadge">{node.kind}</span>
            </div>
            {summary && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {(
                  [
                    [summary.counts.children, 'sub-project', 'sub-projects'],
                    [summary.counts.sources, 'source', 'sources'],
                    [summary.counts.tools, 'tool', 'tools'],
                    [summary.counts.groups, 'workspace', 'workspaces'],
                    [summary.counts.agents, 'agent', 'agents'],
                    [summary.counts.secrets, 'secret', 'secrets'],
                  ] as const
                ).map(([k, one, many]) => (
                  <span key={one} className="badge muted">{`${k} ${k === 1 ? one : many}`}</span>
                ))}
              </div>
            )}

            <h4>COO agents</h4>
            <div className="hint mb-8">Agents that can administer this {node.kind} through MCP.</div>
            {summary?.cooAgents.length ? (
              <div className="row" style={{ gap: 8 }}>
                {summary.cooAgents.map((a) => (
                  <button key={a.id} className="ghost mini" onClick={() => onNavigate?.('agents')}>
                    {a.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="hint">None yet. Set an agent's role to COO on the Agents page.</div>
            )}

            <h4>Shared into this {node.kind}</h4>
            <div className="hint mb-8">Things from other projects this {node.kind} is allowed to use.</div>
            {access.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>From project</th>
                    <th>Used by workspaces</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {access.map((r) => (
                    <tr key={`${r.resourceType}:${r.resourceId}`}>
                      <td>
                        <span className="tbadge">{r.resourceType}</span>
                      </td>
                      <td>
                        {r.name}
                        {r.grantedBy && (
                          <span className="badge muted">by {agentNames.get(r.grantedBy) ?? 'agent'}</span>
                        )}
                      </td>
                      <td>{nameOf(r.fromProjectId)}</td>
                      <td>{r.usedBy.map((u) => u.name).join(', ') || '—'}</td>
                      <td>
                        <button className="ghost mini" onClick={() => void revoke(r)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint">Nothing shared yet.</div>
            )}

            <h4>Share something in</h4>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select
                aria-label="Resource type"
                value={grantType}
                onChange={(e) => {
                  setGrantType(e.target.value as ResourceType | '');
                  setGrantId('');
                }}
              >
                <option value="">Type…</option>
                <option value="source">Source</option>
                <option value="tool">Tool</option>
                <option value="secret">Secret</option>
              </select>
              <select
                aria-label="Resource"
                value={grantId}
                disabled={!grantType}
                onChange={(e) => setGrantId(e.target.value)}
              >
                <option value="">{grantType && !candidates.length ? 'Nothing to share' : 'Resource…'}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({nameOf(c.projectId)})
                  </option>
                ))}
              </select>
              <button className="btn-primary" disabled={!grantId} onClick={() => void grant()}>
                Grant
              </button>
            </div>

            <h4>Move into this {node.kind}</h4>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select
                aria-label="Move type"
                value={moveType}
                onChange={(e) => {
                  setMoveType(e.target.value as MoveType | '');
                  setMoveId('');
                }}
              >
                <option value="">Type…</option>
                <option value="source">Source</option>
                <option value="tool">Tool</option>
                <option value="secret">Secret</option>
                <option value="group">Workspace</option>
                <option value="agent">Agent</option>
              </select>
              <select
                aria-label="Move resource"
                value={moveId}
                disabled={!moveType}
                onChange={(e) => setMoveId(e.target.value)}
              >
                <option value="">{moveType && !movable.length ? 'Nothing to move' : 'Resource…'}</option>
                {movable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({nameOf(c.projectId)})
                  </option>
                ))}
              </select>
              <button className="btn-primary" disabled={!moveId} onClick={() => void move()}>
                Move
              </button>
            </div>
            <div className="hint">
              A source brings its tools and secrets; a workspace drops tools it can no longer use.
            </div>

            {!isDefaultNode(node) && (
              <div className="row" style={{ marginTop: 16 }}>
                <button className="danger" disabled={!summary} onClick={() => void remove()}>
                  Delete {node.kind}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
