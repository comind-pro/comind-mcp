import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups } from '../db/schema.js';
import { sendErr } from '../lib/req.js';
import { inSubtree, scopeFor } from '../lib/scope.js';
import { createGroup, listGroupTools, ownedGroup, setGroupTools } from '../services/groups.js';
import { isErr } from '../services/sources.js';

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

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/groups', async (req, reply) => {
    const scope = await scopeFor(req);
    return reply.code(201).send(await createGroup(scope, createBody.parse(req.body), null));
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
    const r = await listGroupTools(await scopeFor(req), id);
    return isErr(r) ? sendErr(reply, r) : r;
  });

  app.put('/groups/:id/tools', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const { toolIds } = z.object({ toolIds: z.array(z.string()) }).parse(req.body);
    const r = await setGroupTools(scope, id, toolIds);
    return isErr(r) ? sendErr(reply, r) : r;
  });
}
