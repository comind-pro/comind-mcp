import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const row = {
  id: 's1',
  name: 'GA_KEY',
  sourceId: null,
  sourceName: null,
  displayName: 'GA_KEY',
  kind: 'encrypted',
  envRef: null,
  pending: true,
  projectId: 'p',
  createdByAgentId: 'coo1',
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => (p === '/secrets' ? [row] : [])),
    patch: vi.fn(async () => ({})),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { SecretsTab } from './SecretsTab.js';

it('shows pending badge and saves the value inline', async () => {
  render(<SecretsTab />);
  expect(await screen.findByText('pending')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('set value'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/secrets/s1', { value: 'abc' }));
});
