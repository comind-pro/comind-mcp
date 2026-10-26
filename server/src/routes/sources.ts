import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createConnector, parseSourceConfig, sourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { sources } from '../db/schema.js';
import { sendErr } from '../lib/req.js';
import { scopeFor } from '../lib/scope.js';
import { checkScopedSources } from '../scheduler/source-check.js';
import { injectSecrets, loadSecretMap } from '../secrets/loader.js';
import {
  administeredSource,
  createSource,
  getSource,
  importSource,
  isErr,
  listSources,
  refreshObjects,
  slugTaken,
  testSource,
} from '../services/sources.js';

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

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sources', async (req, reply) => {
    const r = await createSource(await scopeFor(req), createBody.parse(req.body), null);
    return isErr(r) ? sendErr(reply, r) : reply.code(201).send(r);
  });

  app.get('/sources', async (req) => listSources(await scopeFor(req)));

  app.get('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await getSource(await scopeFor(req), id);
    return isErr(r) ? sendErr(reply, r) : r;
  });

  app.patch('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const existing = await administeredSource(await scopeFor(req), id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (body.name !== undefined && body.name !== existing.name && (await slugTaken(existing.ownerId, body.name, id)))
      return reply.code(409).send({ error: 'name_taken' });

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.config !== undefined) patch.config = parseSourceConfig(existing.kind, body.config);
    if (Object.keys(patch).length) await db.update(sources).set(patch).where(eq(sources.id, id));

    const [row] = await db.select().from(sources).where(eq(sources.id, id));
    return row;
  });

  app.delete('/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await administeredSource(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(sources).where(eq(sources.id, id));
    return reply.code(204).send();
  });

  // Stateless connection check for the new-source wizard (before the row exists).
  // Resolves the owner's GLOBAL secrets plus any pending (not-yet-saved) secret
  // values passed inline by the wizard. Skips applyAuth (no stored OAuth tokens).
  app.post('/sources/test', async (req, reply) => {
    const scope = await scopeFor(req);
    const body = testBody.parse(req.body);
    try {
      const map = { ...(await loadSecretMap(scope.ownerId, undefined, scope.createIn)), ...(body.secrets ?? {}) };
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

  // Run the periodic source check now, for every connection in scope.
  app.post('/sources/check', async (req) => checkScopedSources(await scopeFor(req)));

  app.post('/sources/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await testSource(await scopeFor(req), id);
    return isErr(r) ? sendErr(reply, r) : r;
  });

  // Refresh the cached queryable objects (GA properties, DB schemas, mailboxes…).
  app.post('/sources/:id/objects', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await refreshObjects(await scopeFor(req), id);
    return isErr(r) ? sendErr(reply, r) : { id, ...r };
  });

  app.post('/sources/:id/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    // `force`: overwrite existing tools too (refresh metadata/schemas). Default:
    // only create missing tools, leaving existing ones (and manual edits) intact.
    const force =
      (req.body as { force?: boolean } | null)?.force === true || (req.query as { force?: string }).force === 'true';
    const r = await importSource(await scopeFor(req), id, { force, createdByAgentId: null });
    return isErr(r) ? sendErr(reply, r) : r;
  });
}
