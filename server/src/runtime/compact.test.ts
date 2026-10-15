import { describe, expect, it } from 'vitest';
import {
  COMPACT_MIN_BYTES,
  cleanJson,
  compactResult,
  compactText,
  htmlToText,
  parseJson,
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
  it('drops null/empty strings, keeps empty arrays, masks base64', () => {
    const v = cleanJson({ a: null, b: '', c: [], d: {}, g: 'data:image/png;base64,AAAA' });
    expect(v).toEqual({ c: [], d: {}, g: '<base64 26 chars>' });
  });
  it('masks only real binary: keeps cursors and non-base64 data: strings', () => {
    const cursor = 'Ab1'.repeat(100);
    expect(cleanJson({ cursor, d: 'data:text/plain,hello', s: 'data: 42' })).toEqual({
      cursor,
      d: 'data:text/plain,hello',
      s: 'data: 42',
    });
    expect(cleanJson({ blob: `${'QUJD'.repeat(300)}==` })).toEqual({ blob: '<base64 1202 chars>' });
  });
  it('leaves numbers untouched', () => {
    expect(cleanJson({ x: 1.2e-7, y: 1.23456789012 })).toEqual({ x: 1.2e-7, y: 1.23456789012 });
  });
});

describe('parseJson', () => {
  it('quotes 16+ digit integers in value position, not inside strings or decimals', () => {
    expect(parseJson('{"id":9007199254740993,"a":[ 12345678901234567890 ],"s":"x:1234567890123456789,"}')).toEqual({
      id: '9007199254740993',
      a: ['12345678901234567890'],
      s: 'x:1234567890123456789,',
    });
    expect(parseJson('{"n":42,"f":1.2e-7,"d":1234567890123456.5}')).toEqual({
      n: 42,
      f: 1.2e-7,
      d: 1234567890123456.5,
    });
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
  it('escapes | and newlines inside table cells', () => {
    const out = renderFlat([{ a: 'x|y' }, { a: 'l1\nl2' }, { a: 'z' }]);
    expect(out).toBe('(3 rows):\na\nx\\|y\nl1 l2\nz');
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
  it('keeps leading indentation (code blocks)', () => {
    expect(htmlToText('<p>Code:</p><pre>def f():\n    return 1   \n</pre>')).toBe('Code:\ndef f():\n    return 1');
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
  it('keeps big integers exact and tiny floats as-is', () => {
    expect(compactText('{"id":9007199254740993}')).toBe('id: 9007199254740993');
    expect(compactText('{"p":1.2e-7,"n":null}')).toBe('p: 1.2e-7');
  });
  it('appends a _fields/_limit hint when the flat text is still >= 8 KB', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...issues[0], id: i }));
    const out = compactText(JSON.stringify({ items: many }));
    expect(out).toMatch(
      /\n\(still \d+\.\d KB — pass _fields=\[\.\.\.\] to keep only the columns you need, _limit=N to cap rows\)$/,
    );
    expect(compactText(JSON.stringify({ items: issues }))).not.toContain('(still ');
  });
  it('returns the input for an all-null object', () => {
    expect(compactText('{"a":null,"b":null}')).toBe('{"a":null,"b":null}');
  });
  it('treats XML as text, not HTML', () => {
    const items = Array.from({ length: 10 }, (_, i) => `<item><title>T${i}</title></item>`).join('\n\n\n');
    const xml = `<?xml version="1.0"?>\n<rss><channel>\n${items}\n</channel></rss>`;
    expect(compactText(xml)).toContain('<item><title>T0</title></item>');
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
  it('compacts each text block on its own: projection notes stay separate', () => {
    const r = {
      content: [
        { type: 'text', text: JSON.stringify({ items: issues }) },
        { type: 'text', text: '(_limit 2: 1 item omitted)' },
      ],
    };
    const out = compactResult(r);
    expect(out.content).toHaveLength(2);
    expect(out.content[0].text?.startsWith('items (25 rows):')).toBe(true);
    expect(out.content[1]).toEqual({ type: 'text', text: '(_limit 2: 1 item omitted)' });
  });
  it('threshold constant is 2048', () => expect(COMPACT_MIN_BYTES).toBe(2048));
});

describe('compactResult bytes and base64', () => {
  it('threshold counts UTF-8 bytes, not chars', () => {
    const wide = { content: [{ type: 'text', text: `${'é'.repeat(1100)}\n\n\n\nx` }] };
    expect(compactResult(wide)).not.toBe(wide);
    const ascii = { content: [{ type: 'text', text: `${'e'.repeat(1100)}\n\n\n\nx` }] };
    expect(compactResult(ascii)).toBe(ascii);
  });
  it('keeps a long sentence with spaces verbatim', () => {
    const s = 'word '.repeat(60);
    expect(cleanJson({ s })).toEqual({ s });
  });
});
