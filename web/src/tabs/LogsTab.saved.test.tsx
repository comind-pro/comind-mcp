import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const row = {
  id: 'l1',
  toolName: 'search',
  status: 'success',
  source: 'live',
  durationMs: 5,
  tokensEst: null,
  agentId: 'a1',
  projectId: null,
  error: null,
  args: null,
  bytesIn: 12600,
  bytesOut: 2100,
  ts: Date.now(),
};
vi.mock('../api.js', () => ({
  api: {
    base: '',
    get: vi.fn(async (p: string) => {
      if (p.startsWith('/logs')) return [row];
      if (p.startsWith('/metrics'))
        return {
          totals: { calls: 1, errors: 0, tokens: 0, avg_ms: 5, p95_ms: 5, saved_bytes: 10500 },
          byTool: [{ tool_name: 'search', calls: 1, errors: 0, tokens: 0, avg_ms: 5, saved_bytes: 10500 }],
          byAgent: [],
        };
      return [];
    }),
  },
  projectStore: { get: () => null, set: () => {} },
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
}));

import { LogsTab } from './LogsTab.js';

it('shows saved KB in totals and per tool, and in→out per row', async () => {
  render(<LogsTab />);
  expect(await screen.findByText('12.3→2.1 KB')).toBeTruthy();
  expect(screen.getAllByText('saved KB').length).toBe(2);
  expect(screen.getAllByText('10').length).toBe(2);
});
