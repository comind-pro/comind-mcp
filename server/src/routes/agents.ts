import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { agentGroups, agentKeys, agents, groups } from '../db/schema.js';
import { SYSTEM_TOOL_NAMES } from '../gateway/system-tools.js';
import { hashKey } from '../lib/crypto.js';
import { newApiKey, newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';

const createBody = z.object({ name: z.string().min(1) });
// Only known system.* tool names may be enabled on an agent.
const systemTools = z.array(z.string().refine((n) => SYSTEM_TOOL_NAMES.has(n), 'unknown system tool'));

function publicAgent(a: typeof agents.$inferSelect) {
  const { apiKeyHash: _h, apiKeyPrefix: _p, ...rest } = a;
  return rest;
}

function publicKey(k: typeof agentKeys.$inferSelect) {
  return { id: k.id, prefix: k.prefix, label: k.label, archived: k.archived, createdAt: k.createdAt };
}

/** active (non-archived) key count for an agent */
async function keyCount(agentId: string): Promise<number> {
  const rows = await db.select().from(agentKeys).where(and(eq(agentKeys.agentId, agentId), eq(agentKeys.archived, false)));
  return rows.length;
}

function endpointFor(groupId: string): string {
  return `http://${config.host}:${config.port}/g/${groupId}/mcp`;
}

async function ownedAgent(id: string, owner: string) {
  const [row] = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.ownerId, owner)));
  return row ?? null;
}

async function agentGrants(agentId: string) {
  const links = await db.select().from(agentGroups).where(eq(agentGroups.agentId, agentId));
  const ids = links.map((l) => l.groupId);
  if (!ids.length) return [];
  const grps = await db.select().from(groups).where(inArray(groups.id, ids));
  return grps.map((g) => ({ id: g.id, name: g.name, slug: g.slug, endpoint: endpointFor(g.id) }));
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/agents', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);
    const key = newApiKey();
    const row = { id: newId(), ownerId: owner, name: body.name, apiKeyHash: null, apiKeyPrefix: null, systemTools: [], createdAt: new Date() };
    await db.insert(agents).values(row);
    await db.insert(agentKeys).values({ id: newId(), agentId: row.id, hash: hashKey(key.token), prefix: key.prefix, label: 'default', archived: false, createdAt: new Date() });
    return reply.code(201).send({ ...publicAgent(row), apiKey: key.token, keyCount: 1, groups: [] });
  });

  app.get('/agents', async (req) => {
    const rows = await db.select().from(agents).where(eq(agents.ownerId, ownerOf(req)));
    return Promise.all(rows.map(async (a) => ({ ...publicAgent(a), keyCount: await keyCount(a.id), groups: await agentGrants(a.id) })));
  });

  // Which built-in system.* introspection tools this agent exposes (all its V-MCPs + /a/mcp).
  app.put('/agents/:id/system-tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    if (!(await ownedAgent(id, owner))) return reply.code(404).send({ error: 'not_found' });
    const { names } = z.object({ names: systemTools }).parse(req.body);
    const unique = [...new Set(names)];
    await db.update(agents).set({ systemTools: unique }).where(eq(agents.id, id));
    return { agentId: id, systemTools: unique };
  });

  // ----- API keys -----
  app.get('/agents/:id/keys', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await ownedAgent(id, ownerOf(req)))) return reply.code(404).send({ error: 'not_found' });
    const rows = await db.select().from(agentKeys).where(eq(agentKeys.agentId, id)).orderBy(desc(agentKeys.createdAt));
    return rows.map(publicKey);
  });

  app.post('/agents/:id/keys', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await ownedAgent(id, ownerOf(req)))) return reply.code(404).send({ error: 'not_found' });
    const { label } = z.object({ label: z.string().optional() }).parse(req.body ?? {});
    const key = newApiKey();
    const row = { id: newId(), agentId: id, hash: hashKey(key.token), prefix: key.prefix, label: label || null, archived: false, createdAt: new Date() };
    await db.insert(agentKeys).values(row);
    return reply.code(201).send({ ...publicKey(row), apiKey: key.token });
  });

  app.patch('/agents/:id/keys/:keyId', async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    if (!(await ownedAgent(id, ownerOf(req)))) return reply.code(404).send({ error: 'not_found' });
    const { archived, label } = z.object({ archived: z.boolean().optional(), label: z.string().optional() }).parse(req.body);
    const patch: Record<string, unknown> = {};
    if (archived !== undefined) patch.archived = archived;
    if (label !== undefined) patch.label = label || null;
    if (Object.keys(patch).length) await db.update(agentKeys).set(patch).where(and(eq(agentKeys.id, keyId), eq(agentKeys.agentId, id)));
    const [row] = await db.select().from(agentKeys).where(and(eq(agentKeys.id, keyId), eq(agentKeys.agentId, id)));
    return row ? publicKey(row) : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/agents/:id/keys/:keyId', async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    if (!(await ownedAgent(id, ownerOf(req)))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(agentKeys).where(and(eq(agentKeys.id, keyId), eq(agentKeys.agentId, id)));
    return reply.code(204).send();
  });

  app.get('/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedAgent(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ...publicAgent(row), keyCount: await keyCount(id), groups: await agentGrants(id) };
  });

  app.delete('/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(agents).where(and(eq(agents.id, id), eq(agents.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

  app.get('/agents/:id/groups', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedAgent(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return agentGrants(id);
  });

  app.post('/agents/:id/groups', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.body);
    const agent = await ownedAgent(id, owner);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    // group must belong to the same owner
    const [grp] = await db.select().from(groups).where(and(eq(groups.id, groupId), eq(groups.ownerId, owner)));
    if (!grp) return reply.code(400).send({ error: 'unknown_group' });

    const [exists] = await db
      .select()
      .from(agentGroups)
      .where(and(eq(agentGroups.agentId, id), eq(agentGroups.groupId, groupId)));
    if (!exists) await db.insert(agentGroups).values({ agentId: id, groupId });
    return agentGrants(id);
  });

  app.delete('/agents/:id/groups/:groupId', async (req, reply) => {
    const { id, groupId } = req.params as { id: string; groupId: string };
    const agent = await ownedAgent(id, ownerOf(req));
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    await db.delete(agentGroups).where(and(eq(agentGroups.agentId, id), eq(agentGroups.groupId, groupId)));
    return reply.code(204).send();
  });
}
