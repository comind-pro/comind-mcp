import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentGroups, agents, callLogs, groups, groupTools, tools } from '../db/schema.js';
import { ownerOf } from '../lib/req.js';
import { invokeTool } from '../runtime/invoker.js';

const SELF_CRON = ['schedule_task', 'list_schedules', 'cancel_schedule'];

async function groupVisibleTools(groupId: string) {
  const links = await db.select().from(groupTools).where(eq(groupTools.groupId, groupId));
  const ids = links.map((l) => l.toolId);
  if (!ids.length) return [];
  const rows = await db.select().from(tools).where(inArray(tools.id, ids));
  return rows.filter((t) => t.visible);
}

export async function observabilityRoutes(app: FastifyInstance): Promise<void> {
  // Structured call logs.
  app.get('/logs', async (req) => {
    const q = req.query as {
      groupId?: string;
      agentId?: string;
      toolName?: string;
      status?: string;
      limit?: string;
    };
    const filters: SQL[] = [eq(callLogs.ownerId, ownerOf(req))];
    if (q.groupId) filters.push(eq(callLogs.groupId, q.groupId));
    if (q.agentId) filters.push(eq(callLogs.agentId, q.agentId));
    if (q.toolName) filters.push(eq(callLogs.toolName, q.toolName));
    if (q.status === 'success' || q.status === 'error') filters.push(eq(callLogs.status, q.status));
    const limit = Math.min(Number(q.limit ?? 100) || 100, 1000);
    return db.select().from(callLogs).where(and(...filters)).orderBy(desc(callLogs.ts)).limit(limit);
  });

  // Aggregate usage metrics.
  app.get('/metrics', async (req) => {
    const rows = await db.select().from(callLogs).where(eq(callLogs.ownerId, ownerOf(req)));
    const byTool: Record<string, { calls: number; errors: number; tokens: number }> = {};
    const byAgent: Record<string, { calls: number; errors: number; tokens: number }> = {};
    let calls = 0,
      errors = 0,
      tokens = 0;
    for (const r of rows) {
      calls++;
      if (r.status === 'error') errors++;
      tokens += r.tokensEst ?? 0;
      const tt = (byTool[r.toolName] ??= { calls: 0, errors: 0, tokens: 0 });
      tt.calls++;
      if (r.status === 'error') tt.errors++;
      tt.tokens += r.tokensEst ?? 0;
      const ak = r.agentId ?? '(none)';
      const aa = (byAgent[ak] ??= { calls: 0, errors: 0, tokens: 0 });
      aa.calls++;
      if (r.status === 'error') aa.errors++;
      aa.tokens += r.tokensEst ?? 0;
    }
    return { totals: { calls, errors, tokens }, byTool, byAgent };
  });

  // What does this agent actually see through its endpoint?
}
