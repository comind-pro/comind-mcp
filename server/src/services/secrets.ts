import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { secrets, sources } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { inScope, type Scope } from '../lib/scope.js';
import { encrypt } from '../secrets/vault.js';
import { administeredSource, NOT_FOUND, type ServiceErr } from './sources.js';

export type SecretRow = typeof secrets.$inferSelect;
export type PublicSecret = Awaited<ReturnType<typeof publicSecret>>;

/** Never the value: name, scope and a `pending` flag. */
export async function publicSecret(s: SecretRow) {
  let sourceName: string | null = null;
  if (s.sourceId) {
    const [src] = await db.select().from(sources).where(eq(sources.id, s.sourceId));
    sourceName = src?.name ?? '(deleted)';
  }
  return {
    id: s.id,
    name: s.name,
    sourceId: s.sourceId,
    sourceName,
    displayName: sourceName ? `${sourceName}.${s.name}` : s.name,
    kind: s.envRef ? 'env' : 'encrypted',
    pending: !s.encryptedValue && !s.envRef,
    projectId: s.projectId,
    createdByAgentId: s.createdByAgentId,
    envRef: s.envRef,
    createdAt: s.createdAt,
  };
}

/** A secret with a value, an env ref, or neither (pending). A source-scoped secret
 *  needs an administered source and lives in its project. */
export async function createSecret(
  scope: Scope,
  input: { name: string; sourceId?: string; value?: string; envRef?: string },
  createdByAgentId: string | null,
): Promise<PublicSecret | ServiceErr> {
  const owner = scope.ownerId;
  let projectId = scope.createIn;
  if (input.sourceId) {
    const src = await administeredSource(scope, input.sourceId);
    if (!src) return NOT_FOUND;
    projectId = src.projectId; // a source-scoped secret lives with its source
  }
  const where = input.sourceId
    ? and(eq(secrets.ownerId, owner), eq(secrets.name, input.name), eq(secrets.sourceId, input.sourceId))
    : and(eq(secrets.ownerId, owner), eq(secrets.name, input.name), isNull(secrets.sourceId));
  const [clash] = await db.select().from(secrets).where(where);
  if (clash) return { error: 'name_taken' };

  const row = {
    id: newId(),
    ownerId: owner,
    projectId,
    createdByAgentId,
    name: input.name,
    sourceId: input.sourceId ?? null,
    encryptedValue: input.value ? encrypt(input.value) : null,
    envRef: input.envRef ?? null,
    createdAt: new Date(),
  };
  await db.insert(secrets).values(row);
  return publicSecret(row);
}

/** A pending secret (no value): the owner fills it in admin. */
export function declareSecret(
  scope: Scope,
  input: { name: string; sourceId?: string },
  createdByAgentId: string | null,
): Promise<PublicSecret | ServiceErr> {
  return createSecret(scope, { name: input.name, sourceId: input.sourceId }, createdByAgentId);
}

export async function listSecrets(scope: Scope): Promise<PublicSecret[]> {
  const rows = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.ownerId, scope.ownerId), inScope(secrets.projectId, secrets.id, 'secret', scope)));
  return Promise.all(rows.map(publicSecret));
}
