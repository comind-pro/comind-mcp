import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { agents, users } from '../db/schema.js';
import { mcpToolName } from '../lib/tool-name.js';

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

/** One JSON-RPC request to /a/mcp; the body is SSE (`data: {...}`) or plain JSON. */
async function rpc(key: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/a/mcp',
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
  let A: string;
  let B: string;
  let srcB: string;
  let coo: { id: string; apiKey: string };
  let lead: { id: string; apiKey: string };
  let toolA: { id: string; name: string };
  const called = new Set<string>();

  const rest = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
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
    token = (reg.json() as { token: string }).token;
    const nodes = (await rest('GET', '/projects')).json() as { id: string; kind: string; parentId: string | null }[];
    const root = nodes.find((n) => n.kind === 'team' && !n.parentId)?.id as string;
    const mk = async (name: string) =>
      ((await rest('POST', '/projects', { kind: 'project', name, parentId: root })).json() as { id: string }).id;
    A = await mk('A');
    B = await mk('B');
    srcB = ((await rest('POST', `/sources?project=${B}`, httpSource('src-b'))).json() as { id: string }).id;
    coo = (await rest('POST', `/agents?project=${A}`, { name: 'coo' })).json();
    lead = (await rest('POST', `/agents?project=${A}`, { name: 'lead' })).json();
    // ponytail: Task 3 adds PATCH /agents/:id {role}; until then set it directly.
    await db.update(agents).set({ role: 'coo' }).where(eq(agents.id, coo.id));
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
      keys: 1,
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
