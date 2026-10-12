import { and, eq, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { liveTool, tools } from '../db/schema.js';
import { granted, inScope, inSubtree, type Scope, scopeFor, usableBy } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';

const patchBody = z.object({
  name: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  visible: z.boolean().optional(),
  // Discovery metadata.
  readOnly: z.boolean().nullable().optional(),
  dangerous: z.boolean().nullable().optional(),
  permissions: z.array(z.string()).optional(),
  examples: z.array(z.object({ description: z.string().optional(), input: z.record(z.unknown()) })).optional(),
  recommendedUse: z
    .object({
      daily_report: z.boolean().optional(),
      safe_for_automation: z.boolean().optional(),
      requires_user_confirmation: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

/** Tools a scope may read: its subtree, grants on the tool, or grants on its source. */
export const toolVisibleCond = (scope: Scope) =>
  or(inScope(tools.projectId, tools.id, 'tool', scope), granted(tools.sourceId, 'source', scope.nodeId)) as SQL;

/** Tools a single node may put into its workspaces (rule 1). */
export const toolUsableCond = (nodeId: string) =>
  or(usableBy(tools.projectId, tools.id, 'tool', nodeId), granted(tools.sourceId, 'source', nodeId)) as SQL;

async function visibleTool(scope: Scope, id: string) {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), liveTool(), toolVisibleCond(scope)));
  return row ?? null;
}

async function administeredTool(scope: Scope, id: string) {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), liveTool(), inSubtree(tools.projectId, scope)));
  return row ?? null;
}

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tools', async (req) => {
    const q = req.query as { sourceId?: string; kind?: string; visible?: string };
    const scope = await scopeFor(req);
    const filters: SQL[] = [eq(tools.ownerId, scope.ownerId), liveTool(), toolVisibleCond(scope)];
    if (q.sourceId) filters.push(eq(tools.sourceId, q.sourceId));
    if (q.kind === 'native' || q.kind === 'composite' || q.kind === 'virtual' || q.kind === 'python') {
      filters.push(eq(tools.kind, q.kind));
    }
    if (q.visible === 'true' || q.visible === 'false') filters.push(eq(tools.visible, q.visible === 'true'));
    return db
      .select()
      .from(tools)
      .where(and(...filters));
  });

  app.get('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await visibleTool(await scopeFor(req), id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.patch('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const body = patchBody.parse(req.body);
    const existing = await administeredTool(scope, id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (body.name && body.name !== existing.name) {
      const [clash] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.name, body.name), eq(tools.ownerId, owner)));
      if (clash) return reply.code(409).send({ error: 'name_taken' });
    }

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.description !== undefined) patch.description = body.description;
    if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
    if (body.outputSchema !== undefined) patch.outputSchema = body.outputSchema;
    if (body.visible !== undefined) patch.visible = body.visible;
    if (body.readOnly !== undefined) patch.readOnly = body.readOnly;
    if (body.dangerous !== undefined) patch.dangerous = body.dangerous;
    if (body.permissions !== undefined) patch.permissions = body.permissions;
    if (body.examples !== undefined) patch.examples = body.examples;
    if (body.recommendedUse !== undefined) patch.recommendedUse = body.recommendedUse;
    if (Object.keys(patch).length) await db.update(tools).set(patch).where(eq(tools.id, id));

    const [row] = await db.select().from(tools).where(eq(tools.id, id));
    return row;
  });

  app.delete('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await administeredTool(await scopeFor(req), id))) return reply.code(404).send({ error: 'not_found' });
    await db.delete(tools).where(eq(tools.id, id));
    return reply.code(204).send();
  });

  app.post('/tools/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const tool = await visibleTool(scope, id);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    const result = await invokeTool(tool.name, args, { ownerId: owner, groupId: null, agentId: null, source: 'test' });
    return result;
  });
}
