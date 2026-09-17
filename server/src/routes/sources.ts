import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyAuth } from '../auth/apply.js';
import { createConnector, parseSourceConfig, sourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { liveTool, sources, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { changedFields } from '../lib/tool-diff.js';
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
async function owned(_req: { url: string }, id: string, owner: string) {
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.ownerId, owner)));
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

  app.get('/sources', async (req) =>
    db
      .select()
      .from(sources)
      .where(eq(sources.ownerId, ownerOf(req))),
  );

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

    const connector = createConnector(
      row.kind,
      await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)),
    );
    const result = await connector.health();
    await db
      .update(sources)
      .set({ status: result.ok ? 'ok' : 'error', statusMessage: result.message ?? null, statusCheckedAt: new Date() })
      .where(eq(sources.id, id));
    return result;
  });

  // Refresh the cached queryable objects (GA properties, DB schemas, mailboxes…).
  app.post('/sources/:id/objects', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await owned(req, id, ownerOf(req));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const connector = createConnector(
      row.kind,
      await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)),
    );
    const objects = connector.listObjects ? await connector.listObjects() : [];
    const objectsCheckedAt = new Date();
    await db
      .update(sources)
      .set({ objects: objects as unknown as Array<Record<string, unknown>>, objectsCheckedAt })
      .where(eq(sources.id, id));
    return { id, objects, objectsCheckedAt };
  });

  app.post('/sources/:id/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const row = await owned(req, id, owner);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    // `force`: overwrite existing tools too (refresh metadata/schemas). Default:
    // only create missing tools, leaving existing ones (and manual edits) intact.
    const force =
      (req.body as { force?: boolean } | null)?.force === true || (req.query as { force?: string }).force === 'true';

    const connector = createConnector(
      row.kind,
      await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)),
    );
    const upstream = await connector.listTools();
    const prefix = slugify(row.name);

    // Snapshot the rows we may touch (soft-deleted ones too — they still own their
    // name), so the response can say what actually changed.
    const before = new Map(
      upstream.length
        ? (
            await db
              .select()
              .from(tools)
              .where(
                and(
                  eq(tools.ownerId, owner),
                  inArray(
                    tools.name,
                    upstream.map((t) => `${prefix}.${t.name}`),
                  ),
                ),
              )
          ).map((r) => [r.name, r] as const)
        : [],
    );

    // Per-tool outcome. `outdated` = differs from the source but left alone (non-force);
    // `removed` / `missing` = gone from the source: soft-deleted by force, otherwise kept;
    // `restored` = was soft-deleted and the source offers it again.
    const changes: Array<{
      name: string;
      status: 'created' | 'updated' | 'unchanged' | 'outdated' | 'removed' | 'missing' | 'restored';
      fields: string[];
    }> = [];
    for (const t of upstream) {
      // NB: dots are fine here — the MCP gateway maps names onto the MCP-safe
      // charset at the boundary (see lib/tool-name.ts); stored names stay stable.
      const name = `${prefix}.${t.name}`;
      // What a force refresh overwrites. undefined is omitted by drizzle,
      // preserving a manual value on refresh.
      const refreshed = {
        upstreamName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? null,
        outputSchema: t.outputSchema,
        // curated discovery metadata from the connector (when provided)
        readOnly: t.readOnly,
        dangerous: t.dangerous,
        permissions: t.permissions,
        examples: t.examples,
        recommendedUse: t.recommendedUse,
      };
      const values = {
        id: newId(),
        ownerId: owner,
        sourceId: row.id,
        kind: 'native' as const,
        name,
        upstreamName: t.name,
        displayName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? null,
        outputSchema: t.outputSchema ?? null,
        readOnly: t.readOnly ?? null,
        dangerous: t.dangerous ?? null,
        permissions: t.permissions ?? [],
        examples: t.examples ?? [],
        recommendedUse: t.recommendedUse ?? null,
        visible: true,
        createdAt: new Date(),
      };
      const old = before.get(name);
      // The user can't see a soft-deleted tool, so its return is a fresh import in
      // either mode: refresh it from the source and bring it back.
      const restore = !!old?.deletedAt;
      const fields = old && !restore ? changedFields(old, refreshed) : [];
      changes.push({
        name,
        status: !old ? 'created' : restore ? 'restored' : !fields.length ? 'unchanged' : force ? 'updated' : 'outdated',
        fields,
      });
      if (force || restore) {
        await db
          .insert(tools)
          .values(values)
          .onConflictDoUpdate({
            target: [tools.ownerId, tools.name],
            set: { sourceId: row.id, ...refreshed, deletedAt: null },
          });
      } else {
        // create-only: existing tools are left untouched.
        await db
          .insert(tools)
          .values(values)
          .onConflictDoNothing({ target: [tools.ownerId, tools.name] });
      }
    }
    const created = changes.filter((c) => c.status === 'created').length;

    // Live tools the source no longer offers. Matched on upstreamName, not the
    // prefixed name, so renaming a source never makes its tools look gone.
    // ponytail: an empty upstream list is treated as a connector glitch, not "remove
    // everything" — delete the source itself to drop all of its tools.
    const gone = upstream.length
      ? await db
          .select({ id: tools.id, name: tools.name })
          .from(tools)
          .where(
            and(
              eq(tools.sourceId, row.id),
              eq(tools.kind, 'native'),
              liveTool(),
              notInArray(
                tools.upstreamName,
                upstream.map((t) => t.name),
              ),
            ),
          )
      : [];
    // Soft delete (see `tools.deletedAt`): gone for users and agents alike, restored
    // by the next import that sees the tool again.
    if (force && gone.length)
      await db
        .update(tools)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            tools.id,
            gone.map((g) => g.id),
          ),
        );
    for (const g of gone) changes.push({ name: g.name, status: force ? 'removed' : 'missing', fields: [] });

    await db.update(sources).set({ status: 'ok', statusMessage: null }).where(eq(sources.id, id));
    const imported = await db
      .select()
      .from(tools)
      .where(and(eq(tools.sourceId, row.id), eq(tools.kind, 'native'), liveTool()));
    return {
      mode: force ? 'force' : 'new',
      total: upstream.length,
      created,
      updated: changes.filter((c) => c.status === 'updated').length,
      removed: force ? gone.length : 0,
      restored: changes.filter((c) => c.status === 'restored').length,
      skipped: changes.filter((c) => c.status === 'unchanged' || c.status === 'outdated').length,
      imported: imported.length,
      changes,
      tools: imported,
    };
  });
}
