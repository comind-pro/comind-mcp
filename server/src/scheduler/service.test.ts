import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { groups, users } from '../db/schema.js';
import { createSchedule, execute, listRuns, stopScheduler } from './service.js';

/** Integration test: the group's self-scheduling switch freezes agent crons.
 *  Needs a reachable Postgres; skipped when none is available. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `sched-${Math.random().toString(36).slice(2, 8)}@test.local`;
const NEVER_SOON = '0 5 * * *'; // registered but must not fire during the test

async function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe.skipIf(!dbUp)('self-scheduling switch', () => {
  let token: string;
  let userId: string;
  let groupId: string;
  let agentSchedId: string;
  let uiSchedId: string;

  beforeAll(async () => {
    await runMigrations();
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    token = (reg.json() as { token: string }).token;
    const [row] = await db.select().from(users).where(eq(users.email, email));
    userId = row.id;

    // a tool that runs without touching the network: a descriptive virtual tool
    const tool = await call(token, 'POST', '/virtual-tools', {
      name: 'ping',
      executable: false,
      response: { ok: true },
    });
    const toolId = (tool.json() as { id: string }).id;

    const grp = await call(token, 'POST', '/groups', { name: 'Sched WS', slug: `sched-${Date.now()}` });
    groupId = (grp.json() as { id: string }).id;
    await call(token, 'PUT', `/groups/${groupId}/tools`, { toolIds: [toolId] });

    // createdBy 'agent' is only reachable through the gateway's self-cron, so
    // seed both kinds through the service directly.
    agentSchedId = (
      await createSchedule({ ownerId: userId, groupId, cron: NEVER_SOON, toolName: 'ping', createdBy: 'agent' })
    ).id;
    uiSchedId = (
      await createSchedule({ ownerId: userId, groupId, cron: NEVER_SOON, toolName: 'ping', createdBy: 'ui' })
    ).id;
  });

  afterAll(async () => {
    stopScheduler();
    await db.delete(users).where(eq(users.email, email)); // cascades groups/schedules
    await app.close();
  });

  it('runs both kinds while scheduling is on', async () => {
    await execute(agentSchedId);
    await execute(uiSchedId);
    expect(await listRuns(agentSchedId)).toHaveLength(1);
    expect(await listRuns(uiSchedId)).toHaveLength(1);
  });

  it("freezes agent crons when switched off, leaves the owner's own running", async () => {
    const res = await call(token, 'PATCH', `/groups/${groupId}`, { schedulingEnabled: false });
    expect(res.statusCode).toBe(200);
    const [grp] = await db.select().from(groups).where(eq(groups.id, groupId));
    expect(grp.schedulingEnabled).toBe(false);

    await execute(agentSchedId);
    await execute(uiSchedId);
    expect(await listRuns(agentSchedId)).toHaveLength(1); // unchanged — skipped
    expect(await listRuns(uiSchedId)).toHaveLength(2); // owner's schedule still runs
  });

  it('refuses run-now on a frozen schedule instead of reporting success', async () => {
    const res = await call(token, 'POST', `/schedules/${agentSchedId}/run`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'scheduling_disabled' });
  });

  it('resumes the agent crons when switched back on', async () => {
    await call(token, 'PATCH', `/groups/${groupId}`, { schedulingEnabled: true });
    await execute(agentSchedId);
    expect(await listRuns(agentSchedId)).toHaveLength(2);
  });
});
