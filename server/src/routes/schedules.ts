import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups, schedules } from '../db/schema.js';
import { inSubtree, type Scope, scopeFor } from '../lib/scope.js';
import {
  createSchedule,
  deleteSchedule,
  execute,
  isFrozen,
  isValidCron,
  listByGroup,
  listRuns,
  toolInGroup,
} from '../scheduler/service.js';

const createBody = z.object({
  cron: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

const groupIn = async (scope: Scope, id: string) =>
  (
    await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.ownerId, scope.ownerId), inSubtree(groups.projectId, scope)))
  )[0];

const scheduleIn = async (scope: Scope, id: string) =>
  (
    await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.ownerId, scope.ownerId), inSubtree(schedules.projectId, scope)))
  )[0];

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/groups/:id/schedules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = await scopeFor(req);
    const owner = scope.ownerId;
    const body = createBody.parse(req.body);
    const grp = await groupIn(scope, id);
    if (!grp) return reply.code(404).send({ error: 'not_found' });
    if (!isValidCron(body.cron)) return reply.code(400).send({ error: 'invalid_cron' });
    if (!(await toolInGroup(id, body.toolName, owner))) return reply.code(400).send({ error: 'tool_not_in_group' });

    const row = await createSchedule({
      ownerId: owner,
      groupId: id,
      cron: body.cron,
      toolName: body.toolName,
      args: body.args,
      createdBy: 'ui',
    });
    return reply.code(201).send(row);
  });

  app.get('/groups/:id/schedules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const grp = await groupIn(await scopeFor(req), id);
    if (!grp) return reply.code(404).send({ error: 'not_found' });
    return listByGroup(id);
  });

  app.delete('/schedules/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await scheduleIn(await scopeFor(req), sid);
    if (!sch) return reply.code(404).send({ error: 'not_found' });
    await deleteSchedule(sid);
    return reply.code(204).send();
  });

  app.post('/schedules/:sid/run', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await scheduleIn(await scopeFor(req), sid);
    if (!sch) return reply.code(404).send({ error: 'not_found' });
    // execute() would silently skip a frozen schedule; say so instead of
    // returning a runId-less success that reads as "ran fine".
    if (await isFrozen(sch)) return reply.code(409).send({ error: 'scheduling_disabled' });
    const runId = await execute(sid);
    return { runId };
  });

  app.get('/schedules/:sid/runs', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await scheduleIn(await scopeFor(req), sid);
    if (!sch) return reply.code(404).send({ error: 'not_found' });
    return listRuns(sid);
  });
}
