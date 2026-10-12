import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scopeFor } from '../lib/scope.js';
import { createNode, deleteNode, grantAccess, listAccess, listNodes, revokeAccess } from '../services/projects.js';

const resType = z.enum(['source', 'tool', 'secret']);

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (req) => listNodes(await scopeFor(req)));
  app.post('/projects', async (req, reply) => {
    const body = z
      .object({
        kind: z.enum(['team', 'project']),
        name: z.string().min(1),
        slug: z.string().min(1).optional(),
        parentId: z.string(),
      })
      .parse(req.body);
    const r = await createNode(await scopeFor(req), body);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'slug_taken') return reply.code(409).send({ error: 'slug_taken' });
    return reply.code(201).send(r);
  });
  app.delete('/projects/:id', async (req, reply) => {
    const r = await deleteNode(await scopeFor(req), (req.params as { id: string }).id);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'default_node') return reply.code(409).send({ error: 'default_node' });
    return reply.code(204).send();
  });
  app.get('/projects/:id/access', async (req, reply) => {
    const rows = await listAccess(await scopeFor(req), (req.params as { id: string }).id);
    return rows ?? reply.code(404).send({ error: 'not_found' });
  });
  app.post('/projects/:id/access', async (req, reply) => {
    const body = z.object({ resourceType: resType, resourceId: z.string() }).parse(req.body);
    const r = await grantAccess(await scopeFor(req), {
      projectId: (req.params as { id: string }).id,
      ...body,
      grantedBy: null,
    });
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'not_visible') return reply.code(400).send({ error: 'not_visible' });
    return reply.code(201).send({ ok: true });
  });
  app.delete('/projects/:id/access/:type/:resourceId', async (req, reply) => {
    const p = req.params as { id: string; type: string; resourceId: string };
    const type = resType.safeParse(p.type);
    if (!type.success) return reply.code(404).send({ error: 'not_found' });
    const r = await revokeAccess(await scopeFor(req), {
      projectId: p.id,
      resourceType: type.data,
      resourceId: p.resourceId,
    });
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
