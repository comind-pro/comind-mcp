import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { secrets } from '../db/schema.js';
import { sendErr } from '../lib/req.js';
import { inSubtree, scopeFor } from '../lib/scope.js';
import { encrypt } from '../secrets/vault.js';
import { createSecret, listSecrets, publicSecret } from '../services/secrets.js';
import { isErr } from '../services/sources.js';

const createBody = z
  .object({
    name: z.string().min(1),
    value: z.string().optional(),
    envRef: z.string().optional(),
    sourceId: z.string().optional(),
    pending: z.boolean().optional(),
  })
  .refine((b) => b.value || b.envRef || b.pending, { message: 'Provide value, envRef or pending' });

const updateBody = z
  .object({ value: z.string().optional(), envRef: z.string().optional() })
  .refine((b) => b.value !== undefined || b.envRef !== undefined, {
    message: 'Provide value or envRef',
  });

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  app.post('/secrets', async (req, reply) => {
    const sc = await scopeFor(req);
    const { pending: _p, ...body } = createBody.parse(req.body);
    const r = await createSecret(sc, body, null);
    if (isErr(r))
      return r.error === 'not_found' ? reply.code(400).send({ error: 'unknown_source' }) : sendErr(reply, r);
    return reply.code(201).send(r);
  });

  app.get('/secrets', async (req) => listSecrets(await scopeFor(req)));

  app.patch('/secrets/:id', async (req, reply) => {
    const sc = await scopeFor(req);
    const owner = sc.ownerId;
    const { id } = req.params as { id: string };
    const body = updateBody.parse(req.body);
    const [existing] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.ownerId, owner), inSubtree(secrets.projectId, sc)));
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
    const sc = await scopeFor(req);
    const administered = and(eq(secrets.id, id), eq(secrets.ownerId, sc.ownerId), inSubtree(secrets.projectId, sc));
    const [row] = await db.select({ id: secrets.id }).from(secrets).where(administered);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await db.delete(secrets).where(administered);
    return reply.code(204).send();
  });
}
