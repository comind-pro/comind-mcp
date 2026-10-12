import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compositeDefinitionSchema, hasPythonStep, runCompositeTrace } from '../composite/engine.js';
import { db } from '../db/client.js';
import { composites, liveTool, tools } from '../db/schema.js';
import { hasFeature, PYTHON_TOOLS } from '../lib/features.js';
import { newId } from '../lib/id.js';
import { ownerOf } from '../lib/req.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';
import { toolUsableCond, toolVisibleCond } from './tools.js';

const createBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  definition: compositeDefinitionSchema,
});

async function ownedComposite(scope: Scope, id: string) {
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), inSubtree(tools.projectId, scope)));
  return tool && tool.kind === 'composite' ? tool : null;
}

/** Referenced step tools must be usable by the project (rule 1). Python steps reference none. */
async function missingRefs(steps: { tool?: string }[], scope: Scope) {
  const refNames = [...new Set(steps.map((s) => s.tool).filter((n): n is string => Boolean(n)))];
  if (!refNames.length) return [];
  const found = await db
    .select()
    .from(tools)
    .where(
      and(inArray(tools.name, refNames), eq(tools.ownerId, scope.ownerId), liveTool(), toolUsableCond(scope.createIn)),
    );
  return refNames.filter((n) => !found.some((t) => t.name === n));
}

export async function compositeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/composite-tools', async (req, reply) => {
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const body = createBody.parse(req.body);

    const missing = await missingRefs(body.definition.steps, scope);
    if (missing.length) return reply.code(400).send({ error: 'unknown_tools', missing });
    if (hasPythonStep(body.definition) && !(await hasFeature(owner, PYTHON_TOOLS))) {
      return reply.code(403).send({ error: 'feature_disabled', feature: PYTHON_TOOLS });
    }

    const [clash] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
    if (clash) return reply.code(409).send({ error: 'name_taken' });

    const toolId = newId();
    const compId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(tools).values({
        id: toolId,
        ownerId: owner,
        projectId: scope.createIn,
        createdByAgentId: null,
        sourceId: null,
        kind: 'composite',
        name: body.name,
        upstreamName: null,
        displayName: body.displayName ?? body.name,
        description: body.description ?? null,
        inputSchema: body.definition.inputSchema ?? null,
        outputSchema: body.definition.outputSchema ?? null,
        visible: true,
        createdAt: new Date(),
      });
      await tx.insert(composites).values({ id: compId, toolId, definition: body.definition });
    });

    const [row] = await db.select().from(tools).where(eq(tools.id, toolId));
    return reply.code(201).send(row);
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
      const missing = await missingRefs(body.definition.steps, scope);
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
      (name, a, d) => invokeTool(name, a, { ownerId: owner, groupId: null, agentId: null, source: 'test' }, d),
      0,
    );
    return { content: result.content, isError: result.isError, steps };
  });
}
