import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { scripts, tools } from '../db/schema.js';
import { hasFeature, PYTHON_TOOLS } from '../lib/features.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { invokeTool } from '../runtime/invoker.js';
import { runPython } from '../runtime/python.js';

const codeField = z.string().min(1).max(config.pythonMaxCodeBytes);

const createBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  code: codeField,
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
});

async function ownedPython(id: string, owner: string) {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, owner)));
  return tool && tool.kind === 'python' ? tool : null;
}

export async function pythonRoutes(app: FastifyInstance): Promise<void> {
  // Every route here is gated; dispatch() re-checks at call time so revoking the
  // feature also stops tools that already exist.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/python-tools')) return;
    if (!(await hasFeature(ownerOf(req), PYTHON_TOOLS))) {
      return reply.code(403).send({ error: 'feature_disabled', feature: PYTHON_TOOLS });
    }
  });

  /** Run an unsaved draft — the authoring loop in the tool editor. */
  app.post('/python-tools/test', async (req) => {
    const owner = ownerOf(req);
    const body = z.object({ code: codeField, args: z.record(z.unknown()).optional() }).parse(req.body);
    try {
      const { result, stdout } = await runPython(body.code, { args: body.args ?? {} }, (name, a, d) =>
        invokeTool(name, a, { ownerId: owner, groupId: null, agentId: null, source: 'test' }, d),
      );
      return { ...result, stdout };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });

  app.post('/python-tools', async (req, reply) => {
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);

    const [clash] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
    if (clash) return reply.code(409).send({ error: 'name_taken' });

    const toolId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(tools).values({
        id: toolId,
        ownerId: owner,
        sourceId: null,
        kind: 'python',
        name: body.name,
        upstreamName: null,
        displayName: body.displayName ?? body.name,
        description: body.description ?? null,
        inputSchema: body.inputSchema ?? null,
        outputSchema: body.outputSchema ?? null,
        visible: true,
        createdAt: new Date(),
      });
      await tx.insert(scripts).values({ id: newId(), toolId, code: body.code });
    });

    const [row] = await db.select().from(tools).where(eq(tools.id, toolId));
    return reply.code(201).send(row);
  });

  app.get('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedPython(id, ownerOf(req));
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [s] = await db.select().from(scripts).where(eq(scripts.toolId, id));
    return { ...tool, code: s?.code ?? '' };
  });

  app.patch('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedPython(id, ownerOf(req));
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ code: codeField.optional() }).parse(req.body);
    if (body.code !== undefined) await db.update(scripts).set({ code: body.code }).where(eq(scripts.toolId, id));
    const [s] = await db.select().from(scripts).where(eq(scripts.toolId, id));
    return { ...tool, code: s?.code ?? '' };
  });

  app.delete('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(tools).where(and(eq(tools.id, id), eq(tools.ownerId, ownerOf(req)))); // cascades scripts
    return reply.code(204).send();
  });

  app.post('/python-tools/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const tool = await ownedPython(id, owner);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [s] = await db.select().from(scripts).where(eq(scripts.toolId, id));
    if (!s) return reply.code(404).send({ error: 'code_missing' });

    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    try {
      // Run the source directly (not via invokeTool) so the editor also gets stdout.
      const { result, stdout } = await runPython(s.code, { args }, (name, a, d) =>
        invokeTool(name, a, { ownerId: owner, groupId: null, agentId: null, source: 'test' }, d),
      );
      return { ...result, stdout };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
}
