import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const agent = { id: 'a1', name: 'coo-1', role: 'lead', keyCount: 1, groups: [], systemTools: [] };
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => (p === '/agents' ? [agent] : [])),
    patch: vi.fn(async (_p: string, b: { role: string }) => ({ ...agent, role: b.role })),
  },
  SYSTEM_TOOLS: [],
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { AgentsTab } from './AgentsTab.js';

it('changes the agent role and shows the COO badge', async () => {
  render(<AgentsTab />);
  fireEvent.click(await screen.findByText('coo-1'));
  const sel = (await screen.findByLabelText('Role')) as HTMLSelectElement;
  expect(sel.value).toBe('lead');
  expect(screen.queryByText('COO')).toBeNull();
  fireEvent.change(sel, { target: { value: 'coo' } });
  expect(api.patch).toHaveBeenCalledWith('/agents/a1', { role: 'coo' });
  await waitFor(() => expect(screen.getAllByText('COO').length).toBeGreaterThan(0));
});
