import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  agentGroups,
  agentKeys,
  agents,
  groups,
  groupTools,
  liveTool,
  oauthAccessTokens,
  oauthAuthCodes,
  projects,
  tools,
} from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { newApiKey, newId } from '../lib/id.js';
import { inSubtree, type Scope } from '../lib/scope.js';
import { NOT_FOUND, type ServiceErr } from './sources.js';
import { toolUsableCond } from './tools.js';

export type AgentRow = typeof agents.$inferSelect;

export const endpointFor = (groupId: string): string => `http://${config.host}:${config.port}/g/${groupId}/mcp`;
const agentEndpoint = (): string => `http://${config.host}:${config.port}/a/mcp`;

export async function ownedAgent(scope: Scope, id: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, scope.ownerId), inSubtree(agents.projectId, scope)));
  return row ?? null;
}

/** New agent with one 'default' key. The raw key is returned once. The caller's own
 *  role (who may mint a 'coo') is checked by the MCP layer; here the target node and
 *  every group must be in the scope's subtree. */
export async function createAgent(
  scope: Scope,
  input: { name: string; role: 'lead' | 'coo'; projectId?: string; groupIds: string[] },
  createdByAgentId: string | null,
): Promise<
  | {
      agent: AgentRow;
      apiKey: string;
      endpoints: { agent: string; groups: { id: string; slug: string; url: string }[] };
    }
  | ServiceErr
> {
  const projectId = input.projectId ?? scope.createIn;
  if (input.projectId) {
    const [node] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, scope.ownerId), inSubtree(projects.id, scope)));
    if (!node) return NOT_FOUND;
  }
  const groupIds = [...new Set(input.groupIds)];
  const grps = groupIds.length
    ? await db
        .select()
        .from(groups)
        .where(and(inArray(groups.id, groupIds), eq(groups.ownerId, scope.ownerId), inSubtree(groups.projectId, scope)))
    : [];
  if (grps.length !== groupIds.length) return NOT_FOUND;

  const key = newApiKey();
  const agent: AgentRow = {
    id: newId(),
    ownerId: scope.ownerId,
    projectId,
    createdByAgentId,
    role: input.role,
    name: input.name,
    apiKeyHash: null,
    apiKeyPrefix: null,
    systemTools: [],
    blockedTools: [],
    createdAt: new Date(),
  };
  await db.insert(agents).values(agent);
  await db.insert(agentKeys).values({
    id: newId(),
    agentId: agent.id,
    hash: hashKey(key.token),
    prefix: key.prefix,
    label: 'default',
    archived: false,
    createdAt: new Date(),
  });
  if (grps.length) await db.insert(agentGroups).values(grps.map((g) => ({ agentId: agent.id, groupId: g.id })));
  return {
    agent,
    apiKey: key.token,
    endpoints: {
      agent: agentEndpoint(),
      groups: grps.map((g) => ({ id: g.id, slug: g.slug, url: endpointFor(g.id) })),
    },
  };
}

/** Archive every active key and drop its OAuth sessions (tokens, refresh tokens, pending
 *  codes). The agent row stays, so its logs keep their attribution. */
export async function revokeAgent(scope: Scope, agentId: string): Promise<{ archivedKeys: number } | ServiceErr> {
  if (!(await ownedAgent(scope, agentId))) return NOT_FOUND;
  const rows = await db
    .update(agentKeys)
    .set({ archived: true })
    .where(and(eq(agentKeys.agentId, agentId), eq(agentKeys.archived, false)))
    .returning({ id: agentKeys.id });
  await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.agentId, agentId));
  await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.agentId, agentId));
  return { archivedKeys: rows.length };
}

export async function setAgentRole(
  scope: Scope,
  agentId: string,
  role: 'lead' | 'coo',
): Promise<AgentRow | ServiceErr> {
  if (!(await ownedAgent(scope, agentId))) return NOT_FOUND;
  const [row] = await db.update(agents).set({ role }).where(eq(agents.id, agentId)).returning();
  return row;
}

// Lite mode's per-agent group: holds tools switched on for this agent that no shared group gives it.
const personalSlug = (agentId: string) => `agent-${agentId}`;

/** Tool ids in the agent's granted groups, split into the personal group and the rest. */
async function reachable(agent: AgentRow) {
  const rows = await db
    .select({ toolId: groupTools.toolId, slug: groups.slug })
    .from(agentGroups)
    .innerJoin(groups, eq(groups.id, agentGroups.groupId))
    .innerJoin(groupTools, eq(groupTools.groupId, groups.id))
    .where(eq(agentGroups.agentId, agent.id));
  const own = personalSlug(agent.id);
  return {
    shared: new Set(rows.filter((r) => r.slug !== own).map((r) => r.toolId)),
    personal: new Set(rows.filter((r) => r.slug === own).map((r) => r.toolId)),
  };
}

/** Tool ids the agent can call: everything its groups hold, minus its blocked list. */
export async function agentToolIds(scope: Scope, agentId: string): Promise<{ toolIds: string[] } | ServiceErr> {
  const agent = await ownedAgent(scope, agentId);
  if (!agent) return NOT_FOUND;
  const { shared, personal } = await reachable(agent);
  const blocked = new Set(agent.blockedTools ?? []);
  return { toolIds: [...new Set([...shared, ...personal])].filter((id) => !blocked.has(id)) };
}

/** Make exactly `toolIds` callable by the agent, leaving shared groups untouched:
 *  wanted tools no shared group holds go into the agent's personal group, unwanted
 *  ones a shared group holds go on its blocked list. */
export async function setAgentToolIds(
  scope: Scope,
  agentId: string,
  toolIds: string[],
): Promise<{ toolIds: string[] } | ServiceErr> {
  const agent = await ownedAgent(scope, agentId);
  if (!agent) return NOT_FOUND;
  const want = new Set(toolIds);
  if (want.size) {
    const found = await db
      .select({ id: tools.id })
      .from(tools)
      .where(
        and(
          inArray(tools.id, [...want]),
          eq(tools.ownerId, agent.ownerId),
          liveTool(),
          toolUsableCond(agent.projectId),
        ),
      );
    const missing = [...want].filter((t) => !found.some((f) => f.id === t));
    if (missing.length) return { error: 'unknown_tools', detail: { missing } };
  }
  const { shared } = await reachable(agent);
  const personalTools = [...want].filter((t) => !shared.has(t));
  const blocked = [...shared].filter((t) => !want.has(t));

  await db.transaction(async (tx) => {
    let [grp] = await tx
      .select()
      .from(groups)
      .where(and(eq(groups.ownerId, agent.ownerId), eq(groups.slug, personalSlug(agent.id))));
    if (!grp && personalTools.length) {
      [grp] = await tx
        .insert(groups)
        .values({
          id: newId(),
          ownerId: agent.ownerId,
          projectId: agent.projectId,
          createdByAgentId: null,
          slug: personalSlug(agent.id),
          name: `${agent.name} (personal)`,
          description: 'Managed by Lite mode: tools switched on for this agent only.',
          createdAt: new Date(),
        })
        .returning();
    }
    if (grp) {
      await tx.delete(groupTools).where(eq(groupTools.groupId, grp.id));
      if (personalTools.length)
        await tx.insert(groupTools).values(personalTools.map((toolId) => ({ groupId: grp.id, toolId })));
      await tx.insert(agentGroups).values({ agentId: agent.id, groupId: grp.id }).onConflictDoNothing();
    }
    await tx.update(agents).set({ blockedTools: blocked }).where(eq(agents.id, agent.id));
  });
  return { toolIds: [...want] };
}
