import { and, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tools } from '../db/schema.js';
import { ownerOf } from '../lib/req.js';
import { invokeTool } from '../runtime/invoker.js';

const patchBody = z.object({
  name: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visible: z.boolean().optional(),
});

async function ownedTool(id: string, owner: string) {
  const [row] = await db.select().from(tools).where(and(eq(tools.id, id), eq(tools.ownerId, owner)));
  return row ?? null;
}

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tools', async (req) => {
    const q = req.query as { sourceId?: string; kind?: string; visible?: string };
    const filters: SQL[] = [eq(tools.ownerId, ownerOf(req))];
    if (q.sourceId) filters.push(eq(tools.sourceId, q.sourceId));
    if (q.kind === 'native' || q.kind === 'composite') filters.push(eq(tools.kind, q.kind));
    if (q.visible === 'true' || q.visible === 'false') filters.push(eq(tools.visible, q.visible === 'true'));
    return db.select().from(tools).where(and(...filters));
  });

  app.get('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ownedTool(id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.patch('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const body = patchBody.parse(req.body);
    const existing = await ownedTool(id, owner);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (body.name && body.name !== existing.name) {
      const [clash] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
      if (clash) return reply.code(409).send({ error: 'name_taken' });
    }

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.description !== undefined) patch.description = body.description;
    if (body.visible !== undefined) patch.visible = body.visible;
    if (Object.keys(patch).length) await db.update(tools).set(patch).where(eq(tools.id, id));

    const [row] = await db.select().from(tools).where(eq(tools.id, id));
    return row;
  });

  app.delete('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(tools).where(and(eq(tools.id, id), eq(tools.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

  app.post('/tools/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const tool = await ownedTool(id, owner);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    const result = await invokeTool(tool.name, args, { ownerId: owner, groupId: null, agentId: null });
    return result;
  });
}
