import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const projects = [
  { id: 't', parentId: null, kind: 'team', name: 'My team', slug: 'team', path: '/t/' },
  { id: 'd', parentId: 't', kind: 'project', name: 'Default', slug: 'default', path: '/t/d/' },
  { id: 'a', parentId: 't', kind: 'project', name: 'Analytics', slug: 'analytics', path: '/t/a/' },
] as const;
const summary = {
  node: projects[2],
  counts: { children: 1, sources: 2, tools: 5, groups: 1, agents: 1, secrets: 1 },
  cooAgents: [{ id: 'ag1', name: 'coo-bot' }],
};
const access = [
  {
    resourceType: 'source',
    resourceId: 's1',
    name: 'Shared GA',
    fromProjectId: 'd',
    grantedBy: null,
    usedBy: [{ groupId: 'g1', name: 'Ops' }],
  },
];
const getUnscoped = vi.fn(async (p: string): Promise<unknown> => {
  if (p === '/projects/a/summary') return summary;
  if (p === '/projects/a/access') return access;
  if (p === '/projects/d/summary') return { ...summary, node: projects[1], cooAgents: [] };
  if (p === '/agents') return [{ id: 'ag1', name: 'coo-bot', role: 'coo', projectId: 'a' }];
  if (p === '/sources') return [{ id: 's2', name: 'Postgres', projectId: 'd' }];
  if (p === '/tools')
    return [
      { id: 't1', name: 'pg.query', kind: 'native', projectId: 'd' },
      { id: 't2', name: 'combo', kind: 'composite', projectId: 'd' },
    ];
  if (p === '/groups') return [{ id: 'g1', name: 'Ops', projectId: 'a' }];
  return [];
});
vi.mock('../api.js', () => ({
  api: {
    getUnscoped: (p: string) => getUnscoped(p),
    postUnscoped: vi.fn(async () => ({})),
    delUnscoped: vi.fn(async () => null),
  },
}));

import { api } from '../api.js';
import { ProjectsContext } from '../ProjectSelector.js';
import { ProjectsTab } from './ProjectsTab.js';

const reload = vi.fn(async () => {});
const ui = () =>
  render(
    <ProjectsContext.Provider value={{ projects: [...projects], selected: null, agentNames: new Map(), reload }}>
      <ProjectsTab />
    </ProjectsContext.Provider>,
  );
const openAnalytics = async () => {
  ui();
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }));
  await screen.findByText('Shared GA');
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('renders the tree', () => {
  ui();
  for (const n of ['My team', 'Default', 'Analytics']) expect(screen.getByRole('button', { name: new RegExp(n) }));
});

it('selecting a node shows its summary counts and COO agents', async () => {
  await openAnalytics();
  expect(screen.getByText('5 tools')).toBeTruthy();
  expect(screen.getByText('1 workspace')).toBeTruthy();
  expect(screen.getAllByText('coo-bot').length).toBeGreaterThan(0);
});

it('Grant posts the resource to the node allowlist', async () => {
  await openAnalytics();
  fireEvent.change(screen.getByLabelText('Resource type'), { target: { value: 'source' } });
  fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 's2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
  await waitFor(() =>
    expect(api.postUnscoped).toHaveBeenCalledWith('/projects/a/access', { resourceType: 'source', resourceId: 's2' }),
  );
});

it('Revoke on a used row warns, then deletes', async () => {
  await openAnalytics();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  const modal = (await screen.findByText('Workspaces Ops will lose its tools.')).closest('.modal') as HTMLElement;
  fireEvent.click(within(modal).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(api.delUnscoped).toHaveBeenCalledWith('/projects/a/access/source/s1'));
});

it('New child posts the node and reloads the tree', async () => {
  await openAnalytics();
  fireEvent.change(screen.getByLabelText('New child kind'), { target: { value: 'team' } });
  fireEvent.change(screen.getByLabelText('New child name'), { target: { value: 'Growth' } });
  fireEvent.click(screen.getByRole('button', { name: '+ New child' }));
  await waitFor(() =>
    expect(api.postUnscoped).toHaveBeenCalledWith('/projects', { kind: 'team', name: 'Growth', parentId: 'a' }),
  );
  await waitFor(() => expect(reload).toHaveBeenCalled());
});

it('New child works with no node selected, parented to the root', async () => {
  ui();
  fireEvent.change(screen.getByLabelText('New child name'), { target: { value: 'Growth' } });
  fireEvent.click(screen.getByRole('button', { name: '+ New child' }));
  await waitFor(() =>
    expect(api.postUnscoped).toHaveBeenCalledWith('/projects', { kind: 'project', name: 'Growth', parentId: 't' }),
  );
});

it('Move offers non-native resources from other nodes and posts the move', async () => {
  await openAnalytics();
  fireEvent.change(screen.getByLabelText('Move type'), { target: { value: 'tool' } });
  const opts = () => [...screen.getByLabelText<HTMLSelectElement>('Move resource').options].map((o) => o.value);
  await waitFor(() => expect(opts()).toContain('t2'));
  expect(opts()).not.toContain('t1'); // native: moves with its source
  fireEvent.change(screen.getByLabelText('Move resource'), { target: { value: 't2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  await waitFor(() =>
    expect(api.postUnscoped).toHaveBeenCalledWith('/projects/a/move', { resourceType: 'tool', resourceId: 't2' }),
  );
  await waitFor(() => expect(reload).toHaveBeenCalled());
  // a workspace already homed here is not offered
  fireEvent.change(screen.getByLabelText('Move type'), { target: { value: 'group' } });
  await waitFor(() => expect(opts()).not.toContain('g1'));
});

it('Delete confirms with the counts; hidden for the default nodes', async () => {
  await openAnalytics();
  fireEvent.click(screen.getByRole('button', { name: 'Delete node' }));
  const msg = 'Delete "Analytics"? This removes 1 descendant, 2 sources, 5 tools, 1 workspace, 1 agent, 1 secret.';
  const modal = (await screen.findByText(msg)).closest('.modal') as HTMLElement;
  fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(api.delUnscoped).toHaveBeenCalledWith('/projects/a'));
  await waitFor(() => expect(reload).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /Default/ }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete node' })).toBeNull());
});

it('shows who granted an allowlist row', async () => {
  (access as unknown as { grantedBy: string | null }[])[0].grantedBy = 'coo1';
  render(
    <ProjectsContext.Provider
      value={{ projects: [...projects], selected: null, agentNames: new Map([['coo1', 'COO']]), reload }}
    >
      <ProjectsTab />
    </ProjectsContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }));
  expect(await screen.findByText('by COO')).toBeTruthy();
});
