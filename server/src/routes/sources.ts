import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyAuth } from '../auth/apply.js';
import { createConnector, parseSourceConfig, sourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { sources, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { injectSecrets, loadSecretMap, resolveSourceConfig } from '../secrets/loader.js';

const createBody = z.object({
  name: z.string().min(1),
  kind: sourceKind,
  config: z.record(z.unknown()),
});

const patchBody = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

const testBody = z.object({
  name: z.string().optional(),
  kind: sourceKind,
  config: z.record(z.unknown()),
  secrets: z.record(z.string()).optional(),
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

  // Stateless connection check for the new-source wizard (before the row exists).
  // Resolves the owner's GLOBAL secrets plus any pending (not-yet-saved) secret
  // values passed inline by the wizard. Skips applyAuth (no stored OAuth tokens).
  app.post('/sources/test', async (req, reply) => {
    const owner = ownerOf(req);
    const body = testBody.parse(req.body);
    try {
      const map = { ...(await loadSecretMap(owner)), ...(body.secrets ?? {}) };
      const config = parseSourceConfig(body.kind, injectSecrets(body.config, map));
      const connector = createConnector(body.kind, config);
      return await connector.health();
    } catch (e) {
      const msg =
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          : (e as Error).message;
      return reply.code(200).send({ ok: false, message: msg });
    }
  });

  app.post('/sources/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await owned(req, id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const connector = createConnector(row.kind, await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)));
    const result = await connector.health();
    await db
      .update(sources)
      .set({ status: result.ok ? 'ok' : 'error', statusMessage: result.message ?? null })
      .where(eq(sources.id, id));
    return result;
  });

  app.post('/sources/:id/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const row = await owned(req, id, owner);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const connector = createConnector(row.kind, await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)));
    const upstream = await connector.listTools();
    const prefix = slugify(row.name);

    for (const t of upstream) {
      const name = `${prefix}.${t.name}`;
      await db
        .insert(tools)
        .values({
          id: newId(),
          ownerId: owner,
          sourceId: row.id,
          kind: 'native',
          name,
          upstreamName: t.name,
          displayName: t.name,
          description: t.description ?? null,
          inputSchema: t.inputSchema ?? null,
          outputSchema: t.outputSchema ?? null,
          visible: true,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [tools.ownerId, tools.name],
          set: {
            sourceId: row.id,
            upstreamName: t.name,
            description: t.description ?? null,
            inputSchema: t.inputSchema ?? null,
            // only refresh when the connector provides one (OpenAPI); undefined is
            // omitted by drizzle, preserving a manually-set schema on re-import.
            outputSchema: t.outputSchema,
          },
        });
    }

    await db.update(sources).set({ status: 'ok', statusMessage: null }).where(eq(sources.id, id));
    const imported = await db
      .select()
      .from(tools)
      .where(and(eq(tools.sourceId, row.id), eq(tools.kind, 'native')));
    return { imported: imported.length, tools: imported };
  });
}
