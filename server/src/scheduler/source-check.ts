import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sources } from '../db/schema.js';
import { inSubtree, type Scope } from '../lib/scope.js';
import { listSources, probeSource, type SourceRow, sourceDrift } from '../services/sources.js';

/** One pass over a source: refresh its status; when reachable, record what a
 *  re-import would change. A failed health check keeps the last known drift. */
export async function checkSource(row: SourceRow): Promise<void> {
  const health = await probeSource(row);
  const now = new Date();
  await db
    .update(sources)
    .set({ status: health.ok ? 'ok' : 'error', statusMessage: health.message ?? null, statusCheckedAt: now })
    .where(eq(sources.id, row.id));
  if (!health.ok) return;
  const drift = await sourceDrift(row);
  await db.update(sources).set({ drift, driftCheckedAt: now }).where(eq(sources.id, row.id));
}

/** The "Refresh all" button: check what the scope may edit, return what it may see. */
export async function checkScopedSources(scope: Scope): Promise<SourceRow[]> {
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.ownerId, scope.ownerId), inSubtree(sources.projectId, scope)));
  for (const row of rows) await checkSource(row).catch(() => {});
  return listSources(scope);
}

/** Every source of every owner, one after another. One failure never stops the pass.
 *  ponytail: sequential; batch with a concurrency cap once sources number in the hundreds. */
export async function checkAllSources(): Promise<void> {
  for (const row of await db.select().from(sources)) await checkSource(row).catch(() => {});
}
