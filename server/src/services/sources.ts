import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { applyAuth } from '../auth/apply.js';
import { createConnector, parseSourceConfig, type SourceKind } from '../connectors/index.js';
import { db } from '../db/client.js';
import { liveTool, sources, tools } from '../db/schema.js';
import { newId, slugify } from '../lib/id.js';
import { inScope, inSubtree, type Scope } from '../lib/scope.js';
import { changedFields } from '../lib/tool-diff.js';
import { resolveSourceConfig } from '../secrets/loader.js';

export type SourceRow = typeof sources.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;

/** What a service returns instead of data. Routes map it to HTTP, MCP tools to an error result. */
export type ServiceErr = {
  error: 'not_found' | 'name_taken' | 'not_visible' | 'unknown_tools' | 'validation' | 'feature_disabled';
  detail?: unknown;
};
export const isErr = (r: unknown): r is ServiceErr => typeof r === 'object' && r !== null && 'error' in r;
export const NOT_FOUND: ServiceErr = { error: 'not_found' };

/** Read: in the scope's subtree or granted to it. */
export async function visibleSource(scope: Scope, id: string): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, id),
        eq(sources.ownerId, scope.ownerId),
        inScope(sources.projectId, sources.id, 'source', scope),
      ),
    );
  return row ?? null;
}

/** Write: subtree only (a grant gives read, not edit). */
export async function administeredSource(scope: Scope, id: string): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.ownerId, scope.ownerId), inSubtree(sources.projectId, scope)));
  return row ?? null;
}

/** Native tool names are `${slugify(source.name)}.${upstream}` and unique per owner,
 *  so two sources of one owner must not share a slug (else one's import would claim
 *  the other's tools). */
export async function slugTaken(ownerId: string, name: string, exceptId?: string): Promise<boolean> {
  const slug = slugify(name);
  const rows = await db
    .select({ id: sources.id, name: sources.name })
    .from(sources)
    .where(eq(sources.ownerId, ownerId));
  return rows.some((r) => r.id !== exceptId && slugify(r.name) === slug);
}

export async function listSources(scope: Scope): Promise<SourceRow[]> {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.ownerId, scope.ownerId), inScope(sources.projectId, sources.id, 'source', scope)));
}

export async function getSource(scope: Scope, id: string): Promise<SourceRow | ServiceErr> {
  return (await visibleSource(scope, id)) ?? NOT_FOUND;
}

/** Throws ZodError on a bad config (the route's error handler answers 400). */
export async function createSource(
  scope: Scope,
  input: { name: string; kind: SourceKind; config: Record<string, unknown> },
  createdByAgentId: string | null,
): Promise<SourceRow | ServiceErr> {
  if (await slugTaken(scope.ownerId, input.name)) return { error: 'name_taken' };
  const config = parseSourceConfig(input.kind, input.config);
  const row = {
    id: newId(),
    ownerId: scope.ownerId,
    projectId: scope.createIn,
    createdByAgentId,
    name: input.name,
    kind: input.kind,
    config,
    status: 'unknown' as const,
    statusMessage: null,
    createdAt: new Date(),
  };
  await db.insert(sources).values(row);
  return row as SourceRow;
}

const connectorFor = async (row: SourceRow) =>
  createConnector(row.kind, await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)));

export async function testSource(scope: Scope, id: string): Promise<{ ok: boolean; message?: string } | ServiceErr> {
  const row = await visibleSource(scope, id);
  if (!row) return NOT_FOUND;
  let result: { ok: boolean; message?: string };
  try {
    result = await (await connectorFor(row)).health();
  } catch (e) {
    result = { ok: false, message: (e as Error).message }; // e.g. a pending secret
  }
  // A grantee may check the connection but not write the source's status.
  if (await administeredSource(scope, id))
    await db
      .update(sources)
      .set({ status: result.ok ? 'ok' : 'error', statusMessage: result.message ?? null, statusCheckedAt: new Date() })
      .where(eq(sources.id, id));
  return result;
}

/** Refresh the cached queryable objects (GA properties, DB schemas, mailboxes…). */
export async function refreshObjects(
  scope: Scope,
  id: string,
): Promise<{ objects: unknown[]; objectsCheckedAt: Date } | ServiceErr> {
  const row = await administeredSource(scope, id);
  if (!row) return NOT_FOUND;
  const connector = await connectorFor(row);
  const objects = connector.listObjects ? await connector.listObjects() : [];
  const objectsCheckedAt = new Date();
  await db
    .update(sources)
    .set({ objects: objects as unknown as Array<Record<string, unknown>>, objectsCheckedAt })
    .where(eq(sources.id, id));
  return { objects, objectsCheckedAt };
}

/** Per-tool outcome. `outdated` = differs from the source but left alone (non-force);
 *  `removed` / `missing` = gone from the source: soft-deleted by force, otherwise kept;
 *  `restored` = was soft-deleted and the source offers it again. */
export type ImportChange = {
  name: string;
  status: 'created' | 'updated' | 'unchanged' | 'outdated' | 'removed' | 'missing' | 'restored';
  fields: string[];
};
export type ImportReport = {
  mode: 'force' | 'new';
  total: number;
  created: number;
  updated: number;
  removed: number;
  restored: number;
  skipped: number;
  imported: number;
  changes: ImportChange[];
  tools: ToolRow[];
};

/** Live tools the source no longer offers. Matched on upstreamName, not the
 *  prefixed name, so renaming a source never makes its tools look gone.
 *  ponytail: an empty upstream list is treated as a connector glitch, not "remove
 *  everything" — delete the source itself to drop all of its tools. */
async function goneTools(sourceId: string, upstreamNames: string[]) {
  if (!upstreamNames.length) return [];
  return db
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(
      and(
        eq(tools.sourceId, sourceId),
        eq(tools.kind, 'native'),
        liveTool(),
        notInArray(tools.upstreamName, upstreamNames),
      ),
    );
}

/** What a force import would soft-delete. No writes. */
export async function previewImportRemovals(scope: Scope, id: string): Promise<{ removed: string[] } | ServiceErr> {
  const row = await administeredSource(scope, id);
  if (!row) return NOT_FOUND;
  const upstream = await (await connectorFor(row)).listTools();
  const gone = await goneTools(
    row.id,
    upstream.map((t) => t.name),
  );
  return { removed: gone.map((g) => g.name) };
}

/** `force`: overwrite existing tools too (refresh metadata/schemas). Default:
 *  only create missing tools, leaving existing ones (and manual edits) intact. */
export async function importSource(
  scope: Scope,
  id: string,
  opts: { force: boolean; createdByAgentId: string | null },
): Promise<ImportReport | ServiceErr> {
  const { force } = opts;
  const owner = scope.ownerId;
  const row = await administeredSource(scope, id);
  if (!row) return NOT_FOUND;

  const upstream = await (await connectorFor(row)).listTools();
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
  // A same-named tool bound to another source (e.g. a sibling project's) is not ours
  // to re-point: refuse the whole import before writing anything.
  const foreign = [...before.values()].filter((t) => t.sourceId != null && t.sourceId !== row.id).map((t) => t.name);
  if (foreign.length) return { error: 'name_taken', detail: { names: foreign } };

  const changes: ImportChange[] = [];
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
      projectId: row.projectId, // native tools live with their source
      createdByAgentId: opts.createdByAgentId,
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

  const gone = await goneTools(
    row.id,
    upstream.map((t) => t.name),
  );
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
}
