import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { users } from '../db/schema.js';

const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `iso-${Math.random().toString(36).slice(2, 8)}@test.local`;

type Row = { id: string; projectId: string; name: string; message?: string };

describe.skipIf(!dbUp)('project isolation: sources, tools, secrets', () => {
  let token: string;
  let A: string;
  let B: string;
  const srcA = { id: '' };
  const srcB = { id: '' };

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const list = async (path: string, project?: string) =>
    (await call('GET', project ? `${path}?project=${project}` : path)).json() as Row[];
  const httpSource = (name: string, headers: Record<string, string> = {}) => ({
    name,
    kind: 'http',
    config: {
      baseUrl: 'http://127.0.0.1:9',
      headers,
      endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'ping' }],
    },
  });

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    token = (res.json() as { token: string }).token;
    const nodes = (await call('GET', '/projects')).json() as { id: string; kind: string; parentId: string | null }[];
    const root = nodes.find((n) => n.kind === 'team' && !n.parentId)?.id as string;
    const mk = async (name: string) =>
      ((await call('POST', '/projects', { kind: 'project', name, parentId: root })).json() as { id: string }).id;
    A = await mk('A');
    B = await mk('B');
    for (const [p, s, k] of [
      [A, srcA, 'AKEY'],
      [B, srcB, 'BKEY'],
    ] as const) {
      const r = await call('POST', `/sources?project=${p}`, httpSource(`src-${k}`));
      s.id = (r.json() as Row).id;
      await call('POST', `/sources/${s.id}/import?project=${p}`, {});
      await call('POST', `/secrets?project=${p}`, { name: k, value: `val-${k}` });
    }
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  });

  it('lists are scoped: A sees only A, root sees both', async () => {
    for (const path of ['/sources', '/tools', '/secrets']) {
      const a = await list(path, A);
      expect(a.length).toBe(1);
      expect((await list(path)).length).toBe(2);
    }
  });

  it('reading B from A is 404', async () => {
    expect((await call('GET', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/sources/${srcB.id}?project=${A}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
    const [toolB] = await list('/tools', B);
    expect((await call('GET', `/tools/${toolB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/tools/${toolB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('GET', `/sources/${srcB.id}`)).statusCode).toBe(200); // still there
  });

  it('a granted source is readable but not editable from A', async () => {
    const g = await call('POST', `/projects/${A}/access`, { resourceType: 'source', resourceId: srcB.id });
    expect(g.statusCode).toBe(201);
    expect((await call('GET', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(200);
    expect((await list('/tools', A)).map((t) => t.name)).toContain('src-bkey.ping');
    expect((await call('PATCH', `/sources/${srcB.id}?project=${A}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
  });

  it("A's source cannot resolve B's secret by name", async () => {
    const r = await call('POST', '/sources?project=' + A, httpSource('leaky', { 'x-k': '${secret.BKEY}' }));
    const id = (r.json() as Row).id;
    const t = (await call('POST', `/sources/${id}/test?project=${A}`)).json() as { ok: boolean; message: string };
    expect(t.ok).toBe(false);
    expect(t.message).not.toContain('val-BKEY');
  });

  it('a pending secret fails loudly', async () => {
    const s = await call('POST', `/secrets?project=${A}`, { name: 'PK', pending: true });
    expect(s.statusCode).toBe(201);
    expect((s.json() as { pending: boolean }).pending).toBe(true);
    const r = await call('POST', '/sources?project=' + A, httpSource('pend', { 'x-k': '${secret.PK}' }));
    const id = (r.json() as Row).id;
    const t = (await call('POST', `/sources/${id}/test?project=${A}`)).json() as { ok: boolean; message: string };
    expect(t.message).toContain('secret PK is pending — set its value in admin');
  });

  it('new rows land in ?project= or the default project', async () => {
    const a = (await call('POST', `/sources?project=${A}`, httpSource('inA'))).json() as Row;
    expect(a.projectId).toBe(A);
    const d = (await call('POST', '/sources', httpSource('inDefault'))).json() as Row;
    expect([A, B]).not.toContain(d.projectId);
    expect(d.projectId).toBeTruthy();
  });
});
