import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { db, runMigrations } from '../db/client.js';
import { callLogs, composites, sources, tools, users } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { ensureDefaultNodes } from '../services/projects.js';
import { errorMessage, errorText, invokeTool } from './invoker.js';

// The fake connector records the args it receives and answers with `fake.body`.
const fake = vi.hoisted(() => ({ received: [] as Record<string, unknown>[], body: '' }));
vi.mock('../connectors/index.js', async (orig) => ({
  ...(await orig<object>()),
  createConnector: () => ({
    callTool: async (_name: string, args: Record<string, unknown>) => {
      fake.received.push(args);
      return { content: [{ type: 'text', text: fake.body }] };
    },
  }),
}));

test('errorText: text parts, else the structured body, capped', () => {
  expect(errorText({ content: [{ type: 'text', text: 'boom' }, { type: 'image' }], isError: true })).toBe('boom');
  expect(errorText({ content: [], structuredContent: { code: 404 }, isError: true })).toBe('{"code":404}');
  expect(errorText({ content: [{ type: 'text', text: 'x'.repeat(5000) }], isError: true })).toHaveLength(2000);
});

test('errorMessage: appends the cause that fetch hides', () => {
  const refused = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
  expect(errorMessage(refused)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:9');
  // happy-eyeballs AggregateError has an empty message but carries a code
  expect(errorMessage(new TypeError('fetch failed', { cause: { message: '', code: 'ETIMEDOUT' } }))).toBe(
    'fetch failed: ETIMEDOUT',
  );
  expect(errorMessage(new Error('plain'))).toBe('plain');
  expect(errorMessage('str')).toBe('str');
});

const ITEMS = JSON.stringify({
  items: Array.from({ length: 25 }, (_, i) => ({
    id: i,
    title: `Issue number ${i} needs attention soon`,
    url: `https://x.test/i/${i}`,
  })),
});

describe('invokeTool compaction and projection', () => {
  const ownerId = newId();
  const tag = newId().slice(0, 6).toLowerCase();
  const native = `cr_${tag}.issues`;
  const schemad = `cr_${tag}.schemad`;

  /** The call log row for `name` (inserted fire-and-forget, so poll). */
  const logOf = (name: string) =>
    vi.waitFor(async () => {
      const [row] = await db
        .select()
        .from(callLogs)
        .where(and(eq(callLogs.ownerId, ownerId), eq(callLogs.toolName, name)));
      if (!row) throw new Error('no log yet');
      await db.delete(callLogs).where(eq(callLogs.id, row.id));
      return row;
    });

  beforeAll(async () => {
    await runMigrations();
    await db
      .insert(users)
      .values({ id: ownerId, email: `cr_${tag}@t.local`, passwordHash: 'x', createdAt: new Date() });
    const { projectId } = await ensureDefaultNodes(ownerId);
    const sourceId = newId();
    await db.insert(sources).values({ id: sourceId, ownerId, projectId, name: 's', kind: 'http', config: {} });
    const base = { ownerId, projectId, visible: true, inputSchema: {}, createdAt: new Date() };
    await db.insert(tools).values({ ...base, id: newId(), sourceId, kind: 'native', name: native, upstreamName: 'x' });
    await db.insert(tools).values({
      ...base,
      id: newId(),
      sourceId,
      kind: 'native',
      name: schemad,
      upstreamName: 'x',
      outputSchema: { type: 'object' },
    });
    const compId = newId();
    await db.insert(tools).values({ ...base, id: compId, kind: 'composite', name: `cr_${tag}.comp` });
    await db.insert(composites).values({
      id: newId(),
      toolId: compId,
      definition: { steps: [{ id: 's1', tool: native }], output: 'RAW:${$.steps.s1.text}' },
    });
  });

  test('(a) compact: flat table, bytesIn > bytesOut', async () => {
    fake.body = ITEMS;
    const r = await invokeTool(native, {}, { ownerId, compact: true });
    expect(r.content[0].text).toMatch(/^items \(25 rows\):\nid \| title \| url\n0 \| Issue number 0/);
    const log = await logOf(native);
    expect(log.bytesIn).toBe(Buffer.byteLength(ITEMS));
    expect(log.bytesIn as number).toBeGreaterThan(log.bytesOut as number);
  });

  test('(b) no compact: raw JSON, bytesIn === bytesOut', async () => {
    fake.body = ITEMS;
    const r = await invokeTool(native, {}, { ownerId });
    expect(r.content[0].text).toBe(ITEMS);
    const log = await logOf(native);
    expect(log.bytesIn).toBe(Buffer.byteLength(ITEMS));
    expect(log.bytesOut).toBe(log.bytesIn);
  });

  test('(c) _fields is stripped before dispatch and projects the result', async () => {
    fake.body = ITEMS;
    fake.received = [];
    const r = await invokeTool(native, { q: 1, _fields: ['items.id'], _limit: 2 }, { ownerId });
    expect(fake.received).toEqual([{ q: 1 }]);
    expect(r.content[0].text).toBe('{"items":[{"id":0},{"id":1}]}');
    await logOf(native);
  });

  test('(c2) malformed _fields/_limit are stripped and ignored', async () => {
    fake.body = ITEMS;
    fake.received = [];
    const r = await invokeTool(native, { _fields: 'items.id', _limit: -1 }, { ownerId });
    expect(fake.received).toEqual([{}]);
    expect(r.content[0].text).toBe(ITEMS);
    await logOf(native);
  });

  test('(d) nested composite step sees raw JSON', async () => {
    fake.body = ITEMS;
    const r = await invokeTool(`cr_${tag}.comp`, {}, { ownerId, compact: true });
    expect(r.content[0].text?.startsWith('RAW:{"items"')).toBe(true);
    await logOf(`cr_${tag}.comp`);
    const nested = await logOf(native);
    expect(nested.bytesIn).toBe(Buffer.byteLength(ITEMS));
    expect(nested.bytesOut).toBe(nested.bytesIn);
  });

  test('(e) below the threshold: byte-identical', async () => {
    fake.body = JSON.stringify({ items: [{ id: 1, title: null }] });
    const r = await invokeTool(native, {}, { ownerId, compact: true });
    expect(r.content[0].text).toBe(fake.body);
    await logOf(native);
  });

  test('(f) outputSchema: text shaped, structuredContent stays raw', async () => {
    const body = JSON.stringify({
      items: Array.from({ length: 60 }, (_, i) => ({
        id: i,
        title: `Issue number ${i} needs attention`,
        url: `https://x.test/i/${i}`,
        state: null,
      })),
    });
    fake.body = body;
    const r = await invokeTool(
      schemad,
      { _fields: ['items.title', 'items.url', 'items.state'] },
      { ownerId, compact: true },
    );
    expect(r.content[0].text).toMatch(/^items \(60 rows\):\ntitle \| url\n/);
    expect(r.structuredContent).toEqual(JSON.parse(body));
    await logOf(schemad);
  });
});
