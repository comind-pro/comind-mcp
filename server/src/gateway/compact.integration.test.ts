import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { groups, users } from '../db/schema.js';
import { withReservedArgs } from './server.js';

/** Compaction + projection end to end over /g/:slug/mcp, against a local HTTP stub. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const stub = Fastify();
const email = `compact-${Math.random().toString(36).slice(2, 8)}@test.local`;
const ISSUES = {
  items: Array.from({ length: 25 }, (_, i) => ({
    id: i,
    title: `Issue ${i} needs attention soon`,
    url: `https://tracker.example.test/issues/${i}`,
  })),
};

/** One JSON-RPC request; the body is SSE (`data: {...}`) or plain JSON. */
async function rpc(key: string, url: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  const line = res.body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.body).result;
}

it('withReservedArgs adds _fields/_limit and relaxes additionalProperties', () => {
  const s = { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } } };
  const out = withReservedArgs(s) as { additionalProperties: unknown; properties: Record<string, unknown> };
  expect(Object.keys(out.properties)).toEqual(['q', '_fields', '_limit']);
  expect(out.additionalProperties).toBe(true);
  expect(s.additionalProperties).toBe(false); // input untouched
  expect(withReservedArgs({ type: 'string' })).toEqual({ type: 'string' });
});

describe.skipIf(!dbUp)('result compaction over the gateway', () => {
  let token: string;
  let key: string;
  let groupId: string;
  let url: string;
  let toolName: string;

  beforeAll(async () => {
    await runMigrations();
    stub.get('/issues', async () => ISSUES);
    const base = await stub.listen({ port: 0, host: '127.0.0.1' });
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    token = reg.json().token;
    const rest = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${token}` } });
    const src = (
      await rest('POST', '/sources', {
        name: 'tracker',
        kind: 'http',
        config: { baseUrl: base, endpoints: [{ name: 'issues', method: 'GET', path: '/issues' }] },
      })
    ).json();
    await rest('POST', `/sources/${src.id}/import`, {});
    const tool = ((await rest('GET', '/tools')).json() as { id: string; name: string; sourceId: string }[]).find(
      (t) => t.sourceId === src.id,
    ) as { id: string; name: string };
    toolName = tool.name;
    const grp = (await rest('POST', '/groups', { name: 'compact' })).json();
    groupId = grp.id;
    url = `/g/${grp.slug}/mcp`;
    await rest('PUT', `/groups/${groupId}/tools`, { toolIds: [tool.id] });
    const agent = (await rest('POST', '/agents', { name: 'reader' })).json();
    key = agent.apiKey;
    await rest('POST', `/agents/${agent.id}/groups`, { groupId });
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
    await stub.close();
  });

  const call = async (args: Record<string, unknown> = {}) => {
    const { tools } = await rpc(key, url, 'tools/list');
    const name = (tools as { name: string }[]).find((t) => t.name.endsWith('issues'))?.name;
    return (await rpc(key, url, 'tools/call', { name, arguments: args })) as { content: { text: string }[] };
  };

  it('(a) tools/list advertises _fields/_limit', async () => {
    const { tools } = await rpc(key, url, 'tools/list');
    const t = (tools as { name: string; inputSchema: any }[]).find((x) => x.name.endsWith('issues'));
    expect(t?.inputSchema.properties._fields).toBeDefined();
    expect(t?.inputSchema.properties._limit).toBeDefined();
    expect(t?.inputSchema.additionalProperties).not.toBe(false);
  });

  it('(b) _fields projects the result', async () => {
    const r = await call({ _fields: ['items.title'] });
    expect(r.content[0].text).toContain('Issue 3 needs attention soon');
    expect(r.content[0].text).not.toContain('url');
    expect(r.content[0].text).not.toContain('https://');
  });

  it('(c) large result compacted by default, raw JSON when the workspace turns it off', async () => {
    expect((await call()).content[0].text).toMatch(/^items \(25 rows\):/);
    await db.update(groups).set({ compactResults: false }).where(eq(groups.id, groupId));
    expect((await call()).content[0].text).toBe(JSON.stringify(ISSUES));
  });

  it('(d) GET /logs carries bytesIn/bytesOut', async () => {
    const logs = await vi.waitFor(async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/logs?toolName=${encodeURIComponent(toolName)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const rows = res.json() as { bytesIn: number | null; bytesOut: number | null }[];
      if (rows.length < 3) throw new Error('logs pending');
      return rows;
    });
    expect(logs.every((l) => typeof l.bytesIn === 'number' && typeof l.bytesOut === 'number')).toBe(true);
    expect(logs.some((l) => (l.bytesIn as number) > (l.bytesOut as number))).toBe(true);
  });
});
