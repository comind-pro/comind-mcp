import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { agentGroups, agents, groups } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { newApiKey, newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';

const createBody = z.object({ name: z.string().min(1) });

function publicAgent(a: typeof agents.$inferSelect) {
  const { apiKeyHash: _h, ...rest } = a;
  return rest;
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
    const row = {
      id: newId(),
      ownerId: owner,
      name: body.name,
      apiKeyHash: hashKey(key.token),
      apiKeyPrefix: key.prefix,
      createdAt: new Date(),
    };
    await db.insert(agents).values(row);
    return reply.code(201).send({ ...publicAgent(row), apiKey: key.token, groups: [] });
  });

  app.get('/agents', async (req) => {
    const rows = await db.select().from(agents).where(eq(agents.ownerId, ownerOf(req)));
    return Promise.all(rows.map(async (a) => ({ ...publicAgent(a), groups: await agentGrants(a.id) })));
  });

  app.get('/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedAgent(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ...publicAgent(row), groups: await agentGrants(id) };
  });

  app.delete('/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(agents).where(and(eq(agents.id, id), eq(agents.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

  app.post('/agents/:id/rotate-key', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedAgent(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const key = newApiKey();
    await db.update(agents).set({ apiKeyHash: hashKey(key.token), apiKeyPrefix: key.prefix }).where(eq(agents.id, id));
    return { apiKey: key.token, prefix: key.prefix };
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
