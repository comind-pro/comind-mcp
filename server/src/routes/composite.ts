import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compositeDefinitionSchema, runCompositeTrace } from '../composite/engine.js';
import { db } from '../db/client.js';
import { composites, tools } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { invokeTool } from '../runtime/invoker.js';

const createBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  definition: compositeDefinitionSchema,
});

async function ownedComposite(id: string, owner: string) {
  const [tool] = await db.select().from(tools).where(and(eq(tools.id, id), eq(tools.ownerId, owner)));
  return tool && tool.kind === 'composite' ? tool : null;
}

/** Referenced step tools must belong to the owner. */
async function missingRefs(steps: { tool: string }[], owner: string) {
  const refNames = [...new Set(steps.map((s) => s.tool))];
  const found = await db
    .select()
    .from(tools)
    .where(and(inArray(tools.name, refNames), eq(tools.ownerId, owner)));
  return refNames.filter((n) => !found.some((t) => t.name === n));
}

export async function compositeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/composite-tools', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);

    const missing = await missingRefs(body.definition.steps, owner);
    if (missing.length) return reply.code(400).send({ error: 'unknown_tools', missing });

    const [clash] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
    if (clash) return reply.code(409).send({ error: 'name_taken' });

    const toolId = newId();
    const compId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(tools).values({
        id: toolId,
        ownerId: owner,
        sourceId: null,
        kind: 'composite',
        name: body.name,
        upstreamName: null,
        displayName: body.displayName ?? body.name,
        description: body.description ?? null,
        inputSchema: body.definition.inputSchema ?? null,
        visible: true,
        createdAt: new Date(),
      });
      await tx.insert(composites).values({ id: compId, toolId, definition: body.definition });
    });

    const [row] = await db.select().from(tools).where(eq(tools.id, toolId));
    return reply.code(201).send(row);
  });

  app.get('/composite-tools', async (req) =>
    db
      .select()
      .from(tools)
      .where(and(eq(tools.kind, 'composite'), eq(tools.ownerId, ownerOf(req)))),
  );

  app.get('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedComposite(id, ownerOf(req));
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [comp] = await db.select().from(composites).where(eq(composites.toolId, id));
    return { ...tool, definition: comp?.definition };
  });

  app.patch('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const tool = await ownedComposite(id, owner);
    if (!tool) return reply.code(404).send({ error: 'not_found' });

    const body = z
      .object({
        definition: compositeDefinitionSchema.optional(),
        displayName: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      })
      .parse(req.body);

    if (body.definition) {
      const missing = await missingRefs(body.definition.steps, owner);
      if (missing.length) return reply.code(400).send({ error: 'unknown_tools', missing });
      await db.update(composites).set({ definition: body.definition }).where(eq(composites.toolId, id));
      await db.update(tools).set({ inputSchema: body.definition.inputSchema ?? null }).where(eq(tools.id, id));
    }
    const toolPatch: Record<string, unknown> = {};
    if (body.displayName !== undefined) toolPatch.displayName = body.displayName;
    if (body.description !== undefined) toolPatch.description = body.description;
    if (Object.keys(toolPatch).length) await db.update(tools).set(toolPatch).where(eq(tools.id, id));

    const [comp] = await db.select().from(composites).where(eq(composites.toolId, id));
    const [updated] = await db.select().from(tools).where(eq(tools.id, id));
    return { ...updated, definition: comp?.definition };
  });

  app.delete('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(tools).where(and(eq(tools.id, id), eq(tools.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

}
