import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { userFeatures, users } from '../db/schema.js';
import { PYTHON_TOOLS } from '../lib/features.js';
import { newId } from '../lib/id.js';
import { invokeTool } from '../runtime/invoker.js';
import { shutdownPython } from '../runtime/python.js';

/** Integration test: the python-tool feature gate. Needs a reachable Postgres;
 *  skipped when none is available (same guard as the bundle/isolation tests). */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `python-${Math.random().toString(36).slice(2, 8)}@test.local`;

async function call(token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function grant(userId: string) {
  await db.insert(userFeatures).values({ id: newId(), userId, feature: PYTHON_TOOLS, enabled: true });
}

async function revoke(userId: string) {
  await db.delete(userFeatures).where(and(eq(userFeatures.userId, userId), eq(userFeatures.feature, PYTHON_TOOLS)));
}

describe.skipIf(!dbUp)('python tools feature gate', () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    expect(res.statusCode).toBe(201);
    token = (res.json() as { token: string }).token;
    const [row] = await db.select().from(users).where(eq(users.email, email));
    userId = row.id;
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email)); // cascades tools/scripts/features
    await app.close();
    shutdownPython();
  });

  it('refuses authoring while the feature is off', async () => {
    const res = await call(token, 'POST', '/python-tools', { name: 'py.sum', code: 'output = 1' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'feature_disabled' });
    expect((await call(token, 'GET', '/features')).json()).toEqual({ python_tools: false });
  });

  it('creates and runs a tool once granted, then goes inert when revoked', async () => {
    await grant(userId);
    expect((await call(token, 'GET', '/features')).json()).toEqual({ python_tools: true });

    const created = await call(token, 'POST', '/python-tools', {
      name: 'py.sum',
      description: 'adds two numbers',
      code: 'print("adding")\noutput = {"sum": args["a"] + args["b"]}',
    });
    expect(created.statusCode).toBe(201);
    const toolId = (created.json() as { id: string }).id;

    const run = await call(token, 'POST', `/python-tools/${toolId}/run`, { args: { a: 2, b: 40 } });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { structuredContent: unknown; stdout: string };
    expect(body.structuredContent).toEqual({ sum: 42 });
    expect(body.stdout).toContain('adding');

    // the gateway/scheduler path
    const viaRuntime = await invokeTool('py.sum', { a: 1, b: 1 }, { ownerId: userId, source: 'test' });
    expect(viaRuntime.structuredContent).toEqual({ sum: 2 });

    // revoking must stop tools that already exist, not just new ones
    await revoke(userId);
    const afterRevoke = await invokeTool('py.sum', { a: 1, b: 1 }, { ownerId: userId, source: 'test' });
    expect(afterRevoke.isError).toBe(true);
    expect(afterRevoke.content[0].text).toMatch(/not enabled/);
    expect((await call(token, 'POST', `/python-tools/${toolId}/run`, { args: {} })).statusCode).toBe(403);
  }, 30_000);

  it('gates composites that carry a python step', async () => {
    const definition = {
      steps: [{ id: 'calc', python: 'output = {"doubled": args.get("n", 0) * 2}' }],
    };
    const denied = await call(token, 'POST', '/composite-tools', { name: 'py.comp', definition });
    expect(denied.statusCode).toBe(403);

    await grant(userId);
    const created = await call(token, 'POST', '/composite-tools', { name: 'py.comp', definition });
    expect(created.statusCode).toBe(201);
    const compId = (created.json() as { id: string }).id;

    const run = await call(token, 'POST', `/composite-tools/${compId}/run`, { args: { n: 21 } });
    expect(run.statusCode).toBe(200);
    const { steps } = run.json() as { steps: Array<{ id: string; tool: string; text: string }> };
    expect(steps[0]).toMatchObject({ id: 'calc', tool: 'python' });
    expect(steps[0].text).toContain('42');

    await revoke(userId);
    expect((await call(token, 'POST', `/composite-tools/${compId}/run`, { args: { n: 1 } })).statusCode).toBe(403);
  }, 30_000);
});
