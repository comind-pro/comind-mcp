import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const base = {
  sourceId: null,
  sourceName: null,
  kind: 'encrypted',
  envRef: null,
  pending: true,
  projectId: 'p',
  createdByAgentId: 'coo1',
};
const rows = [
  { ...base, id: 's1', name: 'GA_KEY', displayName: 'GA_KEY' },
  { ...base, id: 's2', name: 'DB_KEY', displayName: 'DB_KEY' },
  { ...base, id: 's3', name: 'E', displayName: 'E', kind: 'env', envRef: 'MY_ENV', pending: false },
];
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => (p === '/secrets' ? rows : [])),
    patch: vi.fn(async () => ({})),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { SecretsTab } from './SecretsTab.js';

afterEach(cleanup);

it('pending rows keep separate drafts, save only their own, and can be deleted', async () => {
  render(<SecretsTab />);
  await screen.findAllByText('needs value');
  const [a, b] = screen.getAllByPlaceholderText('paste value, Enter to save') as HTMLInputElement[];
  fireEvent.change(a, { target: { value: 'abc' } });
  expect(a.value).toBe('abc');
  expect(b.value).toBe('');
  fireEvent.click(screen.getByText('Edit'));
  expect(a.value).toBe('abc');
  expect(b.value).toBe('');
  expect(screen.getAllByText('Delete').length).toBeGreaterThanOrEqual(2);
  fireEvent.click(screen.getAllByText('Save')[0]);
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/secrets/s1', { value: 'abc' }));
  expect(api.patch).toHaveBeenCalledTimes(1);
});
