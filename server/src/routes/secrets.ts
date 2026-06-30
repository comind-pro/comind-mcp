import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { secrets, sources } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { encrypt } from '../secrets/vault.js';

const createBody = z
  .object({
    name: z.string().min(1),
    value: z.string().optional(),
    envRef: z.string().optional(),
    sourceId: z.string().optional(),
  })
  .refine((b) => b.value || b.envRef, { message: 'Provide value or envRef' });

const updateBody = z
  .object({ value: z.string().optional(), envRef: z.string().optional() })
  .refine((b) => b.value !== undefined || b.envRef !== undefined, {
    message: 'Provide value or envRef',
  });

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  app.post('/secrets', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);

    if (body.sourceId) {
      const [src] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.id, body.sourceId), eq(sources.ownerId, owner)));
      if (!src) return reply.code(400).send({ error: 'unknown_source' });
    }

    const scope = body.sourceId
      ? and(eq(secrets.ownerId, owner), eq(secrets.name, body.name), eq(secrets.sourceId, body.sourceId))
      : and(eq(secrets.ownerId, owner), eq(secrets.name, body.name), isNull(secrets.sourceId));
    const [clash] = await db.select().from(secrets).where(scope);
    if (clash) return reply.code(409).send({ error: 'name_taken' });

    const row = {
      id: newId(),
      ownerId: owner,
      name: body.name,
      sourceId: body.sourceId ?? null,
      encryptedValue: body.value ? encrypt(body.value) : null,
      envRef: body.envRef ?? null,
      createdAt: new Date(),
    };
    await db.insert(secrets).values(row);
    return reply.code(201).send(await publicSecret(row));
  });

  app.get('/secrets', async (req) => {
    const rows = await db
      .select()
      .from(secrets)
      .where(eq(secrets.ownerId, ownerOf(req)));
    return Promise.all(rows.map(publicSecret));
  });

  app.patch('/secrets/:id', async (req, reply) => {
    const owner = ownerOf(req);
    const { id } = req.params as { id: string };
    const body = updateBody.parse(req.body);
    const [existing] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.ownerId, owner)));
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    // value → re-encrypt (blind: old plaintext is never read). envRef → store the
    // env var name. Setting one clears the other so the kind stays consistent.
    const patch: Partial<typeof secrets.$inferInsert> = {};
    if (body.value !== undefined) {
      patch.encryptedValue = encrypt(body.value);
      patch.envRef = null;
    } else if (body.envRef !== undefined) {
      patch.envRef = body.envRef;
      patch.encryptedValue = null;
    }
    await db
      .update(secrets)
      .set(patch)
      .where(and(eq(secrets.id, id), eq(secrets.ownerId, owner)));
    const [row] = await db.select().from(secrets).where(eq(secrets.id, id));
    return publicSecret(row);
  });

  app.delete('/secrets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(secrets).where(and(eq(secrets.id, id), eq(secrets.ownerId, ownerOf(req))));
    return reply.code(204).send();
  });
}

async function publicSecret(s: typeof secrets.$inferSelect) {
  let sourceName: string | null = null;
  if (s.sourceId) {
    const [src] = await db.select().from(sources).where(eq(sources.id, s.sourceId));
    sourceName = src?.name ?? '(deleted)';
  }
  return {
    id: s.id,
    name: s.name,
    sourceId: s.sourceId,
    sourceName,
    displayName: sourceName ? `${sourceName}.${s.name}` : s.name,
    kind: s.envRef ? 'env' : 'encrypted',
    envRef: s.envRef,
    createdAt: s.createdAt,
  };
}
