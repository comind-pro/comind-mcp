import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

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
  api: { base: '', get: vi.fn(async (p: string) => (p === '/sources' ? [source] : [])) },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { driftSummary, SourcesTab } from './SourcesTab.js';

it('flags a connection whose source moved on since the import', async () => {
  render(<SourcesTab />);
  expect(await screen.findByText('update available · 1 new · 1 gone')).toBeTruthy();
  expect(driftSummary({ new: [], changed: [], gone: [] })).toBe('');
  expect(driftSummary(null)).toBe('');
});
