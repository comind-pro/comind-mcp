import { isDeepStrictEqual } from 'node:util';

/** Keys of `next` whose value differs from the stored row. `undefined` in `next`
 * means "keep the stored value" (drizzle omits it on update), so it never counts.
 * Deep-equal, not JSON.stringify: jsonb round-trips reorder object keys. */
export function changedFields(old: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return Object.keys(next).filter((k) => next[k] !== undefined && !isDeepStrictEqual(next[k], old[k]));
}
