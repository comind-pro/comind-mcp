import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tools, virtuals } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { invokeTool } from '../runtime/invoker.js';
import { runVirtual, staticResult } from '../runtime/virtual.js';

const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  query: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const createBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  // executable → we HTTP-proxy `request`. descriptive → no endpoint, request optional.
  executable: z.boolean().optional(),
  request: requestSchema.optional(),
  // descriptive: static response body returned on call.
  response: z.unknown().optional(),
});

const patchBody = z.object({
  request: requestSchema.optional(),
  executable: z.boolean().optional(),
  response: z.unknown().optional(),
});

async function ownedVirtual(id: string, owner: string) {
  const [tool] = await db.select().from(tools).where(and(eq(tools.id, id), eq(tools.ownerId, owner)));
  return tool && tool.kind === 'virtual' ? tool : null;
}

export async function virtualRoutes(app: FastifyInstance): Promise<void> {
  // Stateless test for an unsaved draft. Executable → run the request; descriptive
  // → echo the spec the agent would receive (nothing is called).
  app.post('/virtual-tools/test', async (req) => {
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
      const note = { kind: 'virtual', executable: false, note: 'Descriptive tool — not executed. No static response body set.' };
      return { content: [{ type: 'text', text: JSON.stringify(note) }], structuredContent: note };
    }
    return runVirtual(body.request as Record<string, unknown>, body.args ?? {}, ownerOf(req));
  });

  app.post('/virtual-tools', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);
    const executable = body.executable ?? true;
    if (executable && !body.request) return reply.code(400).send({ error: 'request_required' });

    const [clash] = await db.select().from(tools).where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
    if (clash) return reply.code(409).send({ error: 'name_taken' });

    const toolId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(tools).values({
        id: toolId,
        ownerId: owner,
        sourceId: null,
        kind: 'virtual',
        name: body.name,
        upstreamName: null,
        displayName: body.displayName ?? body.name,
        description: body.description ?? null,
        inputSchema: body.inputSchema ?? null,
        outputSchema: body.outputSchema ?? null,
        visible: true,
        createdAt: new Date(),
      });
      await tx.insert(virtuals).values({ id: newId(), toolId, executable, request: body.request ?? {}, response: body.response ?? null });
    });

    const [row] = await db.select().from(tools).where(eq(tools.id, toolId));
    return reply.code(201).send(row);
  });

  app.get('/virtual-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedVirtual(id, ownerOf(req));
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [v] = await db.select().from(virtuals).where(eq(virtuals.toolId, id));
    return { ...tool, request: v?.request ?? null, executable: v?.executable ?? true, response: v?.response ?? null };
  });

  app.patch('/virtual-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedVirtual(id, ownerOf(req));
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
    await db.delete(tools).where(and(eq(tools.id, id), eq(tools.ownerId, ownerOf(req)))); // cascades virtuals
    return reply.code(204).send();
  });

  app.post('/virtual-tools/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const tool = await ownedVirtual(id, owner);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    return invokeTool(tool.name, args, { ownerId: owner, groupId: null, agentId: null, source: 'test' });
  });
}
