import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { secrets } from '../db/schema.js';
import { decrypt } from './vault.js';

function resolveSecretValue(r: typeof secrets.$inferSelect): string {
  if (r.encryptedValue) return decrypt(r.encryptedValue);
  if (r.envRef) return process.env[r.envRef] ?? '';
  return '';
}

/** name → resolved value, scoped to ONE owner. Globals first, then this owner's
 *  source-scoped overrides. Owner scoping is mandatory: secrets must never leak
 *  across tenants. */
export async function loadSecretMap(ownerId: string, sourceId?: string): Promise<Record<string, string>> {
  const rows = await db.select().from(secrets).where(eq(secrets.ownerId, ownerId));
  const map: Record<string, string> = {};
  for (const r of rows) if (r.sourceId == null) map[r.name] = resolveSecretValue(r); // globals
  if (sourceId) for (const r of rows) if (r.sourceId === sourceId) map[r.name] = resolveSecretValue(r); // overrides
  return map;
}

/** Deep-replace `${secret.NAME}` placeholders in a value with secret values. */
export function injectSecrets<T>(value: T, map: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{secret\.([A-Za-z0-9_.-]+)\}/g, (_m, n) => map[n] ?? '') as unknown as T;
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
): Promise<Record<string, unknown>> {
  const map = await loadSecretMap(ownerId, sourceId);
  return injectSecrets(config, map);
}
