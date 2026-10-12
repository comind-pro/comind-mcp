import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { secrets, sources } from '../db/schema.js';
import { usableBy } from '../lib/scope.js';
import { decrypt } from './vault.js';

function resolveSecretValue(r: typeof secrets.$inferSelect): string | null {
  if (r.encryptedValue) return decrypt(r.encryptedValue);
  if (r.envRef) return process.env[r.envRef] ?? '';
  return null; // declared, no value yet
}

/** name → resolved value (null = declared but pending), scoped to ONE owner.
 *  With a projectId: only secrets that project owns or was granted (rule 1).
 *  Without: owner-wide (virtual tools). Globals first, then source overrides. */
export async function loadSecretMap(
  ownerId: string,
  sourceId?: string,
  projectId?: string,
): Promise<Record<string, string | null>> {
  const cond = projectId
    ? and(eq(secrets.ownerId, ownerId), usableBy(secrets.projectId, secrets.id, 'secret', projectId))
    : eq(secrets.ownerId, ownerId);
  const rows = await db.select().from(secrets).where(cond);
  const map: Record<string, string | null> = {};
  for (const r of rows) if (r.sourceId == null) map[r.name] = resolveSecretValue(r); // globals
  if (sourceId) for (const r of rows) if (r.sourceId === sourceId) map[r.name] = resolveSecretValue(r); // overrides
  return map;
}

/** Deep-replace `${secret.NAME}` placeholders in a value with secret values. */
export function injectSecrets<T>(value: T, map: Record<string, string | null>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{secret\.([A-Za-z0-9_.-]+)\}/g, (_m, n) => {
      const v = map[n];
      if (v === null) throw new Error(`secret ${n} is pending — set its value in admin`);
      return v ?? '';
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => injectSecrets(v, map)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = injectSecrets(v, map);
    return out as T;
  }
  return value;
}

/** Resolve all secret placeholders inside a source config, using ONLY the
 *  owning user's secrets (source-scoped overrides globals). */
export async function resolveSourceConfig(
  config: Record<string, unknown>,
  ownerId: string,
  sourceId?: string,
  projectId?: string,
): Promise<Record<string, unknown>> {
  let pid = projectId;
  if (!pid && sourceId) {
    pid = (await db.select({ p: sources.projectId }).from(sources).where(eq(sources.id, sourceId)))[0]?.p;
  }
  const map = await loadSecretMap(ownerId, sourceId, pid);
  return injectSecrets(config, map);
}
