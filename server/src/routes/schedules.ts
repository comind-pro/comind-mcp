import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { groups } from '../db/schema.js';
import { ownerOf } from '../lib/req.js';
import {
  createSchedule,
  deleteSchedule,
  execute,
  getSchedule,
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

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/groups/:id/schedules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = ownerOf(req);
    const body = createBody.parse(req.body);
    const [grp] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.ownerId, owner)));
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
    const [grp] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.ownerId, ownerOf(req))));
    if (!grp) return reply.code(404).send({ error: 'not_found' });
    return listByGroup(id);
  });

  app.delete('/schedules/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await getSchedule(sid);
    if (!sch || sch.ownerId !== ownerOf(req)) return reply.code(404).send({ error: 'not_found' });
    await deleteSchedule(sid);
    return reply.code(204).send();
  });

  app.post('/schedules/:sid/run', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await getSchedule(sid);
    if (!sch || sch.ownerId !== ownerOf(req)) return reply.code(404).send({ error: 'not_found' });
    const runId = await execute(sid);
    return { runId };
  });

  app.get('/schedules/:sid/runs', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const sch = await getSchedule(sid);
    if (!sch || sch.ownerId !== ownerOf(req)) return reply.code(404).send({ error: 'not_found' });
    return listRuns(sid);
  });
}
