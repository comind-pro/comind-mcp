import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { callLogs, tools } from '../db/schema.js';
import { newId } from '../lib/id.js';

const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `compact-${Math.random().toString(36).slice(2, 8)}@test.local`;

describe.skipIf(!dbUp)('compact results routes', () => {
  let token: string;
  let ownerId: string;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    token = (res.json() as { token: string }).token;
    ownerId = (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string }).sub;
  });
  afterAll(async () => {
    await app.close();
  });

  it('round-trips outputFields/outputLimit and rejects a zero limit', async () => {
    const toolId = newId();
    const proj = ((await call('GET', '/projects')).json() as { id: string; kind: string }[]).find(
      (p) => p.kind === 'project',
    );
    await db
      .insert(tools)
      .values({ id: toolId, ownerId, projectId: proj?.id, kind: 'virtual', name: 'cr_tool', createdAt: new Date() });
    const ok = await call('PATCH', `/tools/${toolId}`, { outputFields: ['a.b'], outputLimit: 5 });
    expect(ok.statusCode).toBe(200);
    const got = (await call('GET', `/tools/${toolId}`)).json() as { outputFields: string[]; outputLimit: number };
    expect([got.outputFields, got.outputLimit]).toEqual([['a.b'], 5]);
    expect((await call('PATCH', `/tools/${toolId}`, { outputLimit: 0 })).statusCode).toBe(400);
    expect((await call('PATCH', `/tools/${toolId}`, { outputFields: [''] })).statusCode).toBe(400);
  });

  it('accepts compactResults on create and patch', async () => {
    const dflt = (await call('POST', '/groups', { name: 'D' })).json() as { compactResults: boolean };
    expect(dflt.compactResults).toBe(true);
    const g = (await call('POST', '/groups', { name: 'G', compactResults: false })).json() as {
      id: string;
      compactResults: boolean;
    };
    expect(g.compactResults).toBe(false);
    const p = (await call('PATCH', `/groups/${g.id}`, { compactResults: true })).json() as { compactResults: boolean };
    expect(p.compactResults).toBe(true);
  });

  it('reports saved_bytes in totals and byTool', async () => {
    const row = (bytesIn: number, bytesOut: number) => ({
      id: newId(),
      ownerId,
      toolName: 'saver',
      status: 'success' as const,
      source: 'live' as const,
      durationMs: 1,
      bytesIn,
      bytesOut,
    });
    await db.insert(callLogs).values([row(1000, 400), row(500, 100)]);
    const m = (await call('GET', '/metrics')).json() as {
      totals: { saved_bytes: number };
      byTool: { tool_name: string; saved_bytes: number }[];
    };
    expect(m.totals.saved_bytes).toBe(1000);
    expect(m.byTool[0]).toMatchObject({ tool_name: 'saver', saved_bytes: 1000 });
  });
});
