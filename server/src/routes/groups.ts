import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups, groupTools, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';

const createBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  schedulingEnabled: z.boolean().optional(),
});

const patchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  schedulingEnabled: z.boolean().optional(),
});

async function uniqueSlug(base: string, owner: string): Promise<string> {
  const slug = slugify(base);
  const [clash] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.slug, slug), eq(groups.ownerId, owner)));
  if (!clash) return slug;
  return `${slug}-${newId().slice(0, 4).toLowerCase()}`;
}

async function ownedGroup(id: string, owner: string) {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.ownerId, owner)));
  return row ?? null;
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/groups', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);
    const row = {
      id: newId(),
      ownerId: owner,
      slug: await uniqueSlug(body.slug ?? body.name, owner),
      name: body.name,
      description: body.description ?? null,
      schedulingEnabled: body.schedulingEnabled ?? true,
      createdAt: new Date(),
    };
    await db.insert(groups).values(row);
    return reply.code(201).send(row);
  });

  app.get('/groups', async (req) =>
    db
      .select()
      .from(groups)
      .where(eq(groups.ownerId, ownerOf(req))),
  );

  app.get('/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedGroup(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.patch('/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const existing = await ownedGroup(id, ownerOf(req));
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.schedulingEnabled !== undefined) patch.schedulingEnabled = body.schedulingEnabled;
    if (Object.keys(patch).length) await db.update(groups).set(patch).where(eq(groups.id, id));

    const [row] = await db.select().from(groups).where(eq(groups.id, id));
    return row;
  });

  app.delete('/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(groups).where(and(eq(groups.id, id), eq(groups.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

  app.get('/groups/:id/tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const grp = await ownedGroup(id, ownerOf(req));
    if (!grp) return reply.code(404).send({ error: 'not_found' });
    const links = await db.select().from(groupTools).where(eq(groupTools.groupId, id));
    const ids = links.map((l) => l.toolId);
    if (!ids.length) return [];
    return db.select().from(tools).where(inArray(tools.id, ids));
  });

  app.put('/groups/:id/tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const { toolIds } = z.object({ toolIds: z.array(z.string()) }).parse(req.body);
    const grp = await ownedGroup(id, owner);
    if (!grp) return reply.code(404).send({ error: 'not_found' });

    if (toolIds.length) {
      // tools must belong to the same owner
      const found = await db
        .select()
        .from(tools)
        .where(and(inArray(tools.id, toolIds), eq(tools.ownerId, owner)));
      const missing = toolIds.filter((t) => !found.some((f) => f.id === t));
      if (missing.length) return reply.code(400).send({ error: 'unknown_tools', missing });
    }

    await db.delete(groupTools).where(eq(groupTools.groupId, id));
    if (toolIds.length) {
      await db.insert(groupTools).values(toolIds.map((toolId) => ({ groupId: id, toolId })));
    }
    return { groupId: id, toolIds };
  });
}
