import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const put = vi.fn(async (_p: string, _b: unknown) => ({}));
vi.mock('./api.js', () => ({
  api: {
    base: '',
    put: (p: string, b: unknown) => put(p, b),
    get: vi.fn(async (p: string): Promise<unknown> => {
      if (p === '/agents') return [{ id: 'ag', name: 'Trader' }];
      if (p === '/sources') return [{ id: 'ex', name: 'Exchange', status: 'ok' }];
      if (p === '/tools')
        return ['paper_buy', 'live_buy', 'get_price'].map((n) => ({
          id: n,
          sourceId: 'ex',
          name: `ex.${n}`,
          displayName: n,
          visible: true,
          readOnly: n === 'get_price',
        }));
      if (p === '/agents/ag/tools') return { toolIds: ['paper_buy', 'get_price'] };
      return [];
    }),
  },
}));

import { LiteView } from './LiteView.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('shows partial access, and a single tool switch swaps just that tool', async () => {
  render(<LiteView onFull={() => {}} />);
  expect(await screen.findByText('2 of 3 tools · off: live_buy')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
  fireEvent.click(screen.getByText('live_buy'));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/agents/ag/tools', { toolIds: ['paper_buy', 'get_price', 'live_buy'] }),
  );
});

it('the service switch turns every tool off at once', async () => {
  render(<LiteView onFull={() => {}} />);
  fireEvent.click(await screen.findByLabelText('Trader can use Exchange'));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/agents/ag/tools', { toolIds: [] }));
});
