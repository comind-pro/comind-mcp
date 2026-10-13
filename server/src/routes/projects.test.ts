import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { sources } from '../db/schema.js';
import { newId } from '../lib/id.js';

const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `proj-${Math.random().toString(36).slice(2, 8)}@test.local`;

type Node = { id: string; kind: string; slug: string; path: string; parentId: string | null };

describe.skipIf(!dbUp)('project routes', () => {
  let token: string;
  let ownerId: string;

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const nodes = async () => (await call('GET', '/projects')).json() as Node[];
  const mk = async (kind: string, name: string, parentId: string) =>
    (await call('POST', '/projects', { kind, name, parentId })).json() as Node;

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    const j = res.json() as { token: string; user?: { id: string } };
    token = j.token;
    ownerId = (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string }).sub;
  });
  afterAll(async () => {
    await app.close();
  });

  it('register gives a root team with a default project', async () => {
    expect((await nodes()).map((p) => `${p.kind}:${p.slug}`).sort()).toEqual(['project:default', 'team:team']);
  });

  it('creates a child, refuses deleting defaults, deletes a child subtree', async () => {
    const team = (await nodes()).find((p) => p.kind === 'team') as Node;
    const c = await mk('project', 'Child', team.id);
    expect(c.path).toBe(`${team.path}${c.id}/`);
    const gc = await mk('team', 'Sub', c.id);
    const dup = await mk('project', 'Child', team.id); // second node gets a suffixed slug
    expect(dup.slug).toMatch(/^child-[a-z0-9_-]{4}$/);
    expect(dup.id).not.toBe(c.id);
    expect((await call('DELETE', `/projects/${team.id}`)).statusCode).toBe(409);
    expect((await call('DELETE', `/projects/${c.id}`)).statusCode).toBe(204);
    const ids = (await nodes()).map((p) => p.id);
    expect(ids).not.toContain(c.id);
    expect(ids).not.toContain(gc.id);
  });

  it('grants only what the caller sees and revokes', async () => {
    const team = (await nodes()).find((p) => p.kind === 'team') as Node;
    const src = await call('POST', '/sources', {
      name: 's1',
      kind: 'http',
      config: {
        baseUrl: 'https://api.example.com',
        endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'ping' }],
      },
    });
    const sid = (src.json() as { id: string }).id;
    const a = await mk('project', 'A', team.id);
    const b = await mk('project', 'B', team.id);
    const g = await call('POST', `/projects/${a.id}/access`, { resourceType: 'source', resourceId: sid });
    expect(g.statusCode).toBe(201);
    const list = (await call('GET', `/projects/${a.id}/access`)).json() as {
      resourceType: string;
      resourceId: string;
    }[];
    expect(list).toContainEqual(expect.objectContaining({ resourceType: 'source', resourceId: sid }));
    expect((await call('DELETE', `/projects/${a.id}/access/source/${sid}`)).statusCode).toBe(204);
    expect(((await call('GET', `/projects/${a.id}/access`)).json() as unknown[]).length).toBe(0);

    // a source living in B is invisible from A's scope
    const bid = newId();
    await db
      .insert(sources)
      .values({ id: bid, ownerId, projectId: b.id, name: 's2', kind: 'http', config: {}, createdAt: new Date() });
    const ga = await mk('project', 'GA', a.id);
    const r = await call('POST', `/projects/${ga.id}/access?project=${a.id}`, {
      resourceType: 'source',
      resourceId: bid,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'not_visible' });
    // and A can't reach B at all
    expect((await call('GET', `/projects/${b.id}/access?project=${a.id}`)).statusCode).toBe(404);
  });
});
