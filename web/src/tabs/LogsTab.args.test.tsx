import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const row = {
  id: 'l1',
  toolName: 'project.connection_create',
  status: 'success',
  source: 'live',
  durationMs: 5,
  tokensEst: null,
  agentId: 'a1',
  projectId: 'p',
  error: null,
  args: '{"name":"news","config":"[redacted]"}',
  ts: Date.now(),
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => {
      if (p.startsWith('/logs')) return [row];
      if (p.startsWith('/metrics'))
        return { totals: { calls: 1, errors: 0, tokens: 0, avg_ms: 5, p95_ms: 5 }, byTool: [], byAgent: [] };
      return [];
    }),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { LogsTab } from './LogsTab.js';

it('shows admin badge and args for a successful admin call', async () => {
  render(<LogsTab />);
  expect(await screen.findByText('admin')).toBeTruthy();
  fireEvent.click(screen.getByText('project.connection_create'));
  expect(screen.getByText(/\[redacted\]/)).toBeTruthy();
  expect(screen.queryByText('Error')).toBeNull();
});
