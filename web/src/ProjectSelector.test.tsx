import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ProjectSelector } from './ProjectSelector.js';

const projects = [
  { id: 't', parentId: null, kind: 'team', name: 'My team', slug: 'team', path: '/t/' },
  { id: 'd', parentId: 't', kind: 'project', name: 'Default', slug: 'default', path: '/t/d/' },
  { id: 'c', parentId: 't', kind: 'project', name: 'Child', slug: 'child', path: '/t/c/' },
] as const;

it('lists the tree indented and writes the choice to the URL', () => {
  const onChange = vi.fn();
  render(<ProjectSelector projects={[...projects]} value={null} onChange={onChange} />);
  const sel = screen.getByLabelText('Project') as HTMLSelectElement;
  expect([...sel.options].map((o) => o.text)).toEqual(['All projects', 'My team', '— Child', '— Default']);
  fireEvent.change(sel, { target: { value: 'c' } });
  expect(onChange).toHaveBeenCalledWith('c');
  expect(window.location.search).toContain('project=c');
});
