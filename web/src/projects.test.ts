import { describe, expect, it } from 'vitest';
import { buildTree, knownProject, rowBadges } from './projects.js';

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
