import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
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
      source?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
    const filters: SQL[] = [eq(callLogs.ownerId, ownerOf(req))];
    if (q.groupId) filters.push(eq(callLogs.groupId, q.groupId));
    if (q.agentId) filters.push(eq(callLogs.agentId, q.agentId));
    if (q.toolName) filters.push(eq(callLogs.toolName, q.toolName));
    if (q.status === 'success' || q.status === 'error') filters.push(eq(callLogs.status, q.status));
    if (q.source === 'live' || q.source === 'test' || q.source === 'schedule')
      filters.push(eq(callLogs.source, q.source));
    if (q.from) filters.push(gte(callLogs.ts, new Date(q.from)));
    if (q.to) filters.push(lte(callLogs.ts, new Date(q.to)));
    const limit = Math.min(Number(q.limit ?? 100) || 100, 1000);
    return db.select().from(callLogs).where(and(...filters)).orderBy(desc(callLogs.ts)).limit(limit);
  });

  // Aggregate usage metrics — computed in SQL (scales), with optional time window
  // and source filter. By default excludes nothing; pass ?source=live for prod-only.
  app.get('/metrics', async (req) => {
    const owner = ownerOf(req);
    const q = req.query as { from?: string; to?: string; source?: string };
    const conds = [sql`owner_id = ${owner}`];
    // NB: drizzle field `ts` maps to DB column `created_at`.
    if (q.from) conds.push(sql`created_at >= ${new Date(q.from).toISOString()}`);
    if (q.to) conds.push(sql`created_at <= ${new Date(q.to).toISOString()}`);
    if (q.source === 'live' || q.source === 'test' || q.source === 'schedule')
      conds.push(sql`source = ${q.source}`);
    const where = sql.join(conds, sql` and `);

    const totals = await db.execute(sql`
      select count(*)::int calls,
             count(*) filter (where status='error')::int errors,
             coalesce(sum(tokens_est),0)::int tokens,
             coalesce(round(avg(duration_ms)),0)::int avg_ms,
             coalesce(percentile_cont(0.95) within group (order by duration_ms),0)::int p95_ms
      from call_logs where ${where}`);
    const byTool = await db.execute(sql`
      select tool_name,
             count(*)::int calls,
             count(*) filter (where status='error')::int errors,
             coalesce(sum(tokens_est),0)::int tokens,
             coalesce(round(avg(duration_ms)),0)::int avg_ms
      from call_logs where ${where} group by tool_name order by calls desc limit 50`);
    const byAgent = await db.execute(sql`
      select coalesce(a.name, s.agent_id, '(none)') agent,
             s.calls, s.errors, s.tokens
      from (
        select agent_id,
               count(*)::int calls,
               count(*) filter (where status='error')::int errors,
               coalesce(sum(tokens_est),0)::int tokens
        from call_logs where ${where} group by agent_id
      ) s
      left join agents a on a.id = s.agent_id
      order by s.calls desc limit 50`);

    return { totals: totals.rows[0], byTool: byTool.rows, byAgent: byAgent.rows };
  });

  // What does this agent actually see through its endpoint?
  app.get('/agents/:id/inspect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.ownerId, ownerOf(req))));
    if (!agent) return reply.code(404).send({ error: 'not_found' });

    // What the agent sees per granted group.
    const links = await db.select().from(agentGroups).where(eq(agentGroups.agentId, id));
    const out = [];
    for (const l of links) {
      const [grp] = await db.select().from(groups).where(eq(groups.id, l.groupId));
      if (!grp) continue;
      const visible = await groupVisibleTools(grp.id);
      out.push({
        group: { id: grp.id, name: grp.name, slug: grp.slug, schedulingEnabled: grp.schedulingEnabled },
        tools: visible.map((t) => ({ name: t.name, displayName: t.displayName, kind: t.kind })),
        builtinTools: grp.schedulingEnabled ? SELF_CRON : [],
      });
    }
    return { agentId: agent.id, groups: out };
  });

  // Test invoke from the control plane (gated by a granted group's toolset).
  app.post('/agents/:id/invoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ groupId: z.string(), tool: z.string(), args: z.record(z.unknown()).optional() })
      .parse(req.body);
    const owner = ownerOf(req);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.ownerId, owner)));
    if (!agent) return reply.code(404).send({ error: 'not_found' });

    const [grant] = await db
      .select()
      .from(agentGroups)
      .where(and(eq(agentGroups.agentId, id), eq(agentGroups.groupId, body.groupId)));
    if (!grant) return reply.code(400).send({ error: 'group_not_granted' });

    const visible = await groupVisibleTools(body.groupId);
    if (!visible.some((t) => t.name === body.tool)) {
      return reply.code(400).send({ error: 'tool_not_in_group' });
    }
    const result = await invokeTool(body.tool, body.args ?? {}, {
      ownerId: owner,
      agentId: agent.id,
      groupId: body.groupId,
      source: 'test',
    });
    return result;
  });
}
