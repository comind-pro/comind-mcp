import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { scripts, tools } from '../db/schema.js';
import { hasFeature, PYTHON_TOOLS } from '../lib/features.js';
import { ownerOf, sendErr } from '../lib/req.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';
import { runPython } from '../runtime/python.js';
import { isErr } from '../services/sources.js';
import { codeField, createPythonTool, pythonCreateBody } from '../services/tools.js';

async function ownedPython(scope: Scope, id: string) {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), inSubtree(tools.projectId, scope)));
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
    const scope = await scopeFor(req);
    const r = await createPythonTool(scope, pythonCreateBody.parse(req.body), null);
    return isErr(r) ? sendErr(reply, r) : reply.code(201).send(r);
  });

  app.get('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedPython(await scopeFor(req), id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [s] = await db.select().from(scripts).where(eq(scripts.toolId, id));
    return { ...tool, code: s?.code ?? '' };
  });

  app.patch('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedPython(await scopeFor(req), id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ code: codeField.optional() }).parse(req.body);
    if (body.code !== undefined) await db.update(scripts).set({ code: body.code }).where(eq(scripts.toolId, id));
    const [s] = await db.select().from(scripts).where(eq(scripts.toolId, id));
    return { ...tool, code: s?.code ?? '' };
  });

  app.delete('/python-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await ownedPython(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(tools).where(eq(tools.id, id)); // cascades scripts
    return reply.code(204).send();
  });

  app.post('/python-tools/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const tool = await ownedPython(scope, id);
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
