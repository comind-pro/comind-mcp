import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compositeDefinitionSchema, hasPythonStep, runCompositeTrace } from '../composite/engine.js';
import { db } from '../db/client.js';
import { composites, tools } from '../db/schema.js';
import { hasFeature, PYTHON_TOOLS } from '../lib/features.js';
import { sendErr } from '../lib/req.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';
import { isErr } from '../services/sources.js';
import { compositeCreateBody, createCompositeTool, missingRefs, toolVisibleCond } from '../services/tools.js';

async function ownedComposite(scope: Scope, id: string) {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), inSubtree(tools.projectId, scope)));
  return tool && tool.kind === 'composite' ? tool : null;
}

export async function compositeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/composite-tools', async (req, reply) => {
    const scope = await scopeFor(req);
    const r = await createCompositeTool(scope, compositeCreateBody.parse(req.body), null);
    return isErr(r) ? sendErr(reply, r) : reply.code(201).send(r);
  });

  app.get('/composite-tools', async (req) => {
    const scope = await scopeFor(req);
    return db
      .select()
      .from(tools)
      .where(and(eq(tools.kind, 'composite'), eq(tools.ownerId, scope.ownerId), toolVisibleCond(scope)));
  });

  app.get('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = await ownedComposite(await scopeFor(req), id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [comp] = await db.select().from(composites).where(eq(composites.toolId, id));
    return { ...tool, definition: comp?.definition };
  });

  app.patch('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const tool = await ownedComposite(scope, id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });

    const body = z
      .object({
        definition: compositeDefinitionSchema.optional(),
        displayName: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      })
      .parse(req.body);

    if (body.definition) {
      // checked against the composite's own project, not the caller's
      const missing = await missingRefs(body.definition.steps, owner, tool.projectId);
      if (missing.length) return reply.code(400).send({ error: 'unknown_tools', missing });
      if (hasPythonStep(body.definition) && !(await hasFeature(owner, PYTHON_TOOLS))) {
        return reply.code(403).send({ error: 'feature_disabled', feature: PYTHON_TOOLS });
      }
      await db.update(composites).set({ definition: body.definition }).where(eq(composites.toolId, id));
      await db
        .update(tools)
        .set({
          inputSchema: body.definition.inputSchema ?? null,
          outputSchema: body.definition.outputSchema ?? null,
        })
        .where(eq(tools.id, id));
    }
    const toolPatch: Record<string, unknown> = {};
    if (body.displayName !== undefined) toolPatch.displayName = body.displayName;
    if (body.description !== undefined) toolPatch.description = body.description;
    if (Object.keys(toolPatch).length) await db.update(tools).set(toolPatch).where(eq(tools.id, id));

    const [comp] = await db.select().from(composites).where(eq(composites.toolId, id));
    const [updated] = await db.select().from(tools).where(eq(tools.id, id));
    return { ...updated, definition: comp?.definition };
  });

  app.delete('/composite-tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await ownedComposite(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(tools).where(eq(tools.id, id));
    return reply.code(204).send();
  });

  app.post('/composite-tools/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const tool = await ownedComposite(scope, id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const [comp] = await db.select().from(composites).where(eq(composites.toolId, id));
    if (!comp) return reply.code(404).send({ error: 'definition_missing' });
    // This endpoint runs the engine directly, so it needs the same gate as dispatch().
    if (hasPythonStep(comp.definition) && !(await hasFeature(owner, PYTHON_TOOLS))) {
      return reply.code(403).send({ error: 'feature_disabled', feature: PYTHON_TOOLS });
    }

    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    const { result, steps } = await runCompositeTrace(
      comp.definition,
      args,
      (name, a, d) =>
        invokeTool(
          name,
          a,
          { ownerId: owner, groupId: null, agentId: null, source: 'test', projectId: tool.projectId },
          d,
        ),
      0,
    );
    return { content: result.content, isError: result.isError, steps };
  });
}
