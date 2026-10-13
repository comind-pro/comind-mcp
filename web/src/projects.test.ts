import { describe, expect, it } from 'vitest';
import type { AccessRow, Project, ProjectSummary } from './api.js';
import { buildTree, deleteConfirmText, grantCandidates, knownProject, revokeWarnText, rowBadges } from './projects.js';

const team = { id: 't', parentId: null, kind: 'team', name: 'My team', slug: 'team', path: '/t/' } as const;
const def = { id: 'd', parentId: 't', kind: 'project', name: 'Default', slug: 'default', path: '/t/d/' } as const;
const child = { id: 'c', parentId: 't', kind: 'project', name: 'Child', slug: 'child', path: '/t/c/' } as const;

describe('projects', () => {
  it('buildTree nests children under parents in order', () => {
    const tree = buildTree([def, child, team]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('t');
    expect(tree[0].children.map((n) => n.id)).toEqual(['c', 'd']);
  });
  it('knownProject drops a stale or foreign id', () => {
    expect(knownProject([team, def], 'd')).toBe('d');
    expect(knownProject([team, def], 'gone')).toBeNull();
    expect(knownProject([team, def], null)).toBeNull();
  });
  it('rowBadges: project name; shared-from when outside the selected subtree; by-agent name', () => {
    const byId = new Map<string, any>([team, def, child].map((p) => [p.id, p]));
    const agentNames = new Map([['ag1', 'COO']]);
    expect(rowBadges({ projectId: 'd', createdByAgentId: null }, { selected: null, byId, agentNames })).toEqual({
      project: 'Default',
      sharedFrom: null,
      byAgent: null,
    });
    expect(rowBadges({ projectId: 'd', createdByAgentId: 'ag1' }, { selected: 'c', byId, agentNames })).toEqual({
      project: 'Default',
      sharedFrom: 'Default',
      byAgent: 'COO',
    });
    expect(rowBadges({ projectId: 'c', createdByAgentId: 'gone' }, { selected: 'c', byId, agentNames })).toEqual({
      project: 'Child',
      sharedFrom: null,
      byAgent: 'agent',
    });
  });
});

const projects: Project[] = [
  { id: 't', parentId: null, kind: 'team', name: 'My team', slug: 'team', path: '/t/' },
  { id: 'a', parentId: 't', kind: 'project', name: 'Analytics', slug: 'analytics', path: '/t/a/' },
  { id: 'a2', parentId: 'a', kind: 'project', name: 'Sub', slug: 'sub', path: '/t/a/a2/' },
  { id: 'o', parentId: 't', kind: 'project', name: 'Other', slug: 'other', path: '/t/o/' },
];
const row = (over: Partial<AccessRow>): AccessRow => ({
  resourceType: 'source',
  resourceId: 'x',
  name: 'x',
  fromProjectId: 'o',
  grantedBy: null,
  usedBy: [],
  ...over,
});

it('grantCandidates drops own-subtree and already-granted resources', () => {
  const all = [
    { type: 'source' as const, id: 's-own', name: 'own', projectId: 'a' },
    { type: 'source' as const, id: 's-sub', name: 'sub', projectId: 'a2' },
    { type: 'source' as const, id: 's-other', name: 'other', projectId: 'o' },
    { type: 'tool' as const, id: 't-team', name: 'team tool', projectId: 't' },
    { type: 'tool' as const, id: 't-granted', name: 'granted', projectId: 'o' },
  ];
  const access = [row({ resourceType: 'tool', resourceId: 't-granted' })];
  expect(grantCandidates(all, access, projects[1], projects).map((c) => c.id)).toEqual(['s-other', 't-team']);
});

it('grantCandidates does not treat a sibling with a shared path prefix as own', () => {
  const ps = [
    ...projects,
    { id: 'ab', parentId: 't', kind: 'project', name: 'AB', slug: 'ab', path: '/t/ab/' } as Project,
  ];
  const all = [{ type: 'secret' as const, id: 'k', name: 'k', projectId: 'ab' }];
  expect(grantCandidates(all, [], ps[1], ps)).toHaveLength(1);
});

it('deleteConfirmText pluralises the counts', () => {
  const s: ProjectSummary = {
    node: projects[1],
    counts: { children: 1, sources: 2, tools: 5, groups: 1, agents: 1, secrets: 1 },
    cooAgents: [],
  };
  expect(deleteConfirmText(s)).toBe(
    'Delete "Analytics"? This removes 1 descendant, 2 sources, 5 tools, 1 workspace, 1 agent, 1 secret.',
  );
  s.counts = { children: 2, sources: 0, tools: 1, groups: 2, agents: 0, secrets: 3 };
  expect(deleteConfirmText(s)).toBe(
    'Delete "Analytics"? This removes 2 descendants, 0 sources, 1 tool, 2 workspaces, 0 agents, 3 secrets.',
  );
});

it('revokeWarnText names the workspaces that lose the resource', () => {
  expect(revokeWarnText(row({}))).toBeNull();
  expect(
    revokeWarnText(
      row({
        usedBy: [
          { groupId: 'g1', name: 'X' },
          { groupId: 'g2', name: 'Y' },
        ],
      }),
    ),
  ).toBe('Workspaces X, Y will lose its tools.');
});
