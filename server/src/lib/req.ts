import type { FastifyRequest } from 'fastify';

/** The authenticated user's id (set by the auth preHandler). */
export const ownerOf = (req: FastifyRequest): string => (req as { userId?: string }).userId as string;
