import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyAuth } from '../auth/apply.js';
import { createConnector, parseSourceConfig, sourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { sources, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { resolveSourceConfig } from '../secrets/loader.js';

const createBody = z.object({
  name: z.string().min(1),
  kind: sourceKind,
  config: z.record(z.unknown()),
});

const patchBody = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

/** Load a source owned by the requester, or null. */
async function owned(req: { url: string }, id: string, owner: string) {
  const [row] = await db.select().from(sources).where(and(eq(sources.id, id), eq(sources.ownerId, owner)));
  return row ?? null;
}

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sources', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);
    const config = parseSourceConfig(body.kind, body.config);
    const row = {
      id: newId(),
      ownerId: owner,
      name: body.name,
      kind: body.kind,
      config,
      status: 'unknown' as const,
      statusMessage: null,
      createdAt: new Date(),
    };
    await db.insert(sources).values(row);
    return reply.code(201).send(row);
  });

  app.get('/sources', async (req) => db.select().from(sources).where(eq(sources.ownerId, ownerOf(req))));

  app.get('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await owned(req, id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.patch('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const existing = await owned(req, id, ownerOf(req));
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.config !== undefined) patch.config = parseSourceConfig(existing.kind, body.config);
    if (Object.keys(patch).length) await db.update(sources).set(patch).where(eq(sources.id, id));

    const [row] = await db.select().from(sources).where(eq(sources.id, id));
    return row;
  });

  app.delete('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(sources).where(and(eq(sources.id, id), eq(sources.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });

}
