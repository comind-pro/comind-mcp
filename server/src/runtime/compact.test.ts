import { describe, expect, it } from 'vitest';
import {
  COMPACT_MIN_BYTES,
  cleanJson,
  compactResult,
  compactText,
  htmlToText,
  renderFlat,
  squeezeText,
} from './compact.js';

const issues = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  title: `Issue number ${i + 1} with a reasonably long title to pad bytes`,
  state: i % 2 ? 'open' : 'closed',
  assignee: null,
  labels: [],
  url: `https://example.com/issues/${i + 1}`,
  body: '',
}));

describe('cleanJson', () => {
  it('drops null/empty strings, keeps empty arrays, rounds floats, masks base64', () => {
    const v = cleanJson({
      a: null,
      b: '',
      c: [],
      d: {},
      e: 1.23456789012,
      f: 'A'.repeat(300),
      g: 'data:image/png;base64,AAAA',
    });
    expect(v).toEqual({ c: [], d: {}, e: 1.234568, f: '<base64 300 chars>', g: '<base64 26 chars>' });
  });
});

describe('renderFlat', () => {
  it('renders a uniform object array as a table', () => {
    const out = renderFlat({
      total: 2,
      items: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ],
    });
    expect(out).toBe('total: 2\nitems (3 rows):\nid | name\n1 | a\n2 | b\n3 | c');
  });
  it('keeps a heterogeneous array as inline JSON', () => {
    const out = renderFlat({ items: [{ id: 1 }, { name: 'x' }, { other: true }] });
    expect(out).toBe('items: [{"id":1},{"name":"x"},{"other":true}]');
  });
  it('indents nested objects', () => {
    expect(renderFlat({ user: { name: 'Ann', address: { city: 'Kyiv' } } })).toBe(
      'user:\n  name: Ann\n  address:\n    city: Kyiv',
    );
  });
});

describe('htmlToText', () => {
  it('strips scripts/styles, keeps link targets and block breaks', () => {
    const html =
      '<html><head><title>T</title><style>b{}</style></head><body><script>x()</script><h1>Hi &amp; bye</h1><p>See <a href="https://x.y">docs</a>.</p><p>Next</p></body></html>';
    expect(htmlToText(html)).toBe('Hi & bye\nSee docs (https://x.y).\nNext');
  });
});

describe('squeezeText', () => {
  it('dedupes consecutive identical lines and squeezes blank runs', () => {
    expect(squeezeText('a  \na\na\n\n\n\nb')).toBe('a (×3)\n\nb');
  });
});

describe('compactText', () => {
  it('turns big JSON into a table and shrinks it', () => {
    const text = JSON.stringify({ total_count: 25, items: issues });
    const out = compactText(text);
    expect(out.length).toBeLessThan(text.length * 0.7); // brief said length/2: unattainable, the payload itself is ~64% of the raw JSON
    expect(out.startsWith('total_count: 25\nitems (25 rows):\nid | title | state | labels | url')).toBe(true);
    expect(out).not.toContain('assignee');
  });
  it('returns the input when compaction would not shrink it', () => {
    const text = 'x'.repeat(3000);
    expect(compactText(text)).toBe(text);
  });
});

describe('compactResult', () => {
  const big = {
    content: [{ type: 'text', text: JSON.stringify({ items: issues }) }],
    structuredContent: { items: issues },
  };
  it('leaves short results and errors alone', () => {
    const short = { content: [{ type: 'text', text: '{"a":1}' }] };
    expect(compactResult(short)).toBe(short);
    const err = { ...big, isError: true };
    expect(compactResult(err)).toBe(err);
  });
  it('compacts text, cleans structuredContent and drops it when still large', () => {
    const out = compactResult(big);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].text?.startsWith('items (25 rows):')).toBe(true);
    expect(out.structuredContent).toBeUndefined(); // 25 rows of cleaned JSON is still > COMPACT_MIN_BYTES
    const small = {
      content: [{ type: 'text', text: JSON.stringify({ items: issues }) }],
      structuredContent: { ok: true, n: null },
    };
    expect(compactResult(small).structuredContent).toEqual({ ok: true });
  });
  it('passes non-text blocks through', () => {
    const r = {
      content: [
        { type: 'image', data: 'xx', mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ items: issues }) },
      ],
    };
    const out = compactResult(r);
    expect(out.content[0]).toEqual(r.content[0]);
    expect(out.content).toHaveLength(2);
  });
  it('threshold constant is 2048', () => expect(COMPACT_MIN_BYTES).toBe(2048));
});
