import { db } from '../db/client.js';
import { secrets } from '../db/schema.js';
import { decrypt } from './vault.js';

function valueOf(r: typeof secrets.$inferSelect): string {
  if (r.encryptedValue) return decrypt(r.encryptedValue);
  if (r.envRef) return process.env[r.envRef] ?? '';
  return '';
}

/** name → resolved value. Globals first, then source-scoped overrides (if sourceId given). */
export async function loadSecretMap(sourceId?: string): Promise<Record<string, string>> {
  const rows = await db.select().from(secrets);
  const map: Record<string, string> = {};
  for (const r of rows) if (r.sourceId == null) map[r.name] = valueOf(r); // globals
  if (sourceId) for (const r of rows) if (r.sourceId === sourceId) map[r.name] = valueOf(r); // overrides
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

/** Resolve all secret placeholders inside a source config (source-scoped overrides globals). */
export async function resolveSourceConfig(
  config: Record<string, unknown>,
  sourceId?: string,
): Promise<Record<string, unknown>> {
  const map = await loadSecretMap(sourceId);
  return injectSecrets(config, map);
}
