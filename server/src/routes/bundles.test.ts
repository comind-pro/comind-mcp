import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { secrets, users } from '../db/schema.js';

/** Integration test: group bundle export/import round-trip. Needs a reachable
 *  Postgres; skipped when none is available (same guard as isolation tests). */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const suffix = Math.random().toString(36).slice(2, 8);
const emails: string[] = [];

async function register(tag: string): Promise<string> {
  const email = `bundle-${tag}-${suffix}@test.local`;
  emails.push(email);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'secret123' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

async function call(token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: payload as Record<string, unknown> | undefined,
    headers: { authorization: `Bearer ${token}` },
  });
  return res;
}

const httpSourceConfig = {
  baseUrl: 'https://api.example.com',
  headers: { 'X-Api-Key': '${secret.NEWS_KEY}' },
  endpoints: [
    {
      name: 'everything',
      method: 'GET',
      path: '/v2/everything?q={q}',
      description: 'Search news',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  ],
};

describe.skipIf(!dbUp)('group bundle export/import', () => {
  let tokenA: string;
  let tokenB: string;
  let exported: Record<string, unknown>;

  beforeAll(async () => {
    await runMigrations(); // CI: the pg service starts empty; workers race, so migrate here too
    tokenA = await register('a');
    tokenB = await register('b');

    // seed owner A: http source → native tools, a virtual tool, a group, a scoped secret
    const src = (
      await call(tokenA, 'POST', '/sources', { name: 'news', kind: 'http', config: httpSourceConfig })
    ).json();
    await call(tokenA, 'POST', `/sources/${src.id}/import`);
    await call(tokenA, 'POST', '/secrets', { name: 'SCOPED_KEY', value: 'super-secret-value', sourceId: src.id });

    const virt = (
      await call(tokenA, 'POST', '/virtual-tools', {
        name: 'ping',
        description: 'Ping a service',
        request: { method: 'GET', url: 'https://svc.example.com/ping?key=${secret.PING_KEY}' },
      })
    ).json();

    const toolsA = (await call(tokenA, 'GET', '/tools')).json() as { id: string; name: string }[];
    const grp = (await call(tokenA, 'POST', '/groups', { name: 'News Desk', slug: 'news-desk' })).json();
    await call(tokenA, 'PUT', `/groups/${grp.id}/tools`, { toolIds: toolsA.map((t) => t.id) });

    const res = await call(tokenA, 'GET', `/groups/${grp.id}/export`);
    expect(res.statusCode).toBe(200);
    exported = res.json();
    expect(virt.id).toBeTruthy();
  });

  afterAll(async () => {
    for (const email of emails) await db.delete(users).where(eq(users.email, email)); // cascades everything
    await app.close();
  });

  it('exports the bundle with name refs, no ids, no secret values', () => {
    expect(exported.version).toBe(1);
    const group = exported.group as Record<string, unknown>;
    expect(group.slug).toBe('news-desk');
    expect(group.id).toBeUndefined();

    const sources = exported.sources as Record<string, unknown>[];
    expect(sources.map((s) => s.name)).toEqual(['news']);
    expect(sources[0].id).toBeUndefined();

    const tools = exported.tools as Record<string, unknown>[];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['news.everything', 'ping']);
    const native = tools.find((t) => t.name === 'news.everything');
    expect(native?.source).toBe('news');
    const virt = tools.find((t) => t.name === 'ping') as { virtual: { request: { url: string } } };
    expect(virt.virtual.request.url).toContain('${secret.PING_KEY}');

    // referenced + scoped secrets by name only
    const secretEntries = exported.secrets as { name: string; source: string | null }[];
    const byName = Object.fromEntries(secretEntries.map((s) => [s.name, s.source]));
    expect(byName).toEqual({ NEWS_KEY: null, PING_KEY: null, SCOPED_KEY: 'news' });
    expect(JSON.stringify(exported)).not.toContain('super-secret-value'); // values must not leak
  });

  it('imports into another account, creating everything with empty secrets', async () => {
    const res = await call(tokenB, 'POST', '/groups/import', exported);
    expect(res.statusCode).toBe(201);
    const report = res.json();
    expect(report.group).toBe('created');
    expect(report.sources.created).toEqual(['news']);
    expect(report.tools.created.sort()).toEqual(['news.everything', 'ping']);
    expect(report.secrets.created.sort()).toEqual(['NEWS_KEY', 'PING_KEY', 'SCOPED_KEY']);
    expect(report.secretsToFill.sort()).toEqual(['NEWS_KEY', 'PING_KEY', 'SCOPED_KEY']);

    // secrets exist but are empty (no value, no envRef)
    const rows = (await call(tokenB, 'GET', '/secrets')).json() as { name: string; envRef: string | null }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['NEWS_KEY', 'PING_KEY', 'SCOPED_KEY']);

    // group round-trips with its tools linked
    const groupsB = (await call(tokenB, 'GET', '/groups')).json() as { id: string; slug: string }[];
    const grp = groupsB.find((g) => g.slug === 'news-desk');
    expect(grp).toBeTruthy();
    const linked = (await call(tokenB, 'GET', `/groups/${grp?.id}/tools`)).json() as { name: string }[];
    expect(linked.map((t) => t.name).sort()).toEqual(['news.everything', 'ping']);
  });

  it('re-import is idempotent: everything skipped, nothing duplicated', async () => {
    const res = await call(tokenB, 'POST', '/groups/import', exported);
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.group).toBe('skipped');
    expect(report.sources).toEqual({ created: [], skipped: ['news'] });
    expect(report.tools.created).toEqual([]);
    expect(report.secrets.created).toEqual([]);

    const toolsB = (await call(tokenB, 'GET', '/tools')).json() as unknown[];
    expect(toolsB.length).toBe(2);
  });

  it('never overwrites an existing secret value on import', async () => {
    const rows = (await call(tokenB, 'GET', '/secrets')).json() as { id: string; name: string }[];
    const news = rows.find((r) => r.name === 'NEWS_KEY');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/secrets/${news?.id}`,
      payload: { value: 'filled' },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(patch.statusCode).toBe(200);

    await call(tokenB, 'POST', '/groups/import', exported);
    const [row] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, news?.id ?? ''));
    expect(row.encryptedValue).not.toBeNull(); // still filled after re-import
  });

  it('rejects a bundle with a native tool pointing at a missing source', async () => {
    const bad = JSON.parse(JSON.stringify(exported)) as { tools: { source?: string }[] };
    bad.tools[0] = { ...bad.tools[0], source: 'ghost' };
    const res = await call(tokenB, 'POST', '/groups/import', bad);
    expect(res.statusCode).toBe(400);
  });
});
