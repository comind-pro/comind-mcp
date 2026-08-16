import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { users } from '../db/schema.js';

/** Integration test: how the group MCP endpoint resolves a workspace and how it
 *  explains a failed auth. Needs a reachable Postgres; skipped without one. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `gw-${Math.random().toString(36).slice(2, 8)}@test.local`;
const slug = `gw-${Math.random().toString(36).slice(2, 6)}`;

async function call(token: string, method: 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** tools/list over the group endpoint, the way an agent connects. */
async function toolsList(ref: string, key: string) {
  return app.inject({
    method: 'POST',
    url: `/g/${ref}/mcp`,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
}

describe.skipIf(!dbUp)('group endpoint auth', () => {
  let groupId: string;
  let agentKey: string;
  let otherGroupId: string;

  beforeAll(async () => {
    await runMigrations();
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    const token = (reg.json() as { token: string }).token;

    groupId = ((await call(token, 'POST', '/groups', { name: 'GW', slug })).json() as { id: string }).id;
    otherGroupId = (
      (await call(token, 'POST', '/groups', { name: 'Other', slug: `${slug}-other` })).json() as { id: string }
    ).id;

    const agent = (await call(token, 'POST', '/agents', { name: 'bot' })).json() as { id: string; apiKey: string };
    agentKey = agent.apiKey;
    await call(token, 'POST', `/agents/${agent.id}/groups`, { groupId });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email)); // cascades groups/agents
    await app.close();
  });

  it('accepts the slug the web UI hands out, and the id older connectors use', async () => {
    expect((await toolsList(slug, agentKey)).statusCode).toBe(200);
    expect((await toolsList(groupId, agentKey)).statusCode).toBe(200);
  });

  it('says the token is fine but the workspace is not, instead of "missing bearer token"', async () => {
    const res = await toolsList(otherGroupId, agentKey); // valid key, no grant here
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('bearer is valid');
    expect(res.body).not.toContain('missing bearer token');
  });

  it('still reports a genuinely absent or bogus token as such', async () => {
    for (const res of [
      await app.inject({ method: 'POST', url: `/g/${slug}/mcp`, payload: {} }),
      await toolsList(slug, 'cmd_not_a_real_key'),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('missing or invalid bearer token');
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    }
  });
});
