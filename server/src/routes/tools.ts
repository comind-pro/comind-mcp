import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { liveTool, tools } from '../db/schema.js';
import { sendErr } from '../lib/req.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import { isErr } from '../services/sources.js';
import { getTool, listTools, testTool } from '../services/tools.js';

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
  outputFields: z.array(z.string().min(1)).nullable().optional(),
  outputLimit: z.number().int().positive().nullable().optional(),
  recommendedUse: z
    .object({
      daily_report: z.boolean().optional(),
      safe_for_automation: z.boolean().optional(),
      requires_user_confirmation: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

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
    const kind =
      q.kind === 'native' || q.kind === 'composite' || q.kind === 'virtual' || q.kind === 'python' ? q.kind : undefined;
    const visible = q.visible === 'true' || q.visible === 'false' ? q.visible === 'true' : undefined;
    return listTools(await scopeFor(req), { sourceId: q.sourceId, kind, visible });
  });

  app.get('/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await getTool(await scopeFor(req), id);
    return isErr(r) ? sendErr(reply, r) : r;
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
    if (body.outputFields !== undefined) patch.outputFields = body.outputFields;
    if (body.outputLimit !== undefined) patch.outputLimit = body.outputLimit;
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
    const args = ((req.body as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
    const r = await testTool(await scopeFor(req), id, args, { agentId: null });
    return isErr(r) ? sendErr(reply, r) : r;
  });
}
