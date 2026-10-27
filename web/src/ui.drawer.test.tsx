import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Drawer, useDirty } from './ui.js';

it('useDirty: clean on open, dirty after an edit, clean again for a new id', () => {
  const pick = (e: { id: string; name: string }) => e.name;
  const { result, rerender } = renderHook(({ ed }) => useDirty(ed, pick), {
    initialProps: { ed: { id: 'a', name: 'x' } as { id: string; name: string } | null },
  });
  expect(result.current).toBe(false);
  rerender({ ed: { id: 'a', name: 'y' } });
  expect(result.current).toBe(true);
  rerender({ ed: { id: 'b', name: 'y' } }); // draft saved → got a real id
  expect(result.current).toBe(false);
});

it('Drawer: backdrop closes a clean drawer, asks before discarding a dirty one', async () => {
  const onClose = vi.fn();
  const { container, rerender } = render(
    <Drawer title="t" onClose={onClose}>
      body
    </Drawer>,
  );
  const overlay = container.querySelector('.drawer-overlay') as HTMLElement;
  fireEvent.mouseDown(screen.getByText('body')); // inside: stays open
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(overlay);
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(
    <Drawer title="t" dirty onClose={onClose}>
      body
    </Drawer>,
  );
  fireEvent.mouseDown(overlay);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(overlay);
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
});
