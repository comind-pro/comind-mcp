import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { agentGroups, agentKeys, agents, groups, groupTools, tools, users } from '../db/schema.js';
import { authenticateAgentAll } from '../gateway/server.js';
import { signJwt } from '../lib/auth.js';
import { hashKey } from '../lib/crypto.js';
import { newId } from '../lib/id.js';
import { ensureDefaultNodes } from '../services/projects.js';

/** Lite mode's PUT /agents/:id/tools: shared groups stay untouched, the agent gets a
 *  personal group for extra tools and a blocked list for the ones it should lose. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);
const d = dbUp ? describe : describe.skip;

d('agent tool access (Lite mode)', () => {
  const app = buildApp();
  const tag = newId().slice(0, 6).toLowerCase();
  const ownerId = newId();
  const otherOwner = newId();
  const ids = { shared: newId(), extra: newId(), foreign: newId(), group: newId(), agent: newId(), peer: newId() };
  const token = `tok_lite_${tag}`;
  const auth = () => ({ authorization: `Bearer ${signJwt(ownerId)}` });

  beforeAll(async () => {
    await runMigrations();
    for (const [id, suffix] of [
      [ownerId, 'a'],
      [otherOwner, 'b'],
    ])
      await db
        .insert(users)
        .values({ id, email: `lite_${tag}_${suffix}@t.local`, passwordHash: 'x', createdAt: new Date() });
    const { projectId } = await ensureDefaultNodes(ownerId);
    const other = await ensureDefaultNodes(otherOwner);
    const tool = (id: string, owner: string, project: string, name: string) => ({
      id,
      ownerId: owner,
      projectId: project,
      kind: 'virtual' as const,
      name: `${name}_${tag}`,
      visible: true,
      createdAt: new Date(),
    });
    await db
      .insert(tools)
      .values([
        tool(ids.shared, ownerId, projectId, 'paper_buy'),
        tool(ids.extra, ownerId, projectId, 'get_price'),
        tool(ids.foreign, otherOwner, other.projectId, 'live_buy'),
      ]);
    await db
      .insert(groups)
      .values({ id: ids.group, ownerId, projectId, slug: `trading-${tag}`, name: 'Trading', createdAt: new Date() });
    await db.insert(groupTools).values({ groupId: ids.group, toolId: ids.shared });
    for (const id of [ids.agent, ids.peer]) {
      await db.insert(agents).values({ id, ownerId, projectId, name: `trader-${id}`, createdAt: new Date() });
      await db.insert(agentGroups).values({ agentId: id, groupId: ids.group });
    }
    await db.insert(agentKeys).values({
      id: newId(),
      agentId: ids.agent,
      hash: hashKey(token),
      prefix: 'tok_lite',
      label: 't',
      archived: false,
      createdAt: new Date(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, [ownerId, otherOwner]));
    await app.close();
  });

  const put = (agentId: string, toolIds: string[]) =>
    app.inject({ method: 'PUT', url: `/agents/${agentId}/tools`, headers: auth(), payload: { toolIds } });
  const get = async (agentId: string) =>
    (await app.inject({ method: 'GET', url: `/agents/${agentId}/tools`, headers: auth() })).json().toolIds;

  it('starts with what the shared group gives', async () => {
    expect(await get(ids.agent)).toEqual([ids.shared]);
  });

  it('swaps a shared tool for another without touching the shared group or its other agents', async () => {
    expect((await put(ids.agent, [ids.extra])).statusCode).toBe(200);
    expect(await get(ids.agent)).toEqual([ids.extra]);
    expect(await get(ids.peer)).toEqual([ids.shared]);
    const links = await db.select().from(groupTools).where(eq(groupTools.groupId, ids.group));
    expect(links.map((l) => l.toolId)).toEqual([ids.shared]);

    const all = await authenticateAgentAll(`Bearer ${token}`);
    expect(all?.blockedTools).toEqual([ids.shared]);
    expect(all?.groups.map((g) => g.slug)).toContain(`agent-${ids.agent}`);
  });

  it('switching the shared tool back on unblocks it', async () => {
    await put(ids.agent, [ids.extra, ids.shared]);
    expect((await get(ids.agent)).sort()).toEqual([ids.extra, ids.shared].sort());
    expect((await authenticateAgentAll(`Bearer ${token}`))?.blockedTools).toEqual([]);
  });

  it("rejects another owner's tool", async () => {
    const res = await put(ids.agent, [ids.foreign]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_tools');
  });
});
