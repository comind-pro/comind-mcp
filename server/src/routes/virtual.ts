import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tools, virtuals } from '../db/schema.js';
import { sendErr } from '../lib/req.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';
import { runVirtual, staticResult } from '../runtime/virtual.js';
import { isErr } from '../services/sources.js';
import { createVirtualTool, requestSchema, virtualCreateBody } from '../services/tools.js';

const patchBody = z.object({
  request: requestSchema.optional(),
  executable: z.boolean().optional(),
  response: z.unknown().optional(),
});

async function ownedVirtual(scope: Scope, id: string) {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), inSubtree(tools.projectId, scope)));
  return tool && tool.kind === 'virtual' ? tool : null;
}

export async function virtualRoutes(app: FastifyInstance): Promise<void> {
  // Stateless test for an unsaved draft. Executable → run the request; descriptive
  // → echo the spec the agent would receive (nothing is called).
  app.post('/virtual-tools/test', async (req) => {
    const scope = await scopeFor(req);
    const body = z
      .object({
        request: requestSchema.optional(),
        args: z.record(z.unknown()).optional(),
        executable: z.boolean().optional(),
        response: z.unknown().optional(),
      })
      .parse(req.body);
    if (body.executable === false || !body.request) {
      // descriptive: return the static response body if set, else a catalog note.
      if (body.response !== undefined && body.response !== null) return staticResult(body.response);
      const note = {
        kind: 'virtual',
        executable: false,
        note: 'Descriptive tool — not executed. No static response body set.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(note) }], structuredContent: note };
    }
    return runVirtual(body.request as Record<string, unknown>, body.args ?? {}, scope.ownerId, scope.createIn);
  });

  app.post('/virtual-tools', async (req, reply) => {
    const scope = await scopeFor(req);
    const r = await createVirtualTool(scope, virtualCreateBody.parse(req.body), null);
    return isErr(r) ? sendErr(reply, r) : reply.code(201).send(r);
  });

  app.get('/virtual-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedVirtual(await scopeFor(req), id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [v] = await db.select().from(virtuals).where(eq(virtuals.toolId, id));
    return { ...tool, request: v?.request ?? null, executable: v?.executable ?? true, response: v?.response ?? null };
  });

  app.patch('/virtual-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedVirtual(await scopeFor(req), id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const body = patchBody.parse(req.body);
    const set: Record<string, unknown> = {};
    if (body.request !== undefined) set.request = body.request;
    if (body.executable !== undefined) set.executable = body.executable;
    if (body.response !== undefined) set.response = body.response;
    if (Object.keys(set).length) await db.update(virtuals).set(set).where(eq(virtuals.toolId, id));
    const [v] = await db.select().from(virtuals).where(eq(virtuals.toolId, id));
    return { ...tool, request: v?.request ?? null, executable: v?.executable ?? true, response: v?.response ?? null };
  });

  app.delete('/virtual-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await ownedVirtual(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(tools).where(eq(tools.id, id)); // cascades virtuals
    return reply.code(204).send();
  });

  app.post('/virtual-tools/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const tool = await ownedVirtual(scope, id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    return invokeTool(tool.name, args, { ownerId: owner, groupId: null, agentId: null, source: 'test' });
  });
}
