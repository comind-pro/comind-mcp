import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { userFeatures } from '../db/schema.js';

/** Feature key for user-authored Python tools. */
export const PYTHON_TOOLS = 'python_tools';

/**
 * Per-user feature ACL. Default is OFF: a user has a feature only when a
 * `user_features` row grants it. The env flag is an instance-wide override for
 * local dev / single-user self-host, where per-user ACL is pointless.
 */
export async function hasFeature(userId: string, feature: string): Promise<boolean> {
  if (feature === PYTHON_TOOLS && config.pythonToolsOpen) return true;
  const [row] = await db
    .select()
    .from(userFeatures)
    .where(and(eq(userFeatures.userId, userId), eq(userFeatures.feature, feature)));
  return row?.enabled === true;
}
