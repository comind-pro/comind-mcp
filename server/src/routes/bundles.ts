import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseSourceConfig, sourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { composites, groups, groupTools, secrets, sources, tools, virtuals } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';

/**
 * Group bundle v1: a workspace serialized for transfer between instances.
 * Everything is referenced by name — no ids, no ownerId, no secret values.
 * NB: credentials typed inline into a config (instead of `${secret.X}`)
 * export as-is; the bundle is a self-to-self artifact, not a sharing format.
 */

const bundleTool = z.object({
  name: z.string().min(1),
  kind: z.enum(['native', 'composite', 'virtual']),
  source: z.string().nullable().optional(),
  upstreamName: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  visible: z.boolean().optional(),
  readOnly: z.boolean().nullable().optional(),
  dangerous: z.boolean().nullable().optional(),
  permissions: z.array(z.string()).optional(),
  examples: z.array(z.record(z.unknown())).optional(),
  recommendedUse: z.record(z.unknown()).nullable().optional(),
  virtual: z
    .object({ executable: z.boolean(), request: z.record(z.unknown()), response: z.unknown().optional() })
    .nullable()
    .optional(),
  composite: z.record(z.unknown()).nullable().optional(),
});

const bundleSchema = z.object({
  version: z.literal(1),
  group: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    schedulingEnabled: z.boolean().optional(),
  }),
  sources: z.array(z.object({ name: z.string().min(1), kind: sourceKind, config: z.record(z.unknown()) })).default([]),
  tools: z.array(bundleTool).default([]),
  secrets: z.array(z.object({ name: z.string().min(1), source: z.string().nullable().optional() })).default([]),
});
export type Bundle = z.infer<typeof bundleSchema>;

/** Collect `${secret.NAME}` references anywhere inside a JSON value. */
function secretRefs(value: unknown, into: Set<string>): void {
  const text = JSON.stringify(value ?? null) ?? '';
  for (const m of text.matchAll(/\$\{secret\.([A-Za-z0-9_.-]+)\}/g)) into.add(m[1]);
}

export async function bundleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/groups/:id/export', async (req, reply) => {
    const owner = ownerOf(req);
    const { id } = req.params as { id: string };
    const [grp] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.ownerId, owner)));
    if (!grp) return reply.code(404).send({ error: 'not_found' });

    const links = await db.select().from(groupTools).where(eq(groupTools.groupId, id));
    const toolIds = links.map((l) => l.toolId);
    const toolRows = toolIds.length ? await db.select().from(tools).where(inArray(tools.id, toolIds)) : [];

    const sourceIds = [...new Set(toolRows.map((t) => t.sourceId).filter((s): s is string => s != null))];
    const sourceRows = sourceIds.length ? await db.select().from(sources).where(inArray(sources.id, sourceIds)) : [];
    const sourceName = new Map(sourceRows.map((s) => [s.id, s.name]));

    const virtualIds = toolRows.filter((t) => t.kind === 'virtual').map((t) => t.id);
    const virtualRows = virtualIds.length
      ? await db.select().from(virtuals).where(inArray(virtuals.toolId, virtualIds))
      : [];
    const virtualByTool = new Map(virtualRows.map((v) => [v.toolId, v]));

    const compositeIds = toolRows.filter((t) => t.kind === 'composite').map((t) => t.id);
    const compositeRows = compositeIds.length
      ? await db.select().from(composites).where(inArray(composites.toolId, compositeIds))
      : [];
    const compositeByTool = new Map(compositeRows.map((c) => [c.toolId, c]));

    // secret names: ${secret.X} refs in configs/requests + scoped secrets of bundled sources
    const refs = new Set<string>();
    for (const s of sourceRows) secretRefs(s.config, refs);
    for (const v of virtualRows) secretRefs(v.request, refs);
    const scopedRows = sourceIds.length
      ? await db
          .select()
          .from(secrets)
          .where(and(eq(secrets.ownerId, owner), inArray(secrets.sourceId, sourceIds)))
      : [];
    const secretEntries = [
      ...scopedRows.map((s) => ({ name: s.name, source: sourceName.get(s.sourceId ?? '') ?? null })),
      ...[...refs]
        .filter((name) => !scopedRows.some((s) => s.name === name))
        .map((name) => ({ name, source: null as string | null })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    const bundle: Bundle = {
      version: 1,
      group: {
        slug: grp.slug,
        name: grp.name,
        description: grp.description,
        schedulingEnabled: grp.schedulingEnabled,
      },
      sources: sourceRows.map((s) => ({ name: s.name, kind: s.kind, config: s.config })),
      tools: toolRows.map((t) => ({
        name: t.name,
        kind: t.kind,
        source: t.sourceId ? (sourceName.get(t.sourceId) ?? null) : null,
        upstreamName: t.upstreamName,
        displayName: t.displayName,
        description: t.description,
        inputSchema: t.inputSchema ?? null,
        outputSchema: t.outputSchema ?? null,
        visible: t.visible,
        readOnly: t.readOnly,
        dangerous: t.dangerous,
        permissions: t.permissions ?? [],
        examples: t.examples ?? [],
        recommendedUse: t.recommendedUse ?? null,
        virtual: virtualByTool.has(t.id)
          ? {
              executable: virtualByTool.get(t.id)?.executable ?? true,
              request: virtualByTool.get(t.id)?.request ?? {},
              response: virtualByTool.get(t.id)?.response ?? null,
            }
          : null,
        composite: (compositeByTool.get(t.id)?.definition as Record<string, unknown> | undefined) ?? null,
      })),
      secrets: secretEntries,
    };
    reply.header('content-disposition', `attachment; filename="${grp.slug}.bundle.json"`);
    return bundle;
  });

  app.post('/groups/import', async (req, reply) => {
    const owner = ownerOf(req);
    const bundle = bundleSchema.parse(req.body);

    // validate source configs & name refs up front (fail before writing anything)
    for (const s of bundle.sources) parseSourceConfig(s.kind, s.config);
    const bundleSourceNames = new Set(bundle.sources.map((s) => s.name));
    for (const t of bundle.tools) {
      if (t.kind === 'native' && (!t.source || !bundleSourceNames.has(t.source)))
        return reply.code(400).send({ error: 'unknown_source', tool: t.name, source: t.source ?? null });
      if (t.kind === 'native' && !t.upstreamName)
        return reply.code(400).send({ error: 'missing_upstream_name', tool: t.name });
      if (t.kind === 'virtual' && !t.virtual) return reply.code(400).send({ error: 'missing_virtual', tool: t.name });
      if (t.kind === 'composite' && !t.composite)
        return reply.code(400).send({ error: 'missing_composite', tool: t.name });
    }

    const report = {
      group: 'created' as 'created' | 'skipped',
      sources: { created: [] as string[], skipped: [] as string[] },
      tools: { created: [] as string[], skipped: [] as string[] },
      secrets: { created: [] as string[], skipped: [] as string[] },
      secretsToFill: [] as string[],
    };

    await db.transaction(async (tx) => {
      // group by slug — existing is reused as-is (its name/description win)
      let [grp] = await tx
        .select()
        .from(groups)
        .where(and(eq(groups.slug, bundle.group.slug), eq(groups.ownerId, owner)));
      if (grp) report.group = 'skipped';
      else {
        grp = {
          id: newId(),
          ownerId: owner,
          slug: bundle.group.slug,
          name: bundle.group.name,
          description: bundle.group.description ?? null,
          schedulingEnabled: bundle.group.schedulingEnabled ?? true,
          createdAt: new Date(),
        };
        await tx.insert(groups).values(grp);
      }

      // sources by name
      const sourceId = new Map<string, string>();
      for (const s of bundle.sources) {
        const [existing] = await tx
          .select()
          .from(sources)
          .where(and(eq(sources.name, s.name), eq(sources.ownerId, owner)));
        if (existing) {
          sourceId.set(s.name, existing.id);
          report.sources.skipped.push(s.name);
          continue;
        }
        const id = newId();
        await tx.insert(sources).values({
          id,
          ownerId: owner,
          name: s.name,
          kind: s.kind,
          config: parseSourceConfig(s.kind, s.config),
          status: 'unknown',
          createdAt: new Date(),
        });
        sourceId.set(s.name, id);
        report.sources.created.push(s.name);
      }

      // secrets by (name, scope) — created EMPTY, never overwritten
      for (const s of bundle.secrets) {
        const scopeId = s.source ? (sourceId.get(s.source) ?? null) : null;
        const scope = scopeId
          ? and(eq(secrets.ownerId, owner), eq(secrets.name, s.name), eq(secrets.sourceId, scopeId))
          : and(eq(secrets.ownerId, owner), eq(secrets.name, s.name), isNull(secrets.sourceId));
        const [existing] = await tx.select().from(secrets).where(scope);
        if (existing) {
          report.secrets.skipped.push(s.name);
          if (!existing.encryptedValue && !existing.envRef) report.secretsToFill.push(s.name);
          continue;
        }
        await tx.insert(secrets).values({
          id: newId(),
          ownerId: owner,
          name: s.name,
          sourceId: scopeId,
          encryptedValue: null,
          envRef: null,
          createdAt: new Date(),
        });
        report.secrets.created.push(s.name);
        report.secretsToFill.push(s.name);
      }

      // tools by name; composites last so their step refs (tool names) exist
      const ordered = [...bundle.tools].sort(
        (a, b) => (a.kind === 'composite' ? 1 : 0) - (b.kind === 'composite' ? 1 : 0),
      );
      const linkIds: string[] = [];
      for (const t of ordered) {
        const [existing] = await tx
          .select()
          .from(tools)
          .where(and(eq(tools.name, t.name), eq(tools.ownerId, owner)));
        if (existing) {
          linkIds.push(existing.id);
          report.tools.skipped.push(t.name);
          continue;
        }
        const id = newId();
        await tx.insert(tools).values({
          id,
          ownerId: owner,
          sourceId: t.source ? (sourceId.get(t.source) ?? null) : null,
          kind: t.kind,
          name: t.name,
          upstreamName: t.upstreamName ?? null,
          displayName: t.displayName ?? null,
          description: t.description ?? null,
          inputSchema: t.inputSchema ?? null,
          outputSchema: t.outputSchema ?? null,
          visible: t.visible ?? true,
          readOnly: t.readOnly ?? null,
          dangerous: t.dangerous ?? null,
          permissions: t.permissions ?? [],
          examples: (t.examples ?? []) as Array<Record<string, unknown>>,
          recommendedUse: t.recommendedUse ?? null,
          createdAt: new Date(),
        });
        if (t.kind === 'virtual' && t.virtual) {
          await tx.insert(virtuals).values({
            id: newId(),
            toolId: id,
            executable: t.virtual.executable,
            request: t.virtual.request,
            response: t.virtual.response ?? null,
          });
        }
        if (t.kind === 'composite' && t.composite) {
          await tx.insert(composites).values({ id: newId(), toolId: id, definition: t.composite });
        }
        linkIds.push(id);
        report.tools.created.push(t.name);
      }

      // link all bundle tools into the group (insert missing links only)
      const existingLinks = await tx.select().from(groupTools).where(eq(groupTools.groupId, grp.id));
      const linked = new Set(existingLinks.map((l) => l.toolId));
      const missing = linkIds.filter((tid) => !linked.has(tid));
      if (missing.length) await tx.insert(groupTools).values(missing.map((toolId) => ({ groupId: grp.id, toolId })));
    });

    return reply.code(report.group === 'created' ? 201 : 200).send(report);
  });
}
