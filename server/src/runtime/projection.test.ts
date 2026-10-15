import { describe, expect, it } from 'vitest';
import { limitArrays, normalizePath, project, projectResult } from './projection.js';

const data = {
  total: 3,
  items: [
    { id: 1, title: 'a', user: { login: 'x', url: 'u1' } },
    { id: 2, title: 'b', user: { login: 'y', url: 'u2' } },
    { id: 3, title: 'c', user: { login: 'z', url: 'u3' } },
  ],
};

describe('normalizePath', () => {
  it('accepts [] and dots', () => {
    expect(normalizePath('items[].user.login')).toEqual(['items', 'user', 'login']);
    expect(normalizePath('a.b')).toEqual(['a', 'b']);
  });
});

describe('project', () => {
  it('keeps only matched paths through arrays, preserving structure', () => {
    expect(project(data, ['items.title', 'items.user.login', 'total'])).toEqual({
      matched: true,
      value: {
        total: 3,
        items: [
          { title: 'a', user: { login: 'x' } },
          { title: 'b', user: { login: 'y' } },
          { title: 'c', user: { login: 'z' } },
        ],
      },
    });
  });
  it('a path ending at an object keeps the whole object', () => {
    expect(project(data, ['items.user']).value).toEqual({ items: data.items.map((i) => ({ user: i.user })) });
  });
  it('returns the original when nothing matches', () => {
    expect(project(data, ['nope.x'])).toEqual({ matched: false, value: data });
  });
});

describe('limitArrays', () => {
  it('cuts arrays and counts omissions', () => {
    const r = limitArrays({ a: [1, 2, 3, 4], b: { c: [1, 2, 3] } }, 2);
    expect(r).toEqual({ value: { a: [1, 2], b: { c: [1, 2] } }, omitted: 3 });
  });
});

describe('projectResult', () => {
  const r = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  it('applies owner then agent, agent cannot widen', () => {
    const out = projectResult(
      r,
      { fields: ['items.title', 'items.id'] },
      { fields: ['items.title', 'items.user.login'], limit: 2 },
    );
    expect(JSON.parse(out.content[0].text as string)).toEqual({ items: [{ title: 'a' }, { title: 'b' }] });
    expect(out.structuredContent).toEqual({ items: [{ title: 'a' }, { title: 'b' }] });
    expect(out.content[1]).toEqual({ type: 'text', text: '(_limit 2: 1 item omitted)' });
  });
  it('no match → original plus a note', () => {
    const out = projectResult(r, {}, { fields: ['zzz'] });
    expect(JSON.parse(out.content[0].text as string)).toEqual(data);
    expect(out.content[1]).toEqual({ type: 'text', text: '(_fields matched nothing: zzz)' });
  });
  it('non-JSON text: _fields ignored, _limit keeps first N lines', () => {
    const t = { content: [{ type: 'text', text: 'l1\nl2\nl3' }] };
    expect(projectResult(t, {}, { fields: ['a'], limit: 2 }).content[0].text).toBe('l1\nl2');
  });
  it('errors and empty intent pass through untouched', () => {
    const e = { ...r, isError: true };
    expect(projectResult(e, { fields: ['items.id'] }, {})).toBe(e);
    expect(projectResult(r, {}, {})).toBe(r);
  });
});

describe('projectResult multi-block / structured-only', () => {
  it('joins all text blocks before parsing JSON, keeps non-text blocks', () => {
    const txt = JSON.stringify(data);
    const m = {
      content: [
        { type: 'image', data: 'x' },
        { type: 'text', text: txt.slice(0, 20) },
        { type: 'text', text: txt.slice(20) },
      ],
    };
    const out = projectResult(m, {}, { fields: ['total'] });
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual(m.content[0]);
    expect(JSON.parse(out.content[1].text as string)).toEqual({ total: 3 });
  });
  it('projects structuredContent when text is not JSON', () => {
    const t = { content: [{ type: 'text', text: 'plain' }], structuredContent: data };
    const out = projectResult(t, {}, { fields: ['total'] });
    expect(out.content[0].text).toBe('plain');
    expect(out.structuredContent).toEqual({ total: 3 });
  });
});

describe('projectResult big integers', () => {
  it('keeps integers beyond 2^53 exact (as strings)', () => {
    const r = { content: [{ type: 'text', text: '{"id":9007199254740993,"tags":[1,2,3]}' }] };
    expect(projectResult(r, {}, { limit: 1 }).content[0].text).toBe('{"id":"9007199254740993","tags":[1]}');
  });
});
