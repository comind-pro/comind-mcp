import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServiceErr } from '../services/sources.js';

/** The authenticated user's id (set by the auth preHandler). */
export const ownerOf = (req: FastifyRequest): string => (req as { userId?: string }).userId as string;

const STATUS: Partial<Record<ServiceErr['error'], number>> = { not_found: 404, name_taken: 409, feature_disabled: 403 };

/** ServiceErr → HTTP. `detail` fields join the body (`{ error, missing }`, `{ error, names }`…);
 *  a `detail.error` overrides the code for routes that answer a more specific one. */
export const sendErr = (reply: FastifyReply, e: ServiceErr) =>
  reply.code(STATUS[e.error] ?? 400).send({ error: e.error, ...(e.detail as object | undefined) });
