import { createHash } from 'node:crypto';

/** Hash an agent API key for storage/lookup (keys are never stored in clear). */
export const hashKey = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
