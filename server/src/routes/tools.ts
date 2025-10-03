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

}
