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
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  visible: z.boolean().optional(),
  // Discovery metadata.
  readOnly: z.boolean().nullable().optional(),
  dangerous: z.boolean().nullable().optional(),
  permissions: z.array(z.string()).optional(),
  examples: z.array(z.object({ description: z.string().optional(), input: z.record(z.unknown()) })).optional(),
  recommendedUse: z
    .object({
      daily_report: z.boolean().optional(),
      safe_for_automation: z.boolean().optional(),
      requires_user_confirmation: z.boolean().optional(),
    })
    .nullable()
    .optional(),
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
    if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
    if (body.outputSchema !== undefined) patch.outputSchema = body.outputSchema;
    if (body.visible !== undefined) patch.visible = body.visible;
    if (body.readOnly !== undefined) patch.readOnly = body.readOnly;
    if (body.dangerous !== undefined) patch.dangerous = body.dangerous;
    if (body.permissions !== undefined) patch.permissions = body.permissions;
    if (body.examples !== undefined) patch.examples = body.examples;
    if (body.recommendedUse !== undefined) patch.recommendedUse = body.recommendedUse;
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
    const result = await invokeTool(tool.name, args, { ownerId: owner, groupId: null, agentId: null, source: 'test' });
    return result;
  });
}
