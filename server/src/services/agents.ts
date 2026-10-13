import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { agentGroups, agentKeys, agents, groups, oauthAccessTokens, oauthAuthCodes, projects } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { newApiKey, newId } from '../lib/id.js';
import { inSubtree, type Scope } from '../lib/scope.js';
import { NOT_FOUND, type ServiceErr } from './sources.js';

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
