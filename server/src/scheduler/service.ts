import { and, eq, lt } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { callLogs, groupTools, jobRuns, rateLimits, schedules, tools } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { invokeTool } from '../runtime/invoker.js';

const registry = new Map<string, ScheduledTask>();

export function isValidCron(expr: string): boolean {
  return cron.validate(expr);
}

/** Is `toolName` assigned to `groupId`? (schedules may only target group tools). */
export async function toolInGroup(groupId: string, toolName: string, owner: string): Promise<boolean> {
  const links = await db.select().from(groupTools).where(eq(groupTools.groupId, groupId));
  if (!links.length) return false;
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.name, toolName), eq(tools.ownerId, owner)));
  return rows.some((t) => links.some((l) => l.toolId === t.id));
}

function unregister(id: string): void {
  registry.get(id)?.stop();
  registry.delete(id);
}

function register(id: string, expr: string): void {
  unregister(id);
  const task = cron.schedule(expr, () => {
    void execute(id);
  });
  registry.set(id, task);
}

export interface CreateScheduleInput {
  ownerId: string;
  groupId: string;
  cron: string;
  toolName: string;
  args?: Record<string, unknown>;
  createdBy: 'agent' | 'ui';
  agentId?: string | null;
}

export async function createSchedule(input: CreateScheduleInput) {
  const row = {
    id: newId(),
    ownerId: input.ownerId,
    groupId: input.groupId,
    agentId: input.agentId ?? null,
    cron: input.cron,
    toolName: input.toolName,
    args: input.args ?? null,
    enabled: true,
    createdBy: input.createdBy,
    lastRun: null,
    createdAt: new Date(),
  };
  await db.insert(schedules).values(row);
  register(row.id, row.cron);
  return row;
}

export async function deleteSchedule(id: string): Promise<void> {
  unregister(id);
  await db.delete(schedules).where(eq(schedules.id, id));
}

export async function listByGroup(groupId: string) {
  return db.select().from(schedules).where(eq(schedules.groupId, groupId));
}

export async function getSchedule(id: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
  return row;
}

export async function listRuns(scheduleId: string) {
  return db.select().from(jobRuns).where(eq(jobRuns.scheduleId, scheduleId));
}

/** Run a schedule once, recording a JobRun. Used by cron, run-now and tests. */
export async function execute(scheduleId: string) {
  const [sch] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
  if (!sch) return;

  const runId = newId();
  const startedAt = new Date();
  await db.insert(jobRuns).values({ id: runId, scheduleId, status: 'running', startedAt, finishedAt: null });

  try {
    const result = await invokeTool(sch.toolName, (sch.args ?? {}) as Record<string, unknown>, {
      ownerId: sch.ownerId,
      groupId: sch.groupId,
      agentId: sch.agentId,
      source: 'schedule',
    });
    await db
      .update(jobRuns)
      .set({
        status: result.isError ? 'failed' : 'success',
        finishedAt: new Date(),
        result: result.content,
        error: result.isError ? 'tool returned error' : null,
      })
      .where(eq(jobRuns.id, runId));
  } catch (err) {
    await db
      .update(jobRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) })
      .where(eq(jobRuns.id, runId));
  } finally {
    await db.update(schedules).set({ lastRun: new Date() }).where(eq(schedules.id, scheduleId));
  }
  return runId;
}

/** Load enabled schedules into the cron registry on boot. */
export async function initScheduler(): Promise<void> {
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));
  for (const r of rows) register(r.id, r.cron);

  // Retention: prune old call logs daily (03:00). 0 days = keep forever.
  const days = config.logRetentionDays;
  if (days > 0) {
    cron.schedule('0 3 * * *', () => {
      void db
        .delete(callLogs)
        .where(lt(callLogs.ts, new Date(Date.now() - days * 86_400_000)))
        .catch(() => {});
    });
  }

  // Prune stale rate-limit buckets hourly (keep only the last few minutes).
  cron.schedule('0 * * * *', () => {
    const cutoff = Math.floor(Date.now() / 60_000) - 5;
    void db
      .delete(rateLimits)
      .where(lt(rateLimits.bucket, cutoff))
      .catch(() => {});
  });
}
