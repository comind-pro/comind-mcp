import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const source = {
  id: 's1',
  name: 'newsapi',
  kind: 'http',
  config: {},
  status: 'ok',
  statusMessage: null,
  drift: { new: ['newsapi.top'], changed: [], gone: ['newsapi.old'] },
  driftCheckedAt: new Date().toISOString(),
  projectId: 'p',
  createdByAgentId: null,
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => (p === '/sources' ? [source] : [])),
    post: vi.fn(async () => [{ ...source, drift: null }]),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { api } from '../api.js';
import { driftSummary, SourcesTab } from './SourcesTab.js';

afterEach(cleanup);

it('flags a connection whose source moved on since the import', async () => {
  render(<SourcesTab />);
  expect(await screen.findByText('update available · 1 new · 1 gone')).toBeTruthy();
  expect(driftSummary({ new: [], changed: [], gone: [] })).toBe('');
  expect(driftSummary(null)).toBe('');
});

it('Refresh all checks every connection and shows the fresh list', async () => {
  render(<SourcesTab />);
  fireEvent.click(await screen.findByText('Refresh all'));
  expect(api.post).toHaveBeenCalledWith('/sources/check', {});
  await waitFor(() => expect(screen.queryByText(/update available/)).toBeNull());
});
