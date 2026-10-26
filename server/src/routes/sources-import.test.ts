import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { sources, users } from '../db/schema.js';
import { checkSource } from '../scheduler/source-check.js';
import { sourceDrift } from '../services/sources.js';

/** Integration test: per-tool import report + force re-import soft-deleting tools
 *  the source dropped, and restoring them when they come back. Needs a reachable Postgres; skipped otherwise. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `import-${Math.random().toString(36).slice(2, 8)}@test.local`;

type Change = { name: string; status: string; fields: string[] };
const endpoint = (name: string, description: string) => ({ name, method: 'GET', path: `/${name}`, description });

describe.skipIf(!dbUp)('source import report', () => {
  let token: string;
  let sourceId: string;

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const runImport = async (force: boolean) =>
    (await call('POST', `/sources/${sourceId}/import`, { force })).json() as { changes: Change[]; removed: number };
  /** tool name → description, as the user sees them */
  const userTools = async () =>
    Object.fromEntries(
      ((await call('GET', '/tools')).json() as { name: string; description: string }[]).map((t) => [
        t.name,
        t.description,
      ]),
    );
  const setEndpoints = (endpoints: unknown[]) =>
    call('PATCH', `/sources/${sourceId}`, { name: 'imp', config: { baseUrl: 'https://api.example.com', endpoints } });

  beforeAll(async () => {
    await runMigrations(); // CI: the pg service starts empty; workers race, so migrate here too
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    token = (res.json() as { token: string }).token;
    const src = await call('POST', '/sources', {
      name: 'imp',
      kind: 'http',
      config: { baseUrl: 'https://api.example.com', endpoints: [endpoint('keep', 'v1'), endpoint('drop', 'v1')] },
    });
    sourceId = (src.json() as { id: string }).id;
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email)); // cascades everything
    await app.close();
  });

  it('reports created, then leaves changed/gone tools alone without force', async () => {
    expect((await runImport(false)).changes.map((c) => c.status)).toEqual(['created', 'created']);

    await setEndpoints([endpoint('keep', 'v2')]);
    const r = await runImport(false);
    expect(r.changes).toEqual([
      { name: 'imp.keep', status: 'outdated', fields: ['description'] },
      { name: 'imp.drop', status: 'missing', fields: [] },
    ]);
    expect(r.removed).toBe(0);
    expect(await userTools()).toEqual({ 'imp.keep': 'v1', 'imp.drop': 'v1' });
  });

  it('force replaces changed tools and soft-deletes the ones the source dropped', async () => {
    const groupId = (
      (await call('POST', '/groups', { name: 'G', slug: `g-${email.slice(7, 13)}` })).json() as { id: string }
    ).id;
    const all = (await call('GET', '/tools')).json() as { id: string; name: string }[];
    await call('PUT', `/groups/${groupId}/tools`, { toolIds: all.map((t) => t.id) });
    const dropId = all.find((t) => t.name === 'imp.drop')?.id;

    const r = await runImport(true);
    expect(r.changes).toEqual([
      { name: 'imp.keep', status: 'updated', fields: ['description'] },
      { name: 'imp.drop', status: 'removed', fields: [] },
    ]);
    expect(r.removed).toBe(1);

    // gone everywhere a user or agent looks
    expect(await userTools()).toEqual({ 'imp.keep': 'v2' });
    expect((await call('GET', `/tools/${dropId}`)).statusCode).toBe(404);
    const inGroup = (await call('GET', `/groups/${groupId}/tools`)).json() as { name: string }[];
    expect(inGroup.map((t) => t.name)).toEqual(['imp.keep']);
    const invoked = (await call('POST', `/tools/${dropId}/test`, { args: {} })).statusCode;
    expect(invoked).toBe(404);

    // already removed → not reported again
    expect((await runImport(true)).changes).toEqual([{ name: 'imp.keep', status: 'unchanged', fields: [] }]);

    // back in the source → a plain import restores it, refreshed, still in its group
    await setEndpoints([endpoint('keep', 'v2'), endpoint('drop', 'v3')]);
    expect((await runImport(false)).changes).toEqual([
      { name: 'imp.keep', status: 'unchanged', fields: [] },
      { name: 'imp.drop', status: 'restored', fields: [] },
    ]);
    expect(await userTools()).toEqual({ 'imp.keep': 'v2', 'imp.drop': 'v3' });
    const back = (await call('GET', `/groups/${groupId}/tools`)).json() as { id: string }[];
    expect(back.map((t) => t.id)).toContain(dropId);
  });

  const sourceRow = async () => (await db.select().from(sources).where(eq(sources.id, sourceId)))[0];
  const getSource = async () =>
    (await call('GET', `/sources/${sourceId}`)).json() as { status: string; drift: unknown; driftCheckedAt: string };

  it('reports what a re-import would change without touching the tools', async () => {
    await setEndpoints([endpoint('keep', 'v3'), endpoint('extra', 'v1')]);
    expect(await sourceDrift(await sourceRow())).toEqual({
      new: ['imp.extra'],
      changed: ['imp.keep'],
      gone: ['imp.drop'],
    });
    expect(await userTools()).toEqual({ 'imp.keep': 'v2', 'imp.drop': 'v3' });

    // an import is a check too: a plain one creates the new tool and records what it left alone
    await runImport(false);
    const src = await getSource();
    expect(src.drift).toEqual({ new: [], changed: ['imp.keep'], gone: ['imp.drop'] });
    expect(src.driftCheckedAt).toBeTruthy();
  });

  it('an unreachable source turns red and keeps its last known drift', async () => {
    await call('PATCH', `/sources/${sourceId}`, {
      config: { baseUrl: 'http://127.0.0.1:1', endpoints: [endpoint('keep', 'v3'), endpoint('extra', 'v1')] },
    });
    await checkSource(await sourceRow());
    const src = await getSource();
    expect(src.status).toBe('error');
    expect(src.drift).toEqual({ new: [], changed: ['imp.keep'], gone: ['imp.drop'] });
  });
});
