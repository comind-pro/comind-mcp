import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentGroups, agents, groups, groupTools, oauthAccessTokens, tools } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { invokeTool } from '../runtime/invoker.js';
import {
  createSchedule,
  deleteSchedule,
  isValidCron,
  listByGroup,
  toolInGroup,
} from '../scheduler/service.js';

export interface AgentAuth {
  agentId: string;
  ownerId: string;
  groupId: string;
  groupSlug: string;
  schedulingEnabled: boolean;
}

/** An authenticated agent plus every V-MCP group it may reach (for /a/mcp). */
export interface AgentAuthAll {
  agentId: string;
  ownerId: string;
  groups: { id: string; slug: string; schedulingEnabled: boolean }[];
}

interface Resolved {
  agentId: string;
  ownerId: string;
  /** If set, the Bearer is restricted to this single group (group-scoped OAuth token). */
  restrictGroupId: string | null;
}

/** Resolve a Bearer (raw agent key OR inbound-OAuth access token) to an agent. */
async function resolveBearer(authHeader: string | undefined): Promise<Resolved | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const [agent] = await db.select().from(agents).where(eq(agents.apiKeyHash, hashKey(token)));
  if (agent) return { agentId: agent.id, ownerId: agent.ownerId, restrictGroupId: null };

  const [tok] = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hashKey(token)));
  if (!tok || tok.expiresAt.getTime() <= Date.now()) return null;
  const [ag] = await db.select().from(agents).where(eq(agents.id, tok.agentId));
  if (!ag) return null;
  return { agentId: ag.id, ownerId: ag.ownerId, restrictGroupId: tok.groupId };
}

/** Resolve a Bearer token to an agent and verify it belongs to group `groupId`. */
export async function authenticateAgent(
  groupId: string,
  authHeader: string | undefined,
): Promise<AgentAuth | null> {
  const r = await resolveBearer(authHeader);
  if (!r) return null;
  // Group-scoped OAuth token only works on its own group.
  if (r.restrictGroupId && r.restrictGroupId !== groupId) return null;

  // Agent must be granted access to this group.
  const [grant] = await db
    .select()
    .from(agentGroups)
    .where(and(eq(agentGroups.agentId, r.agentId), eq(agentGroups.groupId, groupId)));
  if (!grant) return null;

  const [grp] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!grp) return null;

  return {
    agentId: r.agentId,
    ownerId: r.ownerId,
    groupId: grp.id,
    groupSlug: grp.slug,
    schedulingEnabled: grp.schedulingEnabled,
  };
}

/** Resolve a Bearer to an agent and ALL groups it may reach (agent-wide /a/mcp).
 *  A group-scoped OAuth token narrows the set to that one group. */
export async function authenticateAgentAll(authHeader: string | undefined): Promise<AgentAuthAll | null> {
  const r = await resolveBearer(authHeader);
  if (!r) return null;

  const grants = await db.select().from(agentGroups).where(eq(agentGroups.agentId, r.agentId));
  let groupIds = grants.map((g) => g.groupId);
  if (r.restrictGroupId) groupIds = groupIds.filter((id) => id === r.restrictGroupId);
  if (!groupIds.length) return { agentId: r.agentId, ownerId: r.ownerId, groups: [] };

  const grps = await db.select().from(groups).where(inArray(groups.id, groupIds));
  return {
    agentId: r.agentId,
    ownerId: r.ownerId,
    groups: grps.map((g) => ({ id: g.id, slug: g.slug, schedulingEnabled: g.schedulingEnabled })),
  };
}

/** Built-in MCP tools that let a connected agent schedule itself. */
const SELF_CRON_TOOLS = [
  {
    name: 'schedule_task',
    description:
      'Schedule a tool in this group to run on a cron expression. Returns the schedule id.',
    inputSchema: {
      type: 'object',
      required: ['cron', 'tool'],
      properties: {
        cron: { type: 'string', description: 'Cron expression (5 or 6 fields).' },
        tool: { type: 'string', description: 'Name of a tool in this group to run.' },
        args: { type: 'object', description: 'Arguments passed to the tool on each run.' },
      },
    },
  },
  {
    name: 'list_schedules',
    description: 'List schedules configured for this group.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_schedule',
    description: 'Cancel a schedule by id (must belong to this group).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
] as const;

const SELF_CRON_NAMES = new Set<string>(SELF_CRON_TOOLS.map((t) => t.name));

function text(t: string, isError = false) {
  return { content: [{ type: 'text', text: t }], isError };
}

/** Handle a built-in self-cron tool call scoped to the agent's group. */
async function handleSelfCron(auth: AgentAuth, name: string, args: Record<string, unknown>) {
  if (name === 'schedule_task') {
    const cronExpr = String(args.cron ?? '');
    const tool = String(args.tool ?? '');
    if (!isValidCron(cronExpr)) return text(`Invalid cron: ${cronExpr}`, true);
    if (!(await toolInGroup(auth.groupId, tool, auth.ownerId))) return text(`Tool not in group: ${tool}`, true);
    const row = await createSchedule({
      ownerId: auth.ownerId,
      groupId: auth.groupId,
      cron: cronExpr,
      toolName: tool,
      args: (args.args as Record<string, unknown>) ?? undefined,
      createdBy: 'agent',
      agentId: auth.agentId,
    });
    return text(JSON.stringify({ id: row.id, cron: row.cron, tool: row.toolName }));
  }

  if (name === 'list_schedules') {
    const rows = await listByGroup(auth.groupId);
    return text(
      JSON.stringify(
        rows.map((r) => ({ id: r.id, cron: r.cron, tool: r.toolName, lastRun: r.lastRun })),
      ),
    );
  }

  if (name === 'cancel_schedule') {
    const id = String(args.id ?? '');
    const rows = await listByGroup(auth.groupId);
    if (!rows.some((r) => r.id === id)) return text(`Schedule not in group: ${id}`, true);
    await deleteSchedule(id);
    return text(JSON.stringify({ cancelled: id }));
  }

  return text(`Unknown self-cron tool: ${name}`, true);
}

/** Visible tools assigned to a group. */
async function groupVisibleTools(groupId: string) {
  const links = await db.select().from(groupTools).where(eq(groupTools.groupId, groupId));
  const ids = links.map((l) => l.toolId);
  if (!ids.length) return [];
  const rows = await db.select().from(tools).where(inArray(tools.id, ids));
  return rows.filter((t) => t.visible);
}

/**
 * Build the virtual MCP server for one group: it exposes the group's curated,
 * visible tools and dispatches calls through the shared runtime.
 */
export async function buildGroupServer(auth: AgentAuth): Promise<Server> {
  const server = new Server(
    { name: `comind:${auth.groupSlug}`, version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const list = await groupVisibleTools(auth.groupId);
    const toolDefs = list.map((t) => ({
      name: t.name,
      description: t.displayName ? `${t.displayName}${t.description ? ` — ${t.description}` : ''}` : t.description ?? undefined,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
    return {
      tools: auth.schedulingEnabled ? [...toolDefs, ...SELF_CRON_TOOLS] : toolDefs,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Built-in self-cron tools: the agent schedules itself.
    if (auth.schedulingEnabled && SELF_CRON_NAMES.has(name)) {
      return handleSelfCron(auth, name, a);
    }

    // Gate: the agent may only call tools assigned & visible in its group.
    const allowed = await groupVisibleTools(auth.groupId);
    if (!allowed.some((t) => t.name === name)) {
      return { content: [{ type: 'text', text: `Tool not in group: ${name}` }], isError: true };
    }
    const result = await invokeTool(name, a, {
      ownerId: auth.ownerId,
      agentId: auth.agentId,
      groupId: auth.groupId,
    });
    return { content: result.content, isError: result.isError };
  });

  return server;
}

/**
 * Build an agent-wide MCP server: the union of curated, visible tools across
 * EVERY group the agent may reach, exposed at one endpoint (/a/mcp). Self-cron
 * tools are omitted here (they are group-scoped). Tool names are unique per
 * owner, so the union never collides; each call dispatches to the group that
 * actually contains the tool.
 */
export async function buildAgentServer(auth: AgentAuthAll): Promise<Server> {
  const server = new Server(
    { name: 'comind:agent', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // name -> { groupId, tool } across all reachable groups (first group wins).
  const index = async () => {
    const map = new Map<string, { groupId: string; tool: Awaited<ReturnType<typeof groupVisibleTools>>[number] }>();
    for (const g of auth.groups) {
      for (const t of await groupVisibleTools(g.id)) {
        if (!map.has(t.name)) map.set(t.name, { groupId: g.id, tool: t });
      }
    }
    return map;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const map = await index();
    return {
      tools: [...map.values()].map(({ tool: t }) => ({
        name: t.name,
        description: t.displayName ? `${t.displayName}${t.description ? ` — ${t.description}` : ''}` : t.description ?? undefined,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const hit = (await index()).get(name);
    if (!hit) {
      return { content: [{ type: 'text', text: `Tool not available to this agent: ${name}` }], isError: true };
    }
    const result = await invokeTool(name, (args ?? {}) as Record<string, unknown>, {
      ownerId: auth.ownerId,
      agentId: auth.agentId,
      groupId: hit.groupId,
    });
    return { content: result.content, isError: result.isError };
  });

  return server;
}
