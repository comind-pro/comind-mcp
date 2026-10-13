import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups, groupTools, liveTool, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { toolUsableCond } from './tools.js';

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

async function ownedGroup(scope: Scope, id: string) {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.ownerId, scope.ownerId), inSubtree(groups.projectId, scope)));
  return row ?? null;
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/groups', async (req, reply) => {
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const body = createBody.parse(req.body);
    const row = {
      id: newId(),
      ownerId: owner,
      projectId: scope.createIn,
      createdByAgentId: null,
      slug: await uniqueSlug(body.slug ?? body.name, owner),
      name: body.name,
      description: body.description ?? null,
      schedulingEnabled: body.schedulingEnabled ?? true,
      createdAt: new Date(),
    };
    await db.insert(groups).values(row);
    return reply.code(201).send(row);
  });

  app.get('/groups', async (req) => {
    const scope = await scopeFor(req);
    return db
      .select()
      .from(groups)
      .where(and(eq(groups.ownerId, scope.ownerId), inSubtree(groups.projectId, scope)));
  });

  app.get('/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedGroup(await scopeFor(req), id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.patch('/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const existing = await ownedGroup(await scopeFor(req), id);
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
    if (!(await ownedGroup(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(groups).where(eq(groups.id, id));
    return reply.code(204).send();
  });

  app.get('/groups/:id/tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const grp = await ownedGroup(await scopeFor(req), id);
    if (!grp) return reply.code(404).send({ error: 'not_found' });
    const links = await db.select().from(groupTools).where(eq(groupTools.groupId, id));
    const ids = links.map((l) => l.toolId);
    if (!ids.length) return [];
    return db
      .select()
      .from(tools)
      .where(and(inArray(tools.id, ids), liveTool()));
  });

  app.put('/groups/:id/tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const { toolIds } = z.object({ toolIds: z.array(z.string()) }).parse(req.body);
    const grp = await ownedGroup(scope, id);
    if (!grp) return reply.code(404).send({ error: 'not_found' });

    if (toolIds.length) {
      // tools must be usable by the group's own project (rule 1)
      const found = await db
        .select()
        .from(tools)
        .where(
          and(inArray(tools.id, toolIds), eq(tools.ownerId, scope.ownerId), liveTool(), toolUsableCond(grp.projectId)),
        );
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
