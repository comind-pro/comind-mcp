import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const group = {
  id: 'g1',
  slug: 'news',
  name: 'News',
  description: null,
  schedulingEnabled: true,
  compactResults: true,
  projectId: 'p',
  createdByAgentId: null,
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => (p === '/groups' ? [group] : [])),
    patch: vi.fn(async () => ({})),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { GroupsTab } from './GroupsTab.js';

it('switching compact results off PATCHes the workspace', async () => {
  render(<GroupsTab />);
  fireEvent.click(await screen.findByText('News'));
  fireEvent.click(await screen.findByText('Raw'));
  expect(api.patch).toHaveBeenCalledWith('/groups/g1', { compactResults: false });
});
