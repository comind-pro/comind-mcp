import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { composites, oauthAccessTokens, projectAccess, tools, users } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { newId } from '../lib/id.js';
import { mcpToolName } from '../lib/tool-name.js';
import { invokeTool } from '../runtime/invoker.js';

/** project.* admin tools over /a/mcp for a COO agent. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `coo-${Math.random().toString(36).slice(2, 8)}@test.local`;

const LITERAL = 'lit-token-9f3k2';

const PROJECT_NAMES = [
  'project.list',
  'project.create_child',
  'project.delete',
  'project.access_create',
  'project.access_revoke',
  'project.connections_list',
  'project.connection_describe',
  'project.connection_create',
  'project.connection_test',
  'project.connection_import',
  'project.secret_declare',
  'project.tool_candidate_create',
  'project.tool_candidate_test',
  'project.tool_candidate_promote',
  'project.workspace_create',
  'project.workspace_set_tools',
  'project.agent_mcp_provision',
  'project.agent_revoke',
];

type Result = { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** One JSON-RPC request to /a/mcp (or `url`); the body is SSE (`data: {...}`) or plain JSON. */
async function rpc(key: string, method: string, params: Record<string, unknown> = {}, url = '/a/mcp') {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  const line = res.body.split('\n').find((l) => l.startsWith('data: '));
  const body = res.statusCode === 200 ? JSON.parse(line ? line.slice(6) : res.body) : null;
  return { status: res.statusCode, result: body?.result };
}

const listNames = async (key: string) =>
  ((await rpc(key, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name);

describe.skipIf(!dbUp)('project.* tools for COO agents', () => {
  let token: string;
  let ownerId: string;
  let srcA: string;
  let A: string;
  let B: string;
  let srcB: string;
  let coo: { id: string; apiKey: string };
  let lead: { id: string; apiKey: string };
  let toolA: { id: string; name: string };
  const called = new Set<string>();

  const rest = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    called.add(name);
    return (await rpc(coo.apiKey, 'tools/call', { name: mcpToolName(name), arguments: args })).result;
  };
  const httpSource = (name: string, headers: Record<string, string> = {}) => ({
    name,
    kind: 'http',
    config: {
      baseUrl: 'http://127.0.0.1:9',
      headers,
      endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'ping' }],
    },
  });

  beforeAll(async () => {
    await runMigrations();
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    ({
      token,
      user: { id: ownerId },
    } = reg.json() as { token: string; user: { id: string } });
    const nodes = (await rest('GET', '/projects')).json() as { id: string; kind: string; parentId: string | null }[];
    const root = nodes.find((n) => n.kind === 'team' && !n.parentId)?.id as string;
    const mk = async (name: string) =>
      ((await rest('POST', '/projects', { kind: 'project', name, parentId: root })).json() as { id: string }).id;
    A = await mk('A');
    B = await mk('B');
    srcB = ((await rest('POST', `/sources?project=${B}`, httpSource('src-b'))).json() as { id: string }).id;
    coo = (await rest('POST', `/agents?project=${A}`, { name: 'coo' })).json();
    lead = (await rest('POST', `/agents?project=${A}`, { name: 'lead' })).json();
    await rest('PATCH', `/agents/${coo.id}`, { role: 'coo' });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  });

  it('only a COO sees the project_* tools', async () => {
    expect((await listNames(lead.apiKey)).filter((n) => n.startsWith('project_'))).toEqual([]);
    const names = await listNames(coo.apiKey);
    for (const n of PROJECT_NAMES) expect(names).toContain(mcpToolName(n));
  });

  it('connections_list hides sibling sources and never returns config', async () => {
    const r = await tool('project.connections_list');
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toContain(srcB);
    expect(r.content[0].text).not.toContain('"config"');
  });

  it('connection_create + connection_import create tools in A attributed to the COO', async () => {
    const created = await tool('project.connection_create', httpSource('src-a', { 'x-api-key': LITERAL }));
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent?.id as string;
    srcA = id;
    expect(created.content[0].text).not.toContain('"config"');
    const imp = await tool('project.connection_import', { id });
    expect(imp.isError).toBeFalsy();
    const rows = (await rest('GET', `/tools?project=${A}`)).json() as {
      id: string;
      name: string;
      createdByAgentId: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0].createdByAgentId).toBe(coo.id);
    toolA = rows[0];
    const desc = await tool('project.connection_describe', { id });
    expect((desc.structuredContent?.tools as { id: string }[]).map((t) => t.id)).toEqual([toolA.id]);
  });

  it('secret_declare leaves a pending secret', async () => {
    const r = await tool('project.secret_declare', { name: 'A_TOKEN' });
    expect(r.structuredContent).toMatchObject({ name: 'A_TOKEN', pending: true, reference: '${secret.A_TOKEN}' });
    const rows = (await rest('GET', `/secrets?project=${A}`)).json() as { name: string; pending: boolean }[];
    expect(rows.find((s) => s.name === 'A_TOKEN')?.pending).toBe(true);
  });

  it('workspace_create with a tool → a Lead granted to it lists the tool', async () => {
    const r = await tool('project.workspace_create', { name: 'ws', toolIds: [toolA.id] });
    expect(r.isError).toBeFalsy();
    const groupId = r.structuredContent?.id as string;
    await rest('POST', `/agents/${lead.id}/groups?project=${A}`, { groupId });
    expect(await listNames(lead.apiKey)).toContain(mcpToolName(toolA.name));
  });

  it('agent_mcp_provision returns a working key; agent_revoke kills it', async () => {
    const r = await tool('project.agent_mcp_provision', { name: 'sub', groupIds: [] });
    const { agentId, apiKey } = r.structuredContent as { agentId: string; apiKey: string };
    expect(apiKey).toBeTruthy();
    expect((await rpc(apiKey, 'tools/list')).status).toBe(200);
    expect((await tool('project.agent_revoke', { agentId })).structuredContent).toMatchObject({
      preview: true,
      archivedKeys: 1,
    });
    expect((await rpc(apiKey, 'tools/list')).status).toBe(200);
    expect((await tool('project.agent_revoke', { agentId, confirm: true })).isError).toBeFalsy();
    expect((await rpc(apiKey, 'tools/list')).status).toBe(401);
    expect((await tool('project.agent_revoke', { agentId: coo.id, confirm: true })).content[0].text).toContain(
      'not_allowed',
    );
  });

  it('delete refuses the own node, previews, then removes a child', async () => {
    expect((await tool('project.delete', { id: A, confirm: true })).content[0].text).toContain('not_allowed');
    const child = await tool('project.create_child', { kind: 'project', name: 'child' });
    const id = child.structuredContent?.id as string;
    expect((await tool('project.delete', { id })).structuredContent).toMatchObject({ preview: true, nodes: 1 });
    expect((await tool('project.list')).content[0].text).toContain(id);
    expect((await tool('project.delete', { id, confirm: true })).isError).toBeFalsy();
    expect((await tool('project.list')).content[0].text).not.toContain(id);
  });

  it('PATCH /agents/:id sets the role; foreign or unknown is 404', async () => {
    const r = await rest('PATCH', `/agents/${lead.id}`, { role: 'coo' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: lead.id, role: 'coo' });
    expect((await rest('PATCH', `/agents/${lead.id}`, { role: 'lead' })).json()).toMatchObject({ role: 'lead' });
    const agentsList = (await rest('GET', '/agents')).json() as { id: string; role: string }[];
    expect(agentsList.find((a) => a.id === coo.id)?.role).toBe('coo');
    expect((await rest('PATCH', '/agents/nope', { role: 'coo' })).statusCode).toBe(404);
    expect((await rest('PATCH', `/agents/${lead.id}`, { role: 'x' })).statusCode).toBe(400);
  });

  it('delete refuses an ancestor; provision refuses an ancestor project', async () => {
    const nodes = (await rest('GET', '/projects')).json() as { id: string; kind: string; parentId: string | null }[];
    const root = nodes.find((n) => n.kind === 'team' && !n.parentId)?.id as string;
    expect((await tool('project.delete', { id: root, confirm: true })).content[0].text).toContain('not_found');
    const r = await tool('project.agent_mcp_provision', { name: 'up', projectId: root, groupIds: [] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not_found');
  });

  it('revoking a share unlinks its tools from workspaces in the grantee', async () => {
    await rest('POST', `/sources/${srcB}/import?project=${B}`, {});
    const toolB = ((await rest('GET', `/tools?project=${B}`)).json() as { id: string; name: string }[])[0];
    expect((await rest('POST', `/projects/${A}/access`, { resourceType: 'source', resourceId: srcB })).statusCode).toBe(
      201,
    );
    const ws = await tool('project.workspace_create', { name: 'ws-b', toolIds: [toolB.id] });
    const groupId = ws.structuredContent?.id as string;
    await rest('POST', `/agents/${lead.id}/groups?project=${A}`, { groupId });
    const gtools = async () => (await rest('GET', `/groups/${groupId}/tools?project=${A}`)).json() as { id: string }[];
    expect((await gtools()).map((t) => t.id)).toContain(toolB.id);
    expect(await listNames(lead.apiKey)).toContain(mcpToolName(toolB.name));
    const r = await tool('project.access_revoke', {
      projectId: A,
      resourceType: 'source',
      resourceId: srcB,
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ unlinked: 1 });
    expect((await gtools()).map((t) => t.id)).not.toContain(toolB.id);
    expect(await listNames(lead.apiKey)).not.toContain(mcpToolName(toolB.name));
  });

  it('access_create outside the subtree is not_found', async () => {
    const r = await tool('project.access_create', { projectId: B, resourceType: 'source', resourceId: srcB });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not_found');
  });

  it('invalid args are an error result', async () => {
    const r = await tool('project.create_child', { kind: 'project' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('invalid arguments');
  });

  const child = async (name: string) =>
    (await tool('project.create_child', { kind: 'project', name })).structuredContent?.id as string;
  const text = (r: Result) => r.content[0].text;

  it('I4: a COO provisions COOs only below itself and revokes only descendants or its own agents', async () => {
    expect(text(await tool('project.agent_mcp_provision', { name: 'peer-coo', role: 'coo' }))).toContain('not_allowed');
    const c = await child('i4-child');
    const sub = await tool('project.agent_mcp_provision', { name: 'sub-coo', role: 'coo', projectId: c });
    expect(sub.isError).toBeFalsy();
    expect(sub.structuredContent).toMatchObject({ role: 'coo', projectId: c });
    // an owner-made peer COO at the same node
    const peer = (await rest('POST', `/agents?project=${A}`, { name: 'peer' })).json() as {
      id: string;
      apiKey: string;
    };
    await rest('PATCH', `/agents/${peer.id}`, { role: 'coo' });
    for (const confirm of [false, true])
      expect(text(await tool('project.agent_revoke', { agentId: peer.id, confirm }))).toContain('not_allowed');
    expect((await rpc(peer.apiKey, 'tools/list')).status).toBe(200);
    // a Lead this COO provisioned at its own node, and an agent in a descendant
    const mine = (await tool('project.agent_mcp_provision', { name: 'mine' })).structuredContent?.agentId as string;
    expect((await tool('project.agent_revoke', { agentId: mine, confirm: true })).structuredContent).toMatchObject({
      revoked: true,
      archivedKeys: 1,
    });
    const subId = sub.structuredContent?.agentId as string;
    expect((await tool('project.agent_revoke', { agentId: subId, confirm: true })).isError).toBeFalsy();
  });

  it('I3: revoking an agent ends its OAuth sessions and refresh', async () => {
    const c = await child('i3-child');
    const ag = (await rest('POST', `/agents?project=${c}`, { name: 'oauth-bot' })).json() as { id: string };
    const session = async () => {
      const access = `acc-${newId()}`;
      const refresh = `ref-${newId()}`;
      await db.insert(oauthAccessTokens).values({
        id: newId(),
        tokenHash: hashKey(access),
        refreshHash: hashKey(refresh),
        clientId: 'test-client',
        agentId: ag.id,
        groupId: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
      });
      return { access, refresh };
    };
    const s1 = await session();
    expect((await rpc(s1.access, 'tools/list')).status).toBe(200);
    expect((await tool('project.agent_revoke', { agentId: ag.id, confirm: true })).isError).toBeFalsy();
    expect((await rpc(s1.access, 'tools/list')).status).toBe(401);
    // a session that somehow outlived the revoke still cannot be refreshed
    const s2 = await session();
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: s2.refresh },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_grant', error_description: 'agent revoked' });
  });

  it('I5: staging, workspace, test and share tools work inside the subtree', async () => {
    const vt = await tool('project.tool_candidate_create', {
      kind: 'virtual',
      definition: { name: 'i5-echo', executable: false, response: { pong: true } },
    });
    expect(vt.isError).toBeFalsy();
    const vtId = vt.structuredContent?.id as string;
    expect(vt.structuredContent).toMatchObject({ kind: 'virtual', projectId: A });
    const run = await tool('project.tool_candidate_test', { toolId: vtId });
    expect(run.isError).toBeFalsy();
    expect(JSON.stringify(run.content)).toContain('pong');
    const ws = (await tool('project.workspace_create', { name: 'ws-i5' })).structuredContent?.id as string;
    expect((await tool('project.tool_candidate_promote', { toolId: vtId, groupId: ws })).structuredContent).toEqual({
      groupId: ws,
      toolIds: [vtId],
    });
    const set = await tool('project.workspace_set_tools', { groupId: ws, toolIds: [toolA.id, vtId] });
    expect(set.isError).toBeFalsy();
    const t = await tool('project.connection_test', { id: srcA });
    expect(t.isError).toBeFalsy();
    expect(t.structuredContent).toHaveProperty('ok');
    const c = await child('i5-child');
    const g = { projectId: c, resourceType: 'source', resourceId: srcA };
    expect((await tool('project.access_create', g)).isError).toBeFalsy();
    // previews never write
    const grants = async () => (await db.select().from(projectAccess).where(eq(projectAccess.projectId, c))).length;
    const ownTools = async () => (await db.select().from(tools).where(eq(tools.ownerId, ownerId))).length;
    expect(await grants()).toBe(1);
    expect((await tool('project.access_revoke', g)).structuredContent).toMatchObject({ preview: true });
    expect(await grants()).toBe(1);
    const n = await ownTools();
    expect((await tool('project.connection_import', { id: srcA, force: true })).structuredContent).toMatchObject({
      preview: true,
    });
    expect(await ownTools()).toBe(n);
  });

  it("I5: sibling B's ids are not_found through every project tool", async () => {
    const s = (await rest('POST', `/sources?project=${B}`, httpSource('neg-b'))).json() as { id: string };
    await rest('POST', `/sources/${s.id}/import?project=${B}`, {});
    const toolB = ((await rest('GET', `/tools?project=${B}`)).json() as { id: string; name: string }[]).find(
      (x) => x.name === 'neg-b.ping',
    ) as { id: string };
    const gB = ((await rest('POST', `/groups?project=${B}`, { name: 'neg-grp' })).json() as { id: string }).id;
    const agB = ((await rest('POST', `/agents?project=${B}`, { name: 'neg-ag' })).json() as { id: string }).id;
    const wsA = (await tool('project.workspace_create', { name: 'ws-neg' })).structuredContent?.id as string;
    const cases: [string, Record<string, unknown>, string][] = [
      ['project.workspace_set_tools', { groupId: gB, toolIds: [] }, 'not_found'],
      ['project.workspace_set_tools', { groupId: wsA, toolIds: [toolB.id] }, 'unknown_tools'],
      ['project.tool_candidate_promote', { toolId: toolA.id, groupId: gB }, 'not_found'],
      ['project.tool_candidate_promote', { toolId: toolB.id, groupId: wsA }, 'unknown_tools'],
      ['project.connection_test', { id: s.id }, 'not_found'],
      ['project.connection_import', { id: s.id }, 'not_found'],
      ['project.connection_import', { id: s.id, force: true }, 'not_found'],
      ['project.tool_candidate_test', { toolId: toolB.id }, 'not_found'],
      ['project.agent_revoke', { agentId: agB }, 'not_found'],
      ['project.agent_revoke', { agentId: agB, confirm: true }, 'not_found'],
      ['project.access_revoke', { projectId: B, resourceType: 'source', resourceId: s.id }, 'not_found'],
      ['project.access_revoke', { projectId: B, resourceType: 'source', resourceId: s.id, confirm: true }, 'not_found'],
      ['project.delete', { id: B, confirm: true }, 'not_found'],
    ];
    for (const [name, args, code] of cases) {
      const r = await tool(name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain(code);
    }
    expect((await rest('GET', `/groups/${gB}?project=${B}`)).statusCode).toBe(200);
  });

  it("I5: a composite in A run by the invoker cannot reach B's ungranted tool", async () => {
    const s = (await rest('POST', `/sources?project=${B}`, httpSource('nest-b'))).json() as { id: string };
    await rest('POST', `/sources/${s.id}/import?project=${B}`, {});
    const id = newId();
    const name = `nest-comp-${id}`;
    await db.insert(tools).values({
      id,
      ownerId,
      projectId: A,
      kind: 'composite',
      name,
      createdAt: new Date(),
    } as typeof tools.$inferInsert);
    await db
      .insert(composites)
      .values({ id: newId(), toolId: id, definition: { steps: [{ id: 's', tool: 'nest-b.ping' }] } });
    const r = await invokeTool(name, {}, { ownerId, groupId: null, agentId: null, source: 'test' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('Unknown tool');
  });

  it('I5: a COO on a group endpoint also gets the project tools', async () => {
    const ws = (await tool('project.workspace_create', { name: 'ws-coo' })).structuredContent as {
      id: string;
      slug: string;
    };
    await rest('POST', `/agents/${coo.id}/groups?project=${A}`, { groupId: ws.id });
    const url = `/g/${ws.slug}/mcp`;
    const names = ((await rpc(coo.apiKey, 'tools/list', {}, url)).result.tools as { name: string }[]).map(
      (t) => t.name,
    );
    for (const n of PROJECT_NAMES) expect(names).toContain(mcpToolName(n));
    const r = (await rpc(coo.apiKey, 'tools/call', { name: mcpToolName('project.list'), arguments: {} }, url))
      .result as Result;
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(A);
  });

  it('every call is audited with args, free-form config redacted', async () => {
    type Log = { toolName: string; args: string | null; status: string };
    let proj: Log[] = [];
    // the audit insert is fire-and-forget: poll until every called tool has a row
    for (let i = 0; i < 50; i++) {
      const logs = (await rest('GET', `/logs?project=${A}&limit=1000`)).json() as Log[];
      proj = logs.filter((l) => l.toolName.startsWith('project.'));
      if ([...called].every((n) => proj.some((l) => l.toolName === n))) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(new Set(proj.map((l) => l.toolName))).toEqual(called);
    for (const l of proj) expect(l.args).not.toBeNull();
    const create = proj.find((l) => l.toolName === 'project.connection_create');
    expect(create?.args).toContain('"[redacted]"');
    expect(create?.args).not.toContain(LITERAL);
    expect(proj.find((l) => l.toolName === 'project.create_child' && l.status === 'error')?.args).toBeTruthy();
  });
});
