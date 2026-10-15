import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const tool = {
  id: 't1',
  sourceId: null,
  kind: 'native',
  name: 'search',
  displayName: null,
  description: null,
  visible: true,
  outputFields: null,
  outputLimit: null,
  projectId: 'p',
  createdByAgentId: null,
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => {
      if (p === '/tools') return [tool];
      if (p === '/features') return { python_tools: false };
      return [];
    }),
    patch: vi.fn(async () => ({})),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { ToolsTab } from './ToolsTab.js';

it('saves output fields and limit with the metadata', async () => {
  render(<ToolsTab onNavigate={() => {}} />);
  fireEvent.click(await screen.findByText('Edit'));
  fireEvent.change(await screen.findByLabelText('Output fields'), { target: { value: 'items.title, items.id' } });
  fireEvent.change(screen.getByLabelText('Output limit'), { target: { value: '20' } });
  fireEvent.click(screen.getByText('Save changes'));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith(
      '/tools/t1',
      expect.objectContaining({ outputFields: ['items.title', 'items.id'], outputLimit: 20 }),
    ),
  );
});
