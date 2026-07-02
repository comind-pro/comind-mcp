import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { agentGroups, agentKeys, agents, callLogs, groups, groupTools, sources, tools, users } from '../db/schema.js';
import { signJwt } from '../lib/auth.js';
import { hashKey } from '../lib/crypto.js';
import { newId } from '../lib/id.js';
import { mcpToolName } from '../lib/tool-name.js';
import { authenticateAgent, authenticateAgentAll } from './server.js';
import { handleSystemTool, type SystemCtx } from './system-tools.js';

/** Integration test: cross-owner isolation. Needs a reachable Postgres; when none
 *  is available (e.g. CI without the db service) the whole suite is skipped. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

interface Seed {
  ownerId: string;
  token: string;
  sourceId: string;
  toolName: string;
  groupId: string;
  groupSlug: string;
  agentId: string;
}

const tag = newId().slice(0, 6).toLowerCase();
const userIds: string[] = [];

async function seedOwner(suffix: string): Promise<Seed> {
  const ownerId = newId();
  userIds.push(ownerId);
  await db
    .insert(users)
    .values({ id: ownerId, email: `iso_${tag}_${suffix}@t.local`, passwordHash: 'x', createdAt: new Date() });

  const sourceId = newId();
  await db.insert(sources).values({
    id: sourceId,
    ownerId,
    name: `src-${suffix}`,
    kind: 'ga',
    config: {},
    status: 'ok',
    objects: [{ id: `properties/${suffix}`, name: `prop-${suffix}`, type: 'property' }],
    createdAt: new Date(),
  });

  const toolId = newId();
  const toolName = `${suffix}.run`;
  await db.insert(tools).values({
    id: toolId,
    ownerId,
    sourceId,
    kind: 'native',
    name: toolName,
    upstreamName: 'run',
    visible: true,
    inputSchema: {},
    readOnly: true,
    dangerous: false,
    permissions: ['ga4.read'],
    examples: [{ description: 'ex', input: { x: 1 } }],
    recommendedUse: { daily_report: true },
    createdAt: new Date(),
  });

  const groupId = newId();
  const groupSlug = `grp-${suffix}-${tag}`;
  await db.insert(groups).values({
    id: groupId,
    ownerId,
    slug: groupSlug,
    name: `grp-${suffix}`,
    schedulingEnabled: true,
    createdAt: new Date(),
  });
  await db.insert(groupTools).values({ groupId, toolId });

  const agentId = newId();
  await db.insert(agents).values({
    id: agentId,
    ownerId,
    name: `agent-${suffix}`,
    apiKeyHash: null,
    apiKeyPrefix: null,
    systemTools: ['system.context', 'system.debug'],
    createdAt: new Date(),
  });
  const token = `tok_${suffix}_${tag}`;
  await db.insert(agentKeys).values({
    id: newId(),
    agentId,
    hash: hashKey(token),
    prefix: token.slice(0, 8),
    label: 'test',
    archived: false,
    createdAt: new Date(),
  });
  await db.insert(agentGroups).values({ agentId, groupId });

  await db.insert(callLogs).values({
    id: newId(),
    ownerId,
    groupId,
    agentId,
    toolName,
    status: 'success',
    source: 'live',
    durationMs: 10,
    ts: new Date(),
  });

  return { ownerId, token, sourceId, toolName, groupId, groupSlug, agentId };
}

const d = dbUp ? describe : describe.skip;

d('cross-owner isolation', () => {
  const app = buildApp();
  let A: Seed;
  let B: Seed;

  beforeAll(async () => {
    await runMigrations();
    A = await seedOwner('a');
    B = await seedOwner('b');
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(callLogs).where(inArray(callLogs.ownerId, userIds));
    await db.delete(users).where(inArray(users.id, userIds)); // cascades sources/tools/groups/agents
    await app.close();
  });

  // ---- gateway auth boundary (the security-critical layer) ----

  it("agent A cannot authenticate into owner B's group", async () => {
    expect(await authenticateAgent(B.groupId, `Bearer ${A.token}`)).toBeNull();
  });

  it('agent A authenticates into its own group', async () => {
    const auth = await authenticateAgent(A.groupId, `Bearer ${A.token}`);
    expect(auth?.ownerId).toBe(A.ownerId);
    expect(auth?.groupId).toBe(A.groupId);
  });

  it('agent-wide auth for A returns only A’s groups, never B’s', async () => {
    const all = await authenticateAgentAll(`Bearer ${A.token}`);
    const ids = all?.groups.map((g) => g.id) ?? [];
    expect(ids).toContain(A.groupId);
    expect(ids).not.toContain(B.groupId);
  });

  // ---- system.context scoping ----

  it('system.context for A exposes only A’s sources and tools', async () => {
    const auth = await authenticateAgent(A.groupId, `Bearer ${A.token}`);
    expect(auth).not.toBeNull();
    const ctx: SystemCtx = {
      agentId: auth!.agentId,
      ownerId: auth!.ownerId,
      scope: 'group',
      groups: [{ id: auth!.groupId, slug: auth!.groupSlug, schedulingEnabled: auth!.schedulingEnabled }],
    };
    const sc = (await handleSystemTool(ctx, 'system.context', {})).structuredContent as any;
    const srcIds = sc.sources.map((s: any) => s.id);
    const toolNames = sc.tools.map((t: any) => t.name);
    expect(srcIds).toContain(A.sourceId);
    expect(srcIds).not.toContain(B.sourceId);
    // system.context exposes MCP-safe names (dots sanitized to underscores).
    expect(toolNames).toContain(mcpToolName(A.toolName));
    expect(toolNames).not.toContain(mcpToolName(B.toolName));

    // enriched discovery metadata
    expect(typeof sc.server.server_time).toBe('string');
    expect(new Date(sc.server.server_time).toString()).not.toBe('Invalid Date');
    const tool = sc.tools.find((t: any) => t.name === mcpToolName(A.toolName));
    expect(tool.callable).toBe(mcpToolName(A.toolName));
    expect(tool.read_only).toBe(true);
    expect(tool.permissions).toEqual(['ga4.read']);
    expect(tool.examples).toHaveLength(1);
    expect(tool.recommended_use.daily_report).toBe(true);
    expect(tool.recommended_use.safe_for_automation).toBe(true); // derived: read_only && !dangerous
    const src = sc.sources.find((s: any) => s.id === A.sourceId);
    expect(src.freshness).toHaveProperty('cached', true);
    expect(src.freshness).toHaveProperty('ttl_seconds');
    // source.objects surfaced (and owner-scoped)
    expect(src.objects.map((o: any) => o.id)).toEqual(['properties/a']);
    expect(src.objects).not.toContainEqual(expect.objectContaining({ id: 'properties/b' }));
  });

  it('system.debug for A never surfaces B’s call logs', async () => {
    const ctx: SystemCtx = {
      agentId: A.agentId,
      ownerId: A.ownerId,
      scope: 'group',
      groups: [{ id: A.groupId, slug: A.groupSlug }],
    };
    const sc = (await handleSystemTool(ctx, 'system.debug', {})).structuredContent as any;
    const tools = sc.calls.map((c: any) => c.tool);
    expect(tools).toContain(A.toolName);
    expect(tools).not.toContain(B.toolName);
  });

  // ---- control-plane owner scoping ----

  it('GET /sources returns only the caller’s sources', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${signJwt(A.ownerId)}` },
    });
    const ids = res.json().map((s: any) => s.id);
    expect(ids).toContain(A.sourceId);
    expect(ids).not.toContain(B.sourceId);
  });

  it('GET /groups returns only the caller’s groups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/groups',
      headers: { authorization: `Bearer ${signJwt(A.ownerId)}` },
    });
    const ids = res.json().map((g: any) => g.id);
    expect(ids).toContain(A.groupId);
    expect(ids).not.toContain(B.groupId);
  });

  it('A cannot set system-tools on B’s agent (404)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${B.agentId}/system-tools`,
      headers: { authorization: `Bearer ${signJwt(A.ownerId)}` },
      payload: { names: ['system.context'] },
    });
    expect(res.statusCode).toBe(404);
  });
});
