import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useItemRoute } from './ui.js';

function Probe({
  openId,
  rows,
  open,
}: {
  openId: string | null;
  rows: { id: string }[] | null;
  open: (r: { id: string }) => void;
}) {
  useItemRoute(openId, rows, open);
  return null;
}

it('reopens the row named in the hash once rows load, then mirrors the open id into the hash', () => {
  location.hash = '#/tools/b';
  const open = vi.fn();
  const { rerender } = render(<Probe openId={null} rows={null} open={open} />);
  expect(location.hash).toBe('#/tools/b'); // not wiped before rows arrive
  rerender(<Probe openId={null} rows={[{ id: 'a' }, { id: 'b' }]} open={open} />);
  expect(open).toHaveBeenCalledWith({ id: 'b' });
  rerender(<Probe openId="a" rows={[{ id: 'a' }, { id: 'b' }]} open={open} />);
  expect(location.hash).toBe('#/tools/a');
  rerender(<Probe openId="new" rows={[{ id: 'a' }, { id: 'b' }]} open={open} />);
  expect(location.hash).toBe('#/tools');
});
